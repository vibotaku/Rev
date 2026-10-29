import { timingSafeEqual } from "node:crypto";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { and, count, eq, gt, isNull, ne } from "drizzle-orm";
import {
  changePasswordBody,
  inviteAcceptBody,
  loginBody,
  setupBody,
  updateProfileBody,
  type Me,
} from "@rev/shared";
import type { AppContext } from "../context";
import { invites, sessions, users } from "../db/schema";
import { endSession, requireActor, requireHuman, SESSION_COOKIE, startSession } from "../lib/auth";
import { hashPassword, sha256, verifyPassword } from "../lib/crypto";
import { badRequest, conflict, forbidden, notFound, parse, unauthorized } from "../lib/errors";
import { userDetail } from "../lib/serialize";

const authLimit = { rateLimit: { max: 10, timeWindow: "1 minute" } };
// Hash used to keep login timing similar when the email is unknown.
const DUMMY_HASH = "scrypt$32768$8$1$AAAAAAAAAAAAAAAAAAAAAA==$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";

function safeEqual(a: string, b: string) {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

export async function meOf(ctx: AppContext, req: FastifyRequest): Promise<Me> {
  const actor = requireActor(req);
  const [user] = await ctx.db.select().from(users).where(eq(users.id, actor.id));
  return { user: userDetail(user!), viaToken: req.authVia === "token" };
}

async function findInvite(ctx: AppContext, token: string) {
  const [invite] = await ctx.db
    .select()
    .from(invites)
    .where(and(eq(invites.tokenHash, sha256(token)), isNull(invites.usedAt), gt(invites.expiresAt, new Date())));
  return invite;
}

export default async function authRoutes(app: FastifyInstance, ctx: AppContext) {
  app.get("/api/setup/status", async () => ({ needsSetup: ctx.setup.token !== null }));

  app.post("/api/setup", { config: authLimit }, async (req, reply) => {
    const body = parse(setupBody, req.body);
    if (!ctx.setup.token) throw conflict("Rev is already set up");
    if (!safeEqual(body.token.trim(), ctx.setup.token)) throw forbidden("Invalid setup token (see the server log)");
    const [{ n }] = (await ctx.db.select({ n: count() }).from(users)) as [{ n: number }];
    if (Number(n) > 0) {
      ctx.setup.token = null;
      throw conflict("Rev is already set up");
    }
    const [user] = await ctx.db
      .insert(users)
      .values({
        email: body.email,
        name: body.name,
        kind: "human",
        role: "admin",
        passwordHash: await hashPassword(body.password),
      })
      .returning();
    ctx.setup.token = null;
    await startSession(ctx, req, reply, user!.id);
    return { user: userDetail(user!), viaToken: false } satisfies Me;
  });

  app.post("/api/auth/login", { config: authLimit }, async (req, reply) => {
    const body = parse(loginBody, req.body);
    const [user] = await ctx.db
      .select()
      .from(users)
      .where(and(eq(users.email, body.email), eq(users.kind, "human")));
    const ok = await verifyPassword(body.password, user?.passwordHash ?? DUMMY_HASH);
    if (!user || !ok) throw unauthorized("Incorrect email or password");
    if (user.disabledAt) throw forbidden("This account is disabled");
    await startSession(ctx, req, reply, user.id);
    return { user: userDetail(user), viaToken: false } satisfies Me;
  });

  app.post("/api/auth/logout", async (req, reply) => {
    await endSession(ctx, req, reply);
    return { ok: true };
  });

  app.get("/api/auth/me", async (req) => meOf(ctx, req));

  app.patch("/api/auth/me", async (req) => {
    const actor = requireHuman(req, "edit profiles");
    const body = parse(updateProfileBody, req.body);
    await ctx.db.update(users).set({ name: body.name }).where(eq(users.id, actor.id));
    return meOf(ctx, req);
  });

  app.post("/api/auth/password", { config: authLimit }, async (req) => {
    const actor = requireHuman(req, "change passwords");
    const body = parse(changePasswordBody, req.body);
    const [user] = await ctx.db.select().from(users).where(eq(users.id, actor.id));
    if (!(await verifyPassword(body.current, user!.passwordHash))) throw badRequest("Current password is incorrect");
    await ctx.db.update(users).set({ passwordHash: await hashPassword(body.next) }).where(eq(users.id, actor.id));
    // Sign out every other browser session.
    const current = req.cookies[SESSION_COOKIE];
    await ctx.db
      .delete(sessions)
      .where(and(eq(sessions.userId, actor.id), current ? ne(sessions.id, sha256(current)) : undefined));
    return { ok: true };
  });

  app.get<{ Params: { token: string } }>("/api/invites/:token", async (req) => {
    const invite = await findInvite(ctx, req.params.token);
    if (!invite) throw notFound("Invitation");
    return { kind: invite.kind, email: invite.email };
  });

  app.post<{ Params: { token: string } }>("/api/invites/:token/accept", { config: authLimit }, async (req, reply) => {
    const body = parse(inviteAcceptBody, req.body);
    const invite = await findInvite(ctx, req.params.token);
    if (!invite) throw notFound("Invitation");
    const passwordHash = await hashPassword(body.password);

    const userId = await ctx.db.transaction(async (tx) => {
      const [claimed] = await tx
        .update(invites)
        .set({ usedAt: new Date() })
        .where(and(eq(invites.id, invite.id), isNull(invites.usedAt)))
        .returning();
      if (!claimed) throw notFound("Invitation");

      if (invite.kind === "reset") {
        if (!invite.userId) throw notFound("Invitation");
        await tx.update(users).set({ passwordHash }).where(eq(users.id, invite.userId));
        await tx.delete(sessions).where(eq(sessions.userId, invite.userId));
        return invite.userId;
      }
      if (!body.name) throw badRequest("name: Name is required");
      const [existing] = await tx.select({ id: users.id }).from(users).where(eq(users.email, invite.email));
      if (existing) throw conflict("An account with this email already exists");
      const [user] = await tx
        .insert(users)
        .values({ email: invite.email, name: body.name, kind: "human", role: invite.role, passwordHash })
        .returning();
      return user!.id;
    });

    await startSession(ctx, req, reply, userId);
    const [user] = await ctx.db.select().from(users).where(eq(users.id, userId));
    return { user: userDetail(user!), viaToken: false } satisfies Me;
  });
}
