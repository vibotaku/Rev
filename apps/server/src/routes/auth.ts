import { timingSafeEqual } from "node:crypto";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { and, count, eq, gt, isNull, ne, sql } from "drizzle-orm";
import {
  changePasswordBody,
  inviteAcceptBody,
  loginBody,
  setupBody,
  updateProfileBody,
  type AuthConfigInfo,
  type Me,
} from "@rev/shared";
import type { AppContext } from "../context";
import { invites, sessions, users } from "../db/schema";
import { endSession, requireActor, requireHuman, SESSION_COOKIE, startSession } from "../lib/auth";
import { hashPassword, sha256, verifyPassword } from "../lib/crypto";
import { DirectoryUnavailableError } from "../lib/directory";
import { upsertDirectoryUser } from "../lib/directory-accounts";
import { badRequest, conflict, forbidden, HttpError, notFound, parse, unauthorized } from "../lib/errors";
import { userDetail } from "../lib/serialize";

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
  const authLimit = { rateLimit: { max: ctx.config.authRateLimit, timeWindow: "1 minute" } };
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

  app.get("/api/auth/config", async (): Promise<AuthConfigInfo> => ({
    local: true,
    ldap: { enabled: !!ctx.directory, domain: ctx.directory?.domain ?? null },
  }));

  /**
   * Local accounts sign in with email + password. With Active Directory
   * configured, anything else (username, UPN, CORP\user, or an email with no
   * local password) is checked against the directory; the Rev account is
   * created on first sign-in. Linked accounts may use either password.
   */
  app.post("/api/auth/login", { config: authLimit }, async (req, reply) => {
    const body = parse(loginBody, req.body);
    const login = body.login.toLowerCase();
    const [local] = login.includes("@")
      ? await ctx.db.select().from(users).where(and(sql`lower(${users.email}) = ${login}`, eq(users.kind, "human")))
      : [];
    const localOk = await verifyPassword(body.password, local?.passwordHash ?? DUMMY_HASH);

    let user = localOk ? local : undefined;
    if (!user && ctx.directory) {
      let result;
      try {
        result = await ctx.directory.authenticate(body.login, body.password);
      } catch (err) {
        if (err instanceof DirectoryUnavailableError) {
          req.log.warn({ err: err.message }, "directory sign-in failed");
          throw new HttpError(503, "directory_unavailable", "Active Directory is unreachable right now. Try again shortly, or use a local account.");
        }
        throw err;
      }
      if (result && !result.allowed) {
        throw forbidden(`Your directory account can't sign in to Rev: ${result.reason ?? "not allowed"}. Ask an administrator for access.`);
      }
      if (result) user = await upsertDirectoryUser(ctx.db, result.user);
    }
    if (!user) throw unauthorized(ctx.directory ? "Incorrect username or password" : "Incorrect email or password");
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
    const [current] = await ctx.db.select({ authSource: users.authSource }).from(users).where(eq(users.id, actor.id));
    if (current?.authSource === "ldap") throw badRequest("Your name comes from Active Directory");
    await ctx.db.update(users).set({ name: body.name }).where(eq(users.id, actor.id));
    return meOf(ctx, req);
  });

  app.post("/api/auth/password", { config: authLimit }, async (req) => {
    const actor = requireHuman(req, "change passwords");
    const body = parse(changePasswordBody, req.body);
    const [user] = await ctx.db.select().from(users).where(eq(users.id, actor.id));
    if (!user!.passwordHash) throw badRequest("Your password is managed by Active Directory");
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
