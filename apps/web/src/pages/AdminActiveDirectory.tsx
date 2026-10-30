import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CheckCircle2, Download, RefreshCw, ShieldCheck, XCircle } from "lucide-react";
import type {
  CaCertificateInfo,
  LdapAccountsInfo,
  LdapAdminInfo,
  LdapSettingsBody,
  LdapSyncStatus,
  LdapTestReport,
} from "@rev/shared";
import { api, ApiError } from "../api";
import { Badge, Button, Card, ErrorBox, Field, Input, PageLoader, Textarea } from "../components/ui";
import { cx, timeAgo } from "../lib";

interface FormState {
  enabled: boolean;
  urls: string;
  baseDn: string;
  bindDn: string;
  bindPassword: string;
  allowedGroup: string;
  domain: string;
  caPem: string;
  startTls: boolean;
  verifyTls: boolean;
  syncMinutes: string;
}

function toForm(info: LdapAdminInfo): FormState {
  const s = info.settings;
  return {
    enabled: s.enabled,
    urls: s.urls.join("\n"),
    baseDn: s.baseDn,
    bindDn: s.bindDn,
    bindPassword: "",
    allowedGroup: s.allowedGroup ?? "",
    domain: s.domain,
    caPem: s.caPem ?? "",
    startTls: s.startTls,
    verifyTls: s.verifyTls,
    syncMinutes: String(s.syncMinutes),
  };
}

function toBody(f: FormState, force = false): LdapSettingsBody {
  return {
    enabled: f.enabled,
    urls: f.urls
      .split(/[\n,]/)
      .map((u) => u.trim())
      .filter(Boolean),
    baseDn: f.baseDn,
    bindDn: f.bindDn,
    bindPassword: f.bindPassword || undefined,
    allowedGroup: f.allowedGroup.trim() || null,
    domain: f.domain,
    caPem: f.caPem.trim() || null,
    startTls: f.startTls,
    verifyTls: f.verifyTls,
    syncMinutes: Number(f.syncMinutes) || 0,
    force,
  };
}

function SyncSummary({ sync }: { sync: LdapSyncStatus }) {
  if (sync.error) return <span className="text-red-600">failed: {sync.error}</span>;
  if (sync.skipped === "unavailable") return <span className="text-amber-700">skipped, directory unreachable</span>;
  if (sync.skipped) return <span className="text-red-600">refused: it would have suspended every directory account. Check the settings.</span>;
  const parts = [`checked ${sync.checked}`];
  if (sync.suspended.length) parts.push(`suspended ${sync.suspended.join(", ")}`);
  if (sync.restored.length) parts.push(`restored ${sync.restored.join(", ")}`);
  return <span>{parts.join(" · ")}</span>;
}

function TestReport({ report }: { report: LdapTestReport }) {
  return (
    <div className={cx("space-y-3 rounded-md border p-3 text-sm", report.ok ? "border-emerald-200 bg-emerald-50/60" : "border-red-200 bg-red-50/60")}>
      <div className="font-medium">{report.ok ? "All domain controllers passed" : "Some checks failed"}</div>
      {report.servers.map((s) => (
        <div key={s.url}>
          <div className="font-mono text-xs text-zinc-600">{s.url}</div>
          <ul className="mt-1 space-y-0.5">
            {s.checks.map((c) => (
              <li key={c.name} className="flex items-start gap-1.5">
                {c.ok ? <CheckCircle2 className="mt-0.5 size-3.5 shrink-0 text-emerald-600" /> : <XCircle className="mt-0.5 size-3.5 shrink-0 text-red-600" />}
                <span>
                  <span className="font-medium">{c.name}:</span> {c.detail}
                </span>
              </li>
            ))}
          </ul>
        </div>
      ))}
      {report.signIn && (
        <div className="flex items-start gap-1.5 border-t border-zinc-200 pt-2">
          {report.signIn.ok ? <CheckCircle2 className="mt-0.5 size-3.5 text-emerald-600" /> : <XCircle className="mt-0.5 size-3.5 text-red-600" />}
          <span>
            <span className="font-medium">Test sign-in:</span> {report.signIn.detail}
          </span>
        </div>
      )}
    </div>
  );
}

