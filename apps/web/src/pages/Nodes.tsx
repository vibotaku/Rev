import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Bot, Check, ChevronDown, ChevronRight, FolderGit2, Pencil, Play, Plus, Server, Square, Terminal, Trash2, X } from "lucide-react";
import { Link } from "react-router";
import { workspaceSession, type NodeInfo, type NodeRunningAgent, type ProjectInfo, type WorkspaceInfo } from "@rev/shared";
import { api } from "../api";
import { useUser } from "../auth";
import { CopyBlock } from "../components/CopyBlock";
import { PageHeader } from "../components/Layout";
import { Badge, Button, Card, EmptyState, ErrorBox, Field, Input, Modal, PageLoader, Select, Spinner, UserChip } from "../components/ui";
import { cx, timeAgo } from "../lib";
import { installCli, keySource, PLACEHOLDER, type KeySource } from "./ConnectAgent";
import { CreateKey } from "./EnrollmentKeys";

/** Shell commands that make a computer a node. `~/.local/bin/rev` because macOS has its own `rev`. */
export function nodeInstallCommands(origin: string, src: KeySource) {
  const install = `~/.local/bin/rev node install --url ${origin}`;
  return [
    "# Install the rev CLI (Node.js 20+)",
    installCli(origin),
    "",
    "# Register this computer as a node and start its background service (launchd on macOS, systemd on Linux)",
    src.kind === "bao"
      ? `bao kv get -mount=secret -field=${src.field} ${src.path} | ${install} --key -`
      : `REV_ENROLL_KEY=${src.kind === "literal" ? src.key : PLACEHOLDER} ${install}`,
    "",
    "# Optional: what Claude Code may do without asking in agent sessions (default: your Claude Code settings)",
    `# ~/.local/bin/rev node install --claude-args "--permission-mode acceptEdits"`,
  ].join("\n");
}

function AddNode({ onClose }: { onClose?: () => void }) {
  const qc = useQueryClient();
  const [enrollKey, setEnrollKey] = useState("");
  const [creating, setCreating] = useState(false);
  return (
    <Card className="space-y-4 p-5">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h2 className="text-sm font-semibold text-zinc-800">Add a node</h2>
          <p className="mt-1 text-sm text-zinc-500">
            Run these commands on the computer. It needs Node.js 20 or newer and git; to start agents it also needs tmux and Claude Code, signed in. It
            connects out to Rev, so it needs no open ports.
          </p>
        </div>
        {onClose && (
          <button className="rounded p-1 text-zinc-400 hover:bg-zinc-100 hover:text-zinc-700" onClick={onClose} aria-label="Close">
            <X className="size-4" />
          </button>
        )}
      </div>
      <div className="flex gap-2">
        <Input
          value={enrollKey}
          onChange={(e) => setEnrollKey(e.target.value)}
          placeholder="Enrollment key: rev_enroll_… or bao:<path>#<field>"
          className="font-mono text-xs"
          spellCheck={false}
          autoComplete="off"
          aria-label="Enrollment key"
        />
        <Button className="shrink-0" onClick={() => setCreating(true)}>
          <Plus className="size-4" /> New key
        </Button>
      </div>
      <CopyBlock text={nodeInstallCommands(window.location.origin, keySource(enrollKey))} />
      <p className="text-xs text-zinc-500">
        The node shows up here within a few seconds. Agents it creates are linked to you. <code>rev node status</code> shows what it is doing, and{" "}
        <code>tmux attach -t rev-&lt;workspace&gt;</code> on that computer opens a running agent's session.
      </p>
      {creating && (
        <CreateKey
          onClose={() => setCreating(false)}
          onCreated={(r) => {
            setCreating(false);
            setEnrollKey(r.key);
            qc.invalidateQueries({ queryKey: ["enrollment-keys"] });
          }}
        />
      )}
    </Card>
  );
}

const SESSION_LABEL: Record<WorkspaceInfo["session"], string> = {
  running: "Agent running",
  stopped: "Agent stopped",
  starting: "Starting…",
  stopping: "Stopping…",
};

