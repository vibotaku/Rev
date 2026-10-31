import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AgentInfo, NodeInfo, NodeJob } from "@rev/shared";
import { Client, startTestServer, type TestServer } from "./helpers";

let server: TestServer;
let alice: Client, bob: Client, anon: Client, node: Client;
let bobId: string;
let enrollKey: string;
let nodeId: string;

const facts = {
  hostname: "mac-01.local",
  platform: "darwin",
  arch: "arm64",
  version: "0.1.0",
  workspaceRoot: "/Users/alice/rev-workspaces",
  capabilities: { node: "v24.0.0", git: "git version 2.50", tmux: "tmux 3.8", claude: "2.1.0 (Claude Code)" },
};

beforeAll(async () => {
  server = await startTestServer();
  anon = new Client(server.app);
  alice = new Client(server.app);
  bob = new Client(server.app);
  await alice.post("/api/setup", { token: "setup-secret", email: "alice@example.com", name: "Alice", password: "correct horse battery" });
  const invite = await alice.post("/api/invites", { email: "bob@example.com" });
  await bob.post(`/api/invites/${invite.json.url.split("/invite/")[1]}/accept`, { name: "Bob", password: "another long password" });
  bobId = (await bob.get("/api/auth/me")).json.user.id;
  await alice.post("/api/projects", { key: "WEB", name: "Web" });
  await alice.post("/api/projects/WEB/members", { userId: bobId, role: "member" });
  // Bob owns the node; Alice is an admin.
  enrollKey = (await bob.post("/api/enrollment-keys", { name: "machines", projects: [] })).json.key;
});

afterAll(async () => {
  await server?.close();
});

const next = async (wait = 0) => {
  const res = await node.get(`/api/node/jobs/next?wait=${wait}`);
  return { status: res.status, job: res.json as NodeJob | null };
};
const myNodes = async (c: Client, all = false) => (await c.get(`/api/nodes${all ? "?all=1" : ""}`)).json as NodeInfo[];

