import { existsSync, readdirSync, statSync } from "node:fs";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client as McpClient } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { ReviewDetail } from "@rev/shared";
import { Client, makeFixtures, startTestServer, type TestServer } from "../../server/test/helpers";
import { RevApi, RevApiError } from "../src/api";
import { submitReviewRound } from "../src/kit";
import { createMcpServer } from "../src/mcp";
import { buildProgram } from "../src/program";

let server: TestServer;
let fixtures: ReturnType<typeof makeFixtures>;
let baseUrl: string;
let admin: Client;
let agentToken: string;
let agentId: string;
let api: RevApi;
let mcp: McpClient;
/** Review comment created in the MCP suite and replied to from the CLI suite. */
let commentId: string;

type ToolResult = { content: { type: string; text?: string; data?: string; mimeType?: string }[]; isError?: boolean };

async function call(name: string, args: Record<string, unknown> = {}) {
  return (await mcp.callTool({ name, arguments: args })) as ToolResult;
}
const textOf = (r: ToolResult) => r.content.filter((c) => c.type === "text").map((c) => c.text).join("\n");

/** Runs the CLI in-process and captures stdout/stderr. */
async function cli(args: string[], env: NodeJS.ProcessEnv) {
  const out: string[] = [];
  const err: string[] = [];
  const program = buildProgram({ out: (t) => out.push(t), err: (t) => err.push(t), env });
  program.exitOverride();
  await program.parseAsync(args, { from: "user" });
  return { out: out.join("\n"), err: err.join("\n") };
}

beforeAll(async () => {
  server = await startTestServer();
  await server.app.listen({ port: 0, host: "127.0.0.1" });
  baseUrl = `http://127.0.0.1:${(server.app.server.address() as AddressInfo).port}`;
  fixtures = makeFixtures(server.dataDir);

  admin = new Client(server.app);
  await admin.post("/api/setup", {
    token: "setup-secret",
    email: "owner@example.com",
    name: "Olivia",
    password: "correct horse battery",
  });
  await admin.post("/api/projects", { key: "WEB", name: "Website" });
  const agent = await admin.post("/api/agents", { name: "claude-bot" });
  agentId = agent.json.id;
  agentToken = (await admin.post(`/api/agents/${agentId}/tokens`, { name: "test" })).json.token;
  await admin.post("/api/projects/WEB/members", { userId: agentId, role: "member" });

  api = new RevApi(`${baseUrl}/`, agentToken);
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  await createMcpServer(api).connect(serverT);
  mcp = new McpClient({ name: "test", version: "1.0.0" });
  await mcp.connect(clientT);
});

afterAll(async () => {
  await mcp?.close();
  await server?.close();
});

describe("API client", () => {
  it("authenticates with the agent token and maps errors", async () => {
    expect(api.baseUrl).toBe(baseUrl);
    const me = await api.me();
    expect(me.user).toMatchObject({ name: "claude-bot", kind: "agent" });
    const bad = new RevApi(baseUrl, "rev_wrong");
    await expect(bad.me()).rejects.toMatchObject({ status: 401, message: "Invalid or revoked API token" });
    await expect(new RevApi("http://127.0.0.1:1", "x").me()).rejects.toBeInstanceOf(RevApiError);
  });
});