/** Expanded/collapsed state of a tree item, remembered in this browser. */
function useExpanded(id: string, initial = true): [boolean, (open: boolean) => void] {
  const key = `rev.nodes.open.${id}`;
  const [open, setOpen] = useState(() => {
    const saved = localStorage.getItem(key);
    return saved === null ? initial : saved === "1";
  });
  return [
    open,
    (next) => {
      localStorage.setItem(key, next ? "1" : "0");
      setOpen(next);
    },
  ];
}

function Twisty({ open, onToggle, label }: { open: boolean; onToggle: () => void; label: string }) {
  return (
    <button
      className="rounded p-0.5 text-zinc-400 hover:bg-zinc-100 hover:text-zinc-700"
      onClick={onToggle}
      aria-expanded={open}
      aria-label={`${open ? "Collapse" : "Expand"} ${label}`}
    >
      {open ? <ChevronDown className="size-4" /> : <ChevronRight className="size-4" />}
    </button>
  );
}

/** A branch of the tree: a heading that folds its children, drawn with a guide line. */
function Branch({ id, title, count, children }: { id: string; title: string; count: number; children: React.ReactNode }) {
  const [open, setOpen] = useExpanded(id);
  return (
    <div>
      <div className="flex items-center gap-1.5 py-1 text-xs font-semibold tracking-wide text-zinc-500 uppercase">
        <Twisty open={open} onToggle={() => setOpen(!open)} label={title} />
        {title} <span className="font-normal text-zinc-400">{count}</span>
      </div>
      {open && <div className="ml-2.5 border-l border-zinc-200 pl-3">{children}</div>}
    </div>
  );
}

/** Renames something in place: Enter saves, Escape cancels. */
function InlineRename({ value, onSave, onCancel, saving }: { value: string; onSave: (v: string) => void; onCancel: () => void; saving: boolean }) {
  const [text, setText] = useState(value);
  const save = () => (text.trim() && text.trim() !== value ? onSave(text.trim()) : onCancel());
  return (
    <span className="flex items-center gap-1">
      <Input
        autoFocus
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") save();
          if (e.key === "Escape") onCancel();
        }}
        className="!h-7 w-56 text-sm"
        aria-label="New name"
      />
      <Button size="sm" variant="primary" loading={saving} onClick={save}>
        Save
      </Button>
      <Button size="sm" variant="ghost" onClick={onCancel}>
        Cancel
      </Button>
    </span>
  );
}

