import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { Layers, Pencil, Plus, Upload, X } from "lucide-react";
import { Link } from "react-router";
import { MEDIA_EXTENSIONS, type ReviewDetail, type ReviewRoundInfo } from "@rev/shared";
import { api, upload } from "../api";
import { Button, ErrorBox, Field, Markdown, Modal, TaskStatusBadge, Textarea, UserChip } from "../components/ui";
import { cx, formatBytes, taskPath, timeAgo } from "../lib";

/** Round switcher; each tab shows how many comments in it still need the owner's decision. */
export function RoundTabs({
  review,
  current,
  undecided,
  onSelect,
  onNew,
}: {
  review: ReviewDetail;
  current: number;
  undecided: Map<number, number>;
  onSelect: (n: number) => void;
  onNew: () => void;
}) {
  if (review.rounds.length < 2 && !review.can.addRound) return null;
  return (
    <div className="mt-2 flex flex-wrap items-center gap-1 pl-8">
      <Layers className="mr-1 size-3.5 text-zinc-400" />
      {review.rounds.map((r) => {
        const n = undecided.get(r.number) ?? 0;
        return (
          <button
            key={r.id}
            onClick={() => onSelect(r.number)}
            className={cx(
              "flex items-center gap-1.5 rounded-md border px-2 py-0.5 text-xs",
              r.number === current ? "border-accent-500 bg-accent-50 font-medium text-accent-700" : "border-zinc-200 text-zinc-600 hover:bg-zinc-50",
              !r.submittedAt && "border-dashed",
            )}
          >
            Round {r.number}
            {!r.submittedAt && <span className="text-amber-700">draft</span>}
            {n > 0 && <span className="rounded-full bg-amber-100 px-1.5 text-[10px] text-amber-800">{n}</span>}
          </button>
        );
      })}
      {review.can.addRound && !review.rounds.some((r) => !r.submittedAt) && (
        <Button size="sm" variant="ghost" onClick={onNew}>
          <Plus className="size-3.5" /> New round
        </Button>
      )}
    </div>
  );
}

/** What changed in a round and which tasks it addresses; draft rounds can be submitted or discarded here. */
export function RoundCard({
  review,
  round,
  canChange,
  onChanged,
}: {
  review: ReviewDetail;
  round: ReviewRoundInfo;
  canChange: boolean;
  onChanged: (r: ReviewDetail | null) => void;
}) {
  const [editing, setEditing] = useState<string | null>(null);
  const saveNotes = useMutation({
    mutationFn: () => api.patch<ReviewDetail>(`/api/reviews/${review.id}/rounds/${round.number}`, { notes: editing ?? "" }),
    onSuccess: (r) => {
      setEditing(null);
      onChanged(r);
    },
  });
  const submit = useMutation({
    mutationFn: () => api.post<ReviewDetail>(`/api/reviews/${review.id}/rounds/${round.number}/submit`),
    onSuccess: onChanged,
  });
  const discard = useMutation({
    mutationFn: () => api.del<ReviewDetail>(`/api/reviews/${review.id}/rounds/${round.number}`),
    onSuccess: onChanged,
  });
  if (review.rounds.length < 2 && round.number === 1) return null;

  return (
    <div className={cx("space-y-2 rounded-lg border bg-white p-3", round.submittedAt ? "border-zinc-200" : "border-dashed border-amber-300 bg-amber-50/40")}>
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-zinc-500">
        <span className="font-semibold text-zinc-700">Round {round.number}</span>
        <UserChip user={round.createdBy} />
        <span>{round.submittedAt ? `submitted ${timeAgo(round.submittedAt)}` : "draft, not visible to reviewers yet"}</span>
        {canChange && editing === null && round.number > 1 && (
          <button className="ml-auto text-zinc-400 hover:text-zinc-700" title="Edit notes" onClick={() => setEditing(round.notes)}>
            <Pencil className="size-3.5" />
          </button>
        )}
      </div>
      {editing !== null ? (
        <div className="space-y-2">
          <Textarea rows={4} value={editing} onChange={(e) => setEditing(e.target.value)} placeholder="What changed in this round?" />
          <div className="flex justify-end gap-2">
            <Button size="sm" onClick={() => setEditing(null)}>
              Cancel
            </Button>
            <Button size="sm" variant="primary" loading={saveNotes.isPending} onClick={() => saveNotes.mutate()}>
              Save
            </Button>
          </div>
        </div>
      ) : round.notes ? (
        <Markdown>{round.notes}</Markdown>
      ) : round.number > 1 ? (
        <p className="text-xs text-zinc-400">No notes.</p>
      ) : null}
      {round.addressedTasks.length > 0 && (
        <div className="flex flex-wrap items-center gap-1.5 text-xs text-zinc-500">
          Addresses
          {round.addressedTasks.map((t) => (
            <Link key={t.id} to={taskPath(t.ref)} className="inline-flex items-center gap-1 hover:underline" title={t.title}>
              <span className="font-mono">{t.ref}</span>
              <TaskStatusBadge status={t.status} closureReview={t.closureReview} />
            </Link>
          ))}
        </div>
      )}
      {!round.submittedAt && canChange && (
        <div className="flex flex-wrap items-center justify-end gap-2 pt-1">
          <span className="mr-auto text-xs text-zinc-500">{round.assetCount} media</span>
          <Button size="sm" variant="danger" loading={discard.isPending} onClick={() => confirm(`Discard draft round ${round.number}?`) && discard.mutate()}>
            Discard
          </Button>
          <Button size="sm" variant="primary" disabled={!round.assetCount} loading={submit.isPending} onClick={() => submit.mutate()}>
            Submit round {round.number}
          </Button>
        </div>
      )}
      <ErrorBox error={saveNotes.error ?? submit.error ?? discard.error} />
    </div>
  );
}

