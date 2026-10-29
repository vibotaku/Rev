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
  };
}
