import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, Pencil } from "lucide-react";
import { Link, useParams } from "react-router";
import {
  formatTimestamp,
  TASK_PRIORITIES,
  TASK_STATUS_LABELS,
  TASK_STATUSES,
  type TaskActivityInfo,
  type TaskDetail,
  type TaskPriority,
  type TaskStatus,
} from "@rev/shared";
import { api } from "../api";
import { useMembers } from "./Project";
import { Avatar, Button, Card, CommentStatusBadge, ErrorBox, Field, Input, Markdown, PageLoader, ReviewStatusBadge, Select, Textarea, UserChip } from "../components/ui";
import { reviewRefPath, timeAgo } from "../lib";

function describeActivity(a: TaskActivityInfo, names: Map<string, string>) {
  const d = (a.data ?? {}) as Record<string, string | null>;
  switch (a.kind) {
    case "created":
      return "created the task";
    case "status":
      return `moved it from ${TASK_STATUS_LABELS[d.from as TaskStatus] ?? d.from} to ${TASK_STATUS_LABELS[d.to as TaskStatus] ?? d.to}`;
    case "assign":
      return d.to ? `assigned it to ${names.get(d.to) ?? "someone"}` : "unassigned it";
    case "priority":
      return `set priority to ${d.to}`;
    case "review":
      return "submitted a review for it";
    default:
      return "";
  }
}

