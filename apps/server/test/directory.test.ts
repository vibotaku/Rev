import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../src/app";
import { loadConfig } from "../src/config";
import type { AppContext } from "../src/context";
import { DirectoryUnavailableError, escapeFilter, type Directory, type DirectoryResult } from "../src/lib/directory";
import { syncDirectoryAccounts } from "../src/lib/directory-accounts";
import { Client } from "./helpers";

interface FakeAccount {
  logins: string[];
  password: string;
  id: string;
  username: string;
  email: string | null;
  name: string;
  enabled: boolean;
  inGroup: boolean;
}

/** In-memory stand-in for Active Directory. */
class FakeDirectory implements Directory {
  readonly domain = "corp.example.com";
  available = true;
  accounts: FakeAccount[] = [];

  private result(a: FakeAccount): DirectoryResult {
    const user = { id: a.id, dn: `CN=${a.name},DC=corp`, username: a.username, email: a.email, name: a.name };
    if (!a.enabled) return { user, allowed: false, reason: "The directory account is disabled" };
    if (!a.inGroup) return { user, allowed: false, reason: "Not a member of Rev-Users" };
    return { user, allowed: true };
  }

  async authenticate(login: string, password: string) {
    if (!this.available) throw new DirectoryUnavailableError("down");
    const a = this.accounts.find((x) => x.logins.includes(login.toLowerCase()));
    if (!a || a.password !== password) return null;
    return this.result(a);
  }

  async lookup(id: string) {
    if (!this.available) throw new DirectoryUnavailableError("down");
    const a = this.accounts.find((x) => x.id === id);
    return a ? this.result(a) : null;
  }
}

const account = (n: number, over: Partial<FakeAccount> = {}): FakeAccount => ({
  logins: [`user${n}`, `user${n}@corp.example.com`],
  password: `ad-password-${n}`,
  id: `${n}`.padStart(32, "a"),
  username: `user${n}`,
  email: `user${n}@corp.example.com`,
  name: `User ${n}`,
  enabled: true,
  inGroup: true,
  ...over,
});

let ctx: AppContext;
let app: Awaited<ReturnType<typeof createApp>>["app"];
let dir: FakeDirectory;
let admin: Client;
let dataDir: string;

beforeAll(async () => {
  dataDir = mkdtempSync(path.join(tmpdir(), "rev-dir-test-"));
  dir = new FakeDirectory();
  const created = await createApp(
    loadConfig({
      DATA_DIR: dataDir,
      REV_SETUP_TOKEN: "setup-secret",
      WEB_DIST: path.join(dataDir, "no-web"),
      AUTH_RATE_LIMIT_PER_MINUTE: "1000",
    }),
    { logger: false, memoryDb: true, directory: dir },
  );
  app = created.app;
  ctx = created.ctx;
  await app.ready();
  admin = new Client(app);
  await admin.post("/api/setup", { token: "setup-secret", email: "root@local.test", name: "Root", password: "correct horse battery" });
});

afterAll(async () => {
  await app?.close();
  rmSync(dataDir, { recursive: true, force: true });
});

const signIn = async (login: string, password: string) => {
  const c = new Client(app);
  const res = await c.post("/api/auth/login", { login, password });
  return { c, res };
};

