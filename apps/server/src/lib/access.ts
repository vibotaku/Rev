// Authorization rules. Every permission decision in the API goes through here.
//
// Global roles: admin (manages users, acts as owner of every project), member.
// Project roles: owner (manages project and members, decides on any review),
//                member (creates/edits tasks and reviews, comments),
//                viewer (read only).
// Agents are capped regardless of role: they can submit reviews, comment, and
// work on tasks assigned to them, but never decide on reviews, create tasks,
// assign work, or manage anything. Only an agent's linked human (or a project
// owner/admin) can assign work to that agent.
import { and, eq, inArray, isNull } from "drizzle-orm";
import type { ProjectRole } from "@rev/shared";
import type { Db } from "../db";
import { projectMembers, projects, reviews, tasks, users } from "../db/schema";
import type { Actor } from "./auth";
import { badRequest, forbidden, notFound } from "./errors";

type Project = typeof projects.$inferSelect;
type Review = typeof reviews.$inferSelect;
type Task = typeof tasks.$inferSelect;

export const isWriter = (role: ProjectRole | null) => role === "owner" || role === "member";

export async function projectRole(db: Db, projectId: string, actor: Actor): Promise<ProjectRole | null> {
  if (actor.kind === "human" && actor.role === "admin") return "owner";
  const [m] = await db
    .select({ role: projectMembers.role })
    .from(projectMembers)
    .where(and(eq(projectMembers.projectId, projectId), eq(projectMembers.userId, actor.id)));
  return m?.role ?? null;
}

/** Loads a project the actor can see. Non-members get 404 so project keys do not leak. */
export async function loadProject(db: Db, actor: Actor, key: string) {
  const [project] = await db.select().from(projects).where(eq(projects.key, key.toUpperCase()));
  if (!project) throw notFound("Project");
  const role = await projectRole(db, project.id, actor);
  if (!role) throw notFound("Project");
  return { project, role };
}

export async function loadProjectById(db: Db, actor: Actor, projectId: string) {
  const [project] = await db.select().from(projects).where(eq(projects.id, projectId));
  if (!project) throw notFound("Project");
  const role = await projectRole(db, project.id, actor);
  if (!role) throw notFound("Project");
  return { project, role };
}

export function projectPerms(actor: Actor, role: ProjectRole | null, project: Project) {
  const human = actor.kind === "human";
  const active = !project.archivedAt;
  return {
    manage: human && role === "owner",
    createTask: human && isWriter(role) && active,
    createReview: isWriter(role) && active,
  };
}

export function taskPerms(actor: Actor, role: ProjectRole | null, task: Task) {
  const human = actor.kind === "human";
  const edit = human && isWriter(role);
  return {
    edit,
    updateStatus: edit || (isWriter(role) && task.assigneeId === actor.id),
    comment: isWriter(role),
  };
}

export function reviewPerms(actor: Actor, role: ProjectRole | null, review: Review) {
  const human = actor.kind === "human";
  const involved = review.createdBy === actor.id || review.ownerId === actor.id;
  const view = role !== null && (review.status !== "draft" || involved || (human && role === "owner"));
  const edit = view && isWriter(role) && (involved || (human && role === "owner"));
  const decide = view && human && isWriter(role) && (review.ownerId === actor.id || role === "owner");
  return {
    view,
    edit,
    comment: view && isWriter(role),
    decide,
    publish: edit && review.status === "draft",
  };
}

export function assertCan(allowed: boolean, message?: string) {
  if (!allowed) throw forbidden(message);
}

/**
 * Users the actor may assign tasks to in this project: any human writer, plus
 * agents the actor is linked to. Project owners and admins may assign any agent.
 */
export async function assignableUserIds(db: Db, projectId: string, actor: Actor, role: ProjectRole | null) {
  if (actor.kind !== "human" || !isWriter(role)) return [];
  const rows = await db
    .select({ id: users.id, kind: users.kind, ownerId: users.ownerId })
    .from(projectMembers)
    .innerJoin(users, eq(users.id, projectMembers.userId))
    .where(
      and(
        eq(projectMembers.projectId, projectId),
        inArray(projectMembers.role, ["owner", "member"]),
        isNull(users.disabledAt),
      ),
    );
  return rows
    .filter((u) => u.kind === "human" || role === "owner" || u.ownerId === actor.id)
    .map((u) => u.id);
}

export async function assertAssignable(
  db: Db,
  projectId: string,
  actor: Actor,
  role: ProjectRole | null,
  assigneeId: string | null | undefined,
) {
  if (!assigneeId) return;
  const allowed = await assignableUserIds(db, projectId, actor, role);
  if (allowed.includes(assigneeId)) return;
  const [target] = await db.select({ kind: users.kind, ownerId: users.ownerId }).from(users).where(eq(users.id, assigneeId));
  if (!target) throw badRequest("Assignee does not exist");
  if (target.kind === "agent" && target.ownerId !== actor.id && role !== "owner") {
    throw forbidden("Only the agent's linked human or a project owner can assign work to this agent");
  }
  throw badRequest("Assignee must be an active, non-viewer member of the project (add the agent to the project first)");
}