describe("MCP server", () => {
  let reviewRef: string;

  it("advertises instructions and tools", async () => {
    expect(mcp.getInstructions()).toContain("list_my_tasks");
    const { tools } = await mcp.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(
      [
        "comment_on_review",
        "comment_on_task",
        "create_review",
        "get_review",
        "get_task",
        "list_my_tasks",
        "list_projects",
        "reply_to_review_comment",
        "submit_review_round",
        "update_task_status",
        "whoami",
      ].sort(),
    );
    expect(textOf(await call("whoami"))).toContain("claude-bot (agent)");
    expect(textOf(await call("list_projects"))).toContain("WEB");
    expect(textOf(await call("list_my_tasks"))).toBe("No tasks assigned to you.");
  });

  it("creates a review kit from local files", async () => {
    const res = await call("create_review", {
      project: "WEB",
      title: "Landing page",
      description: "New hero section",
      files: [fixtures.png, fixtures.mp4],
      captions: ["Desktop", "Walkthrough"],
    });
    expect(res.isError).toBeFalsy();
    expect(textOf(res)).toContain("Published WEB-R1 with 2 asset(s)");
    expect(textOf(res)).toContain(`${baseUrl}/p/WEB/reviews/1`);
    reviewRef = "WEB-R1";

    const bad = await call("create_review", { project: "WEB", title: "x", files: ["/nope/missing.png"] });
    expect(bad.isError).toBe(true);
    expect(textOf(bad)).toContain("File not found");
  });

  it("delivers annotated feedback as tasks with snapshot images", async () => {
    await server.ctx.processor.idle();
    const review = (await admin.get(`/api/reviews/${reviewRef}`)).json as ReviewDetail;
    expect(review.assets.map((a) => a.caption)).toEqual(["Desktop", "Walkthrough"]);
    const video = review.assets.find((a) => a.kind === "video")!;
    const c = await admin.post(`/api/reviews/${reviewRef}/comments`, {
      body: "Button is cut off",
      assetId: video.id,
      timestampMs: 1200,
      annotation: { shapes: [{ type: "rect", x: 0.1, y: 0.2, w: 0.3, h: 0.1, color: "#ff3b30" }] },
    });
    commentId = c.json.id;
    expect((await admin.upload(`/api/comments/${commentId}/snapshot`, fixtures.png, "image/png", "s.png")).status).toBe(200);
    const task = await admin.post(`/api/reviews/${reviewRef}/tasks`, {
      title: "Fix cut-off button",
      commentIds: [commentId],
      assigneeId: agentId,
    });
    expect(task.json.ref).toBe("WEB-1");

    expect(textOf(await call("list_my_tasks"))).toContain("WEB-1");
    const detail = await call("get_task", { ref: "WEB-1" });
    const text = textOf(detail);
    expect(text).toContain("Fix cut-off button");
    expect(text).toContain("clip.mp4 @ 0:01.2");
    expect(text).toContain("box at (10%, 20%) size 30%×10%");
    const image = detail.content.find((x) => x.type === "image");
    expect(image?.mimeType).toBe("image/png");
    expect(Buffer.from(image!.data!, "base64").subarray(1, 4).toString()).toBe("PNG");

    const noImages = await call("get_task", { ref: "WEB-1", include_snapshots: false });
    expect(noImages.content.every((x) => x.type === "text")).toBe(true);
  });

  it("updates status, comments and replies", async () => {
    expect(textOf(await call("update_task_status", { ref: "WEB-1", status: "in_progress", note: "On it" }))).toBe(
      "WEB-1 is now in_progress.",
    );
    expect(textOf(await call("comment_on_task", { ref: "WEB-1", body: "Halfway" }))).toContain("WEB-1");
    expect(textOf(await call("reply_to_review_comment", { review_ref: reviewRef, comment_id: commentId, body: "Fixing" }))).toContain(
      "Replied",
    );
    expect((await call("comment_on_review", { review_ref: reviewRef, body: "Thanks" })).isError).toBeFalsy();

    const review = await call("get_review", { ref: reviewRef, include_snapshots: true });
    expect(textOf(review)).toContain("↳ claude-bot (agent): Fixing");
    expect(review.content.some((x) => x.type === "image")).toBe(true);

    const task = (await admin.get("/api/tasks/WEB-1")).json;
    expect(task.activity.filter((a: any) => a.kind === "comment").map((a: any) => a.body)).toEqual(["On it", "Halfway"]);

    // Permission errors surface as tool errors rather than crashing the server.
    const other = await admin.post("/api/projects/WEB/tasks", { title: "Human task" });
    const denied = await call("update_task_status", { ref: other.json.ref, status: "in_progress" });
    expect(denied.isError).toBe(true);
    expect(textOf(denied)).toContain("Agents can only update the status of tasks assigned to them");
  });
});

