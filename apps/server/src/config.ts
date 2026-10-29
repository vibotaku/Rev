import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));

function bool(value: string | undefined, fallback: boolean) {
  if (value === undefined || value === "") return fallback;
  return ["1", "true", "yes", "on"].includes(value.toLowerCase());
}

function num(value: string | undefined, fallback: number) {
  const n = Number(value);
  return value && Number.isFinite(n) ? n : fallback;
}

export interface Config {
  port: number;
  host: string;
  /** Postgres connection string. When empty, an embedded PGlite database in dataDir is used (dev/tests). */
  databaseUrl: string;
  dataDir: string;
  /** Externally reachable base URL, used in invite links and agent setup instructions. */
  publicUrl: string;
  cookieSecure: boolean;
  trustProxy: boolean;
  maxUploadBytes: number;
  sessionTtlDays: number;
  webDist: string;
  cliBundle: string;
  ffmpegPath: string;
  ffprobePath: string;
  setupToken: string | null;
  logLevel: string;
  /** Sign-in attempts allowed per IP per minute. */
  authRateLimit: number;
  /** Active Directory / LDAP sign-in; null when LDAP_URL is not set. */
  ldap: LdapConfig | null;
}

export interface LdapConfig {
  /** Tried in order, e.g. ldaps://dc01.corp.example.com,ldaps://dc02.corp.example.com */
  urls: string[];
  baseDn: string;
  /** Service account used for lookups, e.g. svc-rev-bind@corp.example.com */
  bindDn: string;
  bindPassword: string;
  /** Group (name or DN) whose members, incl. nested, may sign in. null = any enabled user. */
  allowedGroup: string | null;
  /** UPN suffix shown on the login page and accepted in logins, e.g. corp.example.com */
  domain: string;
  /** PEM bundle for the directory's CA (AD CS); the system trust store is used when unset. */
  caPem: string | null;
  rejectUnauthorized: boolean;
  /** Use StartTLS on ldap:// URLs. */
  startTls: boolean;
  /** How often accounts are re-checked against the directory (0 disables). */
  syncMinutes: number;
}

function loadLdap(env: NodeJS.ProcessEnv): LdapConfig | null {
  const urls = (env.LDAP_URL ?? "").split(",").map((u) => u.trim()).filter(Boolean);
  if (!urls.length) return null;
  const baseDn = env.LDAP_BASE_DN ?? "";
  const bindPassword = env.LDAP_BIND_PASSWORD_FILE
    ? readFileSync(env.LDAP_BIND_PASSWORD_FILE, "utf8").trim()
    : (env.LDAP_BIND_PASSWORD ?? "");
  if (!baseDn || !env.LDAP_BIND_DN || !bindPassword) {
    throw new Error("LDAP_URL is set but LDAP_BASE_DN, LDAP_BIND_DN and LDAP_BIND_PASSWORD(_FILE) are required");
  }
  const startTls = bool(env.LDAP_STARTTLS, false);
  if (urls.some((u) => u.startsWith("ldap://")) && !startTls) {
    throw new Error("Refusing to send passwords over plain ldap://; use ldaps:// or set LDAP_STARTTLS=true");
  }
  const domain =
    env.LDAP_DOMAIN ||
    baseDn
      .split(",")
      .map((p) => p.trim())
      .filter((p) => /^dc=/i.test(p))
      .map((p) => p.slice(3))
      .join(".");
  return {
    urls,
    baseDn,
    bindDn: env.LDAP_BIND_DN,
    bindPassword,
    allowedGroup: env.LDAP_ALLOWED_GROUP || null,
    domain: domain.toLowerCase(),
    caPem: env.LDAP_CA_FILE ? readFileSync(env.LDAP_CA_FILE, "utf8") : null,
    rejectUnauthorized: !bool(env.LDAP_TLS_INSECURE, false),
    startTls,
    syncMinutes: num(env.LDAP_SYNC_MINUTES, 15),
  };
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const publicUrl = (env.PUBLIC_URL ?? "").replace(/\/+$/, "");
  return {
    port: num(env.PORT, 8080),
    host: env.HOST ?? "0.0.0.0",
    databaseUrl: env.DATABASE_URL ?? "",
    dataDir: path.resolve(env.DATA_DIR ?? "./data"),
    publicUrl,
    cookieSecure: bool(env.COOKIE_SECURE, publicUrl.startsWith("https://")),
    trustProxy: bool(env.TRUST_PROXY, true),
    maxUploadBytes: num(env.MAX_UPLOAD_MB, 2048) * 1024 * 1024,
    sessionTtlDays: num(env.SESSION_TTL_DAYS, 30),
    webDist: path.resolve(env.WEB_DIST ?? path.join(here, "../../web/dist")),
    cliBundle: path.resolve(env.CLI_BUNDLE ?? path.join(here, "../../cli/dist/rev.mjs")),
    ffmpegPath: env.FFMPEG_PATH ?? "ffmpeg",
    ffprobePath: env.FFPROBE_PATH ?? "ffprobe",
    setupToken: env.REV_SETUP_TOKEN || null,
    logLevel: env.LOG_LEVEL ?? "info",
    authRateLimit: num(env.AUTH_RATE_LIMIT_PER_MINUTE, 10),
    ldap: loadLdap(env),
  };
}
