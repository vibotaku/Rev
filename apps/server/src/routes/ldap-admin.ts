// Admin → Active Directory: settings, connection tests, CA fetch, sync and accounts.
import type { FastifyInstance } from "fastify";
import { eq } from "drizzle-orm";
import {
  ldapSettingsBody,
  ldapTestBody,
  type LdapAccountInfo,
  type LdapAccountsInfo,
  type LdapTestReport,
} from "@rev/shared";
import type { AppContext } from "../context";
import { users } from "../db/schema";
import { requireAdmin } from "../lib/auth";
import { DirectoryUnavailableError, explainLdapError } from "../lib/directory";
import { HttpError, parse } from "../lib/errors";
import { userDetail } from "../lib/serialize";

export default async function ldapAdminRoutes(app: FastifyInstance, ctx: AppContext) {
  const svc = ctx.directories;

  app.get("/api/admin/ldap", async (req) => {
    requireAdmin(req);
    return svc.info();
  });

  /** Saves settings and applies them immediately. Enabling runs a connection test first unless `force` is set. */
  app.put("/api/admin/ldap", async (req) => {
    const admin = requireAdmin(req);
    const body = parse(ldapSettingsBody, req.body);
    if (body.enabled && !body.force) {
      const report = await svc.build(svc.draftConfig(body)).diagnose();
      if (!report.ok) {
        throw new HttpError(422, "test_failed", "The connection test failed, so the settings were not saved. Fix them or save anyway.", report);
      }
    }
    await svc.save(body, admin.id);
    req.log.info({ by: admin.id, enabled: body.enabled }, "Active Directory settings updated");
    return svc.info();
  });

  /** Tests unsaved settings, optionally including a real sign-in. */
  app.post("/api/admin/ldap/test", async (req): Promise<LdapTestReport> => {
    requireAdmin(req);
    const body = parse(ldapTestBody, req.body);
    const directory = svc.build(svc.draftConfig(body.settings));
    const report = await directory.diagnose();
    if (body.login && body.password) {
      try {
        const r = await directory.authenticate(body.login, body.password);
        report.signIn = !r
          ? { ok: false, allowed: false, detail: "Unknown account or wrong password" }
          : { ok: r.allowed, allowed: r.allowed, detail: r.allowed ? `Would sign in as ${r.user.name} (${r.user.username})` : (r.reason ?? "Not allowed") };
      } catch (err) {
        report.signIn = { ok: false, allowed: false, detail: explainLdapError(err) };
      }
    }
    return report;
  });

  /** Reads the CA certificates the directory publishes, so admins can trust them after checking the fingerprint. */
  app.post("/api/admin/ldap/fetch-ca", async (req) => {
    requireAdmin(req);
    const body = parse(ldapSettingsBody, req.body);
    try {
      return await svc.build({ ...svc.draftConfig({ ...body, caPem: null }), rejectUnauthorized: false }).fetchCa();
    } catch (err) {
      throw new HttpError(502, "directory_error", (err as Error).message);
    }
  });

  app.post("/api/admin/ldap/sync", async (req) => {
    requireAdmin(req);
    return svc.sync();
  });

  /** Rev's directory accounts plus group members who have not signed in yet. */
  app.get("/api/admin/ldap/accounts", async (req): Promise<LdapAccountsInfo> => {
    requireAdmin(req);
    const rows = await ctx.db.select().from(users).where(eq(users.authSource, "ldap"));
    const byExternal = new Map(rows.map((u) => [u.externalId, u]));
    let members: Awaited<ReturnType<NonNullable<typeof ctx.directory>["members"]>> = null;
    let directoryError: string | null = null;
    if (ctx.directory) {
      try {
        members = await ctx.directory.members();
      } catch (err) {
        directoryError = err instanceof DirectoryUnavailableError ? err.message : explainLdapError(err);
      }
    }
    const memberIds = new Set((members ?? []).map((m) => m.id));
    const accounts: LdapAccountInfo[] = rows.map((u) => ({
      user: userDetail(u),
      username: u.username ?? "",
      name: u.name,
      email: u.email,
      status: !u.disabledAt ? "active" : u.disabledReason === "directory" ? "suspended" : "disabled",
      inGroup: members ? memberIds.has(u.externalId ?? "") : null,
    }));
    for (const m of members ?? []) {
      if (byExternal.has(m.id)) continue;
      accounts.push({ user: null, username: m.username, name: m.name, email: m.email, status: "never_signed_in", inGroup: true });
    }
    accounts.sort((a, b) => a.name.localeCompare(b.name));
    return { accounts, directoryError, groupRestricted: members !== null };
  });
}
