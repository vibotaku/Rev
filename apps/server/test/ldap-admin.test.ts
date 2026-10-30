import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { LdapAccountsInfo, LdapAdminInfo, LdapSettingsBody, LdapTestReport } from "@rev/shared";
import { createApp } from "../src/app";
import { loadConfig } from "../src/config";
import type { AppContext } from "../src/context";
import { settings } from "../src/db/schema";
import { FakeDirectory, FakeWorld, fakeAccount, TEST_CA_PEM } from "./fake-directory";
import { Client } from "./helpers";

const world = new FakeWorld();
const dirs: string[] = [];
const apps: Awaited<ReturnType<typeof createApp>>["app"][] = [];

async function boot(env: Record<string, string> = {}, opts: { memoryDb?: boolean; dataDir?: string } = {}) {
  const dataDir = opts.dataDir ?? mkdtempSync(path.join(tmpdir(), "rev-ldap-admin-"));
  if (!opts.dataDir) dirs.push(dataDir);
  const { app, ctx } = await createApp(
    loadConfig({
      DATA_DIR: dataDir,
      REV_SETUP_TOKEN: "setup-secret",
      WEB_DIST: path.join(dataDir, "no-web"),
      AUTH_RATE_LIMIT_PER_MINUTE: "1000",
      ...env,
    }),
    {
      logger: false,
      memoryDb: opts.memoryDb ?? true,
      directoryFactory: (cfg) => {
        world.configs.push(cfg);
        return new FakeDirectory(world, cfg);
      },
    },
  );
  await app.ready();
  apps.push(app);
  return { app, ctx, dataDir };
}

let app: Awaited<ReturnType<typeof boot>>["app"];
let ctx: AppContext;
let admin: Client, bob: Client;

const form = (over: Partial<LdapSettingsBody> = {}): LdapSettingsBody => ({
  enabled: true,
  urls: ["ldaps://dc01.corp.example.com", "ldaps://dc02.corp.example.com"],
  baseDn: "DC=corp,DC=example,DC=com",
  bindDn: "svc-rev-bind@corp.example.com",
  bindPassword: "bind-secret",
  allowedGroup: "Rev-Users",
  domain: "",
  caPem: null,
  startTls: false,
  verifyTls: true,
  syncMinutes: 15,
  ...over,
});

const signIn = (login: string, password: string) => new Client(app).post("/api/auth/login", { login, password });

beforeAll(async () => {
  ({ app, ctx } = await boot());
  admin = new Client(app);
  bob = new Client(app);
  await admin.post("/api/setup", { token: "setup-secret", email: "root@local.test", name: "Root", password: "correct horse battery" });
  const invite = await admin.post("/api/invites", { email: "bob@local.test" });
  await bob.post(`/api/invites/${invite.json.url.split("/invite/")[1]}/accept`, { name: "Bob", password: "another long password" });
  world.accounts.push(fakeAccount(1), fakeAccount(2, { groups: [] }), fakeAccount(6));
});

