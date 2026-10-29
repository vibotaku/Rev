import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { Argument, Command } from "commander";
import { AGENT_TASK_STATUSES, TASK_STATUSES, type TaskStatus } from "@rev/shared";
import { RevApi } from "./api";
import { configPath, loadConfig, saveConfig } from "./config";
import { formatReview, formatTask, formatTaskLine } from "./format";
import { assetNamesFor, createReviewKit } from "./kit";
import { runMcpServer } from "./mcp";
import { VERSION } from "./version";

export interface Io {
  out(text: string): void;
  err(text: string): void;
  env: NodeJS.ProcessEnv;
}

const defaultIo: Io = {
  out: (t) => process.stdout.write(t.endsWith("\n") ? t : `${t}\n`),
  err: (t) => process.stderr.write(t.endsWith("\n") ? t : `${t}\n`),
  env: process.env,
};

const collect = (value: string, prev: string[] = []) => [...prev, value];

export function buildProgram(io: Io = defaultIo) {
  const program = new Command("rev")
    .description("Rev for agents: pull tasks, submit review kits (screenshots + videos), answer feedback.")
    .version(VERSION)
    .option("--json", "print machine-readable JSON")
    .configureOutput({ writeOut: io.out, writeErr: io.err })
    .showHelpAfterError();

  async function api() {
    const cfg = await loadConfig(io.env);
    if (!cfg.url || !cfg.token) {
      throw new Error("Not logged in. Run `rev login --url <url> --token <token>` or set REV_URL and REV_TOKEN.");
    }
    return new RevApi(cfg.url, cfg.token);
  }

  /** Prints JSON with --json, otherwise the human-readable rendering. */
  function emit(cmd: Command, data: unknown, render: () => string) {
    io.out(cmd.optsWithGlobals().json ? JSON.stringify(data, null, 2) : render());
  }

  program
    .command("login")
    .description("Verify an agent API token and save it to the config file")
    .requiredOption("--url <url>", "Rev base URL, e.g. https://rev.example.com")
    .requiredOption("--token <token>", "agent API token (rev_...)")
    .action(async (opts: { url: string; token: string }, cmd: Command) => {
      const client = new RevApi(opts.url, opts.token);
      const me = await client.me();
      const file = await saveConfig({ url: client.baseUrl, token: opts.token }, io.env);
      emit(cmd, { user: me.user, url: client.baseUrl, config: file }, () =>
        `Logged in as ${me.user.name} (${me.user.kind}) on ${client.baseUrl}\nSaved to ${file}`,
      );
    });

  program
    .command("whoami")
    .description("Show the authenticated account")
    .action(async (_opts, cmd: Command) => {
      const client = await api();
      const me = await client.me();
      emit(cmd, me, () => `${me.user.name} (${me.user.kind}) on ${client.baseUrl}\nconfig: ${configPath(io.env)}`);
    });

  program
    .command("projects")
    .description("List projects you are a member of")
    .action(async (_opts, cmd: Command) => {
      const projects = await (await api()).projects();
      emit(cmd, projects, () =>
        projects.length
          ? projects.map((p) => `${p.key.padEnd(10)} ${p.name} (${p.myRole}, ${p.counts.openTasks} open tasks)`).join("\n")
          : "No projects yet. Ask your linked human to add this agent to a project.",
      );
    });

  // ---- reviews ---------------------------------------------------------------

  const review = program.command("review").description("Create and read review kits");

  review
    .command("create")
    .description("Upload screenshots/videos as a review kit and publish it")
    .argument("<files...>", "images (png/jpg/webp/gif) and videos (mp4/webm/mov/mkv)")
    .requiredOption("-p, --project <key>", "project key, e.g. WEB")
    .requiredOption("-t, --title <title>", "review title")
    .option("-d, --description <markdown>", "what changed and how to verify it")
    .option("--description-file <file>", "read the description from a markdown file")
    .option("--task <ref>", "task this review delivers, e.g. WEB-12")
    .option("--caption <text>", "caption for the next file (repeat once per file, in order)", collect)
    .option("--caption-each", "caption each file with its file name")
    .option("--draft", "keep the review as a draft instead of publishing")
    .action(async (files: string[], opts, cmd: Command) => {
      const client = await api();
      const description = opts.descriptionFile ? await readFile(opts.descriptionFile, "utf8") : (opts.description ?? "");
      const captions: (string | undefined)[] = opts.captionEach
        ? files.map((f) => path.basename(f, path.extname(f)))
        : (opts.caption ?? []);
      const result = await createReviewKit(client, {
        project: opts.project,
        title: opts.title,
        description,
        taskRef: opts.task,
        files,
        captions,
        publish: !opts.draft,
        onProgress: (m) => io.err(m),
      });
      const url = client.webUrl("reviews", result.projectKey, result.number);
      emit(cmd, { ...result, webUrl: url }, () =>
        `${opts.draft ? "Saved draft" : "Published"} ${result.ref} (${result.assets.length} assets, owner ${result.owner.name})\n${url}`,
      );
    });

  review
    .command("show")
    .description("Show a review with its assets and comment threads")
    .argument("<ref>", "review reference, e.g. WEB-R3")
    .action(async (ref: string, _opts, cmd: Command) => {
      const client = await api();
      const r = await client.review(ref);
      emit(cmd, r, () => formatReview(client, r));
    });

  review
    .command("comment")
    .description("Post a general comment on a review")
    .argument("<ref>", "review reference")
    .argument("<text>", "comment text (markdown)")
    .action(async (ref: string, text: string, _opts, cmd: Command) => {
      const c = await (await api()).commentOnReview(ref, { body: text });
      emit(cmd, c, () => `Commented on ${c.reviewRef} (${c.id})`);
    });

  review
    .command("reply")
    .description("Reply to a review comment thread")
    .argument("<commentId>", "id of the comment to reply to (see `rev review show`)")
    .argument("<text>", "reply text (markdown)")
    .requiredOption("-r, --review <ref>", "review the comment belongs to, e.g. WEB-R3")
    .action(async (commentId: string, text: string, opts: { review: string }, cmd: Command) => {
      const c = await (await api()).commentOnReview(opts.review, { body: text, parentId: commentId });
      emit(cmd, c, () => `Replied on ${c.reviewRef} (${c.id})`);
    });

  // ---- tasks -----------------------------------------------------------------

  program
    .command("tasks")
    .description("List tasks assigned to you")
    .option("-a, --all-statuses", "include done and cancelled tasks")
    .action(async (opts: { allStatuses?: boolean }, cmd: Command) => {
      const tasks = await (await api()).myTasks(opts.allStatuses ? [...TASK_STATUSES] : undefined);
      emit(cmd, tasks, () => (tasks.length ? tasks.map(formatTaskLine).join("\n") : "No tasks assigned to you."));
    });

  const task = program.command("task").description("Work on a single task");

  task
    .command("show")
    .description("Show a task with the review feedback it came from")
    .argument("<ref>", "task reference, e.g. WEB-12")
    .option("--save-snapshots <dir>", "download annotated snapshots into this directory")
    .action(async (ref: string, opts: { saveSnapshots?: string }, cmd: Command) => {
      const client = await api();
      const t = await client.task(ref);
      const saved: string[] = [];
      if (opts.saveSnapshots) {
        await mkdir(opts.saveSnapshots, { recursive: true });
        for (const c of t.sourceComments) {
          if (!c.snapshotUrl) continue;
          const { data, mime } = await client.download(c.snapshotUrl);
          const file = path.join(opts.saveSnapshots, `${t.ref}-${c.id}${mime === "image/jpeg" ? ".jpg" : ".png"}`);
          await writeFile(file, data);
          saved.push(file);
        }
      }
      const names = await assetNamesFor(client, t.sourceReview?.ref);
      emit(cmd, { ...t, savedSnapshots: saved }, () =>
        [formatTask(client, t, names), ...(saved.length ? ["", "Saved snapshots:", ...saved.map((s) => `- ${s}`)] : [])].join("\n"),
      );
    });

  async function setStatus(cmd: Command, ref: string, status: TaskStatus, note?: string) {
    const client = await api();
    let t = await client.updateTaskStatus(ref, status);
    if (note?.trim()) t = await client.commentOnTask(ref, note);
    emit(cmd, t, () => `${t.ref} → ${t.status}`);
  }

  task
    .command("start")
    .description("Mark a task as in progress")
    .argument("<ref>")
    .action((ref: string, _opts, cmd: Command) => setStatus(cmd, ref, "in_progress"));

  task
    .command("status")
    .description("Set a task's status (agents: todo, in_progress, in_review; humans mark tasks done)")
    .argument("<ref>")
    .addArgument(new Argument("<status>", "new status").choices(AGENT_TASK_STATUSES))
    .action((ref: string, status: TaskStatus, _opts, cmd: Command) => setStatus(cmd, ref, status));

  task
    .command("ready")
    .description("Hand a task back for human review without a review kit (moves it to in_review)")
    .argument("<ref>")
    .option("-n, --note <text>", "note for the reviewer, posted on the task")
    .action((ref: string, opts: { note?: string }, cmd: Command) => setStatus(cmd, ref, "in_review", opts.note));

  task
    .command("comment")
    .description("Post a comment on a task")
    .argument("<ref>")
    .argument("<text>", "comment text (markdown)")
    .action(async (ref: string, text: string, _opts, cmd: Command) => {
      const t = await (await api()).commentOnTask(ref, text);
      emit(cmd, t, () => `Commented on ${t.ref}`);
    });

  // ---- MCP -------------------------------------------------------------------

  program
    .command("mcp")
    .description("Run a Model Context Protocol server on stdio (e.g. `claude mcp add rev -- rev mcp`)")
    .action(async () => {
      await runMcpServer(await api());
    });

  return program;
}