/** Starts the next round: notes, the tasks it addresses, and the new media; then submits it. */
export function NewRoundDialog({
  review,
  onClose,
  onDone,
}: {
  review: ReviewDetail;
  onClose: () => void;
  onDone: (review: ReviewDetail, round: number) => void;
}) {
  const open = review.tasks.filter((t) => t.status !== "done" && t.status !== "cancelled");
  const [notes, setNotes] = useState("");
  const [taskRefs, setTaskRefs] = useState<Set<string>>(new Set(open.map((t) => t.ref)));
  const [files, setFiles] = useState<File[]>([]);
  const [progress, setProgress] = useState<string | null>(null);
  const next = (review.rounds.at(-1)?.number ?? 1) + 1;

  const run = useMutation({
    mutationFn: async (submit: boolean) => {
      let detail = await api.post<ReviewDetail>(`/api/reviews/${review.id}/rounds`, { notes, taskRefs: [...taskRefs] });
      for (const [i, f] of files.entries()) {
        await upload(`/api/reviews/${review.id}/assets?round=${next}`, f, f.name, (p) =>
          setProgress(`Uploading ${f.name} (${i + 1}/${files.length}) ${Math.round(p * 100)}%`),
        );
      }
      if (submit) detail = await api.post<ReviewDetail>(`/api/reviews/${review.id}/rounds/${next}/submit`);
      else detail = await api.get<ReviewDetail>(`/api/reviews/${review.id}`);
      return detail;
    },
    onSuccess: (detail) => onDone(detail, next),
    onSettled: () => setProgress(null),
  });

  return (
    <Modal
      title={`Round ${next} of ${review.ref}`}
      wide
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button loading={run.isPending && run.variables === false} disabled={run.isPending} onClick={() => run.mutate(false)}>
            Save as draft
          </Button>
          <Button variant="primary" disabled={!files.length || run.isPending} loading={run.isPending && run.variables === true} onClick={() => run.mutate(true)}>
            Submit round {next}
          </Button>
        </>
      }
    >
      <Field label="What changed" hint="Markdown. Reviewers see this at the top of the round.">
        <Textarea rows={4} value={notes} onChange={(e) => setNotes(e.target.value)} autoFocus placeholder="Fixed the currency symbol; total no longer cut off at 375px." />
      </Field>
      {open.length > 0 && (
        <div className="space-y-1.5">
          <span className="text-sm font-medium text-zinc-700">Tasks this round addresses</span>
          <div className="divide-y divide-zinc-100 rounded-md border border-zinc-200">
            {open.map((t) => (
              <label key={t.id} className="flex items-center gap-2 px-3 py-1.5 text-sm">
                <input
                  type="checkbox"
                  checked={taskRefs.has(t.ref)}
                  onChange={(e) =>
                    setTaskRefs((prev) => {
                      const s = new Set(prev);
                      if (e.target.checked) s.add(t.ref);
                      else s.delete(t.ref);
                      return s;
                    })
                  }
                />
                <span className="font-mono text-xs text-zinc-500">{t.ref}</span>
                <span className="min-w-0 flex-1 truncate">{t.title}</span>
                <TaskStatusBadge status={t.status} />
              </label>
            ))}
          </div>
          <p className="text-xs text-zinc-500">Submitting moves these tasks to “In review”.</p>
        </div>
      )}
      <label className="flex cursor-pointer flex-col items-center gap-2 rounded-lg border-2 border-dashed border-zinc-300 px-4 py-5 text-sm text-zinc-500">
        <Upload className="size-5" />
        New screenshots and recordings for this round
        <input
          type="file"
          multiple
          accept={Object.keys(MEDIA_EXTENSIONS).join(",")}
          className="hidden"
          onChange={(e) => setFiles((f) => [...f, ...Array.from(e.target.files ?? [])])}
        />
      </label>
      {files.length > 0 && (
        <ul className="space-y-1">
          {files.map((f, i) => (
            <li key={i} className="flex items-center gap-2 text-sm">
              <span className="min-w-0 flex-1 truncate">{f.name}</span>
              <span className="text-xs text-zinc-400">{formatBytes(f.size)}</span>
              <button className="text-zinc-400 hover:text-zinc-700" onClick={() => setFiles(files.filter((_, j) => j !== i))}>
                <X className="size-4" />
              </button>
            </li>
          ))}
        </ul>
      )}
      {progress && <p className="text-xs text-zinc-500">{progress}</p>}
      <ErrorBox error={run.error} />
    </Modal>
  );
}
