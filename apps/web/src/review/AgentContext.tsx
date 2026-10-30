import { useState } from "react";
import { formatTimestamp, FRAME_SHEET, type CommentFrames, type ReviewCommentInfo } from "@rev/shared";
import { Modal } from "../components/ui";
import { cx } from "../lib";

/**
 * The images an agent receives with a comment, shown to the people writing and
 * deciding on it: the snapshot (frame + numbered marks) and, for video, the
 * sheet of frames around the moment. Click either to see it full size.
 */
export function AgentContext({ comment, size = "md" }: { comment: ReviewCommentInfo; size?: "sm" | "md" }) {
  const [open, setOpen] = useState<"snapshot" | "frames" | null>(null);
  if (!comment.snapshotUrl && !comment.frames) return null;
  const thumb = cx("rounded border border-zinc-200 bg-zinc-900 object-contain", size === "sm" ? "h-10" : "h-16");
  const at = comment.timestampMs != null ? ` at ${formatTimestamp(comment.timestampMs, true)}` : "";
  return (
    <div className="mt-2 flex items-start gap-2">
      {comment.snapshotUrl && (
        <button className="group text-left" onClick={() => setOpen("snapshot")} title="The frame with the marks drawn, as the agent receives it">
          <img src={comment.snapshotUrl} alt="Annotated snapshot" loading="lazy" className={thumb} />
          {size === "md" && <span className="text-[10px] text-zinc-500 group-hover:text-zinc-800">Snapshot</span>}
        </button>
      )}
      {comment.frames && size === "md" && (
        <button className="group text-left" onClick={() => setOpen("frames")} title="Frames around this moment, as the agent receives them">
          <img src={comment.frames.url} alt="Frames around the moment" loading="lazy" className={thumb} />
          <span className="text-[10px] text-zinc-500 group-hover:text-zinc-800">Frames ±1 s</span>
        </button>
      )}
      {open === "snapshot" && (
        <Modal title={`Snapshot${at}`} wide="xl" onClose={() => setOpen(null)}>
          <img src={comment.snapshotUrl!} alt="Annotated snapshot" className="w-full rounded bg-zinc-900" />
          <p className="text-xs text-zinc-500">The agent receives this image with the comment, along with each mark's position as a share of the frame.</p>
        </Modal>
      )}
      {open === "frames" && comment.frames && (
        <Modal title={`Frames around ${formatTimestamp(comment.timestampMs ?? 0, true)}`} wide="xl" onClose={() => setOpen(null)}>
          <FrameSheet frames={comment.frames} />
          <p className="text-xs text-zinc-500">
            The agent receives this sheet with the times listed, so it can judge motion and timing. The commented moment is outlined in red.
          </p>
        </Modal>
      )}
    </div>
  );
}

/** The frame sheet with each frame's time laid over it. */
export function FrameSheet({ frames }: { frames: CommentFrames }) {
  return (
    <div className="relative">
      <img src={frames.url} alt="Frames around the moment" className="w-full rounded bg-zinc-900" />
      <div className="absolute inset-0 grid" style={{ gridTemplateColumns: `repeat(${FRAME_SHEET.cols}, 1fr)`, gridTemplateRows: `repeat(${FRAME_SHEET.rows}, 1fr)` }}>
        {frames.timesMs.map((t, i) => (
          <div key={i} className="relative">
            <span
              className={cx(
                "absolute bottom-2 left-2 rounded px-1.5 py-0.5 font-mono text-[11px] text-white",
                i === frames.markedIndex ? "bg-red-600" : "bg-black/70",
              )}
            >
              {formatTimestamp(t, true)}
              {i === frames.markedIndex && " · comment"}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}
