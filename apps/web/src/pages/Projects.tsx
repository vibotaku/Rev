import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { FolderKanban, Plus } from "lucide-react";
import { Link, useNavigate, useSearchParams } from "react-router";
import type { ProjectInfo } from "@rev/shared";
import { api } from "../api";
import { PageHeader } from "../components/Layout";
import { Badge, Button, Card, EmptyState, ErrorBox, Field, Input, Modal, PageLoader, Textarea } from "../components/ui";

export function Projects() {
  const [creating, setCreating] = useState(false);
  const { data, isLoading, error } = useQuery({ queryKey: ["projects"], queryFn: () => api.get<ProjectInfo[]>("/api/projects") });
  // Archived projects are hidden unless ?archived is set; shown, they come last.
  const [params, setParams] = useSearchParams();
  const showArchived = params.has("archived");
  const archivedCount = data?.filter((p) => p.archived).length ?? 0;
  const shown = (data ?? []).filter((p) => showArchived || !p.archived).sort((a, b) => Number(a.archived) - Number(b.archived));
  const setShowArchived = (on: boolean) =>
    setParams(
      (p) => {
        if (on) p.set("archived", "1");
        else p.delete("archived");
        return p;
      },
      { replace: true },
    );

  return (
    <div>
      <PageHeader
        title="Projects"
        actions={
          <>
            {archivedCount > 0 && (
              <label className="flex items-center gap-1.5 text-sm text-zinc-600">
                <input type="checkbox" checked={showArchived} onChange={(e) => setShowArchived(e.target.checked)} /> Show archived ({archivedCount})
              </label>
            )}
            <Button variant="primary" onClick={() => setCreating(true)}>
              <Plus className="size-4" /> New project
            </Button>
          </>
        }
      />
      <div className="mx-auto max-w-5xl px-8 py-6">
        <ErrorBox error={error} />
        {isLoading ? (
          <PageLoader />
        ) : !data?.length ? (
          <EmptyState icon={<FolderKanban className="size-8" />} title="No projects yet">
            Projects hold tasks and review kits. Create one and invite your team and agents.
          </EmptyState>
        ) : !shown.length ? (
          <EmptyState icon={<FolderKanban className="size-8" />} title="No active projects">
            {archivedCount === 1 ? "Your only project is archived." : `All ${archivedCount} projects are archived.`}{" "}
            <button className="text-accent-600 hover:underline" onClick={() => setShowArchived(true)}>
              Show them
            </button>
          </EmptyState>
        ) : (
          <div className="grid gap-3 md:grid-cols-2">
            {shown.map((p) => (
              <Link key={p.id} to={`/p/${p.key}`}>
                <Card className="h-full p-4 transition hover:border-zinc-300 hover:shadow">
                  <div className="flex items-center gap-2">
                    <span className="rounded bg-zinc-900 px-1.5 py-0.5 font-mono text-xs font-semibold text-white">{p.key}</span>
                    <span className="truncate font-medium">{p.name}</span>
                    {p.archived && <Badge className="bg-zinc-100 text-zinc-500">archived</Badge>}
                    <span className="ml-auto text-xs text-zinc-400">{p.myRole}</span>
                  </div>
                  {p.description && <p className="mt-2 line-clamp-2 text-sm text-zinc-500">{p.description}</p>}
                  <div className="mt-3 flex gap-4 text-xs text-zinc-500">
                    <span>{p.counts.openTasks} open task{p.counts.openTasks === 1 ? "" : "s"}</span>
                    <span>{p.counts.openReviews} open review{p.counts.openReviews === 1 ? "" : "s"}</span>
                    <span>{p.counts.members} member{p.counts.members === 1 ? "" : "s"}</span>
                  </div>
                </Card>
              </Link>
            ))}
          </div>
        )}
      </div>
      {creating && <CreateProject onClose={() => setCreating(false)} />}
    </div>
  );
}

function CreateProject({ onClose }: { onClose: () => void }) {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [name, setName] = useState("");
  const [key, setKey] = useState("");
  const [keyTouched, setKeyTouched] = useState(false);
  const [description, setDescription] = useState("");
  const suggested = name
    .toUpperCase()
    .replace(/[^A-Z0-9 ]/g, "")
    .split(/\s+/)
    .filter(Boolean)
    .map((w, _, all) => (all.length > 1 ? w[0] : w.slice(0, 4)))
    .join("")
    .slice(0, 6);
  const effectiveKey = keyTouched ? key : suggested;
  const create = useMutation({
    mutationFn: () => api.post<ProjectInfo>("/api/projects", { name, key: effectiveKey, description }),
    onSuccess: (p) => {
      qc.invalidateQueries({ queryKey: ["projects"] });
      navigate(`/p/${p.key}`);
    },
  });

  return (
    <Modal
      title="New project"
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" loading={create.isPending} onClick={() => create.mutate()} disabled={!name || effectiveKey.length < 2}>
            Create
          </Button>
        </>
      }
    >
      <form
        className="space-y-4"
        onSubmit={(e) => {
          e.preventDefault();
          create.mutate();
        }}
      >
        <Field label="Name">
          <Input
            value={name}
            onChange={(e) => {
              setName(e.target.value);
              if (!keyTouched) setKey("");
            }}
            autoFocus
            required
          />
        </Field>
        <Field label="Key" hint="Prefix for task and review references, e.g. WEB-12, WEB-R3.">
          <Input
            value={effectiveKey}
            onChange={(e) => {
              setKeyTouched(true);
              setKey(e.target.value.toUpperCase());
            }}
            className="font-mono uppercase"
            maxLength={10}
          />
        </Field>
        <Field label="Description">
          <Textarea rows={3} value={description} onChange={(e) => setDescription(e.target.value)} />
        </Field>
        <ErrorBox error={create.error} />
        <button type="submit" className="hidden" />
      </form>
    </Modal>
  );
}
