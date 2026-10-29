import path from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { AGENT_TASK_STATUSES, TASK_STATUSES } from "@rev/shared";
import type { RevApi } from "./api";
import { formatReview, formatTask, formatTaskLine } from "./format";
import { assetNamesFor, createReviewKit, fetchSnapshots } from "./kit";
import { VERSION } from "./version";

export const INSTRUCTIONS = `Rev is the team's task and review tracker. You act as an agent account linked to a human owner.

Workflow:
1. Pull work: call list_my_tasks, then get_task for details. Tasks created from review feedback include the
   reviewers' comments, video timestamps, annotation descriptions and annotated snapshot images; address every one.
2. Call update_task_status with "in_progress" when you start.
3. When done, submit evidence with create_review: screenshots (png/jpg/webp/gif) and screen recordings
   (mp4/webm/mov/mkv) given as local file paths, plus a description of what changed and how to verify it.
   Pass task_ref so the review is linked to the task; publishing it moves the task to "in_review".
4. Humans annotate and comment on the review. Use get_review to read feedback and reply_to_review_comment to answer
   questions. Accepted feedback comes back to you as new tasks.

Rules: you cannot approve reviews, accept or reject comments, create tasks or assign work; those decisions belong to
the humans, as is marking tasks done or cancelled. Keep review titles short and descriptions concrete.`;

type Content = { type: "text"; text: string } | { type: "image"; data: string; mimeType: string };

const text = (s: string) => ({ content: [{ type: "text" as const, text: s }] });

async function guard(fn: () => Promise<{ content: Content[] }>) {
  try {
    return await fn();
  } catch (err) {
    return { isError: true, content: [{ type: "text" as const, text: `Error: ${(err as Error).message}` }] };
  }
}

