import { useState } from "react";
import { Check, CornerDownRight, Crosshair, ListTodo, MessageSquare, RotateCcw, X } from "lucide-react";
import { Link } from "react-router";
import { formatTimestamp, type ReviewAssetInfo, type ReviewCommentInfo, type ReviewDetail } from "@rev/shared";
import { Avatar, Button, CommentStatusBadge, Markdown, TaskStatusBadge, Textarea } from "../components/ui";
import { cx, taskPath, timeAgo } from "../lib";

export function CommentCard({
  comment,
  replies,
  review,
  asset,
  showAsset,
  selected,
  checked,
  onSelect,
  onCheck,
  onDecide,
  onReply,
  onDelete,
  meId,
}: {
  comment: ReviewCommentInfo;
  replies: ReviewCommentInfo[];
  review: ReviewDetail;
  asset: ReviewAssetInfo | undefined;
  showAsset: boolean;
  selected: boolean;
  checked: boolean;
  onSelect: () => void;
  onCheck: (v: boolean) => void;
  onDecide: (status: "accepted" | "rejected" | "open") => void;
  onReply: (body: string) => Promise<unknown>;
  onDelete: (id: string) => void;
  meId: string;
}) {
  const [replying, setReplying] = useState(false);
  const [reply, setReply] = useState("");
  const [sending, setSending] = useState(false);
  const decide = review.can.decide;
  const selectable = decide && !comment.task && comment.status !== "rejected";
  const located = comment.timestampMs != null || !!comment.annotation?.shapes.length;

  return (
    <div
      id={`comment-${comment.id}`}
      className={cx("rounded-lg border bg-white p-3 transition-colors", selected ? "border-accent-500 ring-2 ring-accent-100" : "border-zinc-200")}
    >
      <div className="flex items-start gap-2">
        {selectable && (
          <input
            type="checkbox"
            className="mt-1.5 accent-indigo-600"
            checked={checked}
            onChange={(e) => onCheck(e.target.checked)}
            title="Select for a new task"
          />
        )}
        <Avatar user={comment.author} />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-zinc-500">
            <span className="font-medium text-zinc-800">{comment.author.name}</span>
            <span>{timeAgo(comment.createdAt)}</span>
            <CommentStatusBadge status={comment.status} />
          </div>
          {(located || (showAsset && asset)) && (
            <button className="mt-1 inline-flex items-center gap-1 rounded bg-zinc-100 px-1.5 py-0.5 text-xs text-zinc-700 hover:bg-zinc-200" onClick={onSelect}>
              <Crosshair className="size-3" />
              {showAsset && asset && <span className="max-w-32 truncate">{asset.filename}</span>}
              {comment.timestampMs != null && <span className="font-mono">@ {formatTimestamp(comment.timestampMs)}</span>}
              {!!comment.annotation?.shapes.length && (
                <span>
                  · {comment.annotation.shapes.length} mark{comment.annotation.shapes.length > 1 ? "s" : ""}
                </span>
              )}
            </button>
          )}
          <Markdown className="mt-1">{comment.body}</Markdown>
          {comment.task && (
            <Link to={taskPath(comment.task.ref)} className="mt-1 inline-flex items-center gap-1.5 text-xs text-accent-700 hover:underline">
              <ListTodo className="size-3.5" /> {comment.task.ref}
              <TaskStatusBadge status={comment.task.status} closureReview={comment.task.closureReview} />
            </Link>
          )}
          {comment.decidedBy && comment.status !== "open" && (
            <div className="mt-1 text-[11px] text-zinc-400">
              {comment.status} by {comment.decidedBy.name}
            </div>
          )}
        </div>
      </div>

      {replies.length > 0 && (
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
      )}

      <div className="mt-2 flex flex-wrap items-center gap-1">
        {review.can.comment && (
          <Button size="sm" variant="ghost" onClick={() => setReplying((v) => !v)}>
            <CornerDownRight className="size-3.5" /> Reply
          </Button>
        )}
        {decide && !comment.task && (
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
        )}
        {comment.author.id === meId && !comment.task && (
          <button className="ml-auto text-xs text-zinc-400 hover:text-red-600" onClick={() => onDelete(comment.id)}>
            delete
          </button>
        )}
      </div>
      {replying && (
        <div className="mt-2 space-y-2">
          <Textarea rows={2} value={reply} onChange={(e) => setReply(e.target.value)} placeholder="Reply…" autoFocus />
          <div className="flex justify-end gap-2">
            <Button size="sm" onClick={() => setReplying(false)}>
              Cancel
            </Button>
            <Button
              size="sm"
              variant="primary"
              disabled={!reply.trim()}
              loading={sending}
              onClick={async () => {
                setSending(true);
                try {
                  await onReply(reply);
                  setReply("");
                  setReplying(false);
                } finally {
                  setSending(false);
                }
              }}
            >
              Reply
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

export function EmptyComments() {
  return (
    <div className="flex flex-col items-center gap-2 px-4 py-10 text-center text-sm text-zinc-400">
      <MessageSquare className="size-6" />
      No comments yet. Pick a tool above the media to mark something, then describe it below.
    </div>
  );
}
