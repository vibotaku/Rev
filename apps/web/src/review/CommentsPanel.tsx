import { useState } from "react";
import { Check, CornerDownRight, Crosshair, ListTodo, MessageSquare, RotateCcw, X } from "lucide-react";
import { Link } from "react-router";
import { formatTimestamp, type ReviewAssetInfo, type ReviewCommentInfo, type ReviewDetail } from "@rev/shared";
import { Avatar, Button, CommentStatusBadge, Markdown, TaskStatusBadge, Textarea } from "../components/ui";
import { cx, taskPath, timeAgo } from "../lib";

type Decision = "accepted" | "rejected" | "open";

interface Handlers {
  review: ReviewDetail;
  meId: string;
  selectedId: string | null;
  checkedIds: Set<string>;
  repliesOf: Map<string, ReviewCommentInfo[]>;
  onSelect: (c: ReviewCommentInfo) => void;
  onCheck: (id: string, checked: boolean) => void;
  onDecide: (id: string, status: Decision) => void;
  onReply: (parentId: string, body: string) => Promise<unknown>;
  onDelete: (id: string) => void;
}

/** Accept / Reject / Reopen for anything the owner decides on: overall comments and mark notes alike. */
function DecisionButtons({ comment, onDecide }: { comment: ReviewCommentInfo; onDecide: (s: Decision) => void }) {
  if (comment.task) return null;
  return (
    <>
      {comment.status !== "accepted" && (
        <Button size="sm" variant="ghost" className="text-sky-700" onClick={() => onDecide("accepted")}>
          <Check className="size-3.5" /> Accept
        </Button>
      )}
      {comment.status !== "rejected" && (
        <Button size="sm" variant="ghost" className="text-red-600" onClick={() => onDecide("rejected")}>
          <X className="size-3.5" /> Reject
        </Button>
      )}
      {comment.status !== "open" && (
        <Button size="sm" variant="ghost" onClick={() => onDecide("open")}>
          <RotateCcw className="size-3.5" /> Reopen
        </Button>
      )}
    </>
  );
}

function TaskLink({ comment }: { comment: ReviewCommentInfo }) {
  if (!comment.task) return null;
  return (
    <Link to={taskPath(comment.task.ref)} className="inline-flex items-center gap-1.5 text-xs text-accent-700 hover:underline">
      <ListTodo className="size-3.5" /> {comment.task.ref}
      <TaskStatusBadge status={comment.task.status} closureReview={comment.task.closureReview} />
    </Link>
  );
}

function Replies({ replies, meId, onDelete }: { replies: ReviewCommentInfo[]; meId: string; onDelete: (id: string) => void }) {
  if (!replies.length) return null;
  return (
    <div className="mt-2 space-y-2 border-l-2 border-zinc-100 pl-3">
      {replies.map((r) => (
        <div key={r.id} className="flex gap-2">
          <Avatar user={r.author} size="sm" />
          <div className="min-w-0 flex-1">
            <div className="text-xs text-zinc-500">
              <span className="font-medium text-zinc-800">{r.author.name}</span> · {timeAgo(r.createdAt)}
              {r.author.id === meId && (
                <button className="ml-2 text-zinc-400 hover:text-red-600" onClick={() => onDelete(r.id)}>
                  delete
                </button>
              )}
            </div>
            <Markdown>{r.body}</Markdown>
          </div>
        </div>
      ))}
    </div>
  );
}

function ReplyBox({ onSend, onCancel }: { onSend: (body: string) => Promise<unknown>; onCancel: () => void }) {
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  return (
    <div className="mt-2 space-y-2">
      <Textarea rows={2} value={text} onChange={(e) => setText(e.target.value)} placeholder="Reply…" autoFocus />
      <div className="flex justify-end gap-2">
        <Button size="sm" onClick={onCancel}>
          Cancel
        </Button>
        <Button
          size="sm"
          variant="primary"
          disabled={!text.trim()}
          loading={sending}
          onClick={async () => {
            setSending(true);
            try {
              await onSend(text);
              setText("");
              onCancel();
            } finally {
              setSending(false);
            }
          }}
        >
          Reply
        </Button>
      </div>
    </div>
  );
}

function TaskCheckbox({ comment, h }: { comment: ReviewCommentInfo; h: Handlers }) {
  if (!h.review.can.decide || comment.task || comment.status === "rejected") return null;
  return (
    <input
      type="checkbox"
      className="mt-1 accent-indigo-600"
      checked={h.checkedIds.has(comment.id)}
      onChange={(e) => h.onCheck(comment.id, e.target.checked)}
      title="Select for a new task"
    />
  );
}

