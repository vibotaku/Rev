// Active Directory (LDAP) sign-in. Rev looks accounts up with a read-only
// service account, verifies passwords by binding as the user over TLS, and
// requires membership (incl. nested) of the configured group.
import { AndFilter, Client, EqualityFilter, InvalidCredentialsError, type Entry } from "ldapts";
import { X509Certificate } from "node:crypto";
import type { FastifyBaseLogger } from "fastify";
import type { CaCertificateInfo, LdapCheck, LdapTestReport } from "@rev/shared";
import type { LdapConfig } from "../config";

export interface DirectoryUser {
  /** objectGUID as hex; stable across renames. */
  id: string;
  dn: string;
  username: string;
  email: string | null;
  name: string;
}

export interface DirectoryResult {
  user: DirectoryUser;
  /** False when the account is disabled or not in the allowed group. */
  allowed: boolean;
  reason?: string;
}

export interface DirectoryMember extends DirectoryUser {
  enabled: boolean;
}

export interface Directory {
  readonly domain: string;
  /** null means unknown account or wrong password. */
  authenticate(login: string, password: string): Promise<DirectoryResult | null>;
  /** Re-check an account by id; null means it no longer exists. */
  lookup(id: string): Promise<DirectoryResult | null>;
  /** Connection checks for the admin UI. */
  diagnose(): Promise<LdapTestReport>;
  /** Members of the allowed group (incl. nested); null when sign-in is not group-restricted. */
  members(): Promise<DirectoryMember[] | null>;
  /** CA certificates published in the directory (read without verifying TLS; show fingerprints). */
  fetchCa(): Promise<{ pem: string; info: CaCertificateInfo }[]>;
}

/** Subject/issuer/expiry/fingerprint of every certificate in a PEM bundle; throws on invalid PEM. */
export function describeCertificates(pem: string): CaCertificateInfo[] {
  const blocks = pem.match(/-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g) ?? [];
  if (!blocks.length) throw new Error("No PEM certificate found");
  return blocks.map((block) => {
    const cert = new X509Certificate(block);
    return {
      subject: cert.subject.replace(/\n/g, ", "),
      issuer: cert.issuer.replace(/\n/g, ", "),
      validTo: new Date(cert.validTo).toISOString(),
      fingerprint256: cert.fingerprint256,
    };
  });
}

/** Turns low-level TLS/LDAP errors into something an admin can act on. */
export function explainLdapError(err: unknown) {
  const msg = (err as Error)?.message ?? String(err);
  if (err instanceof InvalidCredentialsError) return "Bind account or password rejected";
  if (/unable to verify|self[- ]signed|certificate chain/i.test(msg)) return `Certificate not trusted: add the directory's CA certificate (${msg})`;
  if (/does not match certificate|altnames/i.test(msg)) return `Use the server name from its certificate (${msg})`;
  if (/timeout|ECONNREFUSED|EHOSTUNREACH|ENOTFOUND/i.test(msg)) return `Server unreachable (${msg})`;
  return msg;
}

/** The directory could not be reached; distinct from "not allowed" so callers never lock people out on outages. */
export class DirectoryUnavailableError extends Error {}

class GroupMissingError extends Error {}

const ACCOUNT_DISABLED = 0x2;
// LDAP_MATCHING_RULE_IN_CHAIN: transitive group membership in AD.
const IN_CHAIN = "1.2.840.113556.1.4.1941";
const USER_ATTRS = ["distinguishedName", "sAMAccountName", "userPrincipalName", "mail", "displayName", "objectGUID", "userAccountControl"];

/** RFC 4515 escaping for values placed inside a search filter. */
export function escapeFilter(value: string) {
  return value.replace(/[\\*()\0]/g, (c) => `\\${c.charCodeAt(0).toString(16).padStart(2, "0")}`);
}


function first(v: Entry[string] | undefined): string | null {
  const x = Array.isArray(v) ? v[0] : v;
  if (x == null) return null;
  return Buffer.isBuffer(x) ? x.toString("utf8") : String(x);
}

export class LdapDirectory implements Directory {
  readonly domain: string;
  private groupDn: string | null | undefined;