function WorkspaceRow({ node, ws, onChange }: { node: NodeInfo; ws: WorkspaceInfo; onChange: (n: NodeInfo) => void }) {
  const [copied, setCopied] = useState(false);
  // Details start folded, unless something needs attention.
  const [open, setOpen] = useExpanded(`ws.${ws.id}`, false);
  const act = useMutation({
    mutationFn: (action: "start" | "stop" | "remove") =>
      action === "remove" ? api.del<NodeInfo>(`/api/workspaces/${ws.id}`) : api.post<NodeInfo>(`/api/workspaces/${ws.id}/${action}`),
    onSuccess: onChange,
  });
  const busy = ws.session === "starting" || ws.session === "stopping";
  const canStart = !!node.capabilities?.tmux && !!node.capabilities?.claude;
  const attach = `tmux attach -t ${workspaceSession(ws.name)}`;
  const problem = ws.error ?? ws.sessionError;

  return (
    <div data-workspace={ws.name} className="space-y-1.5 py-2">
      <div className="flex flex-wrap items-center gap-x-2.5 gap-y-2">
        <Twisty open={open} onToggle={() => setOpen(!open)} label={`workspace ${ws.name}`} />
        <FolderGit2 className="size-4 shrink-0 text-zinc-400" />
        <span className="font-mono text-sm font-medium">{ws.name}</span>
        {ws.project && (
          <Link to={`/p/${ws.project.key}`}>
            <Badge className="bg-zinc-100 text-zinc-700 hover:bg-zinc-200">{ws.project.key}</Badge>
          </Link>
        )}
        {ws.agent && <UserChip user={ws.agent} />}
        <div className="ml-auto flex items-center gap-2">
          {ws.status === "pending" ? (
            <span className="flex items-center gap-1.5 text-xs text-zinc-500">
              <Spinner className="size-3.5" /> Setting up…
            </span>
          ) : ws.status === "failed" ? (
            <Badge className="bg-red-50 text-red-700">Setup failed</Badge>
          ) : (
            <>
              <span className={cx("flex items-center gap-1.5 text-xs", ws.session === "running" ? "text-emerald-700" : "text-zinc-500")}>
                {busy ? <Spinner className="size-3.5" /> : <span className={cx("size-2 rounded-full", ws.session === "running" ? "bg-emerald-500" : "bg-zinc-300")} />}
                {SESSION_LABEL[ws.session]}
              </span>
              {ws.session === "running" || ws.session === "starting" ? (
                <Button size="sm" disabled={ws.session === "starting" || act.isPending} onClick={() => act.mutate("stop")}>
                  <Square className="size-3" /> Stop
                </Button>
              ) : (
                <Button
                  size="sm"
                  variant="primary"
                  disabled={!canStart || node.disabled || ws.session === "stopping" || act.isPending}
                  title={canStart ? "Start Claude Code in this workspace" : `${node.name} needs tmux and Claude Code to start agents`}
                  onClick={() => act.mutate("start")}
                >
                  <Play className="size-3" /> Start
                </Button>
              )}
            </>
          )}
          <button
            className="rounded p-1 text-zinc-400 hover:bg-zinc-100 hover:text-zinc-700"
            title={`Copy "${attach}": run it on ${node.name} to watch or talk to the agent`}
            onClick={() => {
              void navigator.clipboard.writeText(attach);
              setCopied(true);
              setTimeout(() => setCopied(false), 1500);
            }}
          >
            {copied ? <Check className="size-3.5 text-emerald-600" /> : <Terminal className="size-3.5" />}
          </button>
          <button
            className="rounded p-1 text-zinc-400 hover:bg-zinc-100 hover:text-red-600"
            title="Remove workspace"
            onClick={() =>
              confirm(`Remove workspace ${ws.name}? Its agent is disabled and its session stopped. The folder stays on ${node.name}.`) &&
              act.mutate("remove")
            }
          >
            <Trash2 className="size-3.5" />
          </button>
        </div>
      </div>
      {open && (
        <div className="flex flex-wrap gap-x-3 gap-y-0.5 pl-12 text-xs text-zinc-500">
          <span className="font-mono break-all">{ws.path ?? `${node.workspaceRoot}/${ws.name}`}</span>
          <span className="break-all">{ws.repoUrl ? `from ${ws.repoUrl}` : "empty folder"}</span>
          {ws.createdBy && <span>created by {ws.createdBy.name}</span>}
        </div>
      )}
      {problem && <p className="pl-12 text-xs whitespace-pre-wrap text-red-600">{problem}</p>}
      <ErrorBox error={act.error} />
    </div>
  );
}

/** An agent whose Claude Code session runs on the node but that the node did not create. */
function RunningAgentRow({ agent, cwd }: { agent: NodeRunningAgent["agent"]; cwd: string | null }) {
  return (
    <div data-running-agent={agent.name} className="flex flex-wrap items-center gap-x-2.5 gap-y-1 py-2 pl-6">
      <Bot className="size-4 shrink-0 text-zinc-400" />
      <UserChip user={agent} />
      <span className="flex items-center gap-1.5 text-xs text-emerald-700">
        <span className="size-2 rounded-full bg-emerald-500" /> Running
      </span>
      <span className="font-mono text-xs break-all text-zinc-500">{cwd ?? "folder unknown"}</span>
    </div>
  );
}

