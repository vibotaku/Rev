import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Bot, Columns3, List, Plus, Search, UserCheck } from "lucide-react";
import { Link, useOutletContext } from "react-router";
import {
  TASK_PRIORITIES,
  TASK_STATUS_LABELS,
  TASK_STATUSES,
  type ProjectInfo,
  type ProjectMemberInfo,
  type TaskDetail,
  type TaskInfo,
  type TaskPriority,
  type TaskStatus,
} from "@rev/shared";
import { api } from "../api";
import { useUser } from "../auth";
import { TaskRow } from "../components/lists";
import { Avatar, Button, Card, closureTitle, EmptyState, ErrorBox, Field, Input, Modal, PageLoader, PriorityMark, Select, Textarea } from "../components/ui";
import { cx, taskPath } from "../lib";
import { useMembers } from "./Project";

const BOARD: TaskStatus[] = ["todo", "in_progress", "in_review", "done"];

/** Mirrors the server rule: humans anyone, agents only if linked to you (owners: any agent). */
export function assignableMembers(members: ProjectMemberInfo[], meId: string, myRole: ProjectInfo["myRole"]) {
  return members.filter(
    (m) => m.role !== "viewer" && (m.user.kind === "human" || myRole === "owner" || m.user.ownerId === meId),
  );
}