describe("CLI commands", () => {
  it("logs in and stores the token with private permissions", async () => {
    const configFile = path.join(server.dataDir, "cfg", "config.json");
    const env = { REV_CONFIG: configFile };
    const login = await cli(["login", "--url", baseUrl, "--token", agentToken], env);
    expect(login.out).toContain("Logged in as claude-bot (agent)");
    expect(statSync(configFile).mode & 0o777).toBe(0o600);
    expect((await cli(["whoami", "--json"], env)).out).toContain('"kind": "agent"');
    await expect(cli(["whoami"], { REV_CONFIG: path.join(server.dataDir, "none.json") })).rejects.toThrow("not set up on this machine");
  });

  it("lists tasks, saves snapshots and delivers a review for a task", async () => {
    const env = { REV_URL: baseUrl, REV_TOKEN: agentToken, REV_CONFIG: path.join(server.dataDir, "unused.json") };
    expect((await cli(["tasks"], env)).out).toMatch(/WEB-1\s+In progress/);
    const tasksJson = JSON.parse((await cli(["--json", "tasks"], env)).out);
    expect(tasksJson[0].ref).toBe("WEB-1");

    const dir = path.join(server.dataDir, "snaps");
    const shown = await cli(["task", "show", "WEB-1", "--save-snapshots", dir], env);
    expect(shown.out).toContain("Review feedback to address (1)");
    expect(readdirSync(dir)).toHaveLength(1);

    const created = await cli(
      ["review", "create", "-p", "WEB", "-t", "Button fixed", "--task", "WEB-1", "--caption-each", fixtures.png],
      env,
    );
    expect(created.out).toContain("Published WEB-R2 (1 assets");
    expect(created.err).toContain("Uploading shot.png (1/1)");
    expect((await cli(["review", "show", "WEB-R2"], env)).out).toContain("shot.png [image");
    expect((await admin.get("/api/tasks/WEB-1")).json.status).toBe("in_review");

    expect((await cli(["task", "ready", "WEB-1", "--note", "Shipped"], env)).out).toBe("WEB-1 → in_review");
    expect((await cli(["task", "done", "WEB-1", "--note", "Verified on staging"], env)).out).toBe(
      "WEB-1 → done (agent-closed until a human reviews it)",
    );
    expect((await cli(["tasks", "--all-statuses"], env)).out).toMatch(/WEB-1\s+Done \(agent-closed, not reviewed\)/);
    const closed = (await admin.get("/api/tasks/WEB-1")).json;
    expect(closed.closure).toMatchObject({ review: "agent", by: { kind: "agent" } });
    expect((await cli(["review", "reply", commentId, "ack", "--review", "WEB-R1"], env)).out).toContain("Replied on WEB-R1");
    await expect(cli(["task", "status", "WEB-1", "bogus"], env)).rejects.toThrow();
  });

  it("self-registers with an enrollment key and refuses to clobber an existing setup", async () => {
    const enroll = (await admin.post("/api/enrollment-keys", { name: "ci", projects: [{ key: "WEB" }], maxUses: 5 })).json.key;
    const configFile = path.join(server.dataDir, "enrolled", "config.json");
    const env = { REV_CONFIG: configFile, REV_ENROLL_KEY: enroll };
    const reg = await cli(["register", "--url", `${baseUrl}/`, "--name", "ci-runner-1"], env);
    expect(reg.out).toContain("Registered as ci-runner-1 (agent, linked to Olivia)");
    expect(reg.out).toContain("Projects: WEB (member)");
    expect(statSync(configFile).mode & 0o777).toBe(0o600);
    expect((await cli(["whoami"], { REV_CONFIG: configFile })).out).toContain("ci-runner-1 (agent)");

    await expect(cli(["register", "--url", baseUrl, "--name", "ci-runner-2"], env)).rejects.toThrow("already set up");
    const forced = JSON.parse((await cli(["--json", "register", "--url", baseUrl, "--name", "ci-runner-2", "--force"], env)).out);
    expect(forced.agent.name).toBe("ci-runner-2");
    await expect(
      cli(["register", "--url", baseUrl, "--key", "rev_enroll_bogus-key", "--force"], { REV_CONFIG: configFile }),
    ).rejects.toThrow("Invalid enrollment key");
  });

  it("starts the MCP server before registration and works right after", async () => {
    const configFile = path.join(server.dataDir, "lazy", "config.json");
    const env = { REV_CONFIG: configFile };
    const { loadConfig } = await import("../src/config");
    const lazy = async () => {
      const cfg = await loadConfig(env);
      if (!cfg.url || !cfg.token) throw new Error("Rev is not set up on this machine.");
      return new RevApi(cfg.url, cfg.token);
    };
    const [clientT, serverT] = InMemoryTransport.createLinkedPair();
    await createMcpServer(lazy).connect(serverT);
    const client = new McpClient({ name: "lazy-test", version: "0" });
    await client.connect(clientT);
    const before = (await client.callTool({ name: "whoami", arguments: {} })) as ToolResult;
    expect(before.isError).toBe(true);
    expect(textOf(before)).toContain("not set up");

    const enroll = (await admin.post("/api/enrollment-keys", { name: "lazy" })).json.key;
    await cli(["register", "--url", baseUrl, "--key", enroll, "--name", "lazy-bot"], env);
    const after = (await client.callTool({ name: "whoami", arguments: {} })) as ToolResult;
    expect(textOf(after)).toContain("lazy-bot (agent)");
    await client.close();
  });

  it("builds a single-file bundle", () => {
    // The bundle is produced by `npm run build`; only check it when present.
    const bundle = path.join(import.meta.dirname, "..", "dist", "rev.mjs");
    if (existsSync(bundle)) expect(statSync(bundle).mode & 0o111).not.toBe(0);
  });
});

