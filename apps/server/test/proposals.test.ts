import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { DashboardInfo, ProjectInfo, TaskDetail, TaskInfo } from "@rev/shared";
import { Client, startTestServer, type TestServer } from "./helpers";

let server: TestServer;
let alice: Client, bob: Client, bot: Client, viewerBot: Client;
let aliceId: string, bobId: string, botId: string;

beforeAll(async () => {
  server = await startTestServer();
  alice = new Client(server.app);
  bob = new Client(server.app);
  aliceId = (await alice.post("/api/setup", { token: "setup-secret", email: "alice@example.com", name: "Alice", password: "correct horse battery" })).json.user.id;
  const invite = await alice.post("/api/invites", { email: "bob@example.com" });
  bobId = (await bob.post(`/api/invites/${invite.json.url.split("/invite/")[1]}/accept`, { name: "Bob", password: "another long password" })).json.user.id;
  await alice.post("/api/projects", { key: "MINI", name: "MiniBrawl" });
  await alice.post("/api/projects", { key: "OTHER", name: "Other" });
  await alice.post("/api/projects/MINI/members", { userId: bobId, role: "member" });
  await alice.post("/api/projects/OTHER/members", { userId: bobId, role: "member" });

  botId = (await alice.post("/api/agents", { name: "mini-bot" })).json.id;
  bot = new Client(server.app, { token: (await alice.post(`/api/agents/${botId}/tokens`, { name: "t" })).json.token });
  await alice.post("/api/projects/MINI/members", { userId: botId, role: "member" });
  await alice.post("/api/projects/OTHER/members", { userId: botId, role: "member" });
  const viewerId = (await alice.post("/api/agents", { name: "viewer-bot" })).json.id;
  viewerBot = new Client(server.app, { token: (await alice.post(`/api/agents/${viewerId}/tokens`, { name: "t" })).json.token });
  await alice.post("/api/projects/MINI/members", { userId: viewerId, role: "viewer" });
});

afterAll(async () => {
  await server?.close();
});

