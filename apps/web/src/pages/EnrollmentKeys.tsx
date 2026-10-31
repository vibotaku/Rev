import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { KeyRound, Plus } from "lucide-react";
import type { EnrollmentKeyInfo, ProjectInfo } from "@rev/shared";
import { api } from "../api";
import { Badge, Button, Card, ErrorBox, Field, Input, Modal, Select } from "../components/ui";
import { cx, timeAgo } from "../lib";
import { CopyBlock } from "../components/CopyBlock";
import { AgentInstructions } from "./ConnectAgent";

function keyStatus(k: EnrollmentKeyInfo) {
  if (k.revokedAt) return { label: "revoked", className: "bg-red-50 text-red-600" };
  if (k.expiresAt && new Date(k.expiresAt) <= new Date()) return { label: "expired", className: "bg-zinc-100 text-zinc-500" };
  if (k.maxUses != null && k.uses >= k.maxUses) return { label: "used up", className: "bg-zinc-100 text-zinc-500" };
  return { label: "active", className: "bg-emerald-100 text-emerald-800" };
}

function expiresLabel(iso: string | null) {
  if (!iso) return "never expires";
  const days = Math.round((new Date(iso).getTime() - Date.now()) / 86_400_000);
  if (days < 0) return `expired ${timeAgo(iso)}`;
  return days === 0 ? "expires today" : `expires in ${days}d`;
}

