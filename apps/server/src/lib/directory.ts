// Active Directory (LDAP) sign-in. Rev looks accounts up with a read-only
// service account, verifies passwords by binding as the user over TLS, and
// requires membership (incl. nested) of the configured group.
import { AndFilter, Client, EqualityFilter, InvalidCredentialsError, type Entry } from "ldapts";
import type { FastifyBaseLogger } from "fastify";
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

export interface Directory {
  readonly domain: string;
  /** null means unknown account or wrong password. */
  authenticate(login: string, password: string): Promise<DirectoryResult | null>;
  /** Re-check an account by id; null means it no longer exists. */
  lookup(id: string): Promise<DirectoryResult | null>;
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