export function ProjectTasks() {
  const project = useOutletContext<ProjectInfo>();
  const me = useUser();
  const qc = useQueryClient();
  const [view, setView] = useState<"board" | "list">(() => (localStorage.getItem("rev.taskView") as "board" | "list") ?? "board");
  const [filter, setFilter] = useState("all");
  const [query, setQuery] = useState("");
  const [creating, setCreating] = useState(false);
  const [dragging, setDragging] = useState<string | null>(null);
  const [showCancelled, setShowCancelled] = useState(false);

  const key = ["tasks", project.key];
  const { data: tasks, isLoading, error } = useQuery({
    queryKey: key,
    queryFn: () => api.get<TaskInfo[]>(`/api/projects/${project.key}/tasks`),
    refetchInterval: 30_000,
  });
  const move = useMutation({
    mutationFn: ({ ref, status, position }: { ref: string; status: TaskStatus; position: number }) =>
      api.patch(`/api/tasks/${ref}`, { status, position }),
    onMutate: async ({ ref, status, position }) => {
      await qc.cancelQueries({ queryKey: key });
      const prev = qc.getQueryData<TaskInfo[]>(key);
      qc.setQueryData<TaskInfo[]>(key, (old) => old?.map((t) => (t.ref === ref ? { ...t, status, position } : t)));
      return { prev };
    },
    onError: (_e, _v, ctx) => ctx?.prev && qc.setQueryData(key, ctx.prev),
    onSettled: () => {
      qc.invalidateQueries({ queryKey: key });
      qc.invalidateQueries({ queryKey: ["project", project.key] });
    },
  });

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return (tasks ?? [])
      .filter((t) => {
        if (filter === "me" && t.assignee?.id !== me.id) return false;
        if (filter === "agents" && t.assignee?.kind !== "agent") return false;
        if (filter === "unassigned" && t.assignee) return false;
        if (filter === "agent-closed" && t.closure?.review !== "agent") return false;
        if (q && !`${t.ref} ${t.title}`.toLowerCase().includes(q)) return false;
        return true;
      })
      .sort((a, b) => a.position - b.position);
  }, [tasks, filter, query, me.id]);

  function setViewPersist(v: "board" | "list") {
    setView(v);
    localStorage.setItem("rev.taskView", v);
  }

  function drop(status: TaskStatus, beforeId: string | null) {
    const ref = (tasks ?? []).find((t) => t.id === dragging)?.ref;
    setDragging(null);
    if (!ref) return;
    const column = filtered.filter((t) => t.status === status && t.id !== dragging);
    const idx = beforeId ? column.findIndex((t) => t.id === beforeId) : column.length;
    const prev = column[idx - 1]?.position;
    const next = column[idx]?.position;
    const position = prev === undefined ? (next ?? 1000) - 1000 : next === undefined ? prev + 1000 : (prev + next) / 2;
    move.mutate({ ref, status, position });
  }

  const canEdit = project.can.createTask;

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-2 px-8 py-3">
        <div className="relative w-64">
          <Search className="pointer-events-none absolute top-2.5 left-2.5 size-4 text-zinc-400" />
          <Input placeholder="Filter tasks" value={query} onChange={(e) => setQuery(e.target.value)} className="pl-8" />
        </div>
        <Select className="w-44" value={filter} onChange={(e) => setFilter(e.target.value)}>
          <option value="all">Everyone</option>
          <option value="me">Assigned to me</option>
          <option value="agents">Assigned to agents</option>
          <option value="unassigned">Unassigned</option>
          <option value="agent-closed">Closed by agents, not reviewed</option>
        </Select>
        <div className="ml-auto flex items-center gap-1 rounded-md border border-zinc-300 bg-white p-0.5">
          <button
            className={cx("rounded p-1.5", view === "board" ? "bg-zinc-100 text-zinc-900" : "text-zinc-400")}
            onClick={() => setViewPersist("board")}
            title="Board"
          >
            <Columns3 className="size-4" />
          </button>
          <button
            className={cx("rounded p-1.5", view === "list" ? "bg-zinc-100 text-zinc-900" : "text-zinc-400")}
            onClick={() => setViewPersist("list")}
            title="List"
          >
            <List className="size-4" />
          </button>
        </div>
        {canEdit && (
          <Button variant="primary" onClick={() => setCreating(true)}>
            <Plus className="size-4" /> New task
          </Button>
        )}
      </div>
      <ErrorBox error={error ?? move.error} />
      {isLoading ? (
        <PageLoader />
      ) : !tasks?.length ? (
        <div className="px-8">
          <EmptyState title="No tasks yet">
            Create tasks here, or turn accepted review comments into tasks from a review.
          </EmptyState>
        </div>
      ) : view === "board" ? (
        <div className="flex min-h-0 flex-1 gap-3 overflow-x-auto px-8 pb-6">
          {[...BOARD, ...(showCancelled ? (["cancelled"] as TaskStatus[]) : [])].map((status) => {
            const column = filtered.filter((t) => t.status === status);
            const unreviewed = column.filter((t) => t.closure?.review === "agent").length;
            return (
              <div
                key={status}
                className={cx("flex w-72 shrink-0 flex-col rounded-lg bg-zinc-100/80", dragging && "ring-1 ring-zinc-200")}
                onDragOver={(e) => canEdit && e.preventDefault()}
                onDrop={() => drop(status, null)}
              >
                <div className="flex items-center justify-between px-3 py-2 text-xs font-semibold text-zinc-600">
                  <span>{TASK_STATUS_LABELS[status]}</span>
                  <span className="flex items-center gap-1.5">
                    {unreviewed > 0 && (
                      <span
                        className="flex items-center gap-1 rounded-full border border-dashed border-violet-400 bg-violet-50 px-1.5 text-[10px] text-violet-700"
                        title="Closed by agents, not yet reviewed by a human"
                      >
                        <Bot className="size-3" /> {unreviewed} to review
                      </span>
                    )}
                    <span className="text-zinc-400">{column.length}</span>
                  </span>
                </div>
                <div className="min-h-0 flex-1 space-y-2 overflow-y-auto px-2 pb-2">
                  {column.map((t) => (
                    <div
                      key={t.id}
                      draggable={canEdit}
                      onDragStart={() => setDragging(t.id)}
                      onDragEnd={() => setDragging(null)}
                      onDragOver={(e) => canEdit && e.preventDefault()}
                      onDrop={(e) => {
                        e.stopPropagation();
                        drop(status, t.id);
                      }}
                      className={cx(dragging === t.id && "opacity-40")}
                    >
                      <Link
                        to={taskPath(t.ref)}
                        title={closureTitle(t.closure)}
                        className={cx(
                          "block rounded-md border p-2.5 shadow-sm",
                          t.closure?.review === "agent"
                            ? "border-dashed border-violet-400 bg-violet-50/60 hover:border-violet-500"
                            : "border-zinc-200 bg-white hover:border-zinc-300",
                        )}
                      >
                        <div className="flex items-center gap-2 text-xs text-zinc-500">
                          <span className="font-mono">{t.ref}</span>
                          <PriorityMark priority={t.priority} />
                          {t.sourceReview && <span className="truncate">· {t.sourceReview.ref}</span>}
                          <span className="ml-auto">{t.assignee && <Avatar user={t.assignee} size="sm" />}</span>
                        </div>
                        <div className="mt-1 text-sm leading-snug">{t.title}</div>
                        {t.closure?.review === "agent" && (
                          <div className="mt-1.5 flex items-center gap-1 text-[11px] font-medium text-violet-700">
                            <Bot className="size-3" /> Closed by {t.closure.by.name} · not reviewed
                          </div>
                        )}
                        {t.closure?.review === "human" && (
                          <div className="mt-1.5 flex items-center gap-1 text-[11px] text-emerald-700">
                            <UserCheck className="size-3" /> {t.closure.reviewedBy?.name ?? t.closure.by.name}
                          </div>
                        )}
                      </Link>
                    </div>
                  ))}
                </div>
              </div>
            );
          })}
          <button className="h-8 shrink-0 self-start px-2 text-xs text-zinc-500 hover:text-zinc-800" onClick={() => setShowCancelled((v) => !v)}>
            {showCancelled ? "Hide" : "Show"} cancelled
          </button>
        </div>
      ) : (
        <div className="px-8 pb-6">
          <Card className="divide-y divide-zinc-100">
            {TASK_STATUSES.flatMap((s) => filtered.filter((t) => t.status === s)).map((t) => (
              <TaskRow key={t.id} task={t} />
            ))}
          </Card>
        </div>
      )}
      {creating && <CreateTask project={project} onClose={() => setCreating(false)} />}
    </div>
  );
}

