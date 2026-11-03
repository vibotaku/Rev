import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Bot, Check, Columns3, Lightbulb, List, ListTree, Plus, Search, UserCheck, X } from "lucide-react";
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
import {
  Avatar,
  Button,
  Card,
  closureTitle,
  EmptyState,
  ErrorBox,
  Field,
  Input,
  LabelChip,
  LabelInput,
  Modal,
  PageLoader,
  PriorityMark,
  Select,
  Textarea,
} from "../components/ui";
import { cx, taskPath } from "../lib";
import { useMembers } from "./Project";

const BOARD: TaskStatus[] = ["todo", "in_progress", "in_review", "done"];

/** Mirrors the server rule: humans anyone, agents only if linked to you (owners: any agent). */
export function assignableMembers(members: ProjectMemberInfo[], meId: string, myRole: ProjectInfo["myRole"]) {
  return members.filter(
    (m) => m.role !== "viewer" && (m.user.kind === "human" || myRole === "owner" || m.user.ownerId === meId),
  );
}

export function useProjectTasks(key: string | undefined) {
  return useQuery({
    queryKey: ["tasks", key],
    queryFn: () => api.get<TaskInfo[]>(`/api/projects/${key}/tasks`),
    enabled: !!key,
    refetchInterval: 30_000,
  });
}

/** Labels in use in a project, for filters and suggestions. */
export function labelsOf(tasks: TaskInfo[] | undefined) {
  const seen = new Map<string, string>();
  for (const t of tasks ?? []) for (const l of t.labels) if (!seen.has(l.toLowerCase())) seen.set(l.toLowerCase(), l);
  return [...seen.values()].sort((a, b) => a.localeCompare(b));
}

/** Accepts (into a status) or rejects (cancelled) proposals, one request each. */
export function useDecideProposals(key: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ refs, status }: { refs: string[]; status: TaskStatus }) => {
      for (const ref of refs) await api.patch(`/api/tasks/${ref}`, { status });
    },
    onSettled: () => {
      qc.invalidateQueries({ queryKey: ["tasks", key] });
      qc.invalidateQueries({ queryKey: ["task"] });
      qc.invalidateQueries({ queryKey: ["project", key] });
      qc.invalidateQueries({ queryKey: ["dashboard"] });
    },
  });
}