/** A note on one mark (pin, box, …): decided, tasked and discussed on its own. */
function MarkComment({ mark, color, h }: { mark: ReviewCommentInfo; color: string; h: Handlers }) {
  const [replying, setReplying] = useState(false);
  const selected = h.selectedId === mark.id;
  return (
    <div id={`comment-${mark.id}`} className={cx("rounded-md border p-2", selected ? "border-accent-500 bg-accent-50/40" : "border-zinc-100 bg-zinc-50/60")}>
      <div className="flex items-start gap-2">
        <TaskCheckbox comment={mark} h={h} />
        <button
          onClick={() => h.onSelect(mark)}
          title="Show this mark"
          className="mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full text-[11px] font-bold text-white ring-1 ring-black/20"
          style={{ background: color }}
        >
          {mark.markIndex}
        </button>
        <div className="min-w-0 flex-1">
          <Markdown className="!text-[13px]">{mark.body}</Markdown>
          <div className="mt-1 flex flex-wrap items-center gap-2">
            <CommentStatusBadge status={mark.status} />
            <TaskLink comment={mark} />
            {mark.decidedBy && mark.status !== "open" && <span className="text-[11px] text-zinc-400">by {mark.decidedBy.name}</span>}
          </div>
        </div>
      </div>
      <Replies replies={h.repliesOf.get(mark.id) ?? []} meId={h.meId} onDelete={h.onDelete} />
      <div className="mt-1 flex flex-wrap items-center gap-1 pl-7">
        {h.review.can.comment && (
          <Button size="sm" variant="ghost" onClick={() => setReplying((v) => !v)}>
            <CornerDownRight className="size-3.5" /> Reply
          </Button>
        )}
        {h.review.can.decide && <DecisionButtons comment={mark} onDecide={(s) => h.onDecide(mark.id, s)} />}
      </div>
      {replying && <ReplyBox onSend={(b) => h.onReply(mark.id, b)} onCancel={() => setReplying(false)} />}
    </div>
  );
}

export function CommentCard({
  comment,
  marks,
  asset,
  showAsset,
  ...h
}: Handlers & {
  comment: ReviewCommentInfo;
  /** Notes on individual marks of this comment, ordered by mark number. */
  marks: ReviewCommentInfo[];
  asset: ReviewAssetInfo | undefined;
  showAsset: boolean;
}) {
  const [replying, setReplying] = useState(false);
  const shapes = comment.annotation?.shapes ?? [];
  const located = comment.timestampMs != null || shapes.length > 0;
  const selected = h.selectedId === comment.id;

  return (
    <div
      id={`comment-${comment.id}`}
      className={cx("rounded-lg border bg-white p-3 transition-colors", selected ? "border-accent-500 ring-2 ring-accent-100" : "border-zinc-200")}
    >
      <div className="flex items-start gap-2">
        <TaskCheckbox comment={comment} h={h} />
        <Avatar user={comment.author} />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-zinc-500">
            <span className="font-medium text-zinc-800">{comment.author.name}</span>
            <span>{timeAgo(comment.createdAt)}</span>
            <CommentStatusBadge status={comment.status} />
          </div>
          {(located || (showAsset && asset)) && (
            <button
              className="mt-1 inline-flex items-center gap-1 rounded bg-zinc-100 px-1.5 py-0.5 text-xs text-zinc-700 hover:bg-zinc-200"
              onClick={() => h.onSelect(comment)}
            >
              <Crosshair className="size-3" />
              {showAsset && asset && <span className="max-w-32 truncate">{asset.filename}</span>}
              {comment.timestampMs != null && <span className="font-mono">@ {formatTimestamp(comment.timestampMs)}</span>}
              {shapes.length > 0 && (
                <span>
                  · {shapes.length} mark{shapes.length > 1 ? "s" : ""}
                </span>
              )}
            </button>
          )}
          <Markdown className="mt-1">{comment.body}</Markdown>
          <div className="mt-1 flex flex-wrap items-center gap-2">
            <TaskLink comment={comment} />
            {comment.decidedBy && comment.status !== "open" && (
              <span className="text-[11px] text-zinc-400">
                {comment.status} by {comment.decidedBy.name}
              </span>
            )}
          </div>
        </div>
      </div>

      {marks.length > 0 && (
        <div className="mt-2 space-y-1.5">
          {marks.map((m) => (
            <MarkComment key={m.id} mark={m} color={shapes[(m.markIndex ?? 1) - 1]?.color ?? "#71717a"} h={h} />
          ))}
        </div>
      )}

      <Replies replies={h.repliesOf.get(comment.id) ?? []} meId={h.meId} onDelete={h.onDelete} />

      <div className="mt-2 flex flex-wrap items-center gap-1">
        {h.review.can.comment && (
          <Button size="sm" variant="ghost" onClick={() => setReplying((v) => !v)}>
            <CornerDownRight className="size-3.5" /> Reply
          </Button>
        )}
        {h.review.can.decide && <DecisionButtons comment={comment} onDecide={(s) => h.onDecide(comment.id, s)} />}
        {comment.author.id === h.meId && !comment.task && !marks.some((m) => m.task) && (
          <button className="ml-auto text-xs text-zinc-400 hover:text-red-600" onClick={() => h.onDelete(comment.id)}>
            delete
          </button>
        )}
      </div>
      {replying && <ReplyBox onSend={(b) => h.onReply(comment.id, b)} onCancel={() => setReplying(false)} />}
    </div>
  );
}

export function EmptyComments() {
  return (
    <div className="flex flex-col items-center gap-2 px-4 py-10 text-center text-sm text-zinc-400">
      <MessageSquare className="size-6" />
      No comments in this round yet. Pick a tool above the media to mark something, add a note per mark if you like, and write
      an overall comment below.
    </div>
  );
}