function NewWorkspace({ node, onClose, onCreated }: { node: NodeInfo; onClose: () => void; onCreated: (n: NodeInfo) => void }) {
  const projects = useQuery({ queryKey: ["projects"], queryFn: () => api.get<ProjectInfo[]>("/api/projects") });
  const eligible = (projects.data ?? []).filter((p) => !p.archived && (p.myRole === "owner" || p.myRole === "member"));
  const canStart = !!node.capabilities?.tmux && !!node.capabilities?.claude;
  const [name, setName] = useState("");
  const [project, setProject] = useState("");
  const [newKey, setNewKey] = useState("");
  const [newName, setNewName] = useState("");
  const [repoUrl, setRepoUrl] = useState("");
  const [start, setStart] = useState(canStart);
  const creatingProject = project === "__new";
  const create = useMutation({
    mutationFn: () =>
      api.post<NodeInfo>(`/api/nodes/${node.id}/workspaces`, {
        name,
        ...(creatingProject ? { newProject: { key: newKey, name: newName } } : { projectKey: project }),
        repoUrl: repoUrl.trim() || null,
        start: start && canStart,
      }),
    onSuccess: onCreated,
  });
  const ready = name.trim() && (creatingProject ? newKey.trim() && newName.trim() : project);

  return (
    <Modal
      title={`New workspace on ${node.name}`}
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" disabled={!ready} loading={create.isPending} onClick={() => create.mutate()}>
            Create workspace
          </Button>
        </>
      }
    >
      <p className="text-sm text-zinc-500">
        {node.name} creates the folder, and a new agent linked to {node.owner.name} that joins the project.
      </p>
      <Field label="Name" hint={`Folder ${node.workspaceRoot}/${name.trim().toLowerCase() || "<name>"}`}>
        <Input value={name} onChange={(e) => setName(e.target.value.toLowerCase())} placeholder="website" className="font-mono" autoFocus spellCheck={false} />
      </Field>
      <Field label="Project">
        <Select
          value={project}
          onChange={(e) => {
            const v = e.target.value;
            setProject(v);
            const p = eligible.find((x) => x.key === v);
            if (p && !name) setName(p.key.toLowerCase());
          }}
        >
          <option value="">Choose a project…</option>
          {eligible.map((p) => (
            <option key={p.id} value={p.key}>
              {p.key} · {p.name}
            </option>
          ))}
          <option value="__new">New project…</option>
        </Select>
      </Field>
      {creatingProject && (
        <div className="grid grid-cols-[7rem_1fr] gap-3">
          <Field label="Key">
            <Input value={newKey} onChange={(e) => setNewKey(e.target.value.toUpperCase())} placeholder="WEB" className="font-mono" />
          </Field>
          <Field label="Project name">
            <Input value={newName} onChange={(e) => setNewName(e.target.value)} placeholder="Website" />
          </Field>
        </div>
      )}
      <Field label="Git repository (optional)" hint="Cloned into the folder; leave empty for an empty folder with git init. Private repos need credentials on the node.">
        <Input value={repoUrl} onChange={(e) => setRepoUrl(e.target.value)} placeholder="https://github.com/you/repo.git or git@github.com:you/repo.git" spellCheck={false} />
      </Field>
      <label className={cx("flex items-start gap-2 text-sm", !canStart && "text-zinc-400")}>
        <input type="checkbox" className="mt-0.5" checked={start && canStart} disabled={!canStart} onChange={(e) => setStart(e.target.checked)} />
        <span>
          Start the agent when the workspace is ready
          {!canStart && <span className="block text-xs">{node.name} needs tmux and Claude Code to start agents.</span>}
        </span>
      </label>
      <ErrorBox error={create.error} />
    </Modal>
  );
}

function Tool({ name, version }: { name: string; version: string | null | undefined }) {
  return (
    <span
      title={version ?? `${name} is not installed`}
      className={cx("inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px]", version ? "bg-zinc-100 text-zinc-600" : "bg-red-50 text-red-700")}
    >
      {version ? <Check className="size-3" /> : <X className="size-3" />}
      {name}
    </span>
  );
}

