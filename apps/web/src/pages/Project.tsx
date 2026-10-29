import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Trash2, UserPlus } from "lucide-react";
import { Navigate, NavLink, Outlet, useParams } from "react-router";
import { PROJECT_ROLES, type AgentInfo, type ProjectInfo, type ProjectMemberInfo, type ProjectRole, type UserDetail } from "@rev/shared";
import { api } from "../api";
import { useUser } from "../auth";
import { Button, Card, ErrorBox, Field, Input, Modal, PageLoader, Select, Textarea, UserChip } from "../components/ui";
import { cx } from "../lib";

export function useProject(key: string | undefined) {
  return useQuery({
    queryKey: ["project", key],
    queryFn: () => api.get<ProjectInfo>(`/api/projects/${key}`),
    enabled: !!key,
  });
}

export function useMembers(key: string | undefined) {
  return useQuery({
    queryKey: ["members", key],
    queryFn: () => api.get<ProjectMemberInfo[]>(`/api/projects/${key}/members`),
    enabled: !!key,
  });
}

export function ProjectLayout() {
  const { key } = useParams();
  const { data: project, error, isLoading } = useProject(key);
  if (isLoading) return <PageLoader />;
  if (!project) return <div className="p-8"><ErrorBox error={error ?? "Project not found"} /></div>;

  const tab = ({ isActive }: { isActive: boolean }) =>
    cx(
      "border-b-2 px-1 pb-2.5 text-sm font-medium transition-colors",
      isActive ? "border-accent-600 text-zinc-900" : "border-transparent text-zinc-500 hover:text-zinc-800",
    );
  return (
    <div className="flex h-full flex-col">
      <div className="border-b border-zinc-200 bg-white px-8 pt-5">
        <div className="flex items-center gap-2">
          <span className="rounded bg-zinc-900 px-1.5 py-0.5 font-mono text-xs font-semibold text-white">{project.key}</span>
          <h1 className="truncate text-xl font-semibold tracking-tight">{project.name}</h1>
          {project.archived && <span className="text-sm text-zinc-400">(archived)</span>}
        </div>
        {project.description && <p className="mt-1 line-clamp-1 text-sm text-zinc-500">{project.description}</p>}
        <nav className="mt-4 flex gap-6">
          <NavLink to="tasks" className={tab}>
            Tasks <span className="text-zinc-400">{project.counts.openTasks}</span>
          </NavLink>
          <NavLink to="reviews" className={tab}>
            Reviews <span className="text-zinc-400">{project.counts.openReviews}</span>
          </NavLink>
          <NavLink to="members" className={tab}>
            Members <span className="text-zinc-400">{project.counts.members}</span>
          </NavLink>
          {project.can.manage && (
            <NavLink to="settings" className={tab}>
              Settings
            </NavLink>
          )}
        </nav>
      </div>
      <div className="min-h-0 flex-1">
        <Outlet context={project} />
      </div>
    </div>
  );
}

export function ProjectMembers() {
  const { key } = useParams();
  const me = useUser();
  const qc = useQueryClient();
  const { data: project } = useProject(key);
  const { data: members, isLoading } = useMembers(key);
  const [adding, setAdding] = useState(false);
  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ["members", key] });
    qc.invalidateQueries({ queryKey: ["project", key] });
    qc.invalidateQueries({ queryKey: ["agents"] });
  };
  const update = useMutation({
    mutationFn: ({ userId, role }: { userId: string; role: ProjectRole }) => api.patch(`/api/projects/${key}/members/${userId}`, { role }),
    onSuccess: invalidate,
  });
  const remove = useMutation({
    mutationFn: (userId: string) => api.del(`/api/projects/${key}/members/${userId}`),
    onSuccess: invalidate,
  });
  if (isLoading || !project) return <PageLoader />;
  const manage = project.can.manage;

  return (
    <div className="mx-auto max-w-4xl space-y-4 px-8 py-6">
      <div className="flex items-center justify-between">
        <p className="text-sm text-zinc-500">
          Owners manage the project and decide on any review. Members create tasks and reviews. Viewers read only. Agents can be members
          or viewers; only their linked human or a project owner can assign them work.
        </p>
        {project.myRole !== "viewer" && (
          <Button variant="primary" onClick={() => setAdding(true)}>
            <UserPlus className="size-4" /> Add
          </Button>
        )}
      </div>
      <ErrorBox error={update.error ?? remove.error} />
      <Card className="divide-y divide-zinc-100">
        {members?.map((m) => {
          const ownAgent = m.user.kind === "agent" && m.user.ownerId === me.id;
          return (
            <div key={m.user.id} className="flex items-center gap-3 px-4 py-2.5">
              <div className="min-w-0 flex-1">
                <UserChip user={m.user} size="md" />
              </div>
              {m.user.email && <span className="hidden text-sm text-zinc-500 sm:block">{m.user.email}</span>}
              {manage ? (
                <Select
                  className="w-28"
                  value={m.role}
                  onChange={(e) => update.mutate({ userId: m.user.id, role: e.target.value as ProjectRole })}
                >
                  {PROJECT_ROLES.filter((r) => m.user.kind === "human" || r !== "owner").map((r) => (
                    <option key={r} value={r}>
                      {r}
                    </option>
                  ))}
                </Select>
              ) : (
                <span className="w-28 text-sm text-zinc-500">{m.role}</span>
              )}
              {(manage || ownAgent || m.user.id === me.id) && (
                <Button
                  variant="ghost"
                  size="sm"
                  title={m.user.id === me.id ? "Leave project" : "Remove"}
                  onClick={() => confirm(`Remove ${m.user.name} from ${project.key}?`) && remove.mutate(m.user.id)}
                >
                  <Trash2 className="size-3.5" />
                </Button>
              )}
            </div>
          );
        })}
      </Card>
      {adding && <AddMember projectKey={project.key} canAddAnyone={manage} existing={members ?? []} onClose={() => setAdding(false)} onAdded={invalidate} />}
    </div>
  );
}

