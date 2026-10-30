import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { formatTimestamp, TASK_PRIORITIES, type ReviewCommentInfo, type ReviewDetail, type TaskDetail, type TaskPriority } from "@rev/shared";
import { api } from "../api";
import { Button, ErrorBox, Field, Input, Modal, Select, Textarea } from "../components/ui";
import { useMembers } from "../pages/Project";

function composeDescription(review: ReviewDetail, comments: ReviewCommentInfo[]) {
  const assetName = new Map(review.assets.map((a) => [a.id, a.filename]));
  const lines = [`From review **${review.ref}** — ${review.title}`, ""];
  for (const c of comments) {
    const where = [c.assetId ? assetName.get(c.assetId) : null, c.timestampMs != null ? `@ ${formatTimestamp(c.timestampMs)}` : null]
      .filter(Boolean)
      .join(" ");
    const mark = c.markIndex != null ? `mark #${c.markIndex}: ` : "";
    lines.push(`- ${where ? `*${where}*: ` : ""}${mark}${c.body.replace(/\n+/g, " ")}`);
    // Notes on this comment's marks, unless rejected or picked separately.
    review.comments
      .filter((m) => m.markOf === c.id && m.status !== "rejected" && !comments.some((x) => x.id === m.id))
      .sort((a, b) => a.markIndex! - b.markIndex!)
      .forEach((m) => lines.push(`  - mark #${m.markIndex}: ${m.body.replace(/\n+/g, " ")}`));
  }
  if (comments.length) lines.push("", "Annotated snapshots (and frames around video moments) are attached to the task via its source comments.");
  return lines.join("\n");
}

/**
 * The review owner's hand-off: selected comments become one task, assigned by
 * default to the agent that submitted the review.
 */
export function CreateTaskDialog({
  review,
  comments,
  onClose,
  onCreated,
}: {
  review: ReviewDetail;
  comments: ReviewCommentInfo[];
  onClose: () => void;
  onCreated: (task: TaskDetail) => void;
}) {
  const { data: members } = useMembers(review.projectKey);
  const assignable = (members ?? []).filter((m) => review.can.assignableUserIds.includes(m.user.id));
  const defaultAssignee = review.can.assignableUserIds.includes(review.createdBy.id) ? review.createdBy.id : "";
  const first = comments[0]?.body.split("\n")[0] ?? review.title;
  const [title, setTitle] = useState(first.length > 90 ? `${first.slice(0, 87)}…` : first);
  const [description, setDescription] = useState(() => composeDescription(review, comments));
  const [assigneeId, setAssigneeId] = useState(defaultAssignee);
  const [priority, setPriority] = useState<TaskPriority>("medium");
  const create = useMutation({
    mutationFn: () =>
      api.post<TaskDetail>(`/api/reviews/${review.id}/tasks`, {
        commentIds: comments.map((c) => c.id),
        title,
        description,
        priority,
        assigneeId: assigneeId || null,
      }),
    onSuccess: onCreated,
  });

  return (
    <Modal
      title={comments.length ? `Create task from ${comments.length} comment${comments.length > 1 ? "s" : ""}` : "Create task from review"}
      wide
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" disabled={!title.trim()} loading={create.isPending} onClick={() => create.mutate()}>
            Create {assigneeId ? "& assign" : "task"}
          </Button>
        </>
      }
    >
      {comments.some((c) => c.status === "open") && (
        <p className="rounded-md bg-sky-50 px-3 py-2 text-sm text-sky-800">Open comments included here will be marked accepted.</p>
      )}
      <Field label="Title">
        <Input value={title} onChange={(e) => setTitle(e.target.value)} autoFocus />
      </Field>
      <Field label="Description" hint="Agents also receive each comment's annotation and snapshot.">
        <Textarea rows={8} value={description} onChange={(e) => setDescription(e.target.value)} className="font-mono text-xs" />
      </Field>
      <div className="grid grid-cols-2 gap-4">
        <Field label="Assign to" hint="You can assign agents linked to you (project owners: any agent).">
          <Select value={assigneeId} onChange={(e) => setAssigneeId(e.target.value)}>
            <option value="">Unassigned</option>
            {assignable.map((m) => (
              <option key={m.user.id} value={m.user.id}>
                {m.user.name}
                {m.user.kind === "agent" ? " (agent)" : ""}
                {m.user.id === review.createdBy.id ? " — submitted this review" : ""}
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