describe("Active Directory sign-in", () => {
  it("advertises directory sign-in", async () => {
    expect((await new Client(app).get("/api/auth/config")).json).toEqual({
      local: true,
      ldap: { enabled: true, domain: "corp.example.com" },
    });
  });

  it("creates the Rev account on first sign-in and keeps it in step with AD", async () => {
    dir.accounts.push(account(1));
    const first = await signIn("user1", "ad-password-1");
    expect(first.res.status).toBe(200);
    expect(first.res.json.user).toMatchObject({
      name: "User 1",
      email: "user1@corp.example.com",
      authSource: "ldap",
      username: "user1",
      role: "member",
    });
    expect((await first.c.get("/api/auth/me")).status).toBe(200);

    dir.accounts[0]!.name = "User One";
    const again = await signIn("USER1@corp.example.com", "ad-password-1");
    expect(again.res.json.user).toMatchObject({ id: first.res.json.user.id, name: "User One" });
    const all = (await admin.get("/api/users")).json as { authSource: string }[];
    expect(all.filter((u) => u.authSource === "ldap")).toHaveLength(1);
  });

  it("distinguishes bad passwords, disallowed accounts and outages", async () => {
    dir.accounts.push(account(2, { inGroup: false }), account(3, { enabled: false }));
    expect((await signIn("user1", "wrong")).res.status).toBe(401);
    expect((await signIn("nobody", "x")).res.json.message).toBe("Incorrect username or password");
    const notInGroup = await signIn("user2", "ad-password-2");
    expect(notInGroup.res.status).toBe(403);
    expect(notInGroup.res.json.message).toContain("Not a member of Rev-Users");
    expect((await signIn("user3", "ad-password-3")).res.json.message).toContain("disabled");

    dir.available = false;
    const down = await signIn("user1", "ad-password-1");
    expect(down.res.status).toBe(503);
    expect(down.res.json.error).toBe("directory_unavailable");
    // Local break-glass accounts keep working while the directory is down.
    expect((await signIn("root@local.test", "correct horse battery")).res.status).toBe(200);
    dir.available = true;
  });

  it("links an existing local account by email; both passwords then work", async () => {
    const invite = await admin.post("/api/invites", { email: "user4@corp.example.com" });
    await new Client(app).post(`/api/invites/${invite.json.url.split("/invite/")[1]}/accept`, {
      name: "Local Four",
      password: "local password 4",
    });
    dir.accounts.push(account(4));
    const ad = await signIn("user4", "ad-password-4");
    expect(ad.res.json.user).toMatchObject({ name: "User 4", authSource: "ldap", email: "user4@corp.example.com" });
    const local = await signIn("user4@corp.example.com", "local password 4");
    expect(local.res.json.user.id).toBe(ad.res.json.user.id);
  });

  it("leaves names and passwords of directory accounts to AD", async () => {
    const { c, res } = await signIn("user1", "ad-password-1");
    expect((await c.patch("/api/auth/me", { name: "Renamed" })).json.message).toContain("Active Directory");
    expect((await c.post("/api/auth/password", { current: "x", next: "a new long password" })).json.message).toContain(
      "managed by Active Directory",
    );
    expect((await admin.post(`/api/users/${res.json.user.id}/reset-link`)).status).toBe(400);
  });

  it("suspends accounts AD no longer allows, cuts off their agents, and restores them", async () => {
    const { c, res } = await signIn("user1", "ad-password-1");
    const userId = res.json.user.id;
    const agent = (await c.post("/api/agents", { name: "user1-bot" })).json;
    const agentClient = new Client(app, { token: (await c.post(`/api/agents/${agent.id}/tokens`, { name: "t" })).json.token });
    expect((await agentClient.get("/api/tasks")).status).toBe(200);

    dir.accounts[0]!.inGroup = false;
    const r1 = await syncDirectoryAccounts(ctx.db, dir, app.log);
    expect(r1.suspended).toContain("User One");
    expect((await c.get("/api/auth/me")).status).toBe(401);
    expect((await agentClient.get("/api/tasks")).status).toBe(401);
    const suspended = ((await admin.get("/api/users")).json as any[]).find((u) => u.id === userId);
    expect(suspended).toMatchObject({ disabled: true, disabledReason: "directory" });

    dir.accounts[0]!.inGroup = true;
    const r2 = await syncDirectoryAccounts(ctx.db, dir, app.log);
    expect(r2.restored).toContain("User One");
    expect((await agentClient.get("/api/tasks")).status).toBe(200);

    // A Rev admin's own "disable" wins over the directory.
    await admin.patch(`/api/users/${userId}`, { disabled: true });
    await syncDirectoryAccounts(ctx.db, dir, app.log);
    expect((await signIn("user1", "ad-password-1")).res.status).toBe(403);
    await admin.patch(`/api/users/${userId}`, { disabled: false });
  });

  it("never suspends anyone during an outage or when every account would be suspended", async () => {
    dir.available = false;
    expect((await syncDirectoryAccounts(ctx.db, dir, app.log)).skipped).toBe("unavailable");
    dir.available = true;
    dir.accounts.push(account(5));
    expect((await signIn("user5", "ad-password-5")).res.status).toBe(200);

    const saved = dir.accounts;
    dir.accounts = []; // e.g. a wrong base DN: every lookup comes back empty
    const r = await syncDirectoryAccounts(ctx.db, dir, app.log);
    expect(r.skipped).toBe("all-would-be-suspended");
    dir.accounts = saved;
    expect((await signIn("user1", "ad-password-1")).res.status).toBe(200);
  });
});

it("escapes LDAP filter values (RFC 4515)", () => {
  expect(escapeFilter("a*b(c)d\\e\0")).toBe("a\\2ab\\28c\\29d\\5ce\\00");
  expect(escapeFilter("jdoe")).toBe("jdoe");
});
