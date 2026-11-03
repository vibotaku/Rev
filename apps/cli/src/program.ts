import { mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Argument, Command, Option } from "commander";
import { ACCEPTED_TASK_STATUSES, TASK_PRIORITIES, TASK_STATUS_LABELS, TASK_STATUSES, type TaskStatus } from "@rev/shared";
import { RevApi, type TaskProposal } from "./api";
import { agentConfigFile, configPath, findConfigs, linkClaude, loadConfig, saveConfig, savedCredentials } from "./config";
import { formatReview, formatTask, formatTaskLine, formatTaskTree } from "./format";
import { assetNamesFor, createReviewKit, fetchSnapshots, submitReviewRound } from "./kit";
import { runMcpServer } from "./mcp";
import {
  detectTools,
  installService,
  loadNodeConfig,
  lockNode,
  NodeRunner,
  nodePaths,
  realSys,
  uninstallService,
  writePrivate,
  type NodeConfig,
  type Sys,
} from "./node";
import { VERSION } from "./version";

export interface Io {
  out(text: string): void;
  err(text: string): void;
  env: NodeJS.ProcessEnv;
  /** Runs programs for `rev node` (git, tmux, claude, launchctl…); swappable in tests. */
  sys?: Sys;
}

const defaultIo: Io = {
  out: (t) => process.stdout.write(t.endsWith("\n") ? t : `${t}\n`),
  err: (t) => process.stderr.write(t.endsWith("\n") ? t : `${t}\n`),
  env: process.env,
};

const collect = (value: string, prev: string[] = []) => [...prev, value];

const splitLabels = (raw: string) => raw.split(",").map((l) => l.trim()).filter(Boolean);

/** Reads a plan file for `rev task propose --from`: a JSON array of tasks, or {"tasks": [...]}. */
async function readProposals(file: string, assignee: (who: unknown, where: string) => Promise<string | null>) {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(file, "utf8"));
  } catch (e) {
    throw new Error(`Cannot read ${file}: ${(e as Error).message}`);
  }
  const list = Array.isArray(parsed) ? parsed : (parsed as { tasks?: unknown })?.tasks;
  if (!Array.isArray(list) || !list.length) throw new Error(`${file} must hold a non-empty JSON array of tasks (or {"tasks": [...]})`);
  const items: TaskProposal[] = [];
  for (const [i, raw] of list.entries()) {
    const t = raw as Record<string, unknown>;
    const where = `${file} task ${i + 1}${typeof t.key === "string" ? ` (${t.key})` : ""}: `;
    if (typeof t.title !== "string" || !t.title.trim()) throw new Error(`${where}needs a title`);
    const description =
      typeof t.descriptionFile === "string" ? await readFile(path.resolve(path.dirname(file), t.descriptionFile), "utf8") : t.description;
    items.push({
      ...(typeof t.key === "string" ? { key: t.key } : {}),
      title: t.title,
      ...(typeof description === "string" ? { description } : {}),
      ...(typeof t.priority === "string" ? { priority: t.priority as TaskProposal["priority"] } : {}),
      ...(typeof t.parent === "string" ? { parent: t.parent } : {}),
      ...(Array.isArray(t.labels) ? { labels: t.labels.map(String) } : typeof t.labels === "string" ? { labels: splitLabels(t.labels) } : {}),
      assigneeId: await assignee(t.assignee, where),
    });
  }
  return items;
}