function CertList({ certs }: { certs: CaCertificateInfo[] }) {
  return (
    <ul className="space-y-1 text-xs">
      {certs.map((c) => (
        <li key={c.fingerprint256} className="rounded border border-zinc-200 bg-zinc-50 px-2 py-1.5">
          <div className="font-medium">{c.subject}</div>
          <div className="text-zinc-500">
            expires {new Date(c.validTo).toLocaleDateString()} · SHA-256 <span className="font-mono break-all">{c.fingerprint256}</span>
          </div>
        </li>
      ))}
    </ul>
  );
}

export function AdminActiveDirectory() {
  const qc = useQueryClient();
  const info = useQuery({ queryKey: ["ldap-admin"], queryFn: () => api.get<LdapAdminInfo>("/api/admin/ldap") });
  const accounts = useQuery({
    queryKey: ["ldap-accounts"],
    queryFn: () => api.get<LdapAccountsInfo>("/api/admin/ldap/accounts"),
    enabled: !!info.data,
  });
  const [form, setForm] = useState<FormState | null>(null);
  const [testLogin, setTestLogin] = useState({ login: "", password: "" });
  const [report, setReport] = useState<LdapTestReport | null>(null);
  const [fetched, setFetched] = useState<{ pem: string; info: CaCertificateInfo }[] | null>(null);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    if (info.data && !form) setForm(toForm(info.data));
  }, [info.data, form]);

  const refresh = () => {
    qc.invalidateQueries({ queryKey: ["ldap-admin"] });
    qc.invalidateQueries({ queryKey: ["ldap-accounts"] });
    qc.invalidateQueries({ queryKey: ["auth-config"] });
  };
  const test = useMutation({
    mutationFn: () =>
      api.post<LdapTestReport>("/api/admin/ldap/test", {
        settings: toBody(form!),
        ...(testLogin.login && testLogin.password ? testLogin : {}),
      }),
    onSuccess: setReport,
  });
  const save = useMutation({
    mutationFn: (force: boolean) => api.put<LdapAdminInfo>("/api/admin/ldap", toBody(form!, force)),
    onSuccess: (data) => {
      qc.setQueryData(["ldap-admin"], data);
      setForm(toForm(data));
      setReport(null);
      setSaved(true);
      setTimeout(() => setSaved(false), 2500);
      refresh();
    },
    onError: (err) => {
      if (err instanceof ApiError && err.code === "test_failed") setReport(err.details as LdapTestReport);
    },
  });
  const fetchCa = useMutation({
    mutationFn: () => api.post<{ pem: string; info: CaCertificateInfo }[]>("/api/admin/ldap/fetch-ca", toBody(form!)),
    onSuccess: setFetched,
  });
  const sync = useMutation({ mutationFn: () => api.post<LdapSyncStatus>("/api/admin/ldap/sync"), onSuccess: refresh });

  if (info.isLoading || !form) return <PageLoader />;
  if (!info.data) return <div className="p-8"><ErrorBox error={info.error} /></div>;
  const data = info.data;
  const set = <K extends keyof FormState>(k: K, v: FormState[K]) => setForm({ ...form, [k]: v });
  const testFailedOnSave = save.error instanceof ApiError && save.error.code === "test_failed";

  return (
    <div className="mx-auto max-w-4xl space-y-6 px-8 py-6">
      {/* Status */}
      <Card className="flex flex-wrap items-center gap-x-6 gap-y-2 p-4 text-sm">
        <div className="flex items-center gap-2">
          <ShieldCheck className={cx("size-5", data.settings.enabled ? "text-emerald-600" : "text-zinc-400")} />
          <span className="font-medium">Active Directory sign-in</span>
          <Badge className={data.settings.enabled ? "bg-emerald-100 text-emerald-800" : "bg-zinc-100 text-zinc-600"}>
            {data.settings.enabled ? "enabled" : "disabled"}
          </Badge>
        </div>
        <div className="text-zinc-500">
          Last sync:{" "}
          {data.lastSync ? (
            <>
              {timeAgo(data.lastSync.at)} — <SyncSummary sync={data.lastSync} />
            </>
          ) : (
            "never"
          )}
          {data.nextSyncAt && <> · next {new Date(data.nextSyncAt).toLocaleTimeString()}</>}
        </div>
        <Button size="sm" className="ml-auto" disabled={!data.settings.enabled} loading={sync.isPending} onClick={() => sync.mutate()}>
          <RefreshCw className="size-3.5" /> Sync now
        </Button>
        {data.settings.updatedAt && (
          <div className="w-full text-xs text-zinc-400">
            Settings last changed {timeAgo(data.settings.updatedAt)}
            {data.settings.updatedBy ? ` by ${data.settings.updatedBy.name}` : " (imported from the environment)"}.
          </div>
        )}
        <ErrorBox error={sync.error} />
      </Card>

      {data.envIgnored && (
        <div className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800">
          The server still has <code className="text-xs">LDAP_*</code> environment variables. They are ignored: these settings are the source
          of truth. Remove them from the server's <code className="text-xs">.env</code> to avoid confusion.
        </div>
      )}

      {/* Settings */}
      <Card className="space-y-5 p-5">
        <label className="flex items-center gap-2 text-sm font-medium">
          <input type="checkbox" checked={form.enabled} onChange={(e) => set("enabled", e.target.checked)} />
          Allow people to sign in with their Active Directory account
        </label>
        <div className="grid gap-4 md:grid-cols-2">
          <Field label="Domain controllers" hint="One per line, tried in order. ldaps://host (port 636) recommended.">
            <Textarea
              rows={3}
              value={form.urls}
              onChange={(e) => set("urls", e.target.value)}
              className="font-mono text-xs"
              placeholder={"ldaps://dc01.corp.example.com\nldaps://dc02.corp.example.com"}
            />
          </Field>
          <div className="space-y-4">
            <Field label="Base DN">
              <Input value={form.baseDn} onChange={(e) => set("baseDn", e.target.value)} placeholder="DC=corp,DC=example,DC=com" className="font-mono text-xs" />
            </Field>
            <Field label="Sign-in domain" hint="Shown on the login page; also accepted as user@domain.">
              <Input value={form.domain} onChange={(e) => set("domain", e.target.value)} placeholder="derived from the base DN" />
            </Field>
          </div>
          <Field label="Bind account" hint="Read-only service account used to look people up (UPN or DN).">
            <Input value={form.bindDn} onChange={(e) => set("bindDn", e.target.value)} placeholder="svc-rev-bind@corp.example.com" />
          </Field>
          <Field label="Bind password" hint={data.settings.hasBindPassword ? "Saved (encrypted). Leave empty to keep it." : "Stored encrypted."}>
            <Input
              type="password"
              autoComplete="new-password"
              value={form.bindPassword}
              onChange={(e) => set("bindPassword", e.target.value)}
              placeholder={data.settings.hasBindPassword ? "••••••••  (unchanged)" : ""}
            />
          </Field>
          <Field label="Allowed group" hint="Name or DN. Members, incl. nested groups, may sign in. Empty: every enabled account.">
            <Input value={form.allowedGroup} onChange={(e) => set("allowedGroup", e.target.value)} placeholder="Rev-Users" />
          </Field>
          <Field label="Re-check accounts every (minutes)" hint="Suspends people AD no longer allows, and their agents. 0 turns it off.">
            <Input type="number" min={0} max={1440} value={form.syncMinutes} onChange={(e) => set("syncMinutes", e.target.value)} />
          </Field>
        </div>

        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <span className="text-sm font-medium text-zinc-700">CA certificate (PEM)</span>
            <Button size="sm" loading={fetchCa.isPending} onClick={() => fetchCa.mutate()}>
              <Download className="size-3.5" /> Fetch from directory
            </Button>
          </div>
          <Textarea
            rows={4}
            value={form.caPem}
            onChange={(e) => set("caPem", e.target.value)}
            className="font-mono text-[11px]"
            placeholder="-----BEGIN CERTIFICATE----- … (the AD CS root that issued the domain controllers' certificates)"
          />
          {data.settings.caCertificates.length > 0 && form.caPem.trim() === (data.settings.caPem ?? "").trim() && (
            <CertList certs={data.settings.caCertificates} />
          )}
          <ErrorBox error={fetchCa.error} />
          {fetched && (
            <div className="space-y-2 rounded-md border border-amber-200 bg-amber-50 p-3 text-sm">
              <p className="text-amber-900">
                Found {fetched.length} CA certificate{fetched.length === 1 ? "" : "s"} in the directory. They were read without TLS
                verification, so compare the fingerprint with your CA (e.g. <code className="text-xs">certutil -ca.cert</code>) before
                trusting it.
              </p>
              {fetched.map((c) => (
                <div key={c.info.fingerprint256} className="flex items-start gap-2">
                  <div className="min-w-0 flex-1">
                    <CertList certs={[c.info]} />
                  </div>
                  <Button
                    size="sm"
                    onClick={() => {
                      set("caPem", c.pem);
                      setFetched(null);
                    }}
                  >
                    Trust
                  </Button>
                </div>
              ))}
            </div>
          )}
          <div className="flex flex-wrap gap-4 pt-1 text-sm">
            <label className="flex items-center gap-2">
              <input type="checkbox" checked={form.verifyTls} onChange={(e) => set("verifyTls", e.target.checked)} />
              Verify TLS certificates (recommended)
            </label>
            <label className="flex items-center gap-2">
              <input type="checkbox" checked={form.startTls} onChange={(e) => set("startTls", e.target.checked)} />
              Use StartTLS for ldap:// URLs
            </label>
          </div>
        </div>

        <div className="space-y-2 border-t border-zinc-100 pt-4">
          <span className="text-sm font-medium text-zinc-700">Test a sign-in (optional)</span>
          <div className="grid gap-2 md:grid-cols-2">
            <Input placeholder="username" value={testLogin.login} onChange={(e) => setTestLogin({ ...testLogin, login: e.target.value })} autoComplete="off" />
            <Input
              type="password"
              placeholder="password (not stored)"
              value={testLogin.password}
              onChange={(e) => setTestLogin({ ...testLogin, password: e.target.value })}
              autoComplete="new-password"
            />
          </div>
        </div>

        {report && <TestReport report={report} />}
        <ErrorBox error={test.error ?? (testFailedOnSave ? null : save.error)} />
        {testFailedOnSave && <p className="text-sm text-red-700">{(save.error as Error).message}</p>}

        <div className="flex items-center justify-end gap-2">
          {saved && <span className="text-sm text-emerald-700">Saved and applied.</span>}
          <Button loading={test.isPending} onClick={() => test.mutate()}>
            Test connection
          </Button>
          {testFailedOnSave && (
            <Button variant="danger" loading={save.isPending} onClick={() => save.mutate(true)}>
              Save anyway
            </Button>
          )}
          <Button variant="primary" loading={save.isPending && !save.variables} onClick={() => save.mutate(false)}>
            Save
          </Button>
        </div>
      </Card>

      {/* Accounts */}
      <section className="space-y-2">
        <h2 className="text-sm font-semibold text-zinc-700">Directory accounts</h2>
        <ErrorBox error={accounts.error} />
        {accounts.data?.directoryError && (
          <div className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800">
            Couldn't list group members: {accounts.data.directoryError}
          </div>
        )}
        {accounts.isLoading ? (
          <p className="text-sm text-zinc-400">Loading accounts…</p>
        ) : accounts.data?.accounts.length ? (
          <Card className="overflow-hidden">
            <table className="w-full text-sm">
              <thead className="bg-zinc-50 text-left text-xs text-zinc-500">
                <tr>
                  <th className="px-4 py-2 font-medium">Name</th>
                  <th className="px-4 py-2 font-medium">Username</th>
                  <th className="px-4 py-2 font-medium">Status</th>
                  {accounts.data.groupRestricted && <th className="px-4 py-2 font-medium">In group</th>}
                  <th className="px-4 py-2 font-medium">Last sign-in</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-zinc-100">
                {accounts.data.accounts.map((a) => (
                  <tr key={a.user?.id ?? a.username}>
                    <td className="px-4 py-2">
                      <div>{a.name}</div>
                      <div className="text-xs text-zinc-400">{a.email}</div>
                    </td>
                    <td className="px-4 py-2 font-mono text-xs">{a.username}</td>
                    <td className="px-4 py-2">
                      {a.status === "active" && <Badge className="bg-emerald-100 text-emerald-800">active</Badge>}
                      {a.status === "suspended" && <Badge className="bg-red-50 text-red-600">suspended by AD</Badge>}
                      {a.status === "disabled" && <Badge className="bg-zinc-100 text-zinc-600">disabled in Rev</Badge>}
                      {a.status === "never_signed_in" && <Badge className="bg-sky-50 text-sky-700">not signed in yet</Badge>}
                    </td>
                    {accounts.data.groupRestricted && <td className="px-4 py-2">{a.inGroup ? "yes" : <span className="text-red-600">no</span>}</td>}
                    <td className="px-4 py-2 text-zinc-500">{a.user?.lastLoginAt ? timeAgo(a.user.lastLoginAt) : "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Card>
        ) : (
          <p className="text-sm text-zinc-400">No directory accounts yet.</p>
        )}
      </section>
    </div>
  );
}
