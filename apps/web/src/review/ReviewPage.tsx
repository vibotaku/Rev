import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ArrowLeft,
  ArrowUpRight,
  Bot,
  Circle,
  Clock,
  Eraser,
  Film,
  Image as ImageIcon,
  ListTodo,
  MousePointer2,
  Pencil,
  Plus,
  Square,
  Trash2,
  Undo2,
} from "lucide-react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router";
import {
  formatTimestamp,
  MEDIA_EXTENSIONS,
  type ReviewCommentInfo,
  type ReviewDetail,
  type ReviewStatus,
  type Shape,
} from "@rev/shared";
import { api, upload } from "../api";
import { useUser } from "../auth";
import { Button, ErrorBox, Input, Markdown, PageLoader, ReviewStatusBadge, Select, Spinner, TaskStatusBadge, Textarea, UserChip } from "../components/ui";
import { cx, taskPath, timeAgo } from "../lib";
import { useMembers } from "../pages/Project";
import { CommentCard, EmptyComments } from "./CommentsPanel";
import { CreateTaskDialog } from "./CreateTaskDialog";
import { MARKS_VISIBLE_S, MediaStage, type Overlay } from "./MediaStage";
import { NewRoundDialog, RoundCard, RoundTabs } from "./Rounds";
import { COLORS, renderSnapshot, type Tool } from "./shapes";

const TOOLS: { id: Tool; icon: React.ReactNode; label: string; key: string }[] = [
  { id: "none", icon: <MousePointer2 className="size-4" />, label: "Select / play (V)", key: "v" },
  { id: "pin", icon: <Circle className="size-4" />, label: "Pin (P)", key: "p" },
  { id: "rect", icon: <Square className="size-4" />, label: "Box (B)", key: "b" },
  { id: "arrow", icon: <ArrowUpRight className="size-4" />, label: "Arrow (A)", key: "a" },
  { id: "pen", icon: <Pencil className="size-4" />, label: "Draw (D)", key: "d" },
];

/** Closer than this (s) to a comment's time counts as its own frame; further off, its marks are drawn faded. */
const ON_FRAME_S = 0.02;

function isTyping(e: KeyboardEvent) {
  const t = e.target as HTMLElement;
  return t.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(t.tagName);
}

/** Seeks a video and resolves once the new frame can be drawn (or after 3 s). */
function seekTo(v: HTMLVideoElement, seconds: number) {
  return new Promise<void>((resolve) => {
    const done = () => {
      clearTimeout(timer);
      v.removeEventListener("seeked", done);
      resolve();
    };
    const timer = setTimeout(done, 3000);
    v.addEventListener("seeked", done);
    v.currentTime = seconds;
  });
}