async function readStdin() {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

export function buildProgram(io: Io = defaultIo) {
  const program = new Command("rev")
    .description("Rev for agents: pull tasks, submit review kits (screenshots + videos), answer feedback.")
    .version(VERSION)
    .option("--json", "print machine-readable JSON")
    .option("--config <file>", "the agent's credentials file (default: $REV_CONFIG, else ~/.config/rev/config.json)")
    .configureOutput({ writeOut: io.out, writeErr: io.err })
    .showHelpAfterError();

  /** io.env, with REV_CONFIG set from --config when given. */
  let env = io.env;
  program.hook("preAction", (_program, action) => {
    const file = action.optsWithGlobals().config as string | undefined;
    if (file) env = { ...io.env, REV_CONFIG: path.resolve(file) };
  });

  async function api() {
    const cfg = await loadConfig(env);
    if (!cfg.url || !cfg.token) {
      throw new Error(
        "Rev is not set up on this machine. Register with `rev register --url <url> --key <enrollment key>` " +
          "(Claude Code: /rev:setup), log in with `rev login --url <url> --token <token>`, or set REV_URL and REV_TOKEN.",
      );
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
      const file = await saveConfig({ url: client.baseUrl, token: opts.token }, env);
      emit(cmd, { user: me.user, url: client.baseUrl, config: file }, () =>
        `Logged in as ${me.user.name} (${me.user.kind}) on ${client.baseUrl}\nSaved to ${file}`,
      );
    });

  program
    .command("register")
    .description(
      "Register a new agent using an enrollment key, and save its token. If the config file already holds an agent, " +
        "that agent is kept and the new one is saved next to it as <name>.json.",
    )
    .requiredOption("--url <url>", "Rev base URL, e.g. https://rev.example.com")
    .option("--key <key>", "enrollment key (rev_enroll_...); `-` reads it from stdin; defaults to $REV_ENROLL_KEY")
    .option("--name <name>", "agent name, unique among your human's agents (default: <user>@<host>)")
    .option("--description <text>", "what/where this agent is (default: host and platform)")
    .option("--repo <dir>", "make Claude Code in this folder use the new agent (.claude/settings.local.json, kept out of git)")
    .option("--force", "replace the agent saved in the config file instead of keeping it")
    .action(
      async (
        opts: { url: string; key?: string; name?: string; description?: string; repo?: string; force?: boolean },
        cmd: Command,
      ) => {
        const host = os.hostname().split(".")[0] || "host";
        const name = opts.name ?? `${os.userInfo().username}@${host}`;
        let file = configPath(env);
        const kept = opts.force ? null : await savedCredentials(file);
        if (kept) {
          // Several agents can share a machine, each in its own file (REV_CONFIG picks one).
          if (cmd.optsWithGlobals().config) {
            throw new Error(`${file} already holds an agent. Pass --force to replace it, or choose another --config.`);
          }
          file = agentConfigFile(file, name);
          if (await savedCredentials(file)) {
            throw new Error(`${file} already holds an agent. Choose another --name, or pass --config <file>.`);
          }
        }
        const key = (opts.key === "-" ? await readStdin() : (opts.key ?? io.env.REV_ENROLL_KEY ?? "")).trim();
        if (!key) throw new Error("No enrollment key: pass --key <key>, --key - (stdin), or set REV_ENROLL_KEY.");
        const description = opts.description ?? `Registered from ${host} (${process.platform} ${process.arch}) with rev ${VERSION}`;
        const baseUrl = opts.url.replace(/\/+$/, "");
        const reg = await RevApi.register(baseUrl, { key, name, description });
        await saveConfig({ url: baseUrl, token: reg.token }, env, file);
        // The agent exists now: a settings file we can't update is reported, not thrown.
        let linked: string | null = null;
        let linkError: string | null = null;
        if (opts.repo) linked = await linkClaude(path.resolve(opts.repo), file).catch((e: Error) => ((linkError = e.message), null));
        const projects = reg.projects.map((p) => `${p.key} (${p.role})`).join(", ") || "none yet (ask your human to add you)";
        const data = { agent: reg.agent, projects: reg.projects, url: baseUrl, config: file, keptConfig: kept ? configPath(env) : null, claudeSettings: linked, claudeSettingsError: linkError };
        emit(cmd, data, () =>
          [
            `Registered as ${reg.agent.name} (agent, linked to ${reg.agent.owner.name}) on ${baseUrl}`,
            `Projects: ${projects}`,
            `Saved to ${file}`,
            ...(kept ? [`Kept the agent already saved in ${configPath(env)}.`] : []),
            ...(linkError ? [`Could not point Claude Code at this agent: ${linkError}`] : []),
            ...(linked
              ? [`Claude Code in ${path.dirname(path.dirname(linked))} now uses this agent (${linked}). Restart Claude Code there to pick it up.`]
              : kept || linkError
                ? [
                    `Use it with \`rev --config ${file} …\`. For Claude Code in a repo, set "env": { "REV_CONFIG": "${file}" }`,
                    `and "enabledPlugins": { "rev@vibotaku": true } in the repo's .claude/settings.local.json.`,
                  ]
                : []),
          ].join("\n"),
        );
      },
    );

  program
    .command("whoami")
    .description("Show the authenticated account")
    .option("--all", "list every agent saved on this machine, with its projects")
    .action(async (opts: { all?: boolean }, cmd: Command) => {
      if (opts.all) return whoamiAll(cmd);
      const client = await api();
      const me = await client.me();
      emit(cmd, me, () => `${me.user.name} (${me.user.kind}) on ${client.baseUrl}\nconfig: ${configPath(env)}`);
    });

  /** The agents in the config folders (this one, the default one) and the agents of node workspaces. */
  async function whoamiAll(cmd: Command) {
    const current = configPath(env);
    const { REV_CONFIG: _, ...withoutOverride } = io.env;
    const dirs = [path.dirname(current), path.dirname(configPath(withoutOverride)), nodePaths(io.env).agents];
    const agents = await Promise.all(
      (await findConfigs(dirs)).map(async ({ file, config }) => {
        const client = new RevApi(config.url, config.token);
        try {
          const [me, projects] = await Promise.all([client.me(), client.projects()]);
          return { config: file, current: file === current, url: client.baseUrl, user: me.user, projects: projects.map((p) => p.key) };
        } catch (e) {
          return { config: file, current: file === current, url: client.baseUrl, error: (e as Error).message };
        }
      }),
    );
    emit(cmd, agents, () =>
      agents.length
        ? agents
            .map((a) =>
              [
                a.user ? `${a.user.name} (${a.user.kind}) on ${a.url}` : `? (${a.error}) on ${a.url}`,
                a.current ? "  ← current" : "",
                `\n  config: ${a.config}`,
                a.projects ? `\n  projects: ${a.projects.join(", ") || "none"}` : "",
              ].join(""),
            )
            .join("\n")
        : "No agents are saved on this machine.",
    );
  }

  program
    .command("projects")
    .description("List projects you are a member of")
    .action(async (_opts, cmd: Command) => {
      const projects = await (await api()).projects();
      emit(cmd, projects, () =>
        projects.length
          ? projects
              .map((p) => {
                const proposed = p.counts.proposedTasks ? `, ${p.counts.proposedTasks} proposed` : "";
                return `${p.key.padEnd(10)} ${p.name} (${p.myRole}, ${p.counts.openTasks} open tasks${proposed})`;
              })
              .join("\n")
          : "No projects yet. Ask your linked human to add this agent to a project.",
      );
    });

  // ---- reviews ---------------------------------------------------------------

  const review = program.command("review").description("Create review kits, submit new rounds, read feedback");

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
    .command("round")
    .description("Submit the next round of a review after addressing its feedback (new screenshots/videos)")
    .argument("<ref>", "review to continue, e.g. WEB-R3")
    .argument("<files...>", "images (png/jpg/webp/gif) and videos (mp4/webm/mov/mkv)")
    .option("-n, --notes <markdown>", "what changed since the previous round and how to verify it")
    .option("--notes-file <file>", "read the notes from a markdown file")
    .option("--task <ref>", "task this round addresses (repeatable; default: your open tasks from this review)", collect)
    .option("--caption <text>", "caption for the next file (repeat once per file, in order)", collect)
    .option("--caption-each", "caption each file with its file name")
    .action(async (ref: string, files: string[], opts, cmd: Command) => {
      const client = await api();
      const notes = opts.notesFile ? await readFile(opts.notesFile, "utf8") : (opts.notes ?? "");
      const captions: (string | undefined)[] = opts.captionEach
        ? files.map((f) => path.basename(f, path.extname(f)))
        : (opts.caption ?? []);
      const { review: r, round } = await submitReviewRound(client, ref, {
        notes,
        files,
        captions,
        taskRefs: opts.task,
        onProgress: (m) => io.err(m),
      });
      const url = client.webUrl("reviews", r.projectKey, r.number);
      const addressed = round.addressedTasks.map((t) => `${t.ref} (${TASK_STATUS_LABELS[t.status]})`).join(", ") || "no tasks";
      emit(cmd, { review: r, round, webUrl: url }, () =>
        `Submitted round ${round.number} of ${r.ref} (${round.assetCount} assets). Addresses ${addressed}\n${url}`,
      );
    });

  review
    .command("show")
    .description("Show a review round by round: notes, assets, comments, mark notes and replies")
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
    .argument("<commentId>", "id of the comment or mark note to reply to (see `rev review show`)")
    .argument("<text>", "reply text (markdown)")
    .requiredOption("-r, --review <ref>", "review the comment belongs to, e.g. WEB-R3")
    .action(async (commentId: string, text: string, opts: { review: string }, cmd: Command) => {
      const c = await (await api()).commentOnReview(opts.review, { body: text, parentId: commentId });
      emit(cmd, c, () => `Replied on ${c.reviewRef} (${c.id})`);
    });

  // ---- tasks -----------------------------------------------------------------

  program
    .command("tasks")
    .description("List tasks assigned to you, or every task in a project (as a tree of sub-tasks)")
    .option("-a, --all-statuses", "include done and cancelled tasks")
    .option("-p, --project <key>", "list the project's tasks, whoever they are assigned to, proposals included")
    .action(async (opts: { allStatuses?: boolean; project?: string }, cmd: Command) => {
      const client = await api();
      if (opts.project) {
        const open = TASK_STATUSES.filter((s) => s !== "done" && s !== "cancelled");
        const tasks = await client.projectTasks(opts.project, opts.allStatuses ? undefined : open);
        return emit(cmd, tasks, () => (tasks.length ? formatTaskTree(tasks) : `No ${opts.allStatuses ? "" : "open "}tasks in ${opts.project}.`));
      }
      const tasks = await client.myTasks(opts.allStatuses ? [...TASK_STATUSES] : undefined);
      emit(cmd, tasks, () => (tasks.length ? tasks.map((t) => formatTaskLine(t)).join("\n") : "No tasks assigned to you."));
    });

  const task = program.command("task").description("Work on a single task, or propose new ones");

  task
    .command("propose")
    .alias("create")
    .description(
      "Propose tasks in a project. They wait as Proposed until a human accepts them (then they are worked on as usual) or rejects them. " +
        "One task from the options, or many from a JSON file (--from).",
    )
    .requiredOption("-p, --project <key>", "project key, e.g. WEB")
    .option("-t, --title <title>", "title of a single task")
    .option("-d, --description <md>", "description (markdown)")
    .option("--description-file <file>", "read the description from a file")
    .addOption(new Option("--priority <priority>", "priority").choices(TASK_PRIORITIES))
    .option("--parent <ref>", "make it a sub-task of this task, e.g. WEB-3")
    .option("--labels <labels>", "comma-separated labels, e.g. week-1,ui")
    .option("--assign <who>", "me (you plan to do it) or none", "none")
    .option(
      "--from <file>",
      'JSON array of tasks (or {"tasks": [...]}): {key?, title, description?, descriptionFile?, priority?, parent?, labels?, assignee?: "me"}. ' +
        "parent is a task ref or the key of an earlier item; up to 100 tasks, created all or none",
    )
    .action(
      async (
        opts: {
          project: string;
          title?: string;
          description?: string;
          descriptionFile?: string;
          priority?: TaskProposal["priority"];
          parent?: string;
          labels?: string;
          assign: string;
          from?: string;
        },
        cmd: Command,
      ) => {
        if (!!opts.from === !!opts.title) throw new Error("Give either --title (one task) or --from <file> (many).");
        const client = await api();
        let myId: string | undefined;
        const assignee = async (who: unknown, where: string) => {
          if (who == null || who === "none" || who === "") return null;
          if (who !== "me") throw new Error(`${where}assignee must be "me" or none: agents propose work only for themselves`);
          return (myId ??= (await client.me()).user.id);
        };
        let items: TaskProposal[];
        if (opts.from) {
          items = await readProposals(opts.from, assignee);
        } else {
          const description = opts.descriptionFile ? await readFile(opts.descriptionFile, "utf8") : opts.description;
          items = [
            {
              title: opts.title!,
              ...(description !== undefined ? { description } : {}),
              ...(opts.priority ? { priority: opts.priority } : {}),
              ...(opts.parent ? { parent: opts.parent } : {}),
              ...(opts.labels ? { labels: splitLabels(opts.labels) } : {}),
              assigneeId: await assignee(opts.assign, ""),
            },
          ];
        }
        const created = await client.proposeTasks(opts.project, items);
        const proposed = created.filter((t) => t.status === "proposed").length;
        emit(cmd, created, () =>
          [
            formatTaskTree(created),
            "",
            proposed
              ? `Proposed ${proposed} task${proposed === 1 ? "" : "s"} in ${opts.project.toUpperCase()}. ` +
                `They wait for a human to accept them: ${client.webUrl("tasks", opts.project.toUpperCase())}`
              : `Created ${created.length} task${created.length === 1 ? "" : "s"} in ${opts.project.toUpperCase()}.`,
          ].join("\n"),
        );
      },
    );

  task
    .command("show")
    .description("Show a task with the review feedback it came from")
    .argument("<ref>", "task reference, e.g. WEB-12")
    .option("--save-snapshots <dir>", "download annotated snapshots (and frames around video comments) into this directory")
    .action(async (ref: string, opts: { saveSnapshots?: string }, cmd: Command) => {
      const client = await api();
      const t = await client.task(ref);
      const saved: string[] = [];
      if (opts.saveSnapshots) {
        await mkdir(opts.saveSnapshots, { recursive: true });
        for (const s of await fetchSnapshots(client, t.sourceComments, Infinity, Infinity)) {
          const id = s.kind === "frames" ? `${s.comment.markOf ?? s.comment.id}-frames` : s.comment.id;
          const file = path.join(opts.saveSnapshots, `${t.ref}-${id}${s.mime === "image/jpeg" ? ".jpg" : ".png"}`);
          await writeFile(file, s.data);
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
    emit(cmd, t, () => `${t.ref} → ${t.status}${t.closure?.review === "agent" ? " (agent-closed until a human reviews it)" : ""}`);
  }

  task
    .command("start")
    .description("Mark a task as in progress")
    .argument("<ref>")
    .action((ref: string, _opts, cmd: Command) => setStatus(cmd, ref, "in_progress"));

  task
    .command("status")
    .description("Set a task's status")
    .argument("<ref>")
    .addArgument(new Argument("<status>", "new status").choices(ACCEPTED_TASK_STATUSES))
    .action((ref: string, status: TaskStatus, _opts, cmd: Command) => setStatus(cmd, ref, status));

  task
    .command("ready")
    .description("Hand a task back for human review without a review kit (moves it to in_review)")
    .argument("<ref>")
    .option("-n, --note <text>", "note for the reviewer, posted on the task")
    .action((ref: string, opts: { note?: string }, cmd: Command) => setStatus(cmd, ref, "in_review", opts.note));

  task
    .command("done")
    .description("Close a task yourself. It is shown as agent-closed until a human reviews it")
    .argument("<ref>")
    .option("-n, --note <text>", "what was done and how it was verified, posted on the task")
    .action((ref: string, opts: { note?: string }, cmd: Command) => setStatus(cmd, ref, "done", opts.note));

  task
    .command("comment")
    .description("Post a comment on a task")
    .argument("<ref>")
    .argument("<text>", "comment text (markdown)")
    .action(async (ref: string, text: string, _opts, cmd: Command) => {
      const t = await (await api()).commentOnTask(ref, text);
      emit(cmd, t, () => `Commented on ${t.ref}`);
    });

  // ---- Node ------------------------------------------------------------------

  const sys = io.sys ?? realSys;
  const node = program
    .command("node")
    .description("Make this computer a Rev node: Rev can then create workspaces with agents here, and start Claude Code in them");

  node
    .command("install")
    .description("Register this computer as a node (once) and install the background service that runs it")
    .option("--url <url>", "Rev base URL, e.g. https://rev.example.com")
    .option("--key <key>", "enrollment key (rev_enroll_...); `-` reads it from stdin; defaults to $REV_ENROLL_KEY")
    .option("--name <name>", "node name shown in Rev (default: the host name)")
    .option("--root <dir>", "folder to create workspaces in (default: ~/rev-workspaces)")
    .option(
      "--claude-args <args>",
      'extra arguments for claude in agent sessions, e.g. "--permission-mode acceptEdits" (default: none; your Claude Code settings apply)',
    )
    .option("--no-service", "only register; run `rev node run` yourself")
    .option("--force", "register again as a new node even if this computer already is one")
    .action(
      async (
        opts: { url?: string; key?: string; name?: string; root?: string; claudeArgs?: string; service: boolean; force?: boolean },
        cmd: Command,
      ) => {
        const paths = nodePaths(io.env);
        let cfg = await loadNodeConfig(io.env);
        let registered = false;
        if (!cfg || opts.force) {
          if (!opts.url) throw new Error("Pass --url <Rev base URL> to register this computer as a node.");
          const key = (opts.key === "-" ? await readStdin() : (opts.key ?? io.env.REV_ENROLL_KEY ?? "")).trim();
          if (!key) throw new Error("No enrollment key: pass --key <key>, --key - (stdin), or set REV_ENROLL_KEY.");
          const baseUrl = opts.url.replace(/\/+$/, "");
          const draft: Omit<NodeConfig, "token" | "nodeId"> = {
            url: baseUrl,
            name: opts.name ?? (os.hostname().split(".")[0] || "node"),
            workspaceRoot: path.resolve(opts.root ?? paths.defaultRoot),
            claudeArgs: opts.claudeArgs?.split(/\s+/).filter(Boolean) ?? [],
          };
          const runner = new NodeRunner({ ...draft, token: "", nodeId: "" }, sys, io.env, () => undefined);
          const reg = await RevApi.registerNode(baseUrl, { key, name: draft.name, ...(await runner.facts()) });
          cfg = { ...draft, token: reg.token, nodeId: reg.node.id };
          registered = true;
        } else {
          // Already a node: optionally change local settings, then reinstall the service.
          if (opts.root) cfg.workspaceRoot = path.resolve(opts.root);
          if (opts.claudeArgs !== undefined) cfg.claudeArgs = opts.claudeArgs.split(/\s+/).filter(Boolean);
        }
        await writePrivate(paths.config, cfg);
        await mkdir(cfg.workspaceRoot, { recursive: true });
        const tools = await detectTools(sys);
        const service = opts.service ? await installService(io.env, sys, process.argv[1] ?? "") : null;
        const missing = (["git", "tmux", "claude"] as const).filter((t) => !tools[t]);
        emit(cmd, { node: { id: cfg.nodeId, name: cfg.name, url: cfg.url }, registered, workspaceRoot: cfg.workspaceRoot, tools, service }, () =>
          [
            registered ? `Registered ${cfg.name} as a node on ${cfg.url}` : `${cfg.name} is already a node on ${cfg.url}`,
            `Workspaces: ${cfg.workspaceRoot}`,
            `Claude Code arguments: ${cfg.claudeArgs.join(" ") || "(none; your Claude Code settings apply)"}`,
            `Tools: ${(["git", "tmux", "claude"] as const).map((t) => `${t} ${tools[t] ? "yes" : "MISSING"}`).join(", ")}`,
            ...(missing.length ? [`Install ${missing.join(", ")} to let Rev ${missing.includes("git") ? "clone repositories and " : ""}start agents here.`] : []),
            service
              ? `Service: ${service.kind} (${service.file}); logs: ${service.logs}`
              : "No service installed: run `rev node run` to serve Rev.",
            ...(service?.kind === "systemd" ? ["To keep it running while you are logged out: loginctl enable-linger $USER"] : []),
            ...(service?.kind === "launchd"
              ? [
                  "macOS: allow node when macOS asks (System Settings → Privacy & Security): Local Network if Rev is on your local network, " +
                    "and Files and Folders if Claude Code reads files on an external volume or in Desktop, Documents or Downloads.",
                ]
              : []),
            `Saved to ${paths.config}`,
            "Open Rev → Nodes to create workspaces here.",
          ].join("\n"),
        );
      },
    );

  node
    .command("run")
    .description("Serve Rev in the foreground (what the background service runs)")
    .action(async () => {
      const cfg = await loadNodeConfig(io.env);
      if (!cfg) throw new Error("This computer is not a node yet: run `rev node install --url <url> --key <enrollment key>`.");
      const unlock = await lockNode(io.env);
      const stop = new AbortController();
      for (const signal of ["SIGINT", "SIGTERM"] as const) process.once(signal, () => stop.abort());
      try {
        await new NodeRunner(cfg, sys, io.env).serve(stop.signal);
      } finally {
        await unlock();
      }
    });

  node
    .command("status")
    .description("Show this node's settings, tools and workspaces")
    .action(async (_opts, cmd: Command) => {
      const cfg = await loadNodeConfig(io.env);
      if (!cfg) throw new Error("This computer is not a node yet: run `rev node install --url <url> --key <enrollment key>`.");
      const runner = new NodeRunner(cfg, sys, io.env, () => undefined);
      const [facts, running, agents] = await Promise.all([runner.facts(), runner.runningSessions(), runner.runningAgents()]);
      const registry = JSON.parse(await readFile(nodePaths(io.env).registry, "utf8").catch(() => "{}")) as Record<string, { name: string; path: string; agentName: string }>;
      const workspaces = Object.entries(registry).map(([id, w]) => ({ id, ...w, running: running.includes(id) }));
      const { token: _token, ...safe } = cfg;
      emit(cmd, { node: safe, tools: facts.capabilities, workspaces, agents }, () =>
        [
          `${cfg.name} on ${cfg.url}`,
          `Workspaces folder: ${cfg.workspaceRoot}`,
          `Claude Code arguments: ${cfg.claudeArgs.join(" ") || "(none)"}`,
          `Tools: ${(["git", "tmux", "claude"] as const).map((t) => `${t} ${facts.capabilities[t] ?? "MISSING"}`).join(" · ")}`,
          ...(workspaces.length
            ? workspaces.map((w) => `  ${w.name.padEnd(20)} ${w.running ? "running" : "stopped"}  ${w.agentName}  ${w.path}`)
            : ["No workspaces yet."]),
          `Rev sessions running here (shown in Rev under this node): ${agents.length || "none"}`,
          ...agents.map((a) => `  ${a.tokenPrefix}…  ${a.cwd ?? "(folder unknown)"}`),
        ].join("\n"),
      );
    });

  node
    .command("uninstall")
    .description("Remove the background service (the node stays registered; remove it in Rev → Nodes)")
    .action(async (_opts, cmd: Command) => {
      const file = await uninstallService(io.env, sys);
      emit(cmd, { removed: file }, () => `Removed the service (${file}). Workspaces and their folders are untouched.`);
    });

  // ---- MCP -------------------------------------------------------------------

  program
    .command("mcp")
    .description("Run a Model Context Protocol server on stdio (e.g. `claude mcp add rev -- rev mcp`)")
    .action(async () => {
      // Start even when not registered yet; tools report how to set up until credentials exist.
      await runMcpServer(api);
    });

  return program;
}