export function TaskPage() {
  const { key, number } = useParams();
  const ref = `${key}-${number}`;
  const qc = useQueryClient();
  const { data: task, isLoading, error } = useQuery({
    queryKey: ["task", ref],
    queryFn: () => api.get<TaskDetail>(`/api/tasks/${ref}`),
    refetchInterval: 20_000,
  });
  const { data: members } = useMembers(key);
  const [editing, setEditing] = useState<{ title: string; description: string } | null>(null);
  const [comment, setComment] = useState("");

  const onSaved = (t: TaskDetail) => {
    qc.setQueryData(["task", ref], t);
    qc.invalidateQueries({ queryKey: ["tasks", key] });
    qc.invalidateQueries({ queryKey: ["project", key] });
  };
  const update = useMutation({
    mutationFn: (body: Record<string, unknown>) => api.patch<TaskDetail>(`/api/tasks/${ref}`, body),
    onSuccess: (t) => {
      onSaved(t);
      setEditing(null);
    },
  });
  const addComment = useMutation({
    mutationFn: () => api.post<TaskDetail>(`/api/tasks/${ref}/comments`, { body: comment }),
    onSuccess: (t) => {
      onSaved(t);
      setComment("");
    },
  });

  if (isLoading) return <PageLoader />;
  if (!task) return <div className="p-8"><ErrorBox error={error} /></div>;
  const names = new Map((members ?? []).map((m) => [m.user.id, m.user.name]));
  const assignable = (members ?? []).filter((m) => task.can.assignableUserIds.includes(m.user.id));

  return (
    <div className="mx-auto max-w-6xl px-8 py-6">
      <Link to={`/p/${key}/tasks`} className="mb-4 inline-flex items-center gap-1 text-sm text-zinc-500 hover:text-zinc-800">
        <ArrowLeft className="size-4" /> {key} tasks
      </Link>
      <div className="grid gap-6 lg:grid-cols-[1fr_280px]">
        <div className="min-w-0 space-y-6">
          <div>
            <div className="font-mono text-sm text-zinc-500">{task.ref}</div>
            {editing ? (
              <div className="mt-2 space-y-3">
                <Input value={editing.title} onChange={(e) => setEditing({ ...editing, title: e.target.value })} className="text-lg font-semibold" />
                <Textarea rows={10} value={editing.description} onChange={(e) => setEditing({ ...editing, description: e.target.value })} />
                <div className="flex justify-end gap-2">
                  <Button onClick={() => setEditing(null)}>Cancel</Button>
                  <Button variant="primary" loading={update.isPending} onClick={() => update.mutate(editing)}>
                    Save
                  </Button>
                </div>
              </div>
            ) : (
              <>
                <div className="mt-1 flex items-start gap-2">
                  <h1 className="flex-1 text-2xl font-semibold tracking-tight">{task.title}</h1>
                  {task.can.edit && (
                    <Button variant="ghost" size="sm" onClick={() => setEditing({ title: task.title, description: task.description })}>
                      <Pencil className="size-3.5" /> Edit
                    </Button>
                  )}
                </div>
                {task.description ? (
                  <Markdown className="mt-3">{task.description}</Markdown>
                ) : (
                  <p className="mt-3 text-sm text-zinc-400">No description.</p>
                )}
              </>
            )}
          </div>

          {task.sourceComments.length > 0 && (
            <section className="space-y-2">
              <h2 className="text-sm font-semibold text-zinc-700">Review feedback this task addresses</h2>
              {task.sourceComments.map((c) => (
                <Card key={c.id} className="flex gap-3 p-3">
                  {c.snapshotUrl && (
                    <a href={c.snapshotUrl} target="_blank" rel="noreferrer" className="shrink-0">
                      <img src={c.snapshotUrl} alt="Annotated frame" className="h-24 w-40 rounded border border-zinc-200 bg-zinc-900 object-contain" />
                    </a>
                  )}
                  <div className="min-w-0 flex-1 space-y-1">
                    <div className="flex items-center gap-2 text-xs text-zinc-500">
                      <UserChip user={c.author} />
                      <Link to={reviewRefPath(c.reviewRef) + `?comment=${c.id}`} className="font-mono hover:underline">
                        {c.reviewRef}
                      </Link>
                      {c.timestampMs != null && <span>@ {formatTimestamp(c.timestampMs)}</span>}
                      <CommentStatusBadge status={c.status} />
                    </div>
                    <Markdown>{c.body}</Markdown>
                  </div>
                </Card>
              ))}
            </section>
          )}

          <section className="space-y-3">
            <h2 className="text-sm font-semibold text-zinc-700">Activity</h2>
            <ol className="space-y-3">
              {task.activity.map((a) =>
                a.kind === "comment" ? (
                  <li key={a.id} className="flex gap-3">
                    <Avatar user={a.actor} />
                    <Card className="min-w-0 flex-1 px-3 py-2">
                      <div className="mb-1 text-xs text-zinc-500">
                        <span className="font-medium text-zinc-800">{a.actor.name}</span> · {timeAgo(a.createdAt)}
                      </div>
                      <Markdown>{a.body}</Markdown>
                    </Card>
                  </li>
                ) : (
                  <li key={a.id} className="flex items-center gap-3 pl-1 text-xs text-zinc-500">
                    <Avatar user={a.actor} size="sm" />
                    <span>
                      <span className="font-medium text-zinc-700">{a.actor.name}</span> {describeActivity(a, names)} · {timeAgo(a.createdAt)}
                    </span>
                  </li>
                ),
              )}
            </ol>
            {task.can.comment && (
              <div className="space-y-2">
                <Textarea rows={3} placeholder="Leave a comment (markdown)…" value={comment} onChange={(e) => setComment(e.target.value)} />
                <div className="flex justify-end">
                  <Button variant="primary" disabled={!comment.trim()} loading={addComment.isPending} onClick={() => addComment.mutate()}>
                    Comment
                  </Button>
                </div>
              </div>
            )}
            <ErrorBox error={addComment.error} />
          </section>
        </div>

        <aside className="space-y-4">
          <Card className="space-y-4 p-4">
            <Field label="Status">
              <Select
                value={task.status}
                disabled={!task.can.updateStatus}
                onChange={(e) => update.mutate({ status: e.target.value })}
              >
                {TASK_STATUSES.map((s) => (
                  <option key={s} value={s}>
                    {TASK_STATUS_LABELS[s]}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Assignee">
              {task.can.edit ? (
                <Select value={task.assignee?.id ?? ""} onChange={(e) => update.mutate({ assigneeId: e.target.value || null })}>
                  <option value="">Unassigned</option>
                  {task.assignee && !assignable.some((m) => m.user.id === task.assignee!.id) && (
                    <option value={task.assignee.id}>{task.assignee.name}</option>
                  )}
                  {assignable.map((m) => (
                    <option key={m.user.id} value={m.user.id}>
                      {m.user.name}
                      {m.user.kind === "agent" ? " (agent)" : ""}
                    </option>
                  ))}
                </Select>
              ) : (
                <div className="py-1">
                  <UserChip user={task.assignee} />
                </div>
              )}
            </Field>
            <Field label="Priority">
              <Select value={task.priority} disabled={!task.can.edit} onChange={(e) => update.mutate({ priority: e.target.value as TaskPriority })}>
                {TASK_PRIORITIES.map((p) => (
                  <option key={p} value={p}>
                    {p}
                  </option>
                ))}
              </Select>
            </Field>
            <ErrorBox error={update.error} />
            <div className="space-y-1 border-t border-zinc-100 pt-3 text-xs text-zinc-500">
              <div>
                Created by <span className="text-zinc-700">{task.createdBy.name}</span> {timeAgo(task.createdAt)}
              </div>
              {task.sourceReview && (
                <div>
                  From review{" "}
                  <Link to={reviewRefPath(task.sourceReview.ref)} className="text-accent-600 hover:underline">
                    {task.sourceReview.ref}
                  </Link>
                </div>
              )}
              {task.completedAt && <div>Completed {timeAgo(task.completedAt)}</div>}
            </div>
          </Card>
          <Card className="p-4">
            <div className="mb-2 text-sm font-semibold text-zinc-700">Deliveries</div>
            {task.deliveries.length ? (
              <ul className="space-y-2">
                {task.deliveries.map((d) => (
                  <li key={d.id}>
                    <Link to={reviewRefPath(d.ref)} className="flex items-center gap-2 text-sm hover:underline">
                      <span className="font-mono text-xs text-zinc-500">{d.ref}</span>
                      <span className="min-w-0 flex-1 truncate">{d.title}</span>
                      <ReviewStatusBadge status={d.status} />
                    </Link>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-xs text-zinc-400">
                Review kits submitted for this task (e.g. <code>rev review create --task {task.ref}</code>) show up here.
              </p>
            )}
          </Card>
        </aside>
      </div>
    </div>
  );
}
