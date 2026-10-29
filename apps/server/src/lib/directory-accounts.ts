import { and, eq, isNotNull, isNull, ne, or, sql } from "drizzle-orm";
import type { FastifyBaseLogger } from "fastify";
import type { Db } from "../db";
import { sessions, users } from "../db/schema";
import { DirectoryUnavailableError, type Directory, type DirectoryUser } from "./directory";

type UserRow = typeof users.$inferSelect;

/**
 * Creates or refreshes the Rev account for a directory user. Accounts are keyed
 * by the directory id; an existing human account with the same email is linked
 * (its local password keeps working as a fallback). A suspension caused by the
 * directory is lifted once the directory allows the account again.
 */
export async function upsertDirectoryUser(db: Db, du: DirectoryUser): Promise<UserRow> {
  let [user] = await db.select().from(users).where(eq(users.externalId, du.id));
  if (!user && du.email) {
    [user] = await db
      .select()
      .from(users)
      .where(and(eq(users.kind, "human"), isNull(users.externalId), sql`lower(${users.email}) = ${du.email}`));
  }
  const [emailOwner] = du.email
    ? await db.select({ id: users.id }).from(users).where(and(sql`lower(${users.email}) = ${du.email}`, user ? ne(users.id, user.id) : undefined))
    : [];
  const fields = {
    name: du.name,
    username: du.username,
    authSource: "ldap" as const,
    externalId: du.id,
    ...(du.email && !emailOwner ? { email: du.email } : {}),
  };
  if (user) {
    const [updated] = await db
      .update(users)
      .set({ ...fields, ...(user.disabledReason === "directory" ? { disabledAt: null, disabledReason: null } : {}) })
      .where(eq(users.id, user.id))
      .returning();
    return updated!;
  }
  const [created] = await db
    .insert(users)
    .values({ ...fields, kind: "human", role: "member", passwordHash: null })
    .returning();
  return created!;
}

export interface SyncResult {
  checked: number;
  suspended: string[];
  restored: string[];
  skipped?: string;
}

/**
 * Re-checks every directory account. Accounts the directory no longer allows
 * (deleted, disabled, removed from the group) are suspended and signed out,
 * which also stops their agents. Nothing changes when the directory is
 * unreachable, or when every account would be suspended at once (that is far
 * more likely a configuration problem than everyone leaving).
 */
export async function syncDirectoryAccounts(db: Db, directory: Directory, log: FastifyBaseLogger): Promise<SyncResult> {
  const rows = await db
    .select()
    .from(users)
    .where(
      and(
        eq(users.authSource, "ldap"),
        isNotNull(users.externalId),
        or(isNull(users.disabledAt), eq(users.disabledReason, "directory")),
      ),
    );
  const checks: { user: UserRow; result: Awaited<ReturnType<Directory["lookup"]>> }[] = [];
  try {
    for (const user of rows) checks.push({ user, result: await directory.lookup(user.externalId!) });
  } catch (err) {
    if (err instanceof DirectoryUnavailableError) {
      log.warn({ err: err.message }, "directory sync skipped: directory unavailable");
      return { checked: 0, suspended: [], restored: [], skipped: "unavailable" };
    }
    throw err;
  }

  const active = checks.filter((c) => !c.user.disabledAt);
  const toSuspend = active.filter((c) => !c.result?.allowed);
  if (active.length >= 3 && toSuspend.length === active.length) {
    log.error({ count: active.length }, "directory sync refused to suspend every directory account; check the LDAP configuration");
    return { checked: checks.length, suspended: [], restored: [], skipped: "all-would-be-suspended" };
  }

  const result: SyncResult = { checked: checks.length, suspended: [], restored: [] };
  for (const { user, result: r } of checks) {
    if (!r?.allowed) {
      if (user.disabledAt) continue;
      await db.update(users).set({ disabledAt: new Date(), disabledReason: "directory" }).where(eq(users.id, user.id));
      await db.delete(sessions).where(eq(sessions.userId, user.id));
      result.suspended.push(user.name);
      log.info({ userId: user.id, reason: r?.reason ?? "not found in directory" }, "directory account suspended");
      continue;
    }
    const wasSuspended = user.disabledReason === "directory";
    await upsertDirectoryUser(db, r.user);
    if (wasSuspended) {
      result.restored.push(user.name);
      log.info({ userId: user.id }, "directory account restored");
    }
  }
  return result;
}