function NodeCard({ node, meId, onChange }: { node: NodeInfo; meId: string; onChange: () => void }) {
  const qc = useQueryClient();
  const [adding, setAdding] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [open, setOpen] = useExpanded(`node.${node.id}`);
  const replace = (n: NodeInfo) => {
    qc.setQueriesData<NodeInfo[]>({ queryKey: ["nodes"] }, (list) => list?.map((x) => (x.id === n.id ? n : x)));
    onChange();
  };
  const update = useMutation({
    mutationFn: (body: { disabled?: boolean; name?: string }) => api.patch<NodeInfo>(`/api/nodes/${node.id}`, body),
    onSuccess: (n) => {
      setRenaming(false);
      replace(n);
    },
  });
  const remove = useMutation({ mutationFn: () => api.del(`/api/nodes/${node.id}`), onSuccess: onChange });
  const others = node.agents.filter((a) => !a.workspaceId);
  const running = node.workspaces.filter((w) => w.session === "running").length + others.length;

  return (
    <Card>
      <div className="flex flex-wrap items-start gap-3 p-4">
        <span className="mt-2">
          <Twisty open={open} onToggle={() => setOpen(!open)} label={node.name} />
        </span>
        <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-zinc-900 text-white">
          <Server className="size-5" />
        </span>
        <div className="min-w-0 flex-1 space-y-1">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            {renaming ? (
              <InlineRename value={node.name} saving={update.isPending} onCancel={() => setRenaming(false)} onSave={(name) => update.mutate({ name })} />
            ) : (
              <>
                <span className="font-medium break-all">{node.name}</span>
                <button className="rounded p-0.5 text-zinc-400 hover:bg-zinc-100 hover:text-zinc-700" title="Rename node" onClick={() => setRenaming(true)}>
                  <Pencil className="size-3.5" />
                </button>
              </>
            )}
            <span className={cx("flex items-center gap-1 text-xs", node.online ? "text-emerald-700" : "text-zinc-500")}>
              <span className={cx("size-2 rounded-full", node.online ? "bg-emerald-500" : "bg-zinc-300")} />
              {node.online ? "online" : node.lastSeenAt ? `offline, last seen ${timeAgo(node.lastSeenAt)}` : "never connected"}
            </span>
            {node.disabled && <Badge className="bg-red-50 text-red-600">disabled</Badge>}
            {node.owner.id !== meId && <span className="text-xs text-zinc-500">owned by {node.owner.name}</span>}
          </div>
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-zinc-500">
            <span>
              {[node.hostname, node.platform && `${node.platform} ${node.arch}`, node.version && `rev ${node.version}`].filter(Boolean).join(" · ")}
            </span>
            <span className="flex gap-1">
              <Tool name="git" version={node.capabilities?.git} />
              <Tool name="tmux" version={node.capabilities?.tmux} />
              <Tool name="claude" version={node.capabilities?.claude} />
            </span>
          </div>
          {!open && (
            <div className="text-xs text-zinc-500">
              {node.workspaces.length} workspace{node.workspaces.length === 1 ? "" : "s"} · {running} agent{running === 1 ? "" : "s"} running
            </div>
          )}
        </div>
        <div className="flex gap-2 max-sm:w-full max-sm:pl-20">
          <Button size="sm" variant="primary" disabled={node.disabled} onClick={() => setAdding(true)}>
            <Plus className="size-3.5" /> New workspace
          </Button>
          <Button size="sm" variant={node.disabled ? "secondary" : "danger"} onClick={() => update.mutate({ disabled: !node.disabled })}>
            {node.disabled ? "Enable" : "Disable"}
          </Button>
          <Button
            size="sm"
            variant="ghost"
            title="Remove node"
            onClick={() =>
              confirm(`Remove ${node.name} from Rev? The agents it created are disabled. Stop its service with: rev node uninstall`) &&
              remove.mutate()
            }
          >
            <Trash2 className="size-3.5" />
          </Button>
        </div>
      </div>
      <ErrorBox error={update.error ?? remove.error} />
      {open && (
        <div className="space-y-1 border-t border-zinc-100 px-4 py-2 sm:pl-12">
          <Branch id={`node.${node.id}.workspaces`} title="Workspaces" count={node.workspaces.length}>
            {node.workspaces.length ? (
              node.workspaces.map((ws) => <WorkspaceRow key={ws.id} node={node} ws={ws} onChange={replace} />)
            ) : (
              <p className="py-2 text-sm text-zinc-400">None yet. Create one to get a folder with its own agent in {node.workspaceRoot || "the node's workspace folder"}.</p>
            )}
          </Branch>
          <Branch id={`node.${node.id}.agents`} title="Other agents running here" count={others.length}>
            {others.length ? (
              others.map((a) => <RunningAgentRow key={`${a.agent.id}:${a.cwd}`} agent={a.agent} cwd={a.cwd} />)
            ) : (
              <p className="py-2 text-sm text-zinc-400">
                {node.online
                  ? "None right now. Claude Code sessions using Rev on this computer show up here."
                  : "Shown while the node is online."}
              </p>
            )}
          </Branch>
        </div>
      )}
      {adding && (
        <NewWorkspace
          node={node}
          onClose={() => setAdding(false)}
          onCreated={(n) => {
            setAdding(false);
            replace(n);
            qc.invalidateQueries({ queryKey: ["projects"] });
          }}
        />
      )}
    </Card>
  );
}

