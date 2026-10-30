// Owns the Active Directory settings (stored in the database, bind password
// encrypted), the live Directory built from them, and the periodic sync.
// Saving settings re-applies them immediately; no restart needed.
import { eq } from "drizzle-orm";
import type { FastifyBaseLogger } from "fastify";
import type { LdapAdminInfo, LdapSettingsBody, LdapSyncStatus } from "@rev/shared";
import type { LdapConfig } from "../config";
import type { Db } from "../db";
import { settings } from "../db/schema";
import { describeCertificates, LdapDirectory, type Directory } from "./directory";
import { syncDirectoryAccounts } from "./directory-accounts";
import { badRequest } from "./errors";
import type { Secrets } from "./secrets";
import { loadUsers } from "./serialize";

interface StoredLdap {
  enabled: boolean;
  urls: string[];
  baseDn: string;
  bindDn: string;
  /** Encrypted with Secrets; "" when none. */
  bindPassword: string;
  allowedGroup: string | null;
  domain: string;
  caPem: string | null;
  startTls: boolean;
  verifyTls: boolean;
  syncMinutes: number;
}

const SETTINGS_KEY = "ldap";
const SYNC_KEY = "ldap_last_sync";

export type DirectoryFactory = (config: LdapConfig) => Directory;

/** Default domain (UPN suffix) from DC= parts of a base DN. */
export function domainFromBaseDn(baseDn: string) {
  return baseDn
    .split(",")
    .map((p) => p.trim())
    .filter((p) => /^dc=/i.test(p))
    .map((p) => p.slice(3))
    .join(".")
    .toLowerCase();
}

export class DirectoryService {
  directory: Directory | null = null;
  lastSync: LdapSyncStatus | null = null;
  nextSyncAt: Date | null = null;
  envIgnored = false;
  private stored: StoredLdap | null = null;
  private meta: { updatedAt: Date | null; updatedBy: string | null } = { updatedAt: null, updatedBy: null };
  private timer: NodeJS.Timeout | undefined;

  constructor(
    private readonly db: Db,
    private readonly log: FastifyBaseLogger,
    private readonly secrets: Secrets,
    private readonly factory: DirectoryFactory = (cfg) => new LdapDirectory(cfg, log),
    /** Tests: a fixed directory that ignores stored settings. */
    private readonly fixed: Directory | null = null,
  ) {}

  /** Loads stored settings; on first start, imports LDAP_* env settings into the database. */
  async init(envConfig: LdapConfig | null) {
    const [row] = await this.db.select().from(settings).where(eq(settings.key, SETTINGS_KEY));
    if (row) {
      this.stored = row.value as unknown as StoredLdap;
      this.meta = { updatedAt: row.updatedAt, updatedBy: row.updatedBy };
      this.envIgnored = envConfig !== null;
      if (this.envIgnored) this.log.warn("LDAP_* environment variables are ignored: Active Directory settings are managed in Admin → Active Directory");
    } else if (envConfig) {
      await this.persist(
        {
          enabled: true,
          urls: envConfig.urls,
          baseDn: envConfig.baseDn,
          bindDn: envConfig.bindDn,
          bindPassword: this.secrets.encrypt(envConfig.bindPassword),
          allowedGroup: envConfig.allowedGroup,
          domain: envConfig.domain,
          caPem: envConfig.caPem,
          startTls: envConfig.startTls,
          verifyTls: envConfig.rejectUnauthorized,
          syncMinutes: envConfig.syncMinutes,
        },
        null,
      );
      this.log.info("Imported Active Directory settings from LDAP_* environment variables into the database");
    }
    const [sync] = await this.db.select().from(settings).where(eq(settings.key, SYNC_KEY));
    this.lastSync = (sync?.value as unknown as LdapSyncStatus) ?? null;
    this.apply(true);
  }

  private async persist(value: StoredLdap, updatedBy: string | null) {
    const now = new Date();
    await this.db
      .insert(settings)
      .values({ key: SETTINGS_KEY, value: value as unknown as Record<string, unknown>, updatedBy, updatedAt: now })
      .onConflictDoUpdate({ target: settings.key, set: { value: value as unknown as Record<string, unknown>, updatedBy, updatedAt: now } });
    this.stored = value;
    this.meta = { updatedAt: now, updatedBy };
  }

  private toConfig(s: StoredLdap, password: string): LdapConfig {
    return {
      urls: s.urls,
      baseDn: s.baseDn,
      bindDn: s.bindDn,
      bindPassword: password,
      allowedGroup: s.allowedGroup || null,
      domain: s.domain || domainFromBaseDn(s.baseDn),
      caPem: s.caPem || null,
      rejectUnauthorized: s.verifyTls,
      startTls: s.startTls,
      syncMinutes: s.syncMinutes,
    };
  }

  private storedPassword() {
    return this.stored?.bindPassword ? this.secrets.decrypt(this.stored.bindPassword) : "";
  }