  async diagnose(): Promise<LdapTestReport> {
    const report: LdapTestReport = { ok: false, servers: [], group: null };
    for (const url of this.cfg.urls) {
      const checks: LdapCheck[] = [];
      let client: Client | undefined;
      try {
        client = await this.connect(url, this.cfg.bindDn, this.cfg.bindPassword);
        checks.push({ name: "TLS + service account", ok: true, detail: `Connected and bound as ${this.cfg.bindDn}` });
        const base = await client.search(this.cfg.baseDn, { scope: "base", filter: "(objectClass=*)", attributes: ["distinguishedName"] });
        checks.push({ name: "Base DN", ok: base.searchEntries.length === 1, detail: base.searchEntries.length ? this.cfg.baseDn : "Not found" });
        if (this.cfg.allowedGroup) {
          this.groupDn = undefined; // always re-resolve when testing
          try {
            const dn = await this.resolveGroup(client);
            const { searchEntries } = await client.search(this.cfg.baseDn, {
              scope: "sub",
              filter: `(&(objectCategory=person)(objectClass=user)(memberOf:${IN_CHAIN}:=${escapeFilter(dn!)}))`,
              attributes: ["distinguishedName"],
              sizeLimit: 5000,
            });
            checks.push({ name: "Allowed group", ok: true, detail: `${dn} (${searchEntries.length} member${searchEntries.length === 1 ? "" : "s"})` });
            report.group ??= { dn: dn!, members: searchEntries.length };
          } catch (err) {
            checks.push({ name: "Allowed group", ok: false, detail: (err as Error).message });
          }
        } else {
          checks.push({ name: "Allowed group", ok: true, detail: "None: every enabled account may sign in" });
        }
      } catch (err) {
        checks.push({ name: "TLS + service account", ok: false, detail: explainLdapError(err) });
      } finally {
        await client?.unbind().catch(() => undefined);
      }
      report.servers.push({ url, ok: checks.every((c) => c.ok), checks });
    }
    report.ok = report.servers.length > 0 && report.servers.every((s) => s.ok);
    return report;
  }

  async members(): Promise<DirectoryMember[] | null> {
    if (!this.cfg.allowedGroup) return null;
    return this.withService(async (client) => {
      const dn = await this.resolveGroup(client);
      const { searchEntries } = await client.search(this.cfg.baseDn, {
        scope: "sub",
        filter: `(&(objectCategory=person)(objectClass=user)(memberOf:${IN_CHAIN}:=${escapeFilter(dn!)}))`,
        attributes: USER_ATTRS,
        explicitBufferAttributes: ["objectGUID"],
        sizeLimit: 5000,
      });
      return searchEntries.map((e) => {
        const { disabled, ...user } = this.toUser(e);
        return { ...user, enabled: !disabled };
      });
    });
  }

  async fetchCa() {
    let lastError: unknown;
    for (const url of this.cfg.urls) {
      // Deliberately unverified: this is how the CA is obtained in the first place. Admins confirm the fingerprint.
      const client = new Client({ url, timeout: 10_000, connectTimeout: 5_000, tlsOptions: { rejectUnauthorized: false }, strictDN: false });
      try {
        if (this.cfg.startTls && url.startsWith("ldap://")) await client.startTLS({ rejectUnauthorized: false });
        await client.bind(this.cfg.bindDn, this.cfg.bindPassword);
        const root = await client.search("", { scope: "base", filter: "(objectClass=*)", attributes: ["configurationNamingContext"] });
        const configNc = first(root.searchEntries[0]?.configurationNamingContext);
        if (!configNc) throw new Error("Directory did not report configurationNamingContext");
        const { searchEntries } = await client.search(`CN=AIA,CN=Public Key Services,CN=Services,${configNc}`, {
          scope: "one",
          filter: "(objectClass=certificationAuthority)",
          attributes: ["cACertificate"],
          explicitBufferAttributes: ["cACertificate"],
        });
        const ders = searchEntries.flatMap((e) => {
          const v = e.cACertificate;
          return (Array.isArray(v) ? v : [v]).filter((x): x is Buffer => Buffer.isBuffer(x));
        });
        return ders.map((der) => {
          const pem = `-----BEGIN CERTIFICATE-----\n${der.toString("base64").match(/.{1,64}/g)!.join("\n")}\n-----END CERTIFICATE-----\n`;
          return { pem, info: describeCertificates(pem)[0]! };
        });
      } catch (err) {
        lastError = err;
      } finally {
        await client.unbind().catch(() => undefined);
      }
    }
    throw new DirectoryUnavailableError(explainLdapError(lastError));
  }

  constructor(
    private readonly cfg: LdapConfig,
    private readonly log: FastifyBaseLogger,
  ) {
    this.domain = cfg.domain;
  }

  private tls() {
    return { ca: this.cfg.caPem ? [this.cfg.caPem] : undefined, rejectUnauthorized: this.cfg.rejectUnauthorized, minVersion: "TLSv1.2" as const };
  }

  private async connect(url: string, dn: string, password: string) {
    const client = new Client({ url, timeout: 10_000, connectTimeout: 5_000, tlsOptions: this.tls(), strictDN: false });
    try {
      if (this.cfg.startTls && url.startsWith("ldap://")) await client.startTLS(this.tls());
      await client.bind(dn, password);
      return client;
    } catch (err) {
      await client.unbind().catch(() => undefined);
      throw err;
    }
  }

  /** Runs `fn` with a service-account connection, failing over across the configured servers. */
  private async withService<T>(fn: (client: Client, url: string) => Promise<T>): Promise<T> {
    let lastError: unknown;
    for (const url of this.cfg.urls) {
      let client: Client | undefined;
      try {
        client = await this.connect(url, this.cfg.bindDn, this.cfg.bindPassword);
      } catch (err) {
        lastError = err;
        if (err instanceof InvalidCredentialsError) {
          this.log.error("LDAP service account bind rejected; check LDAP_BIND_DN / LDAP_BIND_PASSWORD");
          break;
        }
        this.log.warn({ err: (err as Error).message, url }, "LDAP server unreachable, trying next");
        continue;
      }
      try {
        return await fn(client, url);
      } finally {
        await client.unbind().catch(() => undefined);
      }
    }
    throw new DirectoryUnavailableError(`Directory unavailable: ${(lastError as Error)?.message ?? "no servers configured"}`);
  }