export function createMcpServer(api: RevApi) {
  const server = new McpServer({ name: "rev", version: VERSION }, { instructions: INSTRUCTIONS });
  const readOnly = { readOnlyHint: true, openWorldHint: false };

  server.registerTool(
    "whoami",
    { description: "Show which Rev agent account this server is authenticated as.", annotations: readOnly },
    () =>
      guard(async () => {
        const me = await api.me();
        return text(`${me.user.name} (${me.user.kind}) on ${api.baseUrl}`);
      }),
  );

  server.registerTool(
    "list_projects",
    { description: "List the Rev projects this agent is a member of.", annotations: readOnly },
    () =>
      guard(async () => {
        const projects = await api.projects();
        if (!projects.length) return text("Not a member of any project yet. Ask your linked human to add you.");
        return text(
          projects
            .map((p) => `${p.key.padEnd(10)} ${p.name} (role: ${p.myRole}, open tasks: ${p.counts.openTasks})`)
            .join("\n"),
        );
      }),
  );

  server.registerTool(
    "list_my_tasks",
    {
      description: "List tasks assigned to this agent. By default only to do / in progress / in review.",
      inputSchema: { include_closed: z.boolean().optional().describe("Also include done and cancelled tasks") },
      annotations: readOnly,
    },
    ({ include_closed }) =>
      guard(async () => {
        const tasks = await api.myTasks(include_closed ? [...TASK_STATUSES] : undefined);
        if (!tasks.length) return text("No tasks assigned to you.");
        return text(tasks.map(formatTaskLine).join("\n"));
      }),
  );

  server.registerTool(
    "get_task",
    {
      description:
        "Get a task's full details: description, the review comments it came from (with timestamps and annotation descriptions), and the annotated snapshot images.",
      inputSchema: {
        ref: z.string().describe('Task reference such as "WEB-12"'),
        include_snapshots: z.boolean().default(true).describe("Attach annotated snapshot images (max 4)"),
      },
      annotations: readOnly,
    },
    ({ ref, include_snapshots }) =>
      guard(async () => {
        const task = await api.task(ref);
        const names = await assetNamesFor(api, task.sourceReview?.ref);
        const content: Content[] = [{ type: "text", text: formatTask(api, task, names) }];
        if (include_snapshots) {
          for (const s of await fetchSnapshots(api, task.sourceComments)) {
            content.push({ type: "text", text: `Snapshot for comment ${s.comment.id}:` });
            content.push({ type: "image", data: s.data.toString("base64"), mimeType: s.mime });
          }
        }
        return { content };
      }),
  );

  server.registerTool(
    "update_task_status",
    {
      description:
        'Move one of your tasks to "in_progress" when starting, or back to "todo". Submitting a review with task_ref moves it to "in_review"; humans mark it done. Optionally leave a note.',
      inputSchema: {
        ref: z.string().describe('Task reference such as "WEB-12"'),
        status: z.enum(AGENT_TASK_STATUSES),
        note: z.string().optional().describe("Optional progress note posted on the task"),
      },
    },
    ({ ref, status, note }) =>
      guard(async () => {
        let task = await api.updateTaskStatus(ref, status);
        if (note?.trim()) task = await api.commentOnTask(ref, note);
        return text(`${task.ref} is now ${task.status}.`);
      }),
  );

  server.registerTool(
    "comment_on_task",
    {
      description: "Post a comment on a task (progress updates, questions for the humans).",
      inputSchema: { ref: z.string(), body: z.string().min(1) },
    },
    ({ ref, body }) =>
      guard(async () => {
        await api.commentOnTask(ref, body);
        return text(`Comment posted on ${ref}.`);
      }),
  );

  server.registerTool(
    "create_review",
    {
      description:
        "Submit a review kit: upload screenshots and screen recordings from local file paths so humans can annotate and comment. Link it to the task you worked on with task_ref.",
      inputSchema: {
        project: z.string().describe('Project key, e.g. "WEB"'),
        title: z.string().min(1),
        description: z.string().default("").describe("Markdown: what changed and how to verify it"),
        files: z.array(z.string()).min(1).describe("Absolute paths to images (png/jpg/webp/gif) or videos (mp4/webm/mov/mkv)"),
        captions: z.array(z.string()).optional().describe("Optional captions aligned with files"),
        task_ref: z.string().optional().describe('Task this review delivers, e.g. "WEB-12"'),
        publish: z.boolean().default(true).describe("Publish immediately (false keeps it as a draft)"),
      },
    },
    (args) =>
      guard(async () => {
        const review = await createReviewKit(api, {
          project: args.project,
          title: args.title,
          description: args.description,
          files: args.files.map((f) => path.resolve(f)),
          captions: args.captions,
          taskRef: args.task_ref,
          publish: args.publish,
        });
        return text(
          `${review.publishedAt ? "Published" : "Saved draft"} ${review.ref} with ${review.assets.length} asset(s).\n` +
            `URL: ${api.webUrl("reviews", review.projectKey, review.number)}\nOwner: ${review.owner.name}`,
        );
      }),
  );

  server.registerTool(
    "get_review",
    {
      description: "Read a review: assets, comment threads with status, timestamps and annotations.",
      inputSchema: {
        ref: z.string().describe('Review reference such as "WEB-R3"'),
        include_snapshots: z.boolean().default(false).describe("Attach annotated snapshot images (max 4)"),
      },
      annotations: readOnly,
    },
    ({ ref, include_snapshots }) =>
      guard(async () => {
        const review = await api.review(ref);
        const content: Content[] = [{ type: "text", text: formatReview(api, review) }];
        if (include_snapshots) {
          const open = review.comments.filter((c) => !c.parentId && (c.status === "open" || c.status === "accepted"));
          for (const s of await fetchSnapshots(api, open)) {
            content.push({ type: "text", text: `Snapshot for comment ${s.comment.id}:` });
            content.push({ type: "image", data: s.data.toString("base64"), mimeType: s.mime });
          }
        }
        return { content };
      }),
  );

  server.registerTool(
    "reply_to_review_comment",
    {
      description: "Reply in the thread of a review comment (answer a question, explain a decision).",
      inputSchema: {
        review_ref: z.string().describe('Review reference such as "WEB-R3"'),
        comment_id: z.string().describe("Id of the top-level comment to reply to"),
        body: z.string().min(1),
      },
    },
    ({ review_ref, comment_id, body }) =>
      guard(async () => {
        await api.commentOnReview(review_ref, { body, parentId: comment_id });
        return text(`Replied on ${review_ref}.`);
      }),
  );

  server.registerTool(
    "comment_on_review",
    {
      description: "Post a general (non-threaded) comment on a review.",
      inputSchema: { review_ref: z.string(), body: z.string().min(1) },
    },
    ({ review_ref, body }) =>
      guard(async () => {
        await api.commentOnReview(review_ref, { body });
        return text(`Comment posted on ${review_ref}.`);
      }),
  );

  return server;
}

export async function runMcpServer(api: RevApi) {
  const server = createMcpServer(api);
  await server.connect(new StdioServerTransport());
}
