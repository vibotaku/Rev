import type { FastifyInstance } from "fastify";
import { and, desc, eq, inArray } from "drizzle-orm";
import { agentCreateBody, agentUpdateBody, tokenCreateBody, type AgentInfo, type ApiTokenInfo } from "@rev/shared";
import type { AppContext } from "../context";
import { apiTokens, projectMembers, projects, users } from "../db/schema";
import { requireHuman, type Actor } from "../lib/auth";
import { newApiToken } from "../lib/crypto";
import { forbidden, notFound, parse } from "../lib/errors";
import { loadUsers } from "../lib/serialize";

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
    const [owners, tokens, memberships] = await Promise.all([
      loadUsers(ctx.db, rows.map((a) => a.ownerId)),
      ctx.db.select().from(apiTokens).where(inArray(apiTokens.userId, ids)).orderBy(desc(apiTokens.createdAt)),
      ctx.db
        .select({ userId: projectMembers.userId, role: projectMembers.role, key: projects.key, name: projects.name })
        .from(projectMembers)
        .innerJoin(projects, eq(projects.id, projectMembers.projectId))
        .where(inArray(projectMembers.userId, ids)),
    ]);
    return rows.map((a) => ({
      id: a.id,
      name: a.name,
      description: a.description,
      disabled: !!a.disabledAt,
      owner: owners.get(a.ownerId!)!,
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