  private async resolveGroup(client: Client) {
    if (this.groupDn !== undefined) return this.groupDn;
    const group = this.cfg.allowedGroup;
    if (!group) return (this.groupDn = null);
    if (group.includes("=")) return (this.groupDn = group);
    const { searchEntries } = await client.search(this.cfg.baseDn, {
      scope: "sub",
      filter: `(&(objectClass=group)(|(cn=${escapeFilter(group)})(sAMAccountName=${escapeFilter(group)})))`,
      attributes: ["distinguishedName"],
      sizeLimit: 2,
    });
    const dn = first(searchEntries[0]?.distinguishedName);
    // Not cached when missing, so creating the group later takes effect without a restart.
    if (!dn) throw new GroupMissingError(`Sign-in group "${group}" does not exist in the directory`);
    return (this.groupDn = dn);
  }

  private toUser(e: Entry): DirectoryUser & { disabled: boolean } {
    const guid = e.objectGUID;
    const id = Buffer.isBuffer(guid) ? guid.toString("hex") : Array.isArray(guid) && Buffer.isBuffer(guid[0]) ? guid[0].toString("hex") : "";
    const username = first(e.sAMAccountName) ?? "";
    const upn = first(e.userPrincipalName);
    return {
      id,
      dn: first(e.distinguishedName) ?? e.dn,
      username,
      email: (first(e.mail) ?? upn)?.toLowerCase() ?? null,
      name: first(e.displayName) ?? username,
      disabled: (Number(first(e.userAccountControl) ?? 0) & ACCOUNT_DISABLED) !== 0,
    };
  }

  private async check(client: Client, user: DirectoryUser & { disabled: boolean }): Promise<DirectoryResult> {
    const { disabled, ...rest } = user;
    if (disabled) return { user: rest, allowed: false, reason: "The directory account is disabled" };
    let groupDn: string | null;
    try {
      groupDn = await this.resolveGroup(client);
    } catch (err) {
      if (err instanceof GroupMissingError) return { user: rest, allowed: false, reason: err.message };
      throw err;
    }
    if (!groupDn) return { user: rest, allowed: true };
    const { searchEntries } = await client.search(user.dn, {
      scope: "base",
      filter: `(memberOf:${IN_CHAIN}:=${escapeFilter(groupDn)})`,
      attributes: ["distinguishedName"],
    });
    return searchEntries.length
      ? { user: rest, allowed: true }
      : { user: rest, allowed: false, reason: `Not a member of ${this.cfg.allowedGroup}` };
  }

  async authenticate(login: string, password: string): Promise<DirectoryResult | null> {
    if (!password) return null;
    let name = login.trim();
    if (name.includes("\\")) name = name.slice(name.lastIndexOf("\\") + 1); // CORP\jdoe
    const at = name.lastIndexOf("@");
    const sam = at > 0 && name.slice(at + 1).toLowerCase() === this.domain ? name.slice(0, at) : name;
    const filter =
      `(&(objectCategory=person)(objectClass=user)(|(sAMAccountName=${escapeFilter(sam)})` +
      `(userPrincipalName=${escapeFilter(name)})(mail=${escapeFilter(name)})))`;

    return this.withService(async (client, url) => {
      const { searchEntries } = await client.search(this.cfg.baseDn, {
        scope: "sub",
        filter,
        attributes: USER_ATTRS,
        explicitBufferAttributes: ["objectGUID"],
        sizeLimit: 2,
      });
      if (searchEntries.length !== 1) return null;
      const user = this.toUser(searchEntries[0]!);
      if (!user.id) return null;
      try {
        // Verifying the password is a bind as the user; AD rejects disabled/locked accounts here too.
        const userClient = await this.connect(url, user.dn, password);
        await userClient.unbind().catch(() => undefined);
      } catch (err) {
        if (err instanceof InvalidCredentialsError) return null;
        throw new DirectoryUnavailableError(`Directory unavailable: ${(err as Error).message}`);
      }
      return this.check(client, user);
    });
  }

  async lookup(id: string): Promise<DirectoryResult | null> {
    if (!/^[0-9a-f]{32}$/.test(id)) return null;
    return this.withService(async (client) => {
      const { searchEntries } = await client.search(this.cfg.baseDn, {
        scope: "sub",
        // objectGUID is binary: a Filter object sends the raw bytes (string filters re-encode bytes >= 0x80 as UTF-8).
        filter: new AndFilter({
          filters: [
            new EqualityFilter({ attribute: "objectClass", value: "user" }),
            new EqualityFilter({ attribute: "objectGUID", value: Buffer.from(id, "hex") }),
          ],
        }),
        attributes: USER_ATTRS,
        explicitBufferAttributes: ["objectGUID"],
        sizeLimit: 2,
      });
      if (searchEntries.length !== 1) return null;
      return this.check(client, this.toUser(searchEntries[0]!));
    });
  }
}