describe("nodes", () => {
  it("registers with an enrollment key and gets a node-only token", async () => {
    expect((await anon.post("/api/nodes/register", { key: "rev_enroll_nope-nope-nope", name: "x" })).status).toBe(401);
    const reg = await anon.post("/api/nodes/register", { key: enrollKey, name: "mac-01", ...facts });
    expect(reg.status).toBe(200);
    expect(reg.json.token).toMatch(/^rev_node_/);
    expect(reg.json.node.owner.name).toBe("Bob");
    nodeId = reg.json.node.id;
    node = new Client(server.app, { token: reg.json.token });

    // A node token is not a user: the regular API does not accept it.
    expect((await node.get("/api/projects")).status).toBe(401);
    expect((await node.get("/api/auth/me")).status).toBe(401);
    // And user credentials do not work on node endpoints.
    expect((await bob.get("/api/node/jobs/next")).status).toBe(401);

    const [listed] = await myNodes(bob);
    expect(listed).toMatchObject({ name: "mac-01", online: true, platform: "darwin", workspaces: [] });
    expect(listed!.capabilities?.tmux).toBe("tmux 3.8");
  });

  it("only lets the owner and admins see and use a node", async () => {
    const carol = new Client(server.app);
    const invite = await alice.post("/api/invites", { email: "carol@example.com" });
    await carol.post(`/api/invites/${invite.json.url.split("/invite/")[1]}/accept`, { name: "Carol", password: "yet another password" });
    expect(await myNodes(carol)).toEqual([]);
    expect((await carol.post(`/api/nodes/${nodeId}/workspaces`, { name: "x", projectKey: "WEB" })).status).toBe(404);
    // Admins see everyone's nodes with ?all=1.
    expect((await myNodes(alice)).length).toBe(0);
    expect((await myNodes(alice, true)).map((n) => n.name)).toEqual(["mac-01"]);
  });

  it("creates a workspace with its agent, then starts and stops its session", async () => {
    expect((await next()).status).toBe(204);
    const bad = await bob.post(`/api/nodes/${nodeId}/workspaces`, { name: "../etc", projectKey: "WEB" });
    expect(bad.status).toBe(400);
    const badUrl = await bob.post(`/api/nodes/${nodeId}/workspaces`, { name: "web", projectKey: "WEB", repoUrl: "file:///etc" });
    expect(badUrl.status).toBe(400);

    // A waiting job request is answered as soon as work is queued.
    const waiting = next(10);
    const created = await bob.post(`/api/nodes/${nodeId}/workspaces`, {
      name: "web",
      projectKey: "web",
      repoUrl: "https://github.com/example/web.git",
      start: true,
    });
    expect(created.status).toBe(200);
    const ws = (created.json as NodeInfo).workspaces[0]!;
    expect(ws).toMatchObject({ name: "web", status: "pending", session: "starting", project: { key: "WEB" }, agent: null });

    const { job } = await waiting;
    expect(job).toMatchObject({ kind: "workspace.create", workspaceId: ws.id, payload: { name: "web", repoUrl: "https://github.com/example/web.git", projectKey: "WEB" } });

    // The node creates the workspace's agent: linked to Bob, a member of WEB.
    const grant = await node.post(`/api/node/workspaces/${ws.id}/agent`);
    expect(grant.status).toBe(200);
    expect(grant.json.agent.name).toBe("claude-mac-01-web");
    expect(grant.json.project).toEqual({ key: "WEB", name: "Web" });
    expect((await node.post(`/api/node/workspaces/${ws.id}/agent`)).status).toBe(409);
    const agent = new Client(server.app, { token: grant.json.token });
    expect((await agent.get("/api/auth/me")).json.user).toMatchObject({ name: "claude-mac-01-web", kind: "agent", ownerId: bobId });
    expect((await agent.get("/api/projects")).json.map((p: { key: string }) => p.key)).toEqual(["WEB"]);
    const bobsAgents = (await bob.get("/api/agents")).json as AgentInfo[];
    expect(bobsAgents.map((a) => a.name)).toContain("claude-mac-01-web");

    expect((await node.post(`/api/node/jobs/${job!.id}/result`, { ok: true, path: "/Users/bob/rev-workspaces/web" })).status).toBe(200);
    expect((await node.post(`/api/node/jobs/${job!.id}/result`, { ok: true })).status).toBe(409);

    const start = (await next()).job!;
    expect(start).toMatchObject({ kind: "session.start", workspaceId: ws.id, payload: { path: null } });
    await node.post(`/api/node/jobs/${start.id}/result`, { ok: true });
    let [info] = await myNodes(bob);
    expect(info!.workspaces[0]).toMatchObject({ status: "ready", path: "/Users/bob/rev-workspaces/web", session: "running" });

    // The node reports what is actually running when it checks in.
    await node.put("/api/node/state", { ...facts, sessions: [] });
    [info] = await myNodes(bob);
    expect(info!.workspaces[0]!.session).toBe("stopped");
    await node.put("/api/node/state", { ...facts, sessions: [ws.id] });

    // Admins may operate anyone's node.
    const stopped = await alice.post(`/api/workspaces/${ws.id}/stop`);
    expect(stopped.json.workspaces[0].session).toBe("stopping");
    // Asking twice does not queue twice.
    await alice.post(`/api/workspaces/${ws.id}/stop`);
    const stop = (await next()).job!;
    expect(stop.kind).toBe("session.stop");
    await node.post(`/api/node/jobs/${stop.id}/result`, { ok: false, error: "tmux: no server running" });
    expect((await next()).status).toBe(204);
    [info] = await myNodes(bob);
    expect(info!.workspaces[0]).toMatchObject({ session: "running", sessionError: "tmux: no server running" });
  });

  it("fails a start whose workspace could not be set up, and jobs a node abandoned", async () => {
    const created = await bob.post(`/api/nodes/${nodeId}/workspaces`, { name: "ops", newProject: { key: "OPS", name: "Ops" }, start: true });
    expect(created.status).toBe(200);
    expect((await bob.get("/api/projects/OPS")).json.myRole).toBe("owner");
    const create = (await next()).job!;
    await node.post(`/api/node/jobs/${create.id}/result`, { ok: false, error: "fatal: repository not found" });
    // The queued start is skipped.
    expect((await next()).status).toBe(204);
    const [info] = await myNodes(bob);
    const ops = info!.workspaces.find((w) => w.name === "ops")!;
    expect(ops).toMatchObject({ status: "failed", error: "fatal: repository not found", session: "stopped", sessionError: "The workspace was not set up" });
    expect((await bob.post(`/api/workspaces/${ops.id}/start`)).status).toBe(400);
    expect((await bob.post(`/api/nodes/${nodeId}/workspaces`, { name: "ops", projectKey: "OPS" })).status).toBe(409);

    // A job left running when the node asks for the next one was interrupted.
    const ws = (await bob.post(`/api/nodes/${nodeId}/workspaces`, { name: "docs", projectKey: "WEB" })).json.workspaces.find(
      (w: { name: string }) => w.name === "docs",
    );
    expect((await next()).job!.kind).toBe("workspace.create");
    expect((await next()).status).toBe(204);
    const docs = (await myNodes(bob))[0]!.workspaces.find((w) => w.id === ws.id)!;
    expect(docs).toMatchObject({ status: "failed", error: "Interrupted: the node stopped before finishing it" });
  });

  it("forgets workspaces and nodes, disabling their agents", async () => {
    const [info] = await myNodes(bob);
    const web = info!.workspaces.find((w) => w.name === "web")!;
    const removed = await bob.del(`/api/workspaces/${web.id}`);
    expect(removed.status).toBe(200);
    expect((removed.json as NodeInfo).workspaces.map((w) => w.name)).not.toContain("web");
    // The session is stopped even though the workspace is gone.
    const stop = (await next()).job!;
    expect(stop).toMatchObject({ kind: "session.stop", workspaceId: null, payload: { name: "web" } });
    await node.post(`/api/node/jobs/${stop.id}/result`, { ok: true });
    const agents = (await bob.get("/api/agents")).json as AgentInfo[];
    expect(agents.find((a) => a.name === "claude-mac-01-web")!.disabled).toBe(true);

    // Disabling a node cuts its token off.
    await bob.patch(`/api/nodes/${nodeId}`, { disabled: true });
    expect((await node.get("/api/node/jobs/next")).status).toBe(401);
    await bob.patch(`/api/nodes/${nodeId}`, { disabled: false });
    expect((await next()).status).toBe(204);

    expect((await bob.del(`/api/nodes/${nodeId}`)).status).toBe(200);
    expect(await myNodes(bob)).toEqual([]);
    expect((await node.get("/api/node/jobs/next")).status).toBe(401);
  });

  it("stops working when its owner is disabled", async () => {
    const reg = await anon.post("/api/nodes/register", { key: enrollKey, name: "linux-01", ...facts, platform: "linux" });
    const second = new Client(server.app, { token: reg.json.token });
    expect((await second.get("/api/node/jobs/next")).status).toBe(204);
    await alice.patch(`/api/users/${bobId}`, { disabled: true });
    expect((await second.get("/api/node/jobs/next")).status).toBe(401);
    await alice.patch(`/api/users/${bobId}`, { disabled: false });
  });
});
