import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { Me } from "@rev/shared";
import { api } from "../api";
import { useUser } from "../auth";
import { PageHeader } from "../components/Layout";
import { Button, Card, ErrorBox, Field, Input } from "../components/ui";

export function Account() {
  const user = useUser();
  const qc = useQueryClient();
  const [name, setName] = useState(user.name);
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [done, setDone] = useState(false);
  const profile = useMutation({
    mutationFn: () => api.patch<Me>("/api/auth/me", { name }),
    onSuccess: (me) => qc.setQueryData(["me"], me),
  });
  const password = useMutation({
    mutationFn: () => api.post("/api/auth/password", { current, next }),
    onSuccess: () => {
      setCurrent("");
      setNext("");
      setDone(true);
    },
  });

  return (
    <div>
      <PageHeader title="Account" subtitle={user.email} />
      <div className="mx-auto max-w-xl space-y-6 px-8 py-6">
        <Card className="space-y-4 p-5">
          <Field label="Name">
            <Input value={name} onChange={(e) => setName(e.target.value)} />
          </Field>
          <ErrorBox error={profile.error} />
          <div className="flex justify-end">
            <Button variant="primary" disabled={name === user.name || !name.trim()} loading={profile.isPending} onClick={() => profile.mutate()}>
              Save
            </Button>
          </div>
        </Card>
        <Card className="space-y-4 p-5">
          <h2 className="text-sm font-semibold">Change password</h2>
          <Field label="Current password">
            <Input type="password" value={current} onChange={(e) => setCurrent(e.target.value)} autoComplete="current-password" />
          </Field>
          <Field label="New password" hint="At least 10 characters. Other browser sessions are signed out.">
            <Input type="password" value={next} onChange={(e) => setNext(e.target.value)} autoComplete="new-password" />
          </Field>
          <ErrorBox error={password.error} />
          {done && <p className="text-sm text-emerald-700">Password changed.</p>}
          <div className="flex justify-end">
            <Button variant="primary" disabled={!current || next.length < 10} loading={password.isPending} onClick={() => password.mutate()}>
              Change password
            </Button>
          </div>
        </Card>
      </div>
    </div>
  );
}