function AddMember({
  projectKey,
  canAddAnyone,
  existing,
  onClose,
  onAdded,
}: {
  projectKey: string;
  canAddAnyone: boolean;
  existing: ProjectMemberInfo[];
  onClose: () => void;
  onAdded: () => void;
}) {
  const users = useQuery({ queryKey: ["users"], queryFn: () => api.get<UserDetail[]>("/api/users"), enabled: canAddAnyone });
  const agents = useQuery({ queryKey: ["agents"], queryFn: () => api.get<AgentInfo[]>("/api/agents") });
  const [userId, setUserId] = useState("");
  const [role, setRole] = useState<ProjectRole>("member");
  const add = useMutation({
    mutationFn: () => api.post(`/api/projects/${projectKey}/members`, { userId, role }),
    onSuccess: () => {
      onAdded();
      onClose();
    },
  });
  const taken = new Set(existing.map((m) => m.user.id));
  const candidates = canAddAnyone
    ? (users.data ?? []).filter((u) => !u.disabled && !taken.has(u.id))
    : (agents.data ?? []).filter((a) => !a.disabled && !taken.has(a.id)).map((a) => ({ id: a.id, name: a.name, kind: "agent" as const, email: null }));
  const selected = candidates.find((c) => c.id === userId);

  return (
    <Modal
      title="Add to project"
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" disabled={!userId} loading={add.isPending} onClick={() => add.mutate()}>
            Add
          </Button>
        </>
      }
    >
      {!canAddAnyone && <p className="text-sm text-zinc-500">As a member you can add your own agents. Ask a project owner to add people.</p>}
      <Field label={canAddAnyone ? "Person or agent" : "Your agent"}>
        <Select value={userId} onChange={(e) => setUserId(e.target.value)}>
          <option value="">Select…</option>
          {candidates.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
              {c.kind === "agent" ? " (agent)" : c.email ? ` — ${c.email}` : ""}
            </option>
          ))}
        </Select>
      </Field>
      <Field label="Role">
        <Select value={role} onChange={(e) => setRole(e.target.value as ProjectRole)}>
          {PROJECT_ROLES.filter((r) => (canAddAnyone && selected?.kind !== "agent") || r !== "owner").map((r) => (
            <option key={r} value={r}>
              {r}
            </option>
          ))}
        </Select>
      </Field>
      <ErrorBox error={add.error} />
    </Modal>
  );
}

export function ProjectSettings() {
  const { key } = useParams();
  const qc = useQueryClient();
  const { data: project } = useProject(key);
  const [form, setForm] = useState<{ name: string; description: string } | null>(null);
  const save = useMutation({
    mutationFn: (body: Record<string, unknown>) => api.patch<ProjectInfo>(`/api/projects/${key}`, body),
    onSuccess: (p) => {
      qc.setQueryData(["project", key], p);
      qc.invalidateQueries({ queryKey: ["projects"] });
      setForm(null);
    },
  });
  if (!project) return <PageLoader />;
  if (!project.can.manage) return <Navigate to={`/p/${key}`} replace />;
  const value = form ?? { name: project.name, description: project.description };

  return (
    <div className="mx-auto max-w-2xl space-y-6 px-8 py-6">
      <Card className="space-y-4 p-5">
        <Field label="Name">
          <Input value={value.name} onChange={(e) => setForm({ ...value, name: e.target.value })} />
        </Field>
        <Field label="Description">
          <Textarea rows={4} value={value.description} onChange={(e) => setForm({ ...value, description: e.target.value })} />
        </Field>
        <ErrorBox error={save.error} />
        <div className="flex justify-end">
          <Button variant="primary" disabled={!form} loading={save.isPending} onClick={() => save.mutate(value)}>
            Save
          </Button>
        </div>
      </Card>
      <Card className="flex items-center justify-between p-5">
        <div>
          <div className="text-sm font-medium">{project.archived ? "Unarchive project" : "Archive project"}</div>
          <div className="text-sm text-zinc-500">Archived projects stop accepting new tasks and reviews, and drop out of agents' task queues.</div>
        </div>
        <Button variant="danger" onClick={() => save.mutate({ archived: !project.archived })}>
          {project.archived ? "Unarchive" : "Archive"}
        </Button>
      </Card>
    </div>
  );
}
