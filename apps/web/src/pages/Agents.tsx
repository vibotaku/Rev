import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Bot, KeyRound, Plus, Trash2 } from "lucide-react";
import { Link } from "react-router";
import type { AgentInfo } from "@rev/shared";
import { api } from "../api";
import { useUser } from "../auth";
import { PageHeader } from "../components/Layout";
import { Badge, Button, Card, EmptyState, ErrorBox, Field, Input, Modal, PageLoader, Textarea } from "../components/ui";
import { timeAgo } from "../lib";
import { EnrollmentKeys } from "./EnrollmentKeys";
import { CopyBlock } from "../components/CopyBlock";

export function setupInstructions(token: string) {
  const origin = window.location.origin;
  return [
    "# 1. Install the rev CLI and save this agent's token (Node.js 20+)",
    `mkdir -p ~/.local/bin && curl -fsSL ${origin}/downloads/rev.mjs -o ~/.local/bin/rev && chmod +x ~/.local/bin/rev`,
    `rev login --url ${origin} --token ${token}`,
    "",
    "# 2a. Claude Code: install the Rev plugin (MCP tools + /rev:workflow skill)",
    "/plugin marketplace add vibotaku/Rev",
    "/plugin install rev@vibotaku",
    "",
    "# 2b. Other MCP clients: run `rev mcp` as a stdio server. Or use the CLI directly:",
    "rev tasks",
    'rev review create --project KEY --title "What changed" recording.mp4 screenshot.png',
  ].join("\n");
}