export function ReviewPage() {
  const { key, number } = useParams();
  const ref = `${key}-R${number}`;
  const me = useUser();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const queryKey = ["review", ref];
  const { data: review, isLoading, error } = useQuery({
    queryKey,
    queryFn: () => api.get<ReviewDetail>(`/api/reviews/${ref}`),
    refetchInterval: (q) => (q.state.data?.assets.some((a) => a.status === "processing") ? 2_000 : 15_000),
  });
  const { data: members } = useMembers(key);

  const [assetId, setAssetId] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(params.get("comment"));
  const [tool, setTool] = useState<Tool>("none");
  const [color, setColor] = useState(COLORS[0]!);
  const [draft, setDraftShapes] = useState<Shape[]>([]);
  /** One optional note per draft mark (same order as `draft`). */
  const [markNotes, setMarkNotes] = useState<string[]>([]);
  const [body, setBody] = useState("");
  const [creatingRound, setCreatingRound] = useState(false);
  const markInputs = useRef<(HTMLInputElement | null)[]>([]);
  /** Video time (s) at which the first draft mark was drawn: the comment is pinned to that frame. */
  const [draftAt, setDraftAt] = useState<number | null>(null);
  const setDraft = useCallback((shapes: Shape[]) => {
    setDraftShapes(shapes);
    setMarkNotes((notes) => shapes.map((_, i) => notes[i] ?? ""));
    const media = mediaRef.current;
    setDraftAt((at) => (shapes.length && media instanceof HTMLVideoElement ? (at ?? media.currentTime) : null));
  }, []);
  useEffect(() => {
    if (!draft.length) setDraftAt(null);
  }, [draft.length]);
  const [attachTime, setAttachTime] = useState(true);
  const [time, setTime] = useState(0);
  const [scope, setScope] = useState<"asset" | "all">("asset");
  const [statusFilter, setStatusFilter] = useState("all");
  const [checked, setChecked] = useState<Set<string>>(new Set());
  const [creatingTask, setCreatingTask] = useState(false);
  const [editing, setEditing] = useState<{ title: string; description: string } | null>(null);
  const [uploading, setUploading] = useState<{ name: string; progress: number } | null>(null);
  const mediaRef = useRef<HTMLVideoElement | HTMLImageElement | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  const comments = review?.comments ?? [];
  const selectedComment = comments.find((c) => c.id === selectedId) ?? null;
  // Round shown: ?round=N, else the latest submitted round (or a later draft you are putting together).
  const defaultRound = review?.rounds.filter((r) => r.submittedAt || r.createdBy.id === me.id).at(-1)?.number ?? 1;
  const roundNumber = Number(params.get("round")) || defaultRound;
  const round = review?.rounds.find((r) => r.number === roundNumber) ?? review?.rounds.at(-1);
  const roundAssets = review?.assets.filter((a) => a.roundNumber === round?.number) ?? [];
  const asset = roundAssets.find((a) => a.id === assetId) ?? roundAssets[0] ?? null;
  const setRound = (n: number) => {
    setAssetId(null);
    setDraft([]);
    setSelectedId(null);
    setParams(
      (p) => {
        p.set("round", String(n));
        p.delete("comment");
        return p;
      },
      { replace: true },
    );
  };

  // Deep links (?comment=) open the comment's media.
  useEffect(() => {
    if (!review || assetId) return;
    const target = review.comments.find((c) => c.id === params.get("comment"));
    // Deep links open the comment's round too.
    if (target && !params.get("round") && target.roundNumber !== defaultRound) {
      setParams(
        (p) => {
          p.set("round", String(target.roundNumber));
          return p;
        },
        { replace: true },
      );
    }
    if (target?.assetId) setAssetId(target.assetId);
  }, [review, assetId, params, defaultRound, setParams]);

  // Seek to the selected comment once its video is ready.
  useEffect(() => {
    const v = mediaRef.current;
    if (!selectedComment || selectedComment.timestampMs == null || !(v instanceof HTMLVideoElement)) return;
    if (selectedComment.assetId !== asset?.id) return;
    const seek = () => {
      v.pause();
      v.currentTime = selectedComment.timestampMs! / 1000;
    };
    if (v.readyState >= 1) seek();
    else v.addEventListener("loadedmetadata", seek, { once: true });
    document.getElementById(`comment-${selectedComment.id}`)?.scrollIntoView({ block: "nearest", behavior: "smooth" });
    return () => v.removeEventListener("loadedmetadata", seek);
  }, [selectedComment, asset?.id]);

  const selectComment = useCallback(
    (c: ReviewCommentInfo) => {
      if (c.id !== selectedId) setDraft([]);
      setSelectedId(c.id);
      if (c.assetId && c.assetId !== asset?.id) setAssetId(c.assetId);
      // Picking the selected comment again goes back to its frame (the effect above only runs on a change).
      const v = mediaRef.current;
      if (c.assetId === asset?.id && c.timestampMs != null && v instanceof HTMLVideoElement && v.readyState >= 1) {
        v.pause();
        v.currentTime = c.timestampMs / 1000;
      }
      setParams((p) => {
        p.set("comment", c.id);
        return p;
      }, { replace: true });
    },
    [asset?.id, selectedId, setDraft, setParams],
  );

  const refresh = (r?: ReviewDetail) => {
    if (r) qc.setQueryData(queryKey, r);
    else qc.invalidateQueries({ queryKey });
    qc.invalidateQueries({ queryKey: ["reviews", key] });
    qc.invalidateQueries({ queryKey: ["dashboard"] });
  };

  // What the comment will carry for the agent, spelled out in the composer.
  const withTime = asset?.kind === "video" && (attachTime || draft.length > 0);
  const pinnedAt = draft.length && draftAt != null ? draftAt : time;
  const moved = draft.length > 0 && draftAt != null && Math.abs(time - draftAt) > ON_FRAME_S;
  const agentGets = [
    withTime && "the exact time",
    draft.length > 0 && (draft.length > 1 ? "each mark's position and note" : "the mark's position and note"),
    (withTime || draft.length > 0) && `a snapshot of this frame${draft.length ? " with the marks drawn" : ""}`,
    withTime && "the frames from 1 s before to 1 s after (to judge motion)",
  ].filter((x): x is string => !!x);

  const postComment = useMutation({
    mutationFn: async () => {
      const media = mediaRef.current;
      const isVideo = asset?.kind === "video" && media instanceof HTMLVideoElement;
      if (isVideo && !media.paused) media.pause();
      // Marks belong to the frame they were drawn on, even if the video moved since.
      const at = !isVideo ? null : draft.length ? (draftAt ?? media.currentTime) : attachTime ? media.currentTime : null;
      if (isVideo && at != null && Math.abs(media.currentTime - at) > 0.001) await seekTo(media, at);
      const timestampMs = at != null ? Math.round(at * 1000) : null;
      const created = await api.post<ReviewCommentInfo & { marks: ReviewCommentInfo[] }>(`/api/reviews/${review!.id}/comments`, {
        body,
        assetId: asset?.id ?? null,
        timestampMs,
        annotation: draft.length ? { shapes: draft } : null,
        marks: markNotes.map((note, index) => ({ index, body: note.trim() })).filter((m) => m.body && m.index < draft.length),
        ...(asset ? {} : { round: round?.number }),
      });
      // Attach rendered frames so agents see exactly what was meant: all marks for the overall
      // comment, and just its own mark for each mark comment.
      if (media && (draft.length || timestampMs != null)) {
        const shots: [string, Shape[], number[]][] = [
          [created.id, draft, draft.map((_, i) => i + 1)],
          ...created.marks.map((m): [string, Shape[], number[]] => [m.id, [draft[m.markIndex! - 1]!], [m.markIndex!]]),
        ];
        for (const [id, shapes, labels] of shots) {
          const tag = isVideo && timestampMs != null ? formatTimestamp(timestampMs, true) : undefined;
          const blob = await renderSnapshot(media, shapes, labels, tag).catch(() => null);
          if (blob) await upload(`/api/comments/${id}/snapshot`, blob, "snapshot.jpg").catch(() => undefined);
        }
      }
      return created;
    },
    onSuccess: (c) => {
      setBody("");
      setDraft([]);
      setTool("none");
      setSelectedId(c.id);
      refresh();
    },
  });

  const decide = useMutation({
    mutationFn: ({ id, status }: { id: string; status: string }) => api.patch(`/api/comments/${id}`, { status }),
    onSuccess: () => refresh(),
  });
  const deleteComment = useMutation({
    mutationFn: (id: string) => api.del(`/api/comments/${id}`),
    onSuccess: () => refresh(),
  });
  const updateReview = useMutation({
    mutationFn: (patch: Record<string, unknown>) => api.patch<ReviewDetail>(`/api/reviews/${review!.id}`, patch),
    onSuccess: (r) => {
      refresh(r);
      setEditing(null);
    },
  });
  const deleteAsset = useMutation({
    mutationFn: (id: string) => api.del(`/api/reviews/${review!.id}/assets/${id}`),
    onSuccess: () => {
      setAssetId(null);
      refresh();
    },
  });
  const deleteReview = useMutation({
    mutationFn: () => api.del(`/api/reviews/${review!.id}`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["reviews", key] });
      navigate(`/p/${key}/reviews`);
    },
  });

  async function addFiles(files: FileList | null) {
    if (!files || !review) return;
    try {
      for (const f of Array.from(files)) {
        setUploading({ name: f.name, progress: 0 });
        await upload(`/api/reviews/${review.id}/assets?round=${round?.number ?? 1}`, f, f.name, (p) =>
          setUploading({ name: f.name, progress: p }),
        );
      }
    } catch (err) {
      alert(err instanceof Error ? err.message : String(err));
    } finally {
      setUploading(null);
      refresh();
    }
  }

  // Keyboard: tools, play/pause, frame stepping, escape.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (isTyping(e) || e.metaKey || e.ctrlKey || e.altKey) return;
      const v = mediaRef.current instanceof HTMLVideoElement ? mediaRef.current : null;
      const t = TOOLS.find((x) => x.key === e.key.toLowerCase());
      if (t) return setTool(t.id);
      if (e.key === " " && v) {
        e.preventDefault();
        if (v.paused) void v.play();
        else v.pause();
      } else if ((e.key === "ArrowLeft" || e.key === "ArrowRight") && v) {
        e.preventDefault();
        v.pause();
        v.currentTime = Math.max(0, v.currentTime + (e.key === "ArrowLeft" ? -1 : 1) / 30);
      } else if (e.key === "Escape") {
        setTool("none");
        setSelectedId(null);
      } else if (e.key === "z" && draft.length) {
        setDraft(draft.slice(0, -1));
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [draft]);

  useEffect(() => {
    if (draft.length) markInputs.current[draft.length - 1]?.focus();
  }, [draft.length]);

  // Overall comments of the round shown; mark comments are nested under them.
  const topLevel = useMemo(
    () => comments.filter((c) => !c.parentId && !c.markOf && c.roundNumber === round?.number),
    [comments, round?.number],
  );
  const marksOf = useMemo(() => {
    const m = new Map<string, ReviewCommentInfo[]>();
    for (const c of comments) if (c.markOf) m.set(c.markOf, [...(m.get(c.markOf) ?? []), c].sort((a, b) => a.markIndex! - b.markIndex!));
    return m;
  }, [comments]);
  // Everything the owner decides on (overall comments and mark notes) that is still open, per round.
  const undecided = useMemo(() => {
    const m = new Map<number, number>();
    for (const c of comments) if (!c.parentId && c.status === "open") m.set(c.roundNumber, (m.get(c.roundNumber) ?? 0) + 1);
    return m;
  }, [comments]);
  const repliesOf = useMemo(() => {
    const m = new Map<string, ReviewCommentInfo[]>();
    for (const c of comments) if (c.parentId) m.set(c.parentId, [...(m.get(c.parentId) ?? []), c]);
    return m;
  }, [comments]);

  if (isLoading) return <PageLoader />;
  if (!review) return <div className="p-8"><ErrorBox error={error} /></div>;

  // "This media" also shows general (media-less) comments. Order: media order, then timestamp, then time posted.
  const assetIndex = new Map(roundAssets.map((a, i) => [a.id, i]));
  const matchesStatus = (c: ReviewCommentInfo) =>
    statusFilter === "all" || c.status === statusFilter || (marksOf.get(c.id) ?? []).some((m) => m.status === statusFilter);
  const visible = topLevel
    .filter((c) => scope === "all" || !c.assetId || c.assetId === asset?.id)
    .filter(matchesStatus)
    .sort(
      (a, b) =>
        (assetIndex.get(a.assetId ?? "") ?? 1e9) - (assetIndex.get(b.assetId ?? "") ?? 1e9) ||
        (a.timestampMs ?? Infinity) - (b.timestampMs ?? Infinity) ||
        a.createdAt.localeCompare(b.createdAt),
    );
  const markers = topLevel
    .filter((c) => c.assetId === asset?.id && c.timestampMs != null)
    .map((c) => ({ id: c.id, timestampMs: c.timestampMs!, status: c.status, selected: c.id === selectedId }));

  // What to draw over the media: the selected comment, else (on video) every comment near the playhead.
  // Video marks only show within MARKS_VISIBLE_S of their time, faded off their exact frame.
  const isVideo = asset?.kind === "video";
  const offBy = (c: ReviewCommentInfo) => (isVideo && c.timestampMs != null ? Math.abs(c.timestampMs / 1000 - time) : 0);
  const showsHere = (c: ReviewCommentInfo) => c.assetId === asset?.id && !!c.annotation?.shapes.length && offBy(c) <= MARKS_VISIBLE_S;
  const overlayOf = (c: ReviewCommentInfo, highlight: number | null = null): Overlay => ({
    id: c.id,
    shapes: c.annotation!.shapes,
    labels: c.annotation!.shapes.map((_, i) => i + 1),
    highlight,
    timestampMs: isVideo ? c.timestampMs : null,
    faded: offBy(c) > ON_FRAME_S,
  });
  const selectedRoot = selectedComment?.markOf ? comments.find((c) => c.id === selectedComment.markOf) : selectedComment;
  let overlays: Overlay[] = [];
  if (selectedRoot && showsHere(selectedRoot)) {
    overlays = [overlayOf(selectedRoot, selectedComment?.markIndex != null ? selectedComment.markIndex - 1 : null)];
  } else if (!draft.length && isVideo) {
    overlays = topLevel.filter(showsHere).map((c) => overlayOf(c));
  }
  const draftPin = isVideo && draft.length && draftAt != null ? { timestampMs: Math.round(draftAt * 1000), faded: moved } : null;

  const checkedComments = comments.filter((c) => checked.has(c.id));
  const canChangeRound = !!round && (round.createdBy.id === me.id || review.can.decide);
  const canUpload = !!round && (round.submittedAt ? review.can.edit : canChangeRound);
  const undecidedTotal = [...undecided.values()].reduce((a, b) => a + b, 0);
  const ownerOptions = (members ?? []).filter((m) => m.user.kind === "human" && m.role !== "viewer");
  const decideActions: { label: string; status: ReviewStatus; variant?: "primary" | "danger" }[] = [];
  if (review.can.decide && (review.status === "open" || review.status === "changes_requested")) {
    if (review.status === "open") decideActions.push({ label: "Request changes", status: "changes_requested" });
    decideActions.push({ label: "Approve", status: "approved", variant: "primary" });
    decideActions.push({ label: "Close", status: "closed" });
  } else if (review.can.decide && (review.status === "approved" || review.status === "closed")) {
    decideActions.push({ label: "Reopen", status: "open" });
  } else if (!review.can.decide && review.createdBy.id === me.id && review.status !== "closed" && review.status !== "draft") {
    decideActions.push({ label: "Withdraw", status: "closed" });
  }

  return (
    <div className="flex h-full flex-col">
      {/* Header */}
      <div className="border-b border-zinc-200 bg-white px-6 py-3">
        <div className="flex items-center gap-3">
          <Link to={`/p/${key}/reviews`} className="text-zinc-400 hover:text-zinc-700" title="Back to reviews">
            <ArrowLeft className="size-5" />
          </Link>
          <span className="font-mono text-sm text-zinc-500">{review.ref}</span>
          {editing ? (
            <Input className="max-w-xl" value={editing.title} onChange={(e) => setEditing({ ...editing, title: e.target.value })} />
          ) : (
            <h1 className="min-w-0 truncate text-lg font-semibold">{review.title}</h1>
          )}
          <ReviewStatusBadge status={review.status} />
          <div className="ml-auto flex shrink-0 items-center gap-2">
            {review.can.publish && (
              <Button variant="primary" onClick={() => updateReview.mutate({ status: "open" })} loading={updateReview.isPending}>
                Publish
              </Button>
            )}
            {review.can.decide && review.status !== "draft" && (
              <Button onClick={() => setCreatingTask(true)}>
                <ListTodo className="size-4" />
                {checkedComments.length ? `Create task (${checkedComments.length})` : "Create task"}
              </Button>
            )}
            {decideActions.map((a) => (
              <Button key={a.status} variant={a.variant} onClick={() => updateReview.mutate({ status: a.status })}>
                {a.label}
              </Button>
            ))}
          </div>
        </div>
        <div className="mt-1.5 flex flex-wrap items-center gap-x-4 gap-y-1 pl-8 text-xs text-zinc-500">
          <span className="flex items-center gap-1">
            Submitted by <UserChip user={review.createdBy} /> {timeAgo(review.createdAt)}
          </span>
          <span className="flex items-center gap-1">
            Owner
            {review.can.decide && ownerOptions.length > 1 ? (
              <Select className="!h-7 w-40 text-xs" value={review.owner.id} onChange={(e) => updateReview.mutate({ ownerId: e.target.value })}>
                {ownerOptions.map((m) => (
                  <option key={m.user.id} value={m.user.id}>
                    {m.user.name}
                  </option>
                ))}
              </Select>
            ) : (
              <UserChip user={review.owner} />
            )}
          </span>
          {review.task && (
            <Link to={taskPath(review.task.ref)} className="flex items-center gap-1 hover:underline">
              Delivers <span className="font-mono">{review.task.ref}</span>{" "}
              <TaskStatusBadge status={review.task.status} closureReview={review.task.closureReview} />
            </Link>
          )}
          {review.tasks.length > 0 && (
            <span className="flex items-center gap-1">
              Follow-up tasks:
              {review.tasks.map((t) => (
                <Link
                  key={t.id}
                  to={taskPath(t.ref)}
                  className={cx(
                    "font-mono hover:underline",
                    t.closureReview === "agent" ? "rounded border border-dashed border-violet-400 px-1 text-violet-700" : "text-accent-700",
                  )}
                  title={t.closureReview === "agent" ? "Closed by an agent — not yet reviewed by a human" : undefined}
                >
                  {t.ref}
                </Link>
              ))}
            </span>
          )}
        </div>
        {review.can.decide && undecidedTotal > 0 && (
          <button
            className="mt-1.5 ml-8 rounded-md bg-amber-50 px-2 py-1 text-xs text-amber-800 hover:bg-amber-100"
            onClick={() => setStatusFilter("open")}
          >
            {undecidedTotal} comment{undecidedTotal > 1 ? "s" : ""} need{undecidedTotal > 1 ? "" : "s"} your decision: accept or reject each one
          </button>
        )}
        <RoundTabs review={review} current={round?.number ?? 1} undecided={undecided} onSelect={setRound} onNew={() => setCreatingRound(true)} />
        {review.status === "draft" && (
          <div className="mt-2 ml-8 rounded-md bg-amber-50 px-3 py-1.5 text-xs text-amber-800">
            Draft — only visible to the submitter, the owner and project owners until published.
          </div>
        )}
        <ErrorBox error={updateReview.error ?? decide.error ?? deleteComment.error ?? deleteAsset.error} />
      </div>

      <div className="flex min-h-0 flex-1">
        {/* Assets */}
        <div className="flex w-44 shrink-0 flex-col border-r border-zinc-200 bg-white">
          <div className="min-h-0 flex-1 space-y-2 overflow-y-auto p-2">
            {roundAssets.map((a, i) => {
              const count = comments.filter((c) => c.assetId === a.id && !c.parentId && c.status === "open").length;
              return (
                <button
                  key={a.id}
                  onClick={() => {
                    setAssetId(a.id);
                    setDraft([]);
                    setSelectedId(null);
                  }}
                  className={cx(
                    "group relative block w-full overflow-hidden rounded-md border text-left",
                    a.id === asset?.id ? "border-accent-500 ring-2 ring-accent-100" : "border-zinc-200 hover:border-zinc-300",
                  )}
                >
                  <div className="flex aspect-video items-center justify-center bg-zinc-900">
                    {a.posterUrl ? (
                      <img src={a.posterUrl} alt="" className="size-full object-cover" />
                    ) : a.status === "processing" ? (
                      <Spinner className="size-4" />
                    ) : a.kind === "video" ? (
                      <Film className="size-5 text-zinc-600" />
                    ) : (
                      <ImageIcon className="size-5 text-zinc-600" />
                    )}
                    {a.kind === "video" && a.durationMs != null && (
                      <span className="absolute right-1 bottom-7 rounded bg-black/70 px-1 font-mono text-[10px] text-white">
                        {formatTimestamp(a.durationMs).replace(/\.\d$/, "")}
                      </span>
                    )}
                  </div>
                  <div className="flex items-center gap-1 px-1.5 py-1 text-[11px]">
                    <span className="text-zinc-400">{i + 1}</span>
                    <span className="min-w-0 flex-1 truncate">{a.caption || a.filename}</span>
                    {count > 0 && <span className="rounded-full bg-amber-100 px-1.5 text-amber-800">{count}</span>}
                  </div>
                  {canUpload && (
                    <span
                      role="button"
                      className="absolute top-1 right-1 hidden rounded bg-black/60 p-1 text-white group-hover:block hover:bg-red-600"
                      title="Remove media"
                      onClick={(e) => {
                        e.stopPropagation();
                        if (confirm(`Remove ${a.filename} and its position on comments?`)) deleteAsset.mutate(a.id);
                      }}
                    >
                      <Trash2 className="size-3" />
                    </span>
                  )}
                </button>
              );
            })}
            {!roundAssets.length && <p className="p-2 text-xs text-zinc-400">No media in this round yet.</p>}
          </div>
          {canUpload && (
            <div className="border-t border-zinc-200 p-2">
              <input
                ref={fileInput}
                type="file"
                multiple
                className="hidden"
                accept={Object.keys(MEDIA_EXTENSIONS).join(",")}
                onChange={(e) => {
                  void addFiles(e.target.files);
                  e.target.value = "";
                }}
              />
              {uploading ? (
                <div className="space-y-1 text-[11px] text-zinc-500">
                  <div className="truncate">{uploading.name}</div>
                  <div className="h-1 rounded bg-zinc-200">
                    <div className="h-1 rounded bg-accent-500" style={{ width: `${uploading.progress * 100}%` }} />
                  </div>
                </div>
              ) : (
                <Button size="sm" className="w-full" onClick={() => fileInput.current?.click()}>
                  <Plus className="size-3.5" /> Add media
                </Button>
              )}
            </div>
          )}
        </div>

        {/* Stage */}
        <div className="flex min-w-0 flex-1 flex-col bg-zinc-950">
          {asset && (
            <div className="flex items-center gap-1 border-b border-zinc-800 bg-zinc-900 px-3 py-1.5">
              {TOOLS.map((t) => (
                <button
                  key={t.id}
                  title={t.label}
                  disabled={!review.can.comment && t.id !== "none"}
                  onClick={() => setTool(t.id)}
                  className={cx(
                    "rounded p-1.5 disabled:opacity-30",
                    tool === t.id ? "bg-zinc-700 text-white" : "text-zinc-400 hover:bg-zinc-800 hover:text-zinc-100",
                  )}
                >
                  {t.icon}
                </button>
              ))}
              <span className="mx-2 h-5 w-px bg-zinc-700" />
              {COLORS.map((c) => (
                <button
                  key={c}
                  onClick={() => setColor(c)}
                  className={cx("size-5 rounded-full border-2", color === c ? "border-white" : "border-transparent")}
                  style={{ background: c }}
                  title="Colour"
                />
              ))}
              {draft.length > 0 && (
                <>
                  <span className="mx-2 h-5 w-px bg-zinc-700" />
                  <button className="rounded p-1.5 text-zinc-400 hover:bg-zinc-800 hover:text-white" onClick={() => setDraft(draft.slice(0, -1))} title="Undo (Z)">
                    <Undo2 className="size-4" />
                  </button>
                  <button className="rounded p-1.5 text-zinc-400 hover:bg-zinc-800 hover:text-white" onClick={() => setDraft([])} title="Clear marks">
                    <Eraser className="size-4" />
                  </button>
                  <span className="text-xs whitespace-nowrap text-zinc-400">{draft.length} mark{draft.length > 1 ? "s" : ""}</span>
                </>
              )}
              <span className="ml-auto truncate text-xs text-zinc-500">{asset.caption || asset.filename}</span>
              <a href={`${asset.url}?download=1`} className="ml-2 text-xs text-zinc-500 hover:text-zinc-200">
                Download
              </a>
            </div>
          )}
          <div className="min-h-0 flex-1">
            {asset ? (
              <MediaStage
                asset={asset}
                tool={tool}
                color={color}
                draft={draft}
                onDraftChange={setDraft}
                draftPin={draftPin}
                overlays={overlays}
                markers={markers}
                onMarkerClick={(id) => {
                  const c = topLevel.find((x) => x.id === id);
                  if (c) selectComment(c);
                }}
                mediaRef={mediaRef}
                onTime={setTime}
              />
            ) : (
              <div className="flex h-full items-center justify-center text-sm text-zinc-500">No media yet.</div>
            )}
          </div>
        </div>

        {/* Comments */}
        <div className="flex w-[400px] shrink-0 flex-col border-l border-zinc-200 bg-zinc-50">
          <div className="min-h-0 flex-1 space-y-3 overflow-y-auto p-3">
            {round && (
              <RoundCard
                review={review}
                round={round}
                canChange={canChangeRound}
                onChanged={(r) => {
                  if (r) refresh(r);
                  else refresh();
                  if (r && !r.rounds.some((x) => x.number === round.number)) setRound(r.rounds.at(-1)?.number ?? 1);
                }}
              />
            )}
            {(review.description || editing) && (
              <details open={!!editing || !comments.length} className="rounded-lg border border-zinc-200 bg-white p-3">
                <summary className="cursor-pointer text-xs font-semibold text-zinc-600">Description</summary>
                {editing ? (
                  <div className="mt-2 space-y-2">
                    <Textarea rows={6} value={editing.description} onChange={(e) => setEditing({ ...editing, description: e.target.value })} />
                    <div className="flex justify-end gap-2">
                      <Button size="sm" onClick={() => setEditing(null)}>
                        Cancel
                      </Button>
                      <Button size="sm" variant="primary" onClick={() => updateReview.mutate(editing)}>
                        Save
                      </Button>
                    </div>
                  </div>
                ) : (
                  <Markdown className="mt-2">{review.description}</Markdown>
                )}
              </details>
            )}
            <div className="flex items-center gap-2">
              <div className="flex rounded-md border border-zinc-300 bg-white p-0.5 text-xs">
                {(["asset", "all"] as const).map((s) => (
                  <button
                    key={s}
                    onClick={() => setScope(s)}
                    className={cx("rounded px-2 py-1 whitespace-nowrap", scope === s ? "bg-zinc-100 font-medium text-zinc-900" : "text-zinc-500")}
                  >
                    {s === "asset" ? "This media" : `Round ${round?.number ?? 1} (${topLevel.length})`}
                  </button>
                ))}
              </div>
              <Select className="!h-7 w-36 text-xs" value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)}>
                <option value="all">Any status</option>
                <option value="open">Needs decision</option>
                <option value="accepted">Accepted</option>
                <option value="rejected">Rejected</option>
                <option value="resolved">Resolved</option>
              </Select>
              {review.can.edit && !editing && (
                <button
                  className="ml-auto text-xs whitespace-nowrap text-zinc-500 hover:text-zinc-800"
                  onClick={() => setEditing({ title: review.title, description: review.description })}
                >
                  Edit review
                </button>
              )}
            </div>
            {visible.map((c) => (
              <CommentCard
                key={c.id}
                comment={c}
                marks={marksOf.get(c.id) ?? []}
                repliesOf={repliesOf}
                review={review}
                asset={review.assets.find((a) => a.id === c.assetId)}
                showAsset={scope === "all"}
                selectedId={selectedId}
                checkedIds={checked}
                meId={me.id}
                onSelect={selectComment}
                onCheck={(id, v) =>
                  setChecked((prev) => {
                    const next = new Set(prev);
                    if (v) next.add(id);
                    else next.delete(id);
                    return next;
                  })
                }
                onDecide={(id, status) => decide.mutate({ id, status })}
                onReply={(parentId, text) => api.post(`/api/reviews/${review.id}/comments`, { body: text, parentId }).then(() => refresh())}
                onDelete={(id) => confirm("Delete this comment?") && deleteComment.mutate(id)}
              />
            ))}
            {!topLevel.length && <EmptyComments />}
            {review.createdBy.id === me.id && review.status === "draft" && (
              <button className="text-xs text-red-600 hover:underline" onClick={() => confirm("Delete this draft?") && deleteReview.mutate()}>
                Delete draft
              </button>
            )}
          </div>

          {review.can.comment && (
            <div className="space-y-2 border-t border-zinc-200 bg-white p-3">
              <div className="flex flex-wrap items-center gap-1.5 text-xs">
                {asset ? (
                  <span className="rounded bg-zinc-100 px-1.5 py-0.5 text-zinc-600">on {asset.caption || asset.filename}</span>
                ) : (
                  <span className="rounded bg-zinc-100 px-1.5 py-0.5 text-zinc-600">general comment</span>
                )}
                {asset?.kind === "video" && (
                  <label
                    className="flex items-center gap-1 rounded bg-zinc-100 px-1.5 py-0.5 text-zinc-700"
                    title={draft.length ? "Pinned to the frame you drew the first mark on" : "Pin this comment to the current moment of the video"}
                  >
                    <input type="checkbox" checked={withTime} disabled={draft.length > 0} onChange={(e) => setAttachTime(e.target.checked)} />
                    <Clock className="size-3" /> at <span className="font-mono font-medium">{formatTimestamp(pinnedAt * 1000, true)}</span>
                  </label>
                )}
                {moved && (
                  <button
                    className="rounded bg-amber-50 px-1.5 py-0.5 text-amber-800 hover:bg-amber-100"
                    onClick={() => mediaRef.current instanceof HTMLVideoElement && seekTo(mediaRef.current, draftAt!)}
                  >
                    Your marks are on {formatTimestamp(draftAt! * 1000)} · jump back
                  </button>
                )}
              </div>
              {agentGets.length > 0 && (
                <p className="text-[11px] leading-snug text-zinc-500">
                  <Bot className="mr-1 inline size-3 align-[-2px]" />
                  The agent gets {agentGets.join(", ").replace(/, ([^,]*)$/, " and $1")}.
                </p>
              )}
              {draft.length > 0 && (
                <div className="space-y-1.5">
                  <div className="text-xs font-medium text-zinc-600">Notes on each mark (optional, decided separately)</div>
                  {draft.map((shape, i) => (
                    <div key={i} className="flex items-center gap-1.5">
                      <span
                        className="flex size-5 shrink-0 items-center justify-center rounded-full text-[11px] font-bold text-white ring-1 ring-black/20"
                        style={{ background: shape.color }}
                        title={shape.type}
                      >
                        {i + 1}
                      </span>
                      <Input
                        ref={(el) => {
                          markInputs.current[i] = el;
                        }}
                        className="!h-8 text-xs"
                        value={markNotes[i] ?? ""}
                        placeholder={`What's wrong at mark ${i + 1}?`}
                        onChange={(e) => setMarkNotes((n) => n.map((v, j) => (j === i ? e.target.value : v)))}
                      />
                      <button
                        className="text-zinc-400 hover:text-red-600"
                        title={`Remove mark ${i + 1}`}
                        onClick={() => {
                          setDraftShapes((d) => d.filter((_, j) => j !== i));
                          setMarkNotes((n) => n.filter((_, j) => j !== i));
                        }}
                      >
                        <Trash2 className="size-3.5" />
                      </button>
                    </div>
                  ))}
                </div>
              )}
              <Textarea
                rows={3}
                value={body}
                placeholder={draft.length ? "Overall comment on this frame…" : "Comment on this frame… (⌘↵ to send)"}
                onFocus={() => {
                  const v = mediaRef.current;
                  if (v instanceof HTMLVideoElement && !v.paused) v.pause();
                }}
                onChange={(e) => setBody(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && body.trim()) postComment.mutate();
                }}
              />
              <ErrorBox error={postComment.error} />
              <div className="flex justify-end">
                <Button variant="primary" size="sm" disabled={!body.trim()} loading={postComment.isPending} onClick={() => postComment.mutate()}>
                  Comment
                </Button>
              </div>
            </div>
          )}
        </div>
      </div>

      {creatingRound && (
        <NewRoundDialog
          review={review}
          onClose={() => setCreatingRound(false)}
          onDone={(detail, n) => {
            setCreatingRound(false);
            refresh(detail);
            qc.invalidateQueries({ queryKey: ["tasks", key] });
            setRound(n);
          }}
        />
      )}
      {creatingTask && (
        <CreateTaskDialog
          review={review}
          comments={checkedComments}
          onClose={() => setCreatingTask(false)}
          onCreated={() => {
            setCreatingTask(false);
            setChecked(new Set());
            refresh();
            qc.invalidateQueries({ queryKey: ["tasks", key] });
            qc.invalidateQueries({ queryKey: ["project", key] });
          }}
        />
      )}
    </div>
  );
}
