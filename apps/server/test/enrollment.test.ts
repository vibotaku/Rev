import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AgentInfo, AgentRegistration, EnrollmentKeyInfo } from "@rev/shared";
import { enrollmentKeys } from "../src/db/schema";
import { Client, startTestServer, type TestServer } from "./helpers";

let server: TestServer;
let alice: Client, bob: Client, anon: Client;
let aliceId: string, bobId: string;

beforeAll(async () => {
  server = await startTestServer();
  anon = new Client(server.app);
  alice = new Client(server.app);
  bob = new Client(server.app);
  await alice.post("/api/setup", { token: "setup-secret", email: "alice@example.com", name: "Alice", password: "correct horse battery" });
  const invite = await alice.post("/api/invites", { email: "bob@example.com" });
  await bob.post(`/api/invites/${invite.json.url.split("/invite/")[1]}/accept`, { name: "Bob", password: "another long password" });
  aliceId = (await alice.get("/api/auth/me")).json.user.id;
  bobId = (await bob.get("/api/auth/me")).json.user.id;
  await alice.post("/api/projects", { key: "WEB", name: "Web" });
  await alice.post("/api/projects", { key: "OPS", name: "Ops" });
  await alice.post("/api/projects/WEB/members", { userId: bobId, role: "member" });
});

afterAll(async () => {
  await server?.close();
});

const register = (key: string, name: string, description = "") =>
  anon.post("/api/agents/register", { key, name, description });

describe("agent self-registration with enrollment keys", () => {
  let key: string;
  let keyId: string;

  it("lets humans create keys only for projects they can add agents to", async () => {
    expect((await bob.post("/api/enrollment-keys", { name: "bob ops", projects: [{ key: "OPS" }] })).status).toBe(404);
    const created = await alice.post("/api/enrollment-keys", {
      name: "build boxes",
      projects: [{ key: "WEB" }, { key: "ops", role: "viewer" }],
      maxUses: 2,
      expiresInDays: 7,
    });
    expect(created.status).toBe(200);
    key = created.json.key;
    keyId = created.json.info.id;
    expect(key).toMatch(/^rev_enroll_/);
    expect(created.json.info).toMatchObject({
      name: "build boxes",
      uses: 0,
      maxUses: 2,
      active: true,
      projects: [
        { key: "WEB", role: "member" },
        { key: "OPS", role: "viewer" },
      ],
    });
    // The raw key is never listed again.
    const listed = (await alice.get("/api/enrollment-keys")).json as EnrollmentKeyInfo[];
    expect(JSON.stringify(listed)).not.toContain(key);
    expect((await bob.get("/api/enrollment-keys")).json).toEqual([]);
  });

  it("registers an agent linked to the key's creator, with its own token and projects", async () => {
    expect((await register("rev_enroll_not-a-real-key", "x")).status).toBe(401);
    const res = await register(key, "buildbox-1", "Claude Code on build-01");
    expect(res.status).toBe(200);
    const reg = res.json as AgentRegistration;
    expect(reg.token).toMatch(/^rev_/);
    expect(reg.agent).toMatchObject({ name: "buildbox-1", owner: { id: aliceId } });
    expect(reg.projects.map((p) => `${p.key}:${p.role}`)).toEqual(["WEB:member", "OPS:viewer"]);

    const agent = new Client(server.app, { token: reg.token });
    const me = (await agent.get("/api/auth/me")).json;
    expect(me.user).toMatchObject({ kind: "agent", ownerId: aliceId, name: "buildbox-1" });
    expect((await agent.get("/api/projects")).json.map((p: any) => `${p.key}:${p.myRole}`)).toEqual(["OPS:viewer", "WEB:member"]);
    // Still just an agent: no human-only actions.
    expect((await agent.post("/api/enrollment-keys", { name: "x" })).status).toBe(403);

    const agents = (await alice.get("/api/agents")).json as AgentInfo[];
    expect(agents.find((a) => a.name === "buildbox-1")).toMatchObject({
      enrolledVia: { id: keyId, name: "build boxes" },
      description: "Claude Code on build-01",
    });
  });

  it("enforces unique names per owner and the use limit", async () => {
    expect((await register(key, "BuildBox-1")).status).toBe(409);
    expect((await alice.post("/api/agents", { name: "buildbox-1" })).status).toBe(409);
    expect((await register(key, "buildbox-2")).status).toBe(200);
    const exhausted = await register(key, "buildbox-3");
    expect(exhausted.status).toBe(403);
    expect(exhausted.json.message).toContain("no registrations left");
    const info = ((await alice.get("/api/enrollment-keys")).json as EnrollmentKeyInfo[])[0]!;
    expect(info).toMatchObject({ uses: 2, active: false });
    expect(info.agents.map((a) => a.name).sort()).toEqual(["buildbox-1", "buildbox-2"]);
  });

  it("never exceeds maxUses under concurrent registrations", async () => {
    const single = (await alice.post("/api/enrollment-keys", { name: "single", maxUses: 1 })).json.key;
    const results = await Promise.all([register(single, "race-a"), register(single, "race-b"), register(single, "race-c")]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 403, 403]);
  });

  it("rejects expired keys and skips projects the creator can no longer add agents to", async () => {
    const bobKey = await bob.post("/api/enrollment-keys", { name: "bob web", projects: [{ key: "WEB" }], expiresInDays: null });
    expect(bobKey.json.info.expiresAt).toBeNull();
    await alice.del(`/api/projects/WEB/members/${bobId}`);
    const reg = await register(bobKey.json.key, "bob-bot");
    expect(reg.status).toBe(200);
    expect(reg.json.projects).toEqual([]);
    expect(reg.json.agent.owner.id).toBe(bobId);

    await server.ctx.db
      .update(enrollmentKeys)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(enrollmentKeys.id, bobKey.json.info.id));
    const expired = await register(bobKey.json.key, "bob-bot-2");
    expect(expired.status).toBe(403);
    expect(expired.json.message).toContain("expired");
  });

  it("revokes keys, optionally disabling every agent enrolled with them", async () => {
    const leaked = await alice.post("/api/enrollment-keys", { name: "leaked" });
    const reg = (await register(leaked.json.key, "leaky-bot")).json as AgentRegistration;
    const leakyAgent = new Client(server.app, { token: reg.token });
    expect((await leakyAgent.get("/api/tasks")).status).toBe(200);

    expect((await bob.del(`/api/enrollment-keys/${leaked.json.info.id}`)).status).toBe(403);
    const revoked = await alice.del(`/api/enrollment-keys/${leaked.json.info.id}?disableAgents=1`);
    expect(revoked.json).toMatchObject({ active: false, agents: [{ name: "leaky-bot", disabled: true }] });
    expect((await register(leaked.json.key, "after-revoke")).json.message).toContain("revoked");
    expect((await leakyAgent.get("/api/tasks")).status).toBe(401);
  });

  it("stops registrations once the key's creator is disabled", async () => {
    const k = (await bob.post("/api/enrollment-keys", { name: "bob-2" })).json.key;
    await alice.patch(`/api/users/${bobId}`, { disabled: true });
    expect((await register(k, "while-disabled")).status).toBe(403);
    await alice.patch(`/api/users/${bobId}`, { disabled: false });
    expect((await register(k, "after-enable")).status).toBe(200);
  });
});
