import { useState, type FormEvent, type ReactNode } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Navigate, useNavigate, useParams, useSearchParams } from "react-router";
import type { Me } from "@rev/shared";
import { api } from "../api";
import { Button, ErrorBox, Field, Input, PageLoader } from "../components/ui";

function AuthCard({ title, subtitle, children }: { title: string; subtitle?: ReactNode; children: ReactNode }) {
  return (
    <div className="flex min-h-full items-center justify-center bg-zinc-100 px-4 py-12">
      <div className="w-full max-w-sm">
        <div className="mb-6 flex items-center justify-center gap-2">
          <img src="/favicon.svg" alt="" className="size-8" />
          <span className="text-2xl font-semibold tracking-tight">Rev</span>
        </div>
        <div className="rounded-xl border border-zinc-200 bg-white p-6 shadow-sm">
          <h1 className="text-lg font-semibold">{title}</h1>
          {subtitle && <p className="mt-1 text-sm text-zinc-500">{subtitle}</p>}
          <div className="mt-5">{children}</div>
        </div>
      </div>
    </div>
  );
}

function useSignedIn() {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  return (me: Me) => {
    qc.setQueryData(["me"], me);
    const next = params.get("next");
    navigate(next && next.startsWith("/") && !next.startsWith("//") ? next : "/", { replace: true });
  };
}

export function Setup() {
  const signedIn = useSignedIn();
  const status = useQuery({ queryKey: ["setup"], queryFn: () => api.get<{ needsSetup: boolean }>("/api/setup/status") });
  const [form, setForm] = useState({ token: "", name: "", email: "", password: "" });
  const setup = useMutation({ mutationFn: () => api.post<Me>("/api/setup", form), onSuccess: signedIn });

  if (status.isLoading) return <PageLoader />;
  if (status.data && !status.data.needsSetup) return <Navigate to="/login" replace />;

  const set = (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement>) => setForm({ ...form, [k]: e.target.value });
  return (
    <AuthCard
      title="Welcome to Rev"
      subtitle={
        <>
          Create the first admin account. The setup token is printed in the server log (
          <code className="text-xs">docker compose logs rev</code>).
        </>
      }
    >
      <form
        className="space-y-4"
        onSubmit={(e: FormEvent) => {
          e.preventDefault();
          setup.mutate();
        }}
      >
        <Field label="Setup token">
          <Input value={form.token} onChange={set("token")} required autoFocus />
        </Field>
        <Field label="Your name">
          <Input value={form.name} onChange={set("name")} required />
        </Field>
        <Field label="Email">
          <Input type="email" value={form.email} onChange={set("email")} required />
        </Field>
        <Field label="Password" hint="At least 10 characters.">
          <Input type="password" value={form.password} onChange={set("password")} required minLength={10} />
        </Field>
        <ErrorBox error={setup.error} />
        <Button variant="primary" className="w-full" loading={setup.isPending}>
          Create admin account
        </Button>
      </form>
    </AuthCard>
  );
}

export function Login() {
  const signedIn = useSignedIn();
  const status = useQuery({ queryKey: ["setup"], queryFn: () => api.get<{ needsSetup: boolean }>("/api/setup/status") });
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const login = useMutation({ mutationFn: () => api.post<Me>("/api/auth/login", { email, password }), onSuccess: signedIn });

  if (status.data?.needsSetup) return <Navigate to="/setup" replace />;
  return (
    <AuthCard title="Sign in" subtitle="Accounts are created by invitation from an admin.">
      <form
        className="space-y-4"
        onSubmit={(e) => {
          e.preventDefault();
          login.mutate();
        }}
      >
        <Field label="Email">
          <Input type="email" value={email} onChange={(e) => setEmail(e.target.value)} required autoFocus autoComplete="username" />
        </Field>
        <Field label="Password">
          <Input type="password" value={password} onChange={(e) => setPassword(e.target.value)} required autoComplete="current-password" />
        </Field>
        <ErrorBox error={login.error} />
        <Button variant="primary" className="w-full" loading={login.isPending}>
          Sign in
        </Button>
      </form>
    </AuthCard>
  );
}

export function Invite() {
  const { token } = useParams();
  const signedIn = useSignedIn();
  const invite = useQuery({
    queryKey: ["invite", token],
    queryFn: () => api.get<{ kind: "invite" | "reset"; email: string }>(`/api/invites/${token}`),
  });
  const [name, setName] = useState("");
  const [password, setPassword] = useState("");
  const accept = useMutation({
    mutationFn: () => api.post<Me>(`/api/invites/${token}/accept`, { name: name || undefined, password }),
    onSuccess: signedIn,
  });

  if (invite.isLoading) return <PageLoader />;
  if (!invite.data) {
    return (
      <AuthCard title="Link expired">
        <p className="text-sm text-zinc-600">This link is invalid, already used, or expired. Ask an admin for a new one.</p>
      </AuthCard>
    );
  }
  const reset = invite.data.kind === "reset";
  return (
    <AuthCard title={reset ? "Reset your password" : "Join Rev"} subtitle={invite.data.email}>
      <form
        className="space-y-4"
        onSubmit={(e) => {
          e.preventDefault();
          accept.mutate();
        }}
      >
        {!reset && (
          <Field label="Your name">
            <Input value={name} onChange={(e) => setName(e.target.value)} required autoFocus />
          </Field>
        )}
        <Field label={reset ? "New password" : "Password"} hint="At least 10 characters.">
          <Input type="password" value={password} onChange={(e) => setPassword(e.target.value)} required minLength={10} autoComplete="new-password" />
        </Field>
        <ErrorBox error={accept.error} />
        <Button variant="primary" className="w-full" loading={accept.isPending}>
          {reset ? "Set password" : "Create account"}
        </Button>
      </form>
    </AuthCard>
  );
}
