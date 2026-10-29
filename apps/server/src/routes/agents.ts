import type { FastifyInstance } from "fastify";
import { and, desc, eq, inArray } from "drizzle-orm";
import { agentCreateBody, agentUpdateBody, tokenCreateBody, type AgentInfo, type ApiTokenInfo } from "@rev/shared";
import type { AppContext } from "../context";
import { apiTokens, enrollmentKeys, projectMembers, projects, users } from "../db/schema";
import { requireHuman, type Actor } from "../lib/auth";
import { newApiToken } from "../lib/crypto";
import { forbidden, notFound, parse } from "../lib/errors";
import { loadUsers } from "../lib/serialize";
import { assertAgentNameFree } from "./enrollment";

function tokenInfo(t: typeof apiTokens.$inferSelect): ApiTokenInfo {
  return {
    id: t.id,
    name: t.name,
    prefix: t.prefix,
    createdAt: t.createdAt.toISOString(),
    lastUsedAt: t.lastUsedAt?.toISOString() ?? null,
    revokedAt: t.revokedAt?.toISOString() ?? null,
  };
}

export default async function agentRoutes(app: FastifyInstance, ctx: AppContext) {
  async function loadAgent(actor: Actor, id: string) {
    const [agent] = await ctx.db.select().from(users).where(and(eq(users.id, id), eq(users.kind, "agent")));
    if (!agent) throw notFound("Agent");
    if (agent.ownerId !== actor.id && actor.role !== "admin") throw forbidden("Only the agent's linked human can manage it");
    return agent;
  }

  async function describe(rows: (typeof users.$inferSelect)[]): Promise<AgentInfo[]> {
    if (!rows.length) return [];
    const ids = rows.map((a) => a.id);
    const keyIds = [...new Set(rows.map((a) => a.enrolledVia).filter((k): k is string => !!k))];
    const [owners, tokens, memberships, keys] = await Promise.all([
      loadUsers(ctx.db, rows.map((a) => a.ownerId)),
      ctx.db.select().from(apiTokens).where(inArray(apiTokens.userId, ids)).orderBy(desc(apiTokens.createdAt)),
      ctx.db
        .select({ userId: projectMembers.userId, role: projectMembers.role, key: projects.key, name: projects.name })
        .from(projectMembers)
        .innerJoin(projects, eq(projects.id, projectMembers.projectId))
        .where(inArray(projectMembers.userId, ids)),
      keyIds.length
        ? ctx.db.select({ id: enrollmentKeys.id, name: enrollmentKeys.name }).from(enrollmentKeys).where(inArray(enrollmentKeys.id, keyIds))
        : Promise.resolve([]),
    ]);
    const keyBy = new Map(keys.map((k) => [k.id, k]));
    return rows.map((a) => ({
      id: a.id,
      name: a.name,
      description: a.description,
      disabled: !!a.disabledAt,
      owner: owners.get(a.ownerId!)!,
      enrolledVia: a.enrolledVia ? (keyBy.get(a.enrolledVia) ?? null) : null,
      createdAt: a.createdAt.toISOString(),
      tokens: tokens.filter((t) => t.userId === a.id && !t.revokedAt).map(tokenInfo),
      projects: memberships.filter((m) => m.userId === a.id).map(({ key, name, role }) => ({ key, name, role })),
    }));
  }

  app.get<{ Querystring: { all?: string } }>("/api/agents", async (req) => {
    const actor = requireHuman(req, "manage agents");
    const all = req.query.all === "1" && actor.role === "admin";
    const rows = await ctx.db
      .select()
      .from(users)
      .where(all ? eq(users.kind, "agent") : and(eq(users.kind, "agent"), eq(users.ownerId, actor.id)))
      .orderBy(users.name);
    return describe(rows);
  });

  app.post("/api/agents", async (req) => {
    const actor = requireHuman(req, "create agents");
    const body = parse(agentCreateBody, req.body);
    await assertAgentNameFree(ctx.db, actor.id, body.name);
    const [agent] = await ctx.db
      .insert(users)
      .values({ name: body.name, description: body.description, kind: "agent", role: "member", ownerId: actor.id })
      .returning();
    return (await describe([agent!]))[0];
  });

  app.patch<{ Params: { id: string } }>("/api/agents/:id", async (req) => {
    const actor = requireHuman(req, "manage agents");
    const agent = await loadAgent(actor, req.params.id);
    const body = parse(agentUpdateBody, req.body);
    if (body.name && body.name.toLowerCase() !== agent.name.toLowerCase()) await assertAgentNameFree(ctx.db, agent.ownerId!, body.name);
    const [updated] = await ctx.db
      .update(users)
      .set({
        ...(body.name ? { name: body.name } : {}),
        ...(body.description !== undefined ? { description: body.description } : {}),
        ...(body.disabled !== undefined ? { disabledAt: body.disabled ? new Date() : null } : {}),
      })
      .where(eq(users.id, agent.id))
      .returning();
    return (await describe([updated!]))[0];
  });

  app.post<{ Params: { id: string } }>("/api/agents/:id/tokens", async (req) => {
    const actor = requireHuman(req, "create tokens");
    const agent = await loadAgent(actor, req.params.id);
    const body = parse(tokenCreateBody, req.body);
    const { token, hash, prefix } = newApiToken();
    const [row] = await ctx.db
      .insert(apiTokens)
      .values({ userId: agent.id, name: body.name, tokenHash: hash, prefix, createdBy: actor.id })
      .returning();
    // The raw token is only ever returned here.
    return { token, info: tokenInfo(row!) };
  });

  app.delete<{ Params: { id: string; tokenId: string } }>("/api/agents/:id/tokens/:tokenId", async (req) => {
    const actor = requireHuman(req, "revoke tokens");
    const agent = await loadAgent(actor, req.params.id);
    await ctx.db
      .update(apiTokens)
      .set({ revokedAt: new Date() })
      .where(and(eq(apiTokens.id, req.params.tokenId), eq(apiTokens.userId, agent.id)));
    return { ok: true };
  });
}