/** Enrollment keys let agents register themselves; they become agents linked to the key's creator. */
export function EnrollmentKeys({ showAll }: { showAll: boolean }) {
  const qc = useQueryClient();
  const [creating, setCreating] = useState(false);
  const [created, setCreated] = useState<{ key: string; info: EnrollmentKeyInfo } | null>(null);
  const [revoking, setRevoking] = useState<EnrollmentKeyInfo | null>(null);
  const { data: keys, error } = useQuery({
    queryKey: ["enrollment-keys", showAll],
    queryFn: () => api.get<EnrollmentKeyInfo[]>(`/api/enrollment-keys${showAll ? "?all=1" : ""}`),
  });

  return (
    <section className="space-y-2">
      <div className="flex items-end justify-between gap-4">
        <div>
          <h2 className="text-sm font-semibold text-zinc-700">Enrollment keys</h2>
          <p className="text-sm text-zinc-500">
            Agents holding a key register themselves. They become your agents and join the key's projects.
          </p>
        </div>
        <Button variant="primary" onClick={() => setCreating(true)}>
          <Plus className="size-4" /> New enrollment key
        </Button>
      </div>
      <ErrorBox error={error} />
      {keys?.length ? (
        <Card className="divide-y divide-zinc-100">
          {keys.map((k) => {
            const status = keyStatus(k);
            return (
              <div key={k.id} className="flex items-start gap-3 px-4 py-3">
                <KeyRound className="mt-0.5 size-4 shrink-0 text-zinc-400" />
                <div className="min-w-0 flex-1 space-y-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-medium">{k.name}</span>
                    <code className="text-xs text-zinc-500">{k.prefix}…</code>
                    <Badge className={status.className}>{status.label}</Badge>
                    {showAll && <span className="text-xs text-zinc-500">by {k.createdBy.name}</span>}
                  </div>
                  <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-zinc-500">
                    <span>
                      {k.uses}
                      {k.maxUses != null ? ` / ${k.maxUses}` : ""} registration{(k.maxUses ?? k.uses) === 1 ? "" : "s"}
                    </span>
                    <span>{expiresLabel(k.expiresAt)}</span>
                    {k.lastUsedAt && <span>last used {timeAgo(k.lastUsedAt)}</span>}
                    <span className="flex flex-wrap gap-1">
                      {k.projects.length ? (
                        k.projects.map((p) => (
                          <Badge key={p.key} className="bg-zinc-100 text-zinc-700">
                            {p.key} · {p.role}
                          </Badge>
                        ))
                      ) : (
                        <span className="text-zinc-400">no projects</span>
                      )}
                    </span>
                  </div>
                  {k.agents.length > 0 && (
                    <div className="text-xs text-zinc-500">
                      Registered:{" "}
                      {k.agents.map((a, i) => (
                        <span key={a.id} className={cx(a.disabled && "line-through")}>
                          {i > 0 && ", "}
                          {a.name}
                        </span>
                      ))}
                    </div>
                  )}
                </div>
                {!k.revokedAt && (
                  <Button size="sm" variant="danger" onClick={() => setRevoking(k)}>
                    Revoke
                  </Button>
                )}
              </div>
            );
          })}
        </Card>
      ) : (
        <p className="text-sm text-zinc-400">No enrollment keys yet.</p>
      )}
      {creating && (
        <CreateKey
          onClose={() => setCreating(false)}
          onCreated={(r) => {
            setCreating(false);
            setCreated(r);
            qc.invalidateQueries({ queryKey: ["enrollment-keys"] });
          }}
        />
      )}
      {created && (
        <Modal
          title={`Enrollment key "${created.info.name}"`}
          wide
          onClose={() => setCreated(null)}
          footer={
            <Button variant="primary" onClick={() => setCreated(null)}>
              Done
            </Button>
          }
        >
          <p className="text-sm text-zinc-600">
            Copy it now — it will not be shown again. Store it like a password (e.g. in OpenBao/Vault, then pass{" "}
            <code className="text-xs">bao:&lt;path&gt;#&lt;field&gt;</code> to <code className="text-xs">/rev:setup</code>).
          </p>
          <CopyBlock text={created.key} />
          <AgentInstructions enrollKey={created.key} />
        </Modal>
      )}
      {revoking && (
        <RevokeKey
          keyInfo={revoking}
          onClose={() => setRevoking(null)}
          onDone={() => {
            setRevoking(null);
            qc.invalidateQueries({ queryKey: ["enrollment-keys"] });
            qc.invalidateQueries({ queryKey: ["agents"] });
          }}
        />
      )}
    </section>
  );
}

export function CreateKey({ onClose, onCreated }: { onClose: () => void; onCreated: (r: { key: string; info: EnrollmentKeyInfo }) => void }) {
  const projects = useQuery({ queryKey: ["projects"], queryFn: () => api.get<ProjectInfo[]>("/api/projects") });
  const [name, setName] = useState("");
  const [selected, setSelected] = useState<Record<string, "member" | "viewer" | undefined>>({});
  const [maxUses, setMaxUses] = useState("");
  const [expires, setExpires] = useState("30");
  const create = useMutation({
    mutationFn: () =>
      api.post<{ key: string; info: EnrollmentKeyInfo }>("/api/enrollment-keys", {
        name,
        projects: Object.entries(selected)
          .filter(([, role]) => role)
          .map(([key, role]) => ({ key, role })),
        maxUses: maxUses ? Number(maxUses) : null,
        expiresInDays: expires === "never" ? null : Number(expires),
      }),
    onSuccess: onCreated,
  });
  // Agents can only be enrolled into projects you can add agents to.
  const eligible = (projects.data ?? []).filter((p) => !p.archived && (p.myRole === "owner" || p.myRole === "member"));

  return (
    <Modal
      title="New enrollment key"
      wide
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" disabled={!name.trim()} loading={create.isPending} onClick={() => create.mutate()}>
            Create key
          </Button>
        </>
      }
    >
      <Field label="Name" hint="What the key is for, e.g. “Build machines” or “Alice's laptops”.">
        <Input value={name} onChange={(e) => setName(e.target.value)} autoFocus />
      </Field>
      <div className="space-y-1.5">
        <span className="text-sm font-medium text-zinc-700">Projects new agents join</span>
        {eligible.length ? (
          <div className="divide-y divide-zinc-100 rounded-md border border-zinc-200">
            {eligible.map((p) => (
              <label key={p.key} className="flex items-center gap-3 px-3 py-2 text-sm">
                <input
                  type="checkbox"
                  checked={!!selected[p.key]}
                  onChange={(e) => setSelected({ ...selected, [p.key]: e.target.checked ? "member" : undefined })}
                />
                <span className="w-14 font-mono text-xs text-zinc-500">{p.key}</span>
                <span className="flex-1">{p.name}</span>
                {selected[p.key] && (
                  <Select
                    className="!h-7 w-28 text-xs"
                    value={selected[p.key]}
                    onChange={(e) => setSelected({ ...selected, [p.key]: e.target.value as "member" | "viewer" })}
                  >
                    <option value="member">member</option>
                    <option value="viewer">viewer</option>
                  </Select>
                )}
              </label>
            ))}
          </div>
        ) : (
          <p className="text-sm text-zinc-400">You're not an owner or member of any active project; agents will join no projects.</p>
        )}
      </div>
      <div className="grid grid-cols-2 gap-4">
        <Field label="Max registrations" hint="Leave empty for unlimited.">
          <Input type="number" min={1} value={maxUses} onChange={(e) => setMaxUses(e.target.value)} placeholder="unlimited" />
        </Field>
        <Field label="Expires">
          <Select value={expires} onChange={(e) => setExpires(e.target.value)}>
            <option value="1">in 1 day</option>
            <option value="7">in 7 days</option>
            <option value="30">in 30 days</option>
            <option value="90">in 90 days</option>
            <option value="365">in 1 year</option>
            <option value="never">never</option>
          </Select>
        </Field>
      </div>
      <ErrorBox error={create.error} />
    </Modal>
  );
}

function RevokeKey({ keyInfo, onClose, onDone }: { keyInfo: EnrollmentKeyInfo; onClose: () => void; onDone: () => void }) {
  const active = keyInfo.agents.filter((a) => !a.disabled);
  const [disableAgents, setDisableAgents] = useState(false);
  const revoke = useMutation({
    mutationFn: () => api.del(`/api/enrollment-keys/${keyInfo.id}${disableAgents ? "?disableAgents=1" : ""}`),
    onSuccess: onDone,
  });
  return (
    <Modal
      title={`Revoke "${keyInfo.name}"?`}
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="danger" loading={revoke.isPending} onClick={() => revoke.mutate()}>
            Revoke
          </Button>
        </>
      }
    >
      <p className="text-sm text-zinc-600">No new agents can register with this key. Agents that already registered keep working.</p>
      {active.length > 0 && (
        <label className="flex items-start gap-2 text-sm">
          <input type="checkbox" className="mt-1" checked={disableAgents} onChange={(e) => setDisableAgents(e.target.checked)} />
          <span>
            Also disable the {active.length} agent{active.length > 1 ? "s" : ""} registered with it ({active.map((a) => a.name).join(", ")}),
            e.g. if the key leaked.
          </span>
        </label>
      )}
      <ErrorBox error={revoke.error} />
    </Modal>
  );
}
