import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { and, eq, gt, isNull } from "drizzle-orm";
import type { GlobalRole, UserKind } from "@rev/shared";
import type { AppContext } from "../context";
import { apiTokens, sessions, users } from "../db/schema";
import { randomToken, sha256 } from "./crypto";
import { forbidden, unauthorized } from "./errors";

export interface Actor {
  id: string;
  name: string;
  email: string | null;
  kind: UserKind;
  role: GlobalRole;
  ownerId: string | null;
}

declare module "fastify" {
  interface FastifyRequest {
    actor: Actor | null;
    authVia: "session" | "token" | null;
  }
}

export const SESSION_COOKIE = "rev_session";
const TOUCH_INTERVAL_MS = 60 * 60 * 1000;
const UNSAFE = new Set(["POST", "PUT", "PATCH", "DELETE"]);

type UserRow = typeof users.$inferSelect;

function toActor(u: UserRow): Actor {
  return { id: u.id, name: u.name, email: u.email, kind: u.kind, role: u.role, ownerId: u.ownerId };
}

/** Agents stop working as soon as the human they are linked to is disabled. */
async function isActive(ctx: AppContext, u: UserRow) {
  if (u.disabledAt) return false;
  if (u.kind === "agent") {
    if (!u.ownerId) return false;
    const [owner] = await ctx.db.select({ disabledAt: users.disabledAt }).from(users).where(eq(users.id, u.ownerId));
    return !!owner && !owner.disabledAt;
  }
  return true;
}

function cookieOptions(ctx: AppContext) {
  return {
    httpOnly: true,
    sameSite: "lax" as const,
    secure: ctx.config.cookieSecure,
    path: "/",
    maxAge: ctx.config.sessionTtlDays * 24 * 60 * 60,
  };
}

export async function startSession(ctx: AppContext, req: FastifyRequest, reply: FastifyReply, userId: string) {
  const token = randomToken(32);
  await ctx.db.insert(sessions).values({
    id: sha256(token),
    userId,
    userAgent: req.headers["user-agent"]?.slice(0, 300) ?? null,
    expiresAt: new Date(Date.now() + ctx.config.sessionTtlDays * 86_400_000),
  });
  reply.setCookie(SESSION_COOKIE, token, cookieOptions(ctx));
}

export async function endSession(ctx: AppContext, req: FastifyRequest, reply: FastifyReply) {
  const token = req.cookies[SESSION_COOKIE];
  if (token) await ctx.db.delete(sessions).where(eq(sessions.id, sha256(token)));
  reply.clearCookie(SESSION_COOKIE, { path: "/" });
}

/**
 * Browser requests carry the session cookie automatically, so state-changing
 * requests must come from our own origin (SameSite=Lax covers most cases; this
 * closes the rest). Bearer-token requests are not cookie-based and skip this.
 */
function assertSameOrigin(ctx: AppContext, req: FastifyRequest) {
  const origin = req.headers.origin;
  if (origin) {
    let originHost: string;
    try {
      originHost = new URL(origin).host;
    } catch {
      throw forbidden("Bad request origin");
    }
    // Normalise through URL so default ports (":80"/":443") compare equal.
    const allowed = new Set([new URL(`${req.protocol}://${req.host}`).host]);
    if (ctx.config.publicUrl) allowed.add(new URL(ctx.config.publicUrl).host);
    if (!allowed.has(originHost)) throw forbidden("Cross-origin request rejected");
    return;
  }
  if (req.headers["sec-fetch-site"] === "cross-site") throw forbidden("Cross-site request rejected");
}

export function registerAuth(app: FastifyInstance, ctx: AppContext) {
  app.decorateRequest("actor", null);
  app.decorateRequest("authVia", null);

  app.addHook("onRequest", async (req, reply) => {
    if (!req.url.startsWith("/api/")) return;
    const header = req.headers.authorization;

    if (header?.toLowerCase().startsWith("bearer ")) {
      const token = header.slice(7).trim();
      const [row] = await ctx.db
        .select({ token: apiTokens, user: users })
        .from(apiTokens)
        .innerJoin(users, eq(users.id, apiTokens.userId))
        .where(and(eq(apiTokens.tokenHash, sha256(token)), isNull(apiTokens.revokedAt)))
        .limit(1);
      if (!row || !(await isActive(ctx, row.user))) throw unauthorized("Invalid or revoked API token");
      const last = row.token.lastUsedAt?.getTime() ?? 0;
      if (Date.now() - last > 60_000) {
        await ctx.db.update(apiTokens).set({ lastUsedAt: new Date() }).where(eq(apiTokens.id, row.token.id));
      }
      req.actor = toActor(row.user);
      req.authVia = "token";
      return;
    }

    if (UNSAFE.has(req.method)) assertSameOrigin(ctx, req);

    const cookie = req.cookies[SESSION_COOKIE];
    if (!cookie) return;
    const [row] = await ctx.db
      .select({ session: sessions, user: users })
      .from(sessions)
      .innerJoin(users, eq(users.id, sessions.userId))
      .where(and(eq(sessions.id, sha256(cookie)), gt(sessions.expiresAt, new Date())))
      .limit(1);
    if (!row || row.user.kind !== "human" || !(await isActive(ctx, row.user))) {
      reply.clearCookie(SESSION_COOKIE, { path: "/" });
      return;
    }
    // Sliding expiry, written at most once an hour.
    if (Date.now() - row.session.lastSeenAt.getTime() > TOUCH_INTERVAL_MS) {
      await ctx.db
        .update(sessions)
        .set({ lastSeenAt: new Date(), expiresAt: new Date(Date.now() + ctx.config.sessionTtlDays * 86_400_000) })
        .where(eq(sessions.id, row.session.id));
      reply.setCookie(SESSION_COOKIE, cookie, cookieOptions(ctx));
    }
    req.actor = toActor(row.user);
    req.authVia = "session";
  });
}

export function requireActor(req: FastifyRequest): Actor {
  if (!req.actor) throw unauthorized();
  return req.actor;
}

export function requireHuman(req: FastifyRequest, action = "do that"): Actor {
  const actor = requireActor(req);
  if (actor.kind !== "human") throw forbidden(`Agents cannot ${action}`);
  return actor;
}

export function requireAdmin(req: FastifyRequest): Actor {
  const actor = requireHuman(req);
  if (actor.role !== "admin") throw forbidden("Admin only");
  return actor;
}
