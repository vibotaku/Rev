import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Film, Plus, Upload, X } from "lucide-react";
import { useNavigate, useOutletContext } from "react-router";
import { MEDIA_EXTENSIONS, REVIEW_STATUS_LABELS, type ProjectInfo, type ReviewDetail, type ReviewInfo, type ReviewStatus } from "@rev/shared";
import { api, upload } from "../api";
import { ReviewCard } from "../components/lists";
import { Button, EmptyState, ErrorBox, Field, Input, Modal, PageLoader, Select, Textarea } from "../components/ui";
import { formatBytes, reviewPath } from "../lib";

export function ProjectReviews() {
  const project = useOutletContext<ProjectInfo>();
  const [status, setStatus] = useState<string>("active");
  const [creating, setCreating] = useState(false);
  const { data, isLoading, error } = useQuery({
    queryKey: ["reviews", project.key],
    queryFn: () => api.get<ReviewInfo[]>(`/api/projects/${project.key}/reviews`),
    refetchInterval: 30_000,
  });
  const filtered = (data ?? []).filter((r) =>
    status === "active" ? ["draft", "open", "changes_requested"].includes(r.status) : status === "all" || r.status === status,
  );

  return (
    <div className="px-8 py-4">
      <div className="mb-4 flex items-center gap-2">
        <Select className="w-52" value={status} onChange={(e) => setStatus(e.target.value)}>
          <option value="active">Active</option>
          <option value="all">All</option>
          {(Object.keys(REVIEW_STATUS_LABELS) as ReviewStatus[]).map((s) => (
            <option key={s} value={s}>
              {REVIEW_STATUS_LABELS[s]}
            </option>
          ))}
        </Select>
        {project.can.createReview && (
          <Button variant="primary" className="ml-auto" onClick={() => setCreating(true)}>
            <Plus className="size-4" /> New review
          </Button>
        )}
      </div>
      <ErrorBox error={error} />
      {isLoading ? (
        <PageLoader />
      ) : !filtered.length ? (
        <EmptyState icon={<Film className="size-8" />} title="No reviews here">
          Agents submit review kits with <code className="text-xs">rev review create</code> or the Rev MCP server. You can also upload one
          yourself.
        </EmptyState>
      ) : (
        <div className="grid gap-3 xl:grid-cols-2">
          {filtered.map((r) => (
            <ReviewCard key={r.id} review={r} />
          ))}
        </div>
      )}
      {creating && <CreateReview project={project} onClose={() => setCreating(false)} />}
    </div>
  );
}

const ACCEPT = Object.keys(MEDIA_EXTENSIONS).join(",");

function CreateReview({ project, onClose }: { project: ProjectInfo; onClose: () => void }) {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [files, setFiles] = useState<File[]>([]);
  const [progress, setProgress] = useState<Record<number, number>>({});
  const [dragOver, setDragOver] = useState(false);

  const create = useMutation({
    mutationFn: async () => {
      const review = await api.post<ReviewDetail>(`/api/projects/${project.key}/reviews`, { title, description });
      for (const [i, file] of files.entries()) {
        await upload(`/api/reviews/${review.id}/assets`, file, file.name, (f) => setProgress((p) => ({ ...p, [i]: f })));
      }
      return api.patch<ReviewDetail>(`/api/reviews/${review.id}`, { status: "open" });
    },
    onSuccess: (r) => {
      qc.invalidateQueries({ queryKey: ["reviews", project.key] });
      qc.invalidateQueries({ queryKey: ["project", project.key] });
      navigate(reviewPath(r.projectKey, r.number));
    },
  });

  return (
    <Modal
      title="New review"
      wide
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" disabled={!title.trim()} loading={create.isPending} onClick={() => create.mutate()}>
            Upload & publish
          </Button>
        </>
      }
    >
      <Field label="Title">
        <Input value={title} onChange={(e) => setTitle(e.target.value)} autoFocus />
      </Field>
      <Field label="Description" hint="What should reviewers look at? Markdown supported.">
        <Textarea rows={4} value={description} onChange={(e) => setDescription(e.target.value)} />
      </Field>
      <label
        className={`flex cursor-pointer flex-col items-center gap-2 rounded-lg border-2 border-dashed px-4 py-6 text-sm text-zinc-500 ${dragOver ? "border-accent-500 bg-accent-50" : "border-zinc-300"}`}
        onDragOver={(e) => {
          e.preventDefault();
          setDragOver(true);
        }}
        onDragLeave={() => setDragOver(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragOver(false);
          setFiles((f) => [...f, ...Array.from(e.dataTransfer.files)]);
        }}
      >
        <Upload className="size-5" />
        Drop videos and screenshots here, or click to choose
        <input type="file" multiple accept={ACCEPT} className="hidden" onChange={(e) => setFiles((f) => [...f, ...Array.from(e.target.files ?? [])])} />
      </label>
      {files.length > 0 && (
        <ul className="space-y-1">
          {files.map((f, i) => (
            <li key={i} className="flex items-center gap-2 text-sm">
              <span className="min-w-0 flex-1 truncate">{f.name}</span>
              <span className="text-xs text-zinc-400">{formatBytes(f.size)}</span>
              {progress[i] !== undefined ? (
                <span className="w-10 text-right text-xs text-zinc-500">{Math.round(progress[i]! * 100)}%</span>
              ) : (
                <button className="text-zinc-400 hover:text-zinc-700" onClick={() => setFiles(files.filter((_, j) => j !== i))}>
                  <X className="size-4" />
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
      <ErrorBox error={create.error} />
    </Modal>
  );
}