export function Nodes() {
  const me = useUser();
  const qc = useQueryClient();
  const [showAll, setShowAll] = useState(false);
  const [adding, setAdding] = useState(false);
  const { data, isLoading, error } = useQuery({
    queryKey: ["nodes", showAll],
    queryFn: () => api.get<NodeInfo[]>(`/api/nodes${showAll ? "?all=1" : ""}`),
    // Quick while something is being set up, started or stopped.
    refetchInterval: (q) =>
      q.state.data?.some((n) => n.workspaces.some((w) => w.status === "pending" || w.session === "starting" || w.session === "stopping"))
        ? 2000
        : 10_000,
  });
  const refresh = () => qc.invalidateQueries({ queryKey: ["nodes"] });
  // An admin with no nodes of their own may still be looking for someone else's.
  const others = useQuery({
    queryKey: ["nodes", true],
    queryFn: () => api.get<NodeInfo[]>("/api/nodes?all=1"),
    enabled: me.role === "admin" && !showAll && data?.length === 0,
  });
  const otherCount = others.data?.length ?? 0;

  return (
    <div>
      <PageHeader
        title="Nodes"
        subtitle="Computers running rev node. Create workspaces on them, each with its own agent, and start Claude Code there from here."
        actions={
          <>
            {me.role === "admin" && (
              <label className="flex items-center gap-1.5 text-sm whitespace-nowrap text-zinc-600">
                <input type="checkbox" checked={showAll} onChange={(e) => setShowAll(e.target.checked)} /> All nodes
              </label>
            )}
            {!!data?.length && (
              <Button variant="primary" onClick={() => setAdding(true)}>
                <Plus className="size-4" /> Add a node
              </Button>
            )}
          </>
        }
      />
      <div className="mx-auto max-w-4xl space-y-4 px-4 py-6 md:px-8">
        <ErrorBox error={error} />
        {isLoading ? (
          <PageLoader />
        ) : !data?.length ? (
          <>
            <EmptyState icon={<Server className="size-8" />} title={otherCount ? "You have no nodes of your own" : "No nodes yet"}>
              {otherCount ? (
                <>
                  {otherCount === 1 ? "1 node belongs" : `${otherCount} nodes belong`} to other people
                  {" ("}
                  {[...new Set(others.data!.map((n) => n.owner.email ?? n.owner.name))].join(", ")}
                  {"). "}
                  <button className="text-accent-600 hover:underline" onClick={() => setShowAll(true)}>
                    Show all nodes
                  </button>
                </>
              ) : (
                "A node is a computer that Rev can create workspaces and agents on, and start Claude Code in."
              )}
            </EmptyState>
            <AddNode />
          </>
        ) : (
          <>
            {adding && <AddNode onClose={() => setAdding(false)} />}
            {data.map((n) => (
              <NodeCard key={n.id} node={n} meId={me.id} onChange={refresh} />
            ))}
          </>
        )}
      </div>
    </div>
  );
}