afterAll(async () => {
  for (const a of apps) await a.close().catch(() => undefined);
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

describe("Admin → Active Directory", () => {
  it("starts disabled and is admin-only", async () => {
    const info = (await admin.get("/api/admin/ldap")).json as LdapAdminInfo;
    expect(info.settings).toMatchObject({ enabled: false, hasBindPassword: false, verifyTls: true, syncMinutes: 15 });
    expect(info.lastSync).toBeNull();
    expect((await bob.get("/api/admin/ldap")).status).toBe(403);
    expect((await bob.put("/api/admin/ldap", form())).status).toBe(403);
    expect((await new Client(app).get("/api/auth/config")).json.ldap.enabled).toBe(false);
  });

  it("validates settings", async () => {
    const plain = await admin.put("/api/admin/ldap", form({ urls: ["ldap://dc01.corp.example.com"] }));
    expect(plain.status).toBe(400);
    expect(plain.json.message).toContain("unencrypted");
    expect((await admin.put("/api/admin/ldap", form({ bindPassword: undefined }))).json.message).toContain("bindPassword");
    expect((await admin.put("/api/admin/ldap", form({ caPem: "not a cert" }))).json.message).toContain("caPem");
  });

  it("tests unsaved settings, including a real sign-in", async () => {
    const bad = (await admin.post("/api/admin/ldap/test", { settings: form({ bindPassword: "nope" }) })).json as LdapTestReport;
    expect(bad.ok).toBe(false);
    expect(bad.servers[0]!.checks[0]).toMatchObject({ ok: false, detail: "Bind account or password rejected" });

    const good = (await admin.post("/api/admin/ldap/test", { settings: form(), login: "user1", password: "ad-password-1" })).json;
    expect(good).toMatchObject({ ok: true, group: { dn: "CN=Rev-Users", members: 2 }, signIn: { ok: true } });
    expect(good.servers).toHaveLength(2);
    const outsider = (await admin.post("/api/admin/ldap/test", { settings: form(), login: "user2", password: "ad-password-2" })).json;
    expect(outsider.signIn).toMatchObject({ ok: false, detail: "Not a member of Rev-Users" });
  });

  it("refuses to save a failing configuration unless forced", async () => {
    const res = await admin.put("/api/admin/ldap", form({ allowedGroup: "No-Such-Group" }));
    expect(res.status).toBe(422);
    expect(res.json.details.servers[0].checks.some((c: any) => !c.ok)).toBe(true);
    expect(((await admin.get("/api/admin/ldap")).json as LdapAdminInfo).settings.enabled).toBe(false);
  });

  it("saves, encrypts the bind password, and applies immediately", async () => {
    expect((await signIn("user1", "ad-password-1")).status).toBe(401);
    const saved = await admin.put("/api/admin/ldap", form());
    expect(saved.status).toBe(200);
    const info = saved.json as LdapAdminInfo;
    expect(info.settings).toMatchObject({ enabled: true, hasBindPassword: true, domain: "corp.example.com", updatedBy: { name: "Root" } });
    expect(JSON.stringify(info)).not.toContain("bind-secret");
    const [row] = await ctx.db.select().from(settings).where(eq(settings.key, "ldap"));
    expect(JSON.stringify(row!.value)).not.toContain("bind-secret");
    expect((row!.value as any).bindPassword).toMatch(/^v1:/);

    expect((await new Client(app).get("/api/auth/config")).json.ldap).toEqual({ enabled: true, domain: "corp.example.com" });
    expect((await signIn("user1", "ad-password-1")).status).toBe(200);
  });

  it("keeps the stored password when the field is left empty", async () => {
    world.configs = [];
    const res = await admin.put("/api/admin/ldap", form({ bindPassword: undefined, syncMinutes: 5 }));
    expect(res.status).toBe(200);
    expect(world.configs.at(-1)).toMatchObject({ bindPassword: "bind-secret", syncMinutes: 5 });
  });

  it("fetches the directory's CA for review and stores a trusted CA", async () => {
    const fetched = await admin.post("/api/admin/ldap/fetch-ca", form({ bindPassword: undefined }));
    expect(fetched.json[0].info.subject).toContain("test-ca");
    expect(fetched.json[0].info.fingerprint256).toMatch(/^([0-9A-F]{2}:){31}[0-9A-F]{2}$/);
    // Fetching ignores TLS verification on purpose (that's how the CA is obtained).
    expect(world.configs.at(-1)?.rejectUnauthorized).toBe(false);

    const saved = (await admin.put("/api/admin/ldap", form({ bindPassword: undefined, caPem: fetched.json[0].pem }))).json as LdapAdminInfo;
    expect(saved.settings.caCertificates[0]!.subject).toContain("test-ca");
    expect(world.configs.at(-1)).toMatchObject({ caPem: TEST_CA_PEM.trim(), rejectUnauthorized: true });
  });

  it("syncs on demand and lists accounts, including members who never signed in", async () => {
    const sync = (await admin.post("/api/admin/ldap/sync")).json;
    expect(sync).toMatchObject({ checked: 1, suspended: [], restored: [] });
    const info = (await admin.get("/api/admin/ldap")).json as LdapAdminInfo;
    expect(info.lastSync?.at).toBeTruthy();
    expect(info.nextSyncAt).toBeTruthy();

    let accounts = (await admin.get("/api/admin/ldap/accounts")).json as LdapAccountsInfo;
    expect(accounts.groupRestricted).toBe(true);
    expect(accounts.accounts.map((a) => `${a.username}:${a.status}:${a.inGroup}`)).toEqual([
      "user1:active:true",
      "user6:never_signed_in:true",
    ]);
    expect(accounts.accounts[0]!.user?.lastLoginAt).toBeTruthy();

    world.accounts[0]!.groups = [];
    expect((await admin.post("/api/admin/ldap/sync")).json.suspended).toEqual(["User 1"]);
    accounts = (await admin.get("/api/admin/ldap/accounts")).json as LdapAccountsInfo;
    expect(accounts.accounts.find((a) => a.username === "user1")).toMatchObject({ status: "suspended", inGroup: false });
    world.accounts[0]!.groups = ["Rev-Users"];
    expect((await admin.post("/api/admin/ldap/sync")).json.restored).toEqual(["User 1"]);

    world.available = false;
    const down = (await admin.get("/api/admin/ldap/accounts")).json as LdapAccountsInfo;
    expect(down.directoryError).toBeTruthy();
    expect(down.accounts.map((a) => a.username)).toEqual(["user1"]);
    world.available = true;
  });

  it("disabling turns directory sign-in off without touching local accounts", async () => {
    await admin.put("/api/admin/ldap", form({ enabled: false, bindPassword: undefined }));
    expect((await signIn("user1", "ad-password-1")).status).toBe(401);
    expect((await signIn("root@local.test", "correct horse battery")).status).toBe(200);
    expect((await admin.post("/api/admin/ldap/sync")).status).toBe(400);
    expect(((await admin.get("/api/admin/ldap")).json as LdapAdminInfo).settings.hasBindPassword).toBe(true);
  });
});

describe("LDAP_* environment variables", () => {
  it("are imported once, then the database settings win", async () => {
    const dataDir = mkdtempSync(path.join(tmpdir(), "rev-ldap-env-"));
    dirs.push(dataDir);
    const caFile = path.join(dataDir, "ca.pem");
    writeFileSync(caFile, TEST_CA_PEM);
    const env = {
      LDAP_URL: "ldaps://dc01.corp.example.com",
      LDAP_BASE_DN: "DC=corp,DC=example,DC=com",
      LDAP_BIND_DN: "svc-rev-bind@corp.example.com",
      LDAP_BIND_PASSWORD: "bind-secret",
      LDAP_ALLOWED_GROUP: "Rev-Users",
      LDAP_CA_FILE: caFile,
    };
    const first = await boot(env, { memoryDb: false, dataDir });
    const a = new Client(first.app);
    await a.post("/api/setup", { token: "setup-secret", email: "root@local.test", name: "Root", password: "correct horse battery" });
    const imported = (await a.get("/api/admin/ldap")).json as LdapAdminInfo;
    expect(imported).toMatchObject({ envIgnored: false, settings: { enabled: true, hasBindPassword: true, allowedGroup: "Rev-Users" } });
    expect(imported.settings.caCertificates).toHaveLength(1);
    await a.put("/api/admin/ldap", form({ bindPassword: undefined, urls: ["ldaps://dc09.corp.example.com"] }));
    await first.app.close();

    const second = await boot(env, { memoryDb: false, dataDir });
    const b = new Client(second.app);
    await b.post("/api/auth/login", { login: "root@local.test", password: "correct horse battery" });
    const after = (await b.get("/api/admin/ldap")).json as LdapAdminInfo;
    expect(after.envIgnored).toBe(true);
    expect(after.settings.urls).toEqual(["ldaps://dc09.corp.example.com"]);
  });
});