export function Agents() {
  const me = useUser();
  const qc = useQueryClient();
  const [showAll, setShowAll] = useState(false);
  const [creating, setCreating] = useState(false);
  const [newToken, setNewToken] = useState<{ agent: string; token: string } | null>(null);
  const { data, isLoading, error } = useQuery({
    queryKey: ["agents", showAll],
    queryFn: () => api.get<AgentInfo[]>(`/api/agents${showAll ? "?all=1" : ""}`),
  });
  const invalidate = () => qc.invalidateQueries({ queryKey: ["agents"] });
  const mintToken = useMutation({
    mutationFn: (agent: AgentInfo) =>
      api.post<{ token: string }>(`/api/agents/${agent.id}/tokens`, { name: `token ${new Date().toISOString().slice(0, 10)}` }).then((r) => ({
        agent: agent.name,
        token: r.token,
      })),
    onSuccess: (r) => {
      setNewToken(r);
      invalidate();
    },
  });
  const revoke = useMutation({
    mutationFn: ({ agentId, tokenId }: { agentId: string; tokenId: string }) => api.del(`/api/agents/${agentId}/tokens/${tokenId}`),
    onSuccess: invalidate,
  });
  const toggle = useMutation({
    mutationFn: (a: AgentInfo) => api.patch(`/api/agents/${a.id}`, { disabled: !a.disabled }),
    onSuccess: invalidate,
  });

  return (
    <div>
      <PageHeader
        title="Agents"
        subtitle="Agents act on your behalf: they submit review kits and work on tasks you assign them. You decide on their reviews. Agents can register themselves with an enrollment key, or you can create one by hand."
        actions={
          <>
            {me.role === "admin" && (
              <label className="flex items-center gap-1.5 text-sm text-zinc-600">
                <input type="checkbox" checked={showAll} onChange={(e) => setShowAll(e.target.checked)} /> All agents
              </label>
            )}
            <Button onClick={() => setCreating(true)} title="Create an agent by hand and copy its token to the machine">
              <Plus className="size-4" /> New agent (manual)
            </Button>
          </>
        }
      />
      <div className="mx-auto max-w-4xl space-y-4 px-8 py-6">
        <EnrollmentKeys showAll={showAll} />
        <h2 className="pt-4 text-sm font-semibold text-zinc-700">{showAll ? "All agents" : "Your agents"}</h2>
        <ErrorBox error={error ?? mintToken.error ?? revoke.error} />
        {isLoading ? (
          <PageLoader />
        ) : !data?.length ? (
          <EmptyState icon={<Bot className="size-8" />} title="No agents yet">
            Create an enrollment key above and run <code className="text-xs">/rev:setup</code> (Claude Code plugin) or{" "}
            <code className="text-xs">rev register</code> on the agent's machine, or create an agent by hand.
          </EmptyState>
        ) : (
          data.map((a) => (
            <Card key={a.id} className="p-4">
              <div className="flex items-start gap-3">
                <span className="flex size-9 items-center justify-center rounded-lg bg-zinc-900 text-white">
                  <Bot className="size-5" />
                </span>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="font-medium">{a.name}</span>
                    {a.disabled && <Badge className="bg-red-50 text-red-600">disabled</Badge>}
                    {a.owner.id !== me.id && <span className="text-xs text-zinc-500">linked to {a.owner.name}</span>}
                    {a.enrolledVia && (
                      <Badge className="bg-sky-50 text-sky-700">
                        <KeyRound className="size-3" /> self-registered · {a.enrolledVia.name}
                      </Badge>
                    )}
                  </div>
                  {a.description && <p className="text-sm text-zinc-500">{a.description}</p>}
                  <div className="mt-2 flex flex-wrap gap-1.5">
                    {a.projects.length ? (
                      a.projects.map((p) => (
                        <Link key={p.key} to={`/p/${p.key}`}>
                          <Badge className="bg-zinc-100 text-zinc-700 hover:bg-zinc-200">
                            {p.key} · {p.role}
                          </Badge>
                        </Link>
                      ))
                    ) : (
                      <span className="text-xs text-zinc-400">Not in any project yet — add it from a project's Members tab.</span>
                    )}
                  </div>
                </div>
                <div className="flex gap-2">
                  <Button size="sm" onClick={() => mintToken.mutate(a)} loading={mintToken.isPending && mintToken.variables?.id === a.id}>
                    <KeyRound className="size-3.5" /> New token
                  </Button>
                  <Button size="sm" variant={a.disabled ? "secondary" : "danger"} onClick={() => toggle.mutate(a)}>
                    {a.disabled ? "Enable" : "Disable"}
                  </Button>
                </div>
              </div>
              {a.tokens.length > 0 && (
                <ul className="mt-3 divide-y divide-zinc-100 rounded-md border border-zinc-200">
                  {a.tokens.map((t) => (
                    <li key={t.id} className="flex items-center gap-3 px-3 py-1.5 text-xs">
                      <code className="text-zinc-700">{t.prefix}…</code>
                      <span className="text-zinc-500">{t.name}</span>
                      <span className="ml-auto text-zinc-400">{t.lastUsedAt ? `used ${timeAgo(t.lastUsedAt)}` : "never used"}</span>
                      <button
                        className="text-zinc-400 hover:text-red-600"
                        title="Revoke"
                        onClick={() => confirm("Revoke this token? Agents using it stop working immediately.") && revoke.mutate({ agentId: a.id, tokenId: t.id })}
                      >
                        <Trash2 className="size-3.5" />
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </Card>
          ))
        )}
      </div>
      {creating && (
        <CreateAgent
          onClose={() => setCreating(false)}
          onCreated={(agent) => {
            setCreating(false);
            invalidate();
            mintToken.mutate(agent);
          }}
        />
      )}
      {newToken && (
        <Modal title={`Token for ${newToken.agent}`} wide onClose={() => setNewToken(null)} footer={<Button variant="primary" onClick={() => setNewToken(null)}>Done</Button>}>
          <p className="text-sm text-zinc-600">Copy it now — it will not be shown again.</p>
          <CopyBlock text={newToken.token} />
          <p className="text-sm text-zinc-600">Set up the agent's machine:</p>
          <CopyBlock text={setupInstructions(newToken.token)} />
        </Modal>
      )}
    </div>
  );
}

function CreateAgent({ onClose, onCreated }: { onClose: () => void; onCreated: (a: AgentInfo) => void }) {
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const create = useMutation({ mutationFn: () => api.post<AgentInfo>("/api/agents", { name, description }), onSuccess: onCreated });
  return (
    <Modal
      title="New agent"
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" disabled={!name.trim()} loading={create.isPending} onClick={() => create.mutate()}>
            Create agent
          </Button>
        </>
      }
    >
      <Field label="Name">
        <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="claude-buildbox" autoFocus />
      </Field>
      <Field label="Description">
        <Textarea rows={2} value={description} onChange={(e) => setDescription(e.target.value)} placeholder="Where it runs, what it works on" />
      </Field>
      <ErrorBox error={create.error} />
    </Modal>
  );
}
