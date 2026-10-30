import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import { createApp } from "../src/app";
import { loadConfig } from "../src/config";
import type { AppContext } from "../src/context";

export interface TestServer {
  app: FastifyInstance;
  ctx: AppContext;
  dataDir: string;
  close(): Promise<void>;
}

/**
 * Boots the app on a throwaway database: in-memory PGlite by default, or a real
 * Postgres when TEST_DATABASE_URL is set (its schema is wiped first).
 */
export async function startTestServer(): Promise<TestServer> {
  const dataDir = mkdtempSync(path.join(tmpdir(), "rev-test-"));
  const databaseUrl = process.env.TEST_DATABASE_URL ?? "";
  if (databaseUrl) await resetPostgres(databaseUrl);
  const config = loadConfig({
    DATA_DIR: dataDir,
    DATABASE_URL: databaseUrl,
    REV_SETUP_TOKEN: "setup-secret",
    WEB_DIST: path.join(dataDir, "no-web"),
  });
  const { app, ctx } = await createApp(config, { logger: false, memoryDb: !databaseUrl });
  await app.ready();
  return {
    app,
    ctx,
    dataDir,
    async close() {
      await app.close();
      rmSync(dataDir, { recursive: true, force: true });
    },
  };
}

async function resetPostgres(url: string) {
  const { Client: PgClient } = await import("pg");
  const client = new PgClient({ connectionString: url });
  await client.connect();
  await client.query("drop schema if exists public cascade; drop schema if exists drizzle cascade; create schema public;");
  await client.end();
}

type Auth = { cookie?: string; token?: string };

export class Client {
  constructor(
    private readonly app: FastifyInstance,
    public auth: Auth = {},
  ) {}

  private headers(extra: Record<string, string> = {}) {
    const h: Record<string, string> = { ...extra };
    if (this.auth.cookie) h.cookie = this.auth.cookie;
    if (this.auth.token) h.authorization = `Bearer ${this.auth.token}`;
    return h;
  }

  async req(method: string, url: string, body?: unknown, extraHeaders: Record<string, string> = {}) {
    const res = await this.app.inject({
      method: method as "GET",
      url,
      headers: this.headers(extraHeaders),
      ...(body !== undefined ? { payload: body as object } : {}),
    });
    const setCookie = res.cookies.find((c) => c.name === "rev_session");
    if (setCookie?.value) this.auth.cookie = `rev_session=${setCookie.value}`;
    let json: any = null;
    try {
      json = res.json();
    } catch {
      /* not JSON */
    }
    return { status: res.statusCode, json, res };
  }

  get = (url: string, headers?: Record<string, string>) => this.req("GET", url, undefined, headers);
  post = (url: string, body: unknown = {}, headers?: Record<string, string>) => this.req("POST", url, body, headers);
  patch = (url: string, body: unknown) => this.req("PATCH", url, body);
  put = (url: string, body: unknown) => this.req("PUT", url, body);
  del = (url: string) => this.req("DELETE", url);

  async upload(url: string, filePath: string, mime: string, filename = path.basename(filePath)) {
    const boundary = `----rev${Date.now()}`;
    const head = Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: ${mime}\r\n\r\n`,
    );
    const tail = Buffer.from(`\r\n--${boundary}--\r\n`);
    const res = await this.app.inject({
      method: "POST",
      url,
      headers: this.headers({ "content-type": `multipart/form-data; boundary=${boundary}` }),
      payload: Buffer.concat([head, readFileSync(filePath), tail]),
    });
    return { status: res.statusCode, json: res.json() as any };
  }
}

/** Generates a tiny PNG and a 2s MP4 with ffmpeg, if available. */
export function makeFixtures(dir: string) {
  const png = path.join(dir, "shot.png");
  const mp4 = path.join(dir, "clip.mp4");
  const mov = path.join(dir, "clip.mov");
  const ff = (args: string[]) => execFileSync("ffmpeg", ["-y", "-v", "error", ...args]);
  ff(["-f", "lavfi", "-i", "testsrc=size=320x240", "-frames:v", "1", png]);
  ff(["-f", "lavfi", "-i", "testsrc=duration=2:size=320x240:rate=25", "-pix_fmt", "yuv420p", "-c:v", "libx264", mp4]);
  ff(["-f", "lavfi", "-i", "testsrc=duration=1:size=160x120:rate=25", "-c:v", "mpeg4", mov]);
  return { png, mp4, mov };
}