export function ProjectTasks() {
  const project = useOutletContext<ProjectInfo>();
  const me = useUser();
  const qc = useQueryClient();
  const [view, setView] = useState<"board" | "list">(() => (localStorage.getItem("rev.taskView") as "board" | "list") ?? "board");
  const [filter, setFilter] = useState("all");
  const [label, setLabel] = useState("");
  const [query, setQuery] = useState("");
  const [creating, setCreating] = useState(false);
  const [dragging, setDragging] = useState<string | null>(null);
  const [showCancelled, setShowCancelled] = useState(false);

  const key = ["tasks", project.key];
  const { data: tasks, isLoading, error } = useProjectTasks(project.key);
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
  const decide = useDecideProposals(project.key);

  const labels = useMemo(() => labelsOf(tasks), [tasks]);
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return (tasks ?? [])
      .filter((t) => {
        if (filter === "me" && t.assignee?.id !== me.id) return false;
        if (filter === "agents" && t.assignee?.kind !== "agent") return false;
        if (filter === "unassigned" && t.assignee) return false;
        if (filter === "agent-closed" && t.closure?.review !== "agent") return false;
        if (label && !t.labels.some((l) => l.toLowerCase() === label.toLowerCase())) return false;
        if (q && !`${t.ref} ${t.title} ${t.labels.join(" ")}`.toLowerCase().includes(q)) return false;
        return true;
      })
      .sort((a, b) => a.position - b.position);
  }, [tasks, filter, label, query, me.id]);

  function setViewPersist(v: "board" | "list") {
    setView(v);
    localStorage.setItem("rev.taskView", v);
  }

  const canEdit = project.can.createTask;
  const draggedTask = (tasks ?? []).find((t) => t.id === dragging);
  // Proposals can be dragged out (which accepts them) but nothing can be dragged back in.
  const canDropIn = (status: TaskStatus) => canEdit && (status !== "proposed" || draggedTask?.status === "proposed");

  function drop(status: TaskStatus, beforeId: string | null) {
    const ref = draggedTask?.ref;
    setDragging(null);
    if (!ref || !canDropIn(status)) return;
    const column = filtered.filter((t) => t.status === status && t.id !== dragging);
    const idx = beforeId ? column.findIndex((t) => t.id === beforeId) : column.length;
    const prev = column[idx - 1]?.position;
    const next = column[idx]?.position;
    const position = prev === undefined ? (next ?? 1000) - 1000 : next === undefined ? prev + 1000 : (prev + next) / 2;
    move.mutate({ ref, status, position });
  }

  const hasProposals = (tasks ?? []).some((t) => t.status === "proposed");
  const columns: TaskStatus[] = [...(hasProposals ? (["proposed"] as const) : []), ...BOARD, ...(showCancelled ? (["cancelled"] as const) : [])];

  return (
    <div className="flex h-full flex-col">
      <div className="flex flex-wrap items-center gap-2 px-4 py-3 md:px-8">
        <div className="relative w-full sm:w-64">
          <Search className="pointer-events-none absolute top-2.5 left-2.5 size-4 text-zinc-400" />
          <Input placeholder="Filter tasks" value={query} onChange={(e) => setQuery(e.target.value)} className="pl-8" />
        </div>
        <Select className="min-w-0 flex-1 sm:w-44 sm:flex-none" value={filter} onChange={(e) => setFilter(e.target.value)}>
          <option value="all">Everyone</option>
          <option value="me">Assigned to me</option>
          <option value="agents">Assigned to agents</option>
          <option value="unassigned">Unassigned</option>
          <option value="agent-closed">Closed by agents, not reviewed</option>
        </Select>
        {labels.length > 0 && (
          <Select className="min-w-0 flex-1 sm:w-36 sm:flex-none" value={label} onChange={(e) => setLabel(e.target.value)} aria-label="Label">
            <option value="">All labels</option>
            {labels.map((l) => (
              <option key={l} value={l}>
                {l}
              </option>
            ))}
          </Select>
        )}
        <div className="flex items-center gap-1 rounded-md border border-zinc-300 bg-white p-0.5 sm:ml-auto">
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
      <ErrorBox error={error ?? move.error ?? decide.error} />
      {isLoading ? (
        <PageLoader />
      ) : !tasks?.length ? (
        <div className="px-4 md:px-8">
          <EmptyState title="No tasks yet">
            Create tasks here, or turn accepted review comments into tasks from a review. Agents can also propose tasks for you to accept.
          </EmptyState>
        </div>
      ) : view === "board" ? (
        <div className="flex min-h-0 flex-1 gap-3 overflow-x-auto px-4 pb-6 max-md:snap-x max-md:scroll-px-4 md:px-8">
          {columns.map((status) => {
            const column = filtered.filter((t) => t.status === status);
            const unreviewed = column.filter((t) => t.closure?.review === "agent").length;
            const proposals = status === "proposed";
            return (
              <div
                key={status}
                data-column={status}
                className={cx(
                  "flex w-72 max-w-[calc(100vw-3rem)] shrink-0 flex-col rounded-lg max-md:snap-start",
                  proposals ? "border border-dashed border-sky-300 bg-sky-50/70" : "bg-zinc-100/80",
                  dragging && canDropIn(status) && "ring-1 ring-zinc-200",
                )}
                onDragOver={(e) => canDropIn(status) && e.preventDefault()}
                onDrop={() => drop(status, null)}
              >
                <div className="flex items-center justify-between gap-2 px-3 py-2 text-xs font-semibold text-zinc-600">
                  <span className={cx("flex items-center gap-1", proposals && "text-sky-800")} title={proposals ? "Tasks agents proposed. Accept them to add them to the board." : undefined}>
                    {proposals && <Lightbulb className="size-3.5" />}
                    {TASK_STATUS_LABELS[status]}
                  </span>
                  <span className="flex items-center gap-1.5">
                    {unreviewed > 0 && (
                      <span
                        className="flex items-center gap-1 rounded-full border border-dashed border-violet-400 bg-violet-50 px-1.5 text-[10px] text-violet-700"
                        title="Closed by agents, not yet reviewed by a human"
                      >
                        <Bot className="size-3" /> {unreviewed} to review
                      </span>
                    )}
                    {proposals && canEdit && column.length > 1 && (
                      <Button
                        size="sm"
                        variant="ghost"
                        className="h-6 px-1.5 text-[11px] text-sky-800 hover:bg-sky-100"
                        loading={decide.isPending && decide.variables?.refs.length === column.length}
                        disabled={decide.isPending}
                        onClick={() => decide.mutate({ refs: column.map((t) => t.ref), status: "todo" })}
                        title="Accept every proposal shown here into To do"
                      >
                        <Check className="size-3" /> Accept all
                      </Button>
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
                      onDragOver={(e) => canDropIn(status) && e.preventDefault()}
                      onDrop={(e) => {
                        e.stopPropagation();
                        drop(status, t.id);
                      }}
                      className={cx(dragging === t.id && "opacity-40")}
                    >
                      <TaskCard
                        task={t}
                        canDecide={canEdit}
                        deciding={decide.isPending && !!decide.variables?.refs.includes(t.ref)}
                        onDecide={(to) => decide.mutate({ refs: [t.ref], status: to })}
                      />
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
        <div className="px-4 pb-6 md:px-8">
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

function TaskCard({
  task: t,
  canDecide,
  deciding,
  onDecide,
}: {
  task: TaskInfo;
  canDecide: boolean;
  deciding: boolean;
  onDecide: (status: TaskStatus) => void;
}) {
  const proposed = t.status === "proposed";
  return (
    <div
      data-task={t.ref}
      className={cx(
        "rounded-md border shadow-sm",
        proposed
          ? "border-dashed border-sky-400 bg-white hover:border-sky-500"
          : t.closure?.review === "agent"
            ? "border-dashed border-violet-400 bg-violet-50/60 hover:border-violet-500"
            : "border-zinc-200 bg-white hover:border-zinc-300",
      )}
    >
      <Link to={taskPath(t.ref)} title={closureTitle(t.closure)} className="block p-2.5">
        <div className="flex items-center gap-2 text-xs text-zinc-500">
          <span className="font-mono">{t.ref}</span>
          <PriorityMark priority={t.priority} />
          {t.sourceReview && <span className="truncate">· {t.sourceReview.ref}</span>}
          {t.parent && (
            <span className="truncate" title={`Sub-task of ${t.parent.ref} ${t.parent.title}`}>
              ↳ {t.parent.ref}
            </span>
          )}
          <span className="ml-auto">{t.assignee && <Avatar user={t.assignee} size="sm" />}</span>
        </div>
        <div className="mt-1 text-sm leading-snug">{t.title}</div>
        {(t.labels.length > 0 || t.subtasks.total > 0) && (
          <div className="mt-1.5 flex flex-wrap items-center gap-1">
            {t.labels.map((l) => (
              <LabelChip key={l} label={l} />
            ))}
            {t.subtasks.total > 0 && (
              <span className="ml-auto flex items-center gap-1 text-[11px] text-zinc-500" title={`${t.subtasks.done} of ${t.subtasks.total} sub-tasks done`}>
                <ListTree className="size-3" /> {t.subtasks.done}/{t.subtasks.total}
              </span>
            )}
          </div>
        )}
        {proposed && (
          <div className="mt-1.5 flex items-center gap-1 text-[11px] font-medium text-sky-700">
            <Lightbulb className="size-3" /> Proposed by {t.createdBy.name}
          </div>
        )}
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
      {proposed && canDecide && (
        <div className="flex gap-1 border-t border-dashed border-sky-200 p-1">
          <Button size="sm" variant="ghost" className="flex-1 text-emerald-700 hover:bg-emerald-50" disabled={deciding} onClick={() => onDecide("todo")}>
            <Check className="size-3.5" /> Accept
          </Button>
          <Button size="sm" variant="ghost" className="flex-1 text-zinc-500" disabled={deciding} onClick={() => onDecide("cancelled")}>
            <X className="size-3.5" /> Reject
          </Button>
        </div>
      )}
    </div>
  );
}

export function CreateTask({ project, parentRef, onClose }: { project: ProjectInfo; parentRef?: string; onClose: () => void }) {
  const me = useUser();
  const qc = useQueryClient();
  const { data: members } = useMembers(project.key);
  const { data: tasks } = useProjectTasks(project.key);
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [priority, setPriority] = useState<TaskPriority>("none");
  const [assigneeId, setAssigneeId] = useState("");
  const [parent, setParent] = useState(parentRef ?? "");
  const [labels, setLabels] = useState<string[]>([]);
  const create = useMutation({
    mutationFn: () =>
      api.post<TaskDetail>(`/api/projects/${project.key}/tasks`, {
        title,
        description,
        priority,
        assigneeId: assigneeId || null,
        parent: parent || null,
        labels,
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["tasks", project.key] });
      qc.invalidateQueries({ queryKey: ["project", project.key] });
      if (parent) qc.invalidateQueries({ queryKey: ["task", parent] });
      onClose();
    },
  });
  const options = assignableMembers(members ?? [], me.id, project.myRole);
  const parents = (tasks ?? []).filter((t) => t.status !== "cancelled").sort((a, b) => a.number - b.number);

  return (
    <Modal
      title={parentRef ? `New sub-task of ${parentRef}` : `New task in ${project.key}`}
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
      <div className="grid gap-4 sm:grid-cols-2">
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
        <Field label="Parent task">
          <Select value={parent} onChange={(e) => setParent(e.target.value)}>
            <option value="">None (top-level task)</option>
            {parents.map((t) => (
              <option key={t.id} value={t.ref}>
                {t.ref} {t.title.length > 60 ? `${t.title.slice(0, 60)}…` : t.title}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Labels">
          <LabelInput value={labels} onChange={setLabels} suggestions={labelsOf(tasks)} />
        </Field>
      </div>
      <ErrorBox error={create.error} />
    </Modal>
  );
}