describe("task proposals, sub-tasks and labels", () => {
  let plan: TaskInfo[];

  it("lets agents propose a plan in one call, with parents named by local key", async () => {
    const res = await bot.post("/api/projects/MINI/tasks/bulk", {
      tasks: [
        { key: "w1", title: "Week 1: sim kernel", priority: "high", labels: ["week-1", "sim"] },
        { key: "w1.a", title: "Deterministic tick", parent: "w1", labels: ["week-1", "Week-1"], assigneeId: botId },
        { key: "w1.a.i", title: "Fixed-point math", parent: "w1.a", description: "**Q16.16**" },
        { title: "Replay harness", parent: "w1" },
      ],
    });
    expect(res.status).toBe(200);
    plan = res.json;
    expect(plan.map((t) => [t.ref, t.status, t.parent?.ref ?? null])).toEqual([
      ["MINI-1", "proposed", null],
      ["MINI-2", "proposed", "MINI-1"],
      ["MINI-3", "proposed", "MINI-2"],
      ["MINI-4", "proposed", "MINI-1"],
    ]);
    expect(plan[1]!.labels).toEqual(["week-1"]);
    expect(plan[1]!.assignee?.id).toBe(botId);
    expect(plan[0]!.createdBy).toMatchObject({ id: botId, kind: "agent" });
    expect(plan[0]!.subtasks).toEqual({ total: 2, done: 0 });

    // A single proposal, with an existing task as its parent.
    const one = await bot.post("/api/projects/MINI/tasks", { title: "Greybox Mat", parent: "MINI-1", labels: ["week-2"] });
    expect(one.json).toMatchObject({ ref: "MINI-5", status: "proposed", parent: { ref: "MINI-1" }, can: { editProposal: true, updateStatus: false } });
    const detail = (await bot.get("/api/tasks/MINI-5")).json as TaskDetail;
    expect(detail.activity[0]).toMatchObject({ kind: "created", data: { proposed: true } });
  });

  it("keeps agents to proposals they can edit but not move", async () => {
    const tries: [Client, string, unknown, number, string][] = [
      [bot, "/api/projects/MINI/tasks", { title: "x", status: "todo" }, 403, "agents can only propose"],
      [bot, "/api/projects/MINI/tasks", { title: "x", assigneeId: bobId }, 403, "assign their proposals to themselves"],
      [viewerBot, "/api/projects/MINI/tasks", { title: "x" }, 403, "cannot create tasks"],
      [bot, "/api/projects/MINI/tasks", { title: "x", parent: "OTHER-1" }, 400, "different project"],
      [bot, "/api/projects/MINI/tasks", { title: "x", parent: "MINI-99" }, 400, "does not exist"],
      [bot, "/api/projects/MINI/tasks/bulk", { tasks: [{ title: "a", parent: "b" }, { key: "b", title: "b" }] }, 400, "must come before"],
      [bot, "/api/projects/MINI/tasks/bulk", { tasks: [{ key: "a", title: "a" }, { key: "a", title: "b" }] }, 400, "used twice"],
      [bot, "/api/projects/MINI/tasks", { title: "x", labels: ["a,b"] }, 400, "commas"],
    ];
    for (const [client, url, body, status, message] of tries) {
      const res = await client.post(url, body);
      expect([res.status, res.json.message]).toEqual([status, expect.stringContaining(message)]);
    }
    // Nothing from the failed bulk calls was created.
    expect(((await alice.get("/api/projects/MINI/tasks")).json as TaskInfo[]).length).toBe(5);

    const start = await bot.patch("/api/tasks/MINI-2", { status: "in_progress" });
    expect([start.status, start.json.message]).toEqual([403, expect.stringContaining("still a proposal")]);
    expect((await bot.post("/api/projects/MINI/reviews", { title: "Early", taskRef: "MINI-2" })).json.message).toContain("still a proposal");

    const edited = await bot.patch("/api/tasks/MINI-2", { title: "Deterministic 60 Hz tick", labels: ["week-1", "core"], assigneeId: null });
    expect(edited.json).toMatchObject({ title: "Deterministic 60 Hz tick", labels: ["week-1", "core"], assignee: null });
    expect((await bot.patch("/api/tasks/MINI-2", { assigneeId: bobId })).status).toBe(403);
    await alice.post("/api/projects/OTHER/tasks", { title: "Not the bot's" });
    expect((await bot.patch("/api/tasks/OTHER-1", { title: "Mine now" })).status).toBe(403);
  });

  it("shows humans what waits for them", async () => {
    const [mini] = ((await bob.get("/api/projects")).json as ProjectInfo[]).filter((p) => p.key === "MINI");
    expect(mini!.counts).toMatchObject({ openTasks: 0, proposedTasks: 5 });
    const dash = (await bob.get("/api/dashboard")).json as DashboardInfo;
    expect(dash.proposals).toEqual([{ projectKey: "MINI", projectName: "MiniBrawl", count: 5, proposedBy: [expect.objectContaining({ name: "mini-bot" })] }]);
    const detail = (await bob.get("/api/tasks/MINI-1")).json as TaskDetail;
    expect(detail.can).toMatchObject({ decideProposal: true, edit: true });
    expect(detail.children.map((c) => c.ref)).toEqual(["MINI-2", "MINI-4", "MINI-5"]);
  });

  it("lets humans accept or reject proposals, after which agents work as usual", async () => {
    expect((await bob.patch("/api/tasks/MINI-2", { status: "todo", assigneeId: botId })).status).toBe(403); // bob is not the bot's human
    const accepted = await alice.patch("/api/tasks/MINI-2", { status: "todo", assigneeId: botId });
    expect(accepted.json).toMatchObject({ status: "todo", can: { decideProposal: false } });
    expect(accepted.json.activity.find((a: { kind: string }) => a.kind === "status")).toMatchObject({ data: { from: "proposed", to: "todo" } });
    expect((await bot.get("/api/tasks")).json.map((t: TaskInfo) => t.ref)).toEqual(["MINI-2"]);
    expect((await bot.patch("/api/tasks/MINI-2", { status: "in_progress" })).json.status).toBe("in_progress");
    expect((await bot.patch("/api/tasks/MINI-2", { title: "Renamed after acceptance" })).status).toBe(403);
    expect((await alice.patch("/api/tasks/MINI-2", { status: "proposed" })).json.message).toContain("cannot be moved back");

    const rejected = await bob.patch("/api/tasks/MINI-4", { status: "cancelled" });
    expect(rejected.json).toMatchObject({ status: "cancelled", closure: { review: "human", by: { id: bobId } } });
    expect(((await bob.get("/api/tasks/MINI-1")).json as TaskDetail).subtasks).toEqual({ total: 2, done: 0 });
  });

  it("lets humans re-parent tasks and label them, but not into a loop", async () => {
    await alice.patch("/api/tasks/MINI-1", { status: "todo" });
    expect((await alice.patch("/api/tasks/MINI-1", { parent: "MINI-3" })).json.message).toContain("one of its sub-tasks");
    expect((await alice.patch("/api/tasks/MINI-1", { parent: "MINI-1" })).json.message).toContain("this task");
    const moved = await alice.patch("/api/tasks/MINI-5", { parent: null, labels: ["week-2", "art"] });
    expect(moved.json).toMatchObject({ parent: null, labels: ["week-2", "art"] });
    const human = await alice.post("/api/projects/MINI/tasks", { title: "Human task", parent: "MINI-3", labels: ["ops"] });
    expect(human.json).toMatchObject({ status: "todo", parent: { ref: "MINI-3" }, labels: ["ops"] });
    const level5 = await alice.post("/api/projects/MINI/tasks", { title: "Level 5", parent: human.json.ref });
    expect(level5.status).toBe(200);
    const deep = await alice.post("/api/projects/MINI/tasks", { title: "Too deep", parent: level5.json.ref });
    expect(deep.json.message).toContain("at most 5 levels");
    expect((await alice.patch("/api/tasks/MINI-3", { status: "done" })).json.status).toBe("done");
    expect(((await alice.get("/api/tasks/MINI-2")).json as TaskDetail).subtasks).toEqual({ total: 1, done: 1 });
  });
});