  /** A config from unsaved form values; an empty password means "keep the stored one". */
  draftConfig(body: LdapSettingsBody): LdapConfig {
    const password = body.bindPassword || this.storedPassword();
    if (!password) throw badRequest("bindPassword: Enter the bind account's password");
    if (body.caPem?.trim()) {
      try {
        describeCertificates(body.caPem);
      } catch (err) {
        throw badRequest(`caPem: ${(err as Error).message}`);
      }
    }
    return this.toConfig(
      {
        enabled: body.enabled,
        urls: body.urls,
        baseDn: body.baseDn,
        bindDn: body.bindDn,
        bindPassword: "",
        allowedGroup: body.allowedGroup,
        domain: body.domain,
        caPem: body.caPem?.trim() || null,
        startTls: body.startTls,
        verifyTls: body.verifyTls,
        syncMinutes: body.syncMinutes,
      },
      password,
    );
  }

  /** Builds a throwaway directory from unsaved values (for tests and CA fetches). */
  build(config: LdapConfig) {
    return this.factory(config);
  }

  async save(body: LdapSettingsBody, updatedBy: string) {
    const passwordChanged = !!body.bindPassword;
    if (body.enabled || passwordChanged) this.draftConfig(body); // validates password + CA
    await this.persist(
      {
        enabled: body.enabled,
        urls: body.urls,
        baseDn: body.baseDn,
        bindDn: body.bindDn,
        bindPassword: passwordChanged ? this.secrets.encrypt(body.bindPassword!) : (this.stored?.bindPassword ?? ""),
        allowedGroup: body.allowedGroup || null,
        domain: body.domain || domainFromBaseDn(body.baseDn),
        caPem: body.caPem?.trim() || null,
        startTls: body.startTls,
        verifyTls: body.verifyTls,
        syncMinutes: body.syncMinutes,
      },
      updatedBy,
    );
    this.envIgnored = false;
    this.apply(false);
  }

  /** (Re)builds the live directory and reschedules the sync. */
  private apply(atBoot: boolean) {
    clearInterval(this.timer);
    this.timer = undefined;
    this.nextSyncAt = null;
    if (this.fixed) {
      this.directory = this.fixed;
      return;
    }
    const s = this.stored;
    this.directory = s?.enabled ? this.factory(this.toConfig(s, this.storedPassword())) : null;
    if (!this.directory || !s || s.syncMinutes <= 0) return;
    const every = s.syncMinutes * 60_000;
    this.timer = setInterval(() => void this.sync().catch(() => undefined), every);
    this.timer.unref();
    this.nextSyncAt = new Date(Date.now() + every);
    if (atBoot) setTimeout(() => void this.sync().catch(() => undefined), 30_000).unref();
  }

  async sync(): Promise<LdapSyncStatus> {
    const directory = this.directory;
    if (!directory) throw badRequest("Active Directory sign-in is not enabled");
    let status: LdapSyncStatus;
    try {
      const r = await syncDirectoryAccounts(this.db, directory, this.log);
      status = { at: new Date().toISOString(), checked: r.checked, suspended: r.suspended, restored: r.restored, ...(r.skipped ? { skipped: r.skipped } : {}) };
      if (r.suspended.length || r.restored.length) this.log.info(r, "directory sync");
    } catch (err) {
      this.log.error({ err }, "directory sync failed");
      status = { at: new Date().toISOString(), checked: 0, suspended: [], restored: [], error: (err as Error).message };
    }
    this.lastSync = status;
    if (this.stored?.syncMinutes) this.nextSyncAt = new Date(Date.now() + this.stored.syncMinutes * 60_000);
    await this.db
      .insert(settings)
      .values({ key: SYNC_KEY, value: status as unknown as Record<string, unknown> })
      .onConflictDoUpdate({ target: settings.key, set: { value: status as unknown as Record<string, unknown>, updatedAt: new Date() } });
    return status;
  }

  async info(): Promise<LdapAdminInfo> {
    const s = this.stored;
    const users = await loadUsers(this.db, [this.meta.updatedBy]);
    let caCertificates: LdapAdminInfo["settings"]["caCertificates"] = [];
    try {
      caCertificates = s?.caPem ? describeCertificates(s.caPem) : [];
    } catch {
      // Stored PEM is validated on save; ignore anything unexpected here.
    }
    return {
      settings: {
        enabled: s?.enabled ?? false,
        urls: s?.urls ?? [],
        baseDn: s?.baseDn ?? "",
        bindDn: s?.bindDn ?? "",
        hasBindPassword: !!s?.bindPassword,
        allowedGroup: s?.allowedGroup ?? null,
        domain: s?.domain ?? "",
        caPem: s?.caPem ?? null,
        caCertificates,
        startTls: s?.startTls ?? false,
        verifyTls: s?.verifyTls ?? true,
        syncMinutes: s?.syncMinutes ?? 15,
        updatedAt: this.meta.updatedAt?.toISOString() ?? null,
        updatedBy: this.meta.updatedBy ? (users.get(this.meta.updatedBy) ?? null) : null,
      },
      lastSync: this.lastSync,
      nextSyncAt: this.nextSyncAt?.toISOString() ?? null,
      envIgnored: this.envIgnored,
    };
  }

  stop() {
    clearInterval(this.timer);
  }
}
