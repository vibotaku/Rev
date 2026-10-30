import { readFileSync } from "node:fs";
import path from "node:path";
import type { LdapTestReport } from "@rev/shared";
import type { LdapConfig } from "../src/config";
import { describeCertificates, DirectoryUnavailableError, type Directory, type DirectoryMember, type DirectoryResult } from "../src/lib/directory";

export const TEST_CA_PEM = readFileSync(path.join(import.meta.dirname, "fixtures", "test-ca.pem"), "utf8");

export interface FakeAccount {
  logins: string[];
  password: string;
  id: string;
  username: string;
  email: string | null;
  name: string;
  enabled: boolean;
  /** Groups the account belongs to (incl. nested). */
  groups: string[];
}

/** The pretend Active Directory every FakeDirectory instance talks to. */
export class FakeWorld {
  available = true;
  bindPassword = "bind-secret";
  groups = ["Rev-Users"];
  accounts: FakeAccount[] = [];
  /** Every config a directory was built with (to check what Rev passed in). */
  configs: LdapConfig[] = [];
}

export const fakeAccount = (n: number, over: Partial<FakeAccount> = {}): FakeAccount => ({
  logins: [`user${n}`, `user${n}@corp.example.com`],
  password: `ad-password-${n}`,
  id: `${n}`.padStart(32, "a"),
  username: `user${n}`,
  email: `user${n}@corp.example.com`,
  name: `User ${n}`,
  enabled: true,
  groups: ["Rev-Users"],
  ...over,
});

/** In-memory stand-in for Active Directory, honouring the config it was built with. */
export class FakeDirectory implements Directory {
  readonly domain: string;

  constructor(
    private readonly world: FakeWorld,
    private readonly cfg: Partial<LdapConfig> = {},
  ) {
    this.domain = cfg.domain ?? "corp.example.com";
  }

  private get group() {
    return this.cfg.allowedGroup === undefined ? "Rev-Users" : this.cfg.allowedGroup;
  }

  private check() {
    if (!this.world.available) throw new DirectoryUnavailableError("down");
    if (this.cfg.bindPassword !== undefined && this.cfg.bindPassword !== this.world.bindPassword) {
      throw new DirectoryUnavailableError("bind rejected");
    }
  }

  private result(a: FakeAccount): DirectoryResult {
    const user = { id: a.id, dn: `CN=${a.name},DC=corp`, username: a.username, email: a.email, name: a.name };
    if (!a.enabled) return { user, allowed: false, reason: "The directory account is disabled" };
    if (this.group && !this.world.groups.includes(this.group)) {
      return { user, allowed: false, reason: `Sign-in group "${this.group}" does not exist in the directory` };
    }
    if (this.group && !a.groups.includes(this.group)) return { user, allowed: false, reason: `Not a member of ${this.group}` };
    return { user, allowed: true };
  }

  async authenticate(login: string, password: string) {
    this.check();
    const a = this.world.accounts.find((x) => x.logins.includes(login.toLowerCase()));
    if (!a || a.password !== password) return null;
    return this.result(a);
  }

  async lookup(id: string) {
    this.check();
    const a = this.world.accounts.find((x) => x.id === id);
    return a ? this.result(a) : null;
  }

  async diagnose(): Promise<LdapTestReport> {
    const servers = (this.cfg.urls ?? ["ldaps://fake"]).map((url) => {
      const bindOk = this.world.available && this.cfg.bindPassword === this.world.bindPassword;
      const groupOk = !this.group || this.world.groups.includes(this.group);
      const checks = [
        { name: "TLS + service account", ok: bindOk, detail: bindOk ? "Connected" : "Bind account or password rejected" },
        ...(bindOk ? [{ name: "Allowed group", ok: groupOk, detail: groupOk ? `CN=${this.group}` : `Sign-in group "${this.group}" does not exist` }] : []),
      ];
      return { url, ok: checks.every((c) => c.ok), checks };
    });
    const members = this.world.accounts.filter((a) => this.group && a.groups.includes(this.group)).length;
    return {
      ok: servers.every((s) => s.ok),
      servers,
      group: this.group && this.world.groups.includes(this.group) ? { dn: `CN=${this.group}`, members } : null,
    };
  }

  async members(): Promise<DirectoryMember[] | null> {
    this.check();
    if (!this.group) return null;
    return this.world.accounts
      .filter((a) => a.groups.includes(this.group!))
      .map((a) => ({ id: a.id, dn: `CN=${a.name}`, username: a.username, email: a.email, name: a.name, enabled: a.enabled }));
  }

  async fetchCa() {
    this.check();
    return [{ pem: TEST_CA_PEM, info: describeCertificates(TEST_CA_PEM)[0]! }];
  }
}
