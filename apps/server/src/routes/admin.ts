import type { FastifyInstance, FastifyRequest } from "fastify";
import { and, desc, eq, gt, isNull } from "drizzle-orm";
import { inviteCreateBody, userUpdateBody, type InviteInfo } from "@rev/shared";
import type { AppContext } from "../context";
import { invites, sessions, users } from "../db/schema";
import { requireAdmin, requireHuman } from "../lib/auth";
import { randomToken, sha256 } from "../lib/crypto";
import { badRequest, conflict, notFound, parse } from "../lib/errors";
import { userDetail } from "../lib/serialize";

const INVITE_TTL_MS = 7 * 86_400_000;

export function baseUrl(ctx: AppContext, req: FastifyRequest) {
  return ctx.config.publicUrl || `${req.protocol}://${req.host}`;
}

function inviteInfo(row: typeof invites.$inferSelect, url?: string): InviteInfo {
  return {
    id: row.id,
    kind: row.kind,
    email: row.email,
    role: row.role,
    createdAt: row.createdAt.toISOString(),
    expiresAt: row.expiresAt.toISOString(),
    usedAt: row.usedAt?.toISOString() ?? null,
    url,
  };
}

export default async function adminRoutes(app: FastifyInstance, ctx: AppContext) {
  // Directory used by member pickers; visible to every human.
  app.get("/api/users", async (req) => {
    requireHuman(req, "list users");
    const rows = await ctx.db.select().from(users).orderBy(users.kind, users.name);
    return rows.map(userDetail);
  });

  app.patch<{ Params: { id: string } }>("/api/users/:id", async (req) => {
    const admin = requireAdmin(req);
    const body = parse(userUpdateBody, req.body);
    const [user] = await ctx.db.select().from(users).where(eq(users.id, req.params.id));
    if (!user || user.kind !== "human") throw notFound("User");
    if (user.id === admin.id && (body.disabled || body.role === "member")) {
      throw badRequest("You cannot demote or disable your own account");
    }
    const [updated] = await ctx.db
      .update(users)
      .set({
        ...(body.role ? { role: body.role } : {}),
        ...(body.disabled !== undefined ? { disabledAt: body.disabled ? new Date() : null } : {}),
      })
      .where(eq(users.id, user.id))
      .returning();
    if (body.disabled) await ctx.db.delete(sessions).where(eq(sessions.userId, user.id));
    return userDetail(updated!);
  });

  app.post<{ Params: { id: string } }>("/api/users/:id/reset-link", async (req) => {
    const admin = requireAdmin(req);
    const [user] = await ctx.db.select().from(users).where(eq(users.id, req.params.id));
    if (!user || user.kind !== "human" || !user.email) throw notFound("User");
    const token = randomToken(24);
    const [row] = await ctx.db
      .insert(invites)
      .values({
        kind: "reset",
        email: user.email,
        role: user.role,
        userId: user.id,
        tokenHash: sha256(token),
        createdBy: admin.id,
        expiresAt: new Date(Date.now() + INVITE_TTL_MS),
      })
      .returning();
    return inviteInfo(row!, `${baseUrl(ctx, req)}/invite/${token}`);
  });

  app.get("/api/invites", async (req) => {
    requireAdmin(req);
    const rows = await ctx.db
      .select()
      .from(invites)
      .where(and(eq(invites.kind, "invite"), isNull(invites.usedAt), gt(invites.expiresAt, new Date())))
      .orderBy(desc(invites.createdAt));
    return rows.map((r) => inviteInfo(r));
  });

  app.post("/api/invites", async (req) => {
    const admin = requireAdmin(req);
    const body = parse(inviteCreateBody, req.body);
    const [existing] = await ctx.db.select({ id: users.id }).from(users).where(eq(users.email, body.email));
    if (existing) throw conflict("A user with this email already exists");
    const token = randomToken(24);
    const [row] = await ctx.db
      .insert(invites)
      .values({
        kind: "invite",
        email: body.email,
        role: body.role,
        tokenHash: sha256(token),
        createdBy: admin.id,
        expiresAt: new Date(Date.now() + INVITE_TTL_MS),
      })
      .returning();
    return inviteInfo(row!, `${baseUrl(ctx, req)}/invite/${token}`);
  });

  app.delete<{ Params: { id: string } }>("/api/invites/:id", async (req) => {
    requireAdmin(req);
    await ctx.db.delete(invites).where(eq(invites.id, req.params.id));
    return { ok: true };
  });
}
