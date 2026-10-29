import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Copy, Mail, Trash2 } from "lucide-react";
import { Navigate } from "react-router";
import type { GlobalRole, InviteInfo, UserDetail } from "@rev/shared";
import { api } from "../api";
import { useUser } from "../auth";
import { PageHeader } from "../components/Layout";
import { Badge, Button, Card, ErrorBox, Field, Input, Modal, Select, UserChip } from "../components/ui";
import { timeAgo } from "../lib";

export function Admin() {
  const me = useUser();
  const qc = useQueryClient();
  const [inviting, setInviting] = useState(false);
  const [link, setLink] = useState<{ title: string; url: string } | null>(null);
  const users = useQuery({ queryKey: ["users"], queryFn: () => api.get<UserDetail[]>("/api/users"), enabled: me.role === "admin" });
  const invites = useQuery({ queryKey: ["invites"], queryFn: () => api.get<InviteInfo[]>("/api/invites"), enabled: me.role === "admin" });
  const update = useMutation({
    mutationFn: ({ id, ...body }: { id: string; role?: GlobalRole; disabled?: boolean }) => api.patch(`/api/users/${id}`, body),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["users"] }),
  });
  const reset = useMutation({
    mutationFn: (u: UserDetail) => api.post<InviteInfo>(`/api/users/${u.id}/reset-link`).then((i) => ({ u, i })),
    onSuccess: ({ u, i }) => setLink({ title: `Password reset link for ${u.name}`, url: i.url! }),
  });
  const cancelInvite = useMutation({
    mutationFn: (id: string) => api.del(`/api/invites/${id}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["invites"] }),
  });

  if (me.role !== "admin") return <Navigate to="/" replace />;
  const humans = (users.data ?? []).filter((u) => u.kind === "human");

  return (
    <div>
      <PageHeader
        title="Admin"
        subtitle="People sign in with email and password. Rev does not send email — share invite and reset links yourself."
        actions={
          <Button variant="primary" onClick={() => setInviting(true)}>
            <Mail className="size-4" /> Invite someone
          </Button>
        }
      />
      <div className="mx-auto max-w-4xl space-y-6 px-8 py-6">
        <ErrorBox error={users.error ?? update.error ?? reset.error} />
        <section className="space-y-2">
          <h2 className="text-sm font-semibold text-zinc-700">People</h2>
          <Card className="divide-y divide-zinc-100">
            {humans.map((u) => (
              <div key={u.id} className="flex items-center gap-3 px-4 py-2.5">
                <div className="min-w-0 flex-1">
                  <UserChip user={u} size="md" />
                </div>
                <span className="hidden text-sm text-zinc-500 sm:block">{u.email}</span>
                {u.disabled && <Badge className="bg-red-50 text-red-600">disabled</Badge>}
                <Select
                  className="w-28"
                  value={u.role}
                  disabled={u.id === me.id}
                  onChange={(e) => update.mutate({ id: u.id, role: e.target.value as GlobalRole })}
                >
                  <option value="member">member</option>
                  <option value="admin">admin</option>
                </Select>
                <Button size="sm" onClick={() => reset.mutate(u)}>
                  Reset link
                </Button>
                <Button
                  size="sm"
                  variant={u.disabled ? "secondary" : "danger"}
                  disabled={u.id === me.id}
                  onClick={() => update.mutate({ id: u.id, disabled: !u.disabled })}
                  title="Disabling a person also stops every agent linked to them"
                >
                  {u.disabled ? "Enable" : "Disable"}
                </Button>
              </div>
            ))}
          </Card>
        </section>
        <section className="space-y-2">
          <h2 className="text-sm font-semibold text-zinc-700">Pending invitations</h2>
          {invites.data?.length ? (
            <Card className="divide-y divide-zinc-100">
              {invites.data.map((i) => (
                <div key={i.id} className="flex items-center gap-3 px-4 py-2.5 text-sm">
                  <span className="flex-1">{i.email}</span>
                  <span className="text-zinc-500">{i.role}</span>
                  <span className="text-xs text-zinc-400">sent {timeAgo(i.createdAt)}</span>
                  <button className="text-zinc-400 hover:text-red-600" onClick={() => cancelInvite.mutate(i.id)} title="Cancel invitation">
                    <Trash2 className="size-4" />
                  </button>
                </div>
              ))}
            </Card>
          ) : (
            <p className="text-sm text-zinc-400">None.</p>
          )}
        </section>
      </div>
      {inviting && (
        <InviteDialog
          onClose={() => setInviting(false)}
          onCreated={(i) => {
            setInviting(false);
            qc.invalidateQueries({ queryKey: ["invites"] });
            setLink({ title: `Invitation for ${i.email}`, url: i.url! });
          }}
        />
      )}
      {link && (
        <Modal title={link.title} onClose={() => setLink(null)} footer={<Button variant="primary" onClick={() => setLink(null)}>Done</Button>}>
          <p className="text-sm text-zinc-600">Send this link to them. It works once and expires in 7 days.</p>
          <div className="flex gap-2">
            <Input readOnly value={link.url} onFocus={(e) => e.target.select()} />
            <Button onClick={() => navigator.clipboard.writeText(link.url)} title="Copy">
              <Copy className="size-4" />
            </Button>
          </div>
        </Modal>
      )}
    </div>
  );
}

function InviteDialog({ onClose, onCreated }: { onClose: () => void; onCreated: (i: InviteInfo) => void }) {
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<GlobalRole>("member");
  const create = useMutation({ mutationFn: () => api.post<InviteInfo>("/api/invites", { email, role }), onSuccess: onCreated });
  return (
    <Modal
      title="Invite someone"
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" disabled={!email} loading={create.isPending} onClick={() => create.mutate()}>
            Create invite link
          </Button>
        </>
      }
    >
      <Field label="Email">
        <Input type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoFocus />
      </Field>
      <Field label="Role" hint="Admins manage people and can act as owner of every project.">
        <Select value={role} onChange={(e) => setRole(e.target.value as GlobalRole)}>
          <option value="member">member</option>
          <option value="admin">admin</option>
        </Select>
      </Field>
      <ErrorBox error={create.error} />
    </Modal>
  );
}