describe("review rounds and mark notes", () => {
  const env = () => ({ REV_URL: baseUrl, REV_TOKEN: agentToken, REV_CONFIG: path.join(server.dataDir, "unused.json") });
  let overallId: string;
  let taskRef: string;

  it("shows mark notes nested under their comment and labels them in tasks", async () => {
    const review = (await admin.get("/api/reviews/WEB-R1")).json as ReviewDetail;
    const image = review.assets.find((a) => a.kind === "image")!;
    const posted = await admin.post("/api/reviews/WEB-R1/comments", {
      body: "Header needs polish",
      assetId: image.id,
      annotation: {
        shapes: [
          { type: "pin", x: 0.1, y: 0.1, color: "#ff3b30" },
          { type: "rect", x: 0.4, y: 0.1, w: 0.2, h: 0.1, color: "#0a84ff" },
        ],
      },
      marks: [{ index: 1, body: "Logo is blurry" }],
    });
    overallId = posted.json.id;
    const markId = posted.json.marks[0].id;

    const shown = (await cli(["review", "show", "WEB-R1"], env())).out;
    expect(shown).toContain("== Round 1");
    expect(shown).toContain("Header needs polish");
    expect(shown).toMatch(/#2 \[open\] Logo is blurry \(comment [0-9a-f-]+\)/);

    const task = await admin.post("/api/reviews/WEB-R1/tasks", { title: "Sharpen logo", commentIds: [markId], assigneeId: agentId });
    taskRef = task.json.ref;
    const detail = textOf(await call("get_task", { ref: taskRef, include_snapshots: false }));
    expect(detail).toContain(`mark #2 of comment ${overallId}`);
    expect(detail).toContain("From review: WEB-R1");
  });

  it("submits the fix as the next round via MCP", async () => {
    const res = await call("submit_review_round", { review_ref: "WEB-R1", notes: "Replaced the logo with the SVG", files: [fixtures.png] });
    expect(res.isError).toBeFalsy();
    expect(textOf(res)).toContain(`Submitted round 2 of WEB-R1 with 1 asset(s). Addresses ${taskRef} (In review)`);
    const review = (await admin.get("/api/reviews/WEB-R1")).json as ReviewDetail;
    expect(review.rounds.map((r) => r.number)).toEqual([1, 2]);
    expect(review.status).toBe("open");
    expect((await admin.get(`/api/tasks/${taskRef}`)).json.status).toBe("in_review");
  });

  it("submits a round from the CLI and shows rounds and deliveries", async () => {
    const out = await cli(["review", "round", "WEB-R1", "--notes", "Tweaked spacing", "--task", taskRef, "--caption-each", fixtures.png], env());
    expect(out.out).toContain(`Submitted round 3 of WEB-R1 (1 assets). Addresses ${taskRef} (In review)`);
    expect(out.err).toContain("Started draft round 3 of WEB-R1");

    const shown = (await cli(["review", "show", "WEB-R1"], env())).out;
    expect(shown).toContain("Round 3 of 3");
    expect(shown).toContain("== Round 3 — by claude-bot (agent)");
    expect(shown).toContain("Tweaked spacing");
    expect(shown).toContain(`Addresses: ${taskRef} Sharpen logo`);
    const task = (await cli(["task", "show", taskRef], env())).out;
    expect(task).toContain("WEB-R1 round 3");
    expect(task).toContain("WEB-R1 round 2");
  });

  it("leaves no draft round behind when a submission fails", async () => {
    await expect(cli(["review", "round", "WEB-R1", "/nope/missing.png"], env())).rejects.toThrow("File not found");
    expect(((await admin.get("/api/reviews/WEB-R1")).json as ReviewDetail).rounds).toHaveLength(3);

    // A failure after the draft exists (here: the submit call) deletes the draft again.
    const failing = new RevApi(baseUrl, agentToken);
    failing.submitRound = async () => {
      throw new Error("network went away");
    };
    await expect(submitReviewRound(failing, "WEB-R1", { files: [fixtures.png] })).rejects.toThrow("network went away");
    expect(((await admin.get("/api/reviews/WEB-R1")).json as ReviewDetail).rounds.map((r) => r.number)).toEqual([1, 2, 3]);

    const json = JSON.parse((await cli(["--json", "review", "round", "WEB-R1", fixtures.png], env())).out);
    expect(json.round.number).toBe(4);
  });
});