function CreateTask({ project, onClose }: { project: ProjectInfo; onClose: () => void }) {
  const me = useUser();
  const qc = useQueryClient();
  const { data: members } = useMembers(project.key);
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [priority, setPriority] = useState<TaskPriority>("none");
  const [assigneeId, setAssigneeId] = useState("");
  const create = useMutation({
    mutationFn: () =>
      api.post<TaskDetail>(`/api/projects/${project.key}/tasks`, { title, description, priority, assigneeId: assigneeId || null }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["tasks", project.key] });
      qc.invalidateQueries({ queryKey: ["project", project.key] });
      onClose();
    },
  });
  const options = assignableMembers(members ?? [], me.id, project.myRole);

  return (
    <Modal
      title={`New task in ${project.key}`}
      wide
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" disabled={!title.trim()} loading={create.isPending} onClick={() => create.mutate()}>
            Create task
          </Button>
        </>
      }
    >
      <Field label="Title">
        <Input value={title} onChange={(e) => setTitle(e.target.value)} autoFocus />
      </Field>
      <Field label="Description" hint="Markdown supported.">
        <Textarea rows={6} value={description} onChange={(e) => setDescription(e.target.value)} />
      </Field>
      <div className="grid grid-cols-2 gap-4">
        <Field label="Assignee">
          <Select value={assigneeId} onChange={(e) => setAssigneeId(e.target.value)}>
            <option value="">Unassigned</option>
            {options.map((m) => (
              <option key={m.user.id} value={m.user.id}>
                {m.user.name}
                {m.user.kind === "agent" ? " (agent)" : ""}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Priority">
          <Select value={priority} onChange={(e) => setPriority(e.target.value as TaskPriority)}>
            {TASK_PRIORITIES.map((p) => (
              <option key={p} value={p}>
                {p}
              </option>
            ))}
          </Select>
        </Field>
      </div>
      <ErrorBox error={create.error} />
    </Modal>
  );
}
