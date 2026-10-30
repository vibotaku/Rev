import { existsSync } from "node:fs";
import path from "node:path";
import Fastify, { type FastifyServerOptions } from "fastify";
import cookie from "@fastify/cookie";
import multipart from "@fastify/multipart";
import rateLimit from "@fastify/rate-limit";
import fastifyStatic from "@fastify/static";
import { count, sql } from "drizzle-orm";
import type { Config } from "./config";
import type { AppContext } from "./context";
import { openDatabase } from "./db";
import { users } from "./db/schema";
import { registerAuth } from "./lib/auth";
import { randomToken } from "./lib/crypto";
import type { Directory } from "./lib/directory";
import { DirectoryService, type DirectoryFactory } from "./lib/directory-service";
import { Secrets } from "./lib/secrets";
import { HttpError } from "./lib/errors";
import { MediaProcessor } from "./media/processor";
import { Storage } from "./media/storage";
import adminRoutes from "./routes/admin";
import agentRoutes from "./routes/agents";
import authRoutes from "./routes/auth";
import dashboardRoutes from "./routes/dashboard";
import enrollmentRoutes from "./routes/enrollment";
import ldapAdminRoutes from "./routes/ldap-admin";
import mediaRoutes from "./routes/media";
import projectRoutes from "./routes/projects";
import reviewRoutes from "./routes/reviews";
import roundRoutes from "./routes/rounds";
import taskRoutes from "./routes/tasks";

export interface CreateAppOptions {
  logger?: FastifyServerOptions["logger"];
  /** Use a throwaway in-memory database (tests). */
  memoryDb?: boolean;
  /** Tests: a fixed directory instead of the stored Active Directory settings. */
  directory?: Directory | null;
  /** Tests: builds directories from stored/draft settings instead of real LDAP. */
  directoryFactory?: DirectoryFactory;
}

export async function createApp(config: Config, options: CreateAppOptions = {}) {
  const app = Fastify({
    logger: options.logger ?? { level: config.logLevel },
    trustProxy: config.trustProxy,
    bodyLimit: 2 * 1024 * 1024,
  });

  const database = await openDatabase(config.databaseUrl, options.memoryDb ? null : config.dataDir);
  const storage = new Storage(config.dataDir);
  await storage.init();
  const processor = new MediaProcessor(database.db, storage, config, app.log);

  const [{ n }] = (await database.db.select({ n: count() }).from(users)) as [{ n: number }];
  const secrets = await Secrets.load(config.secretKey, config.dataDir);
  const directories = new DirectoryService(database.db, app.log, secrets, options.directoryFactory, options.directory ?? null);
  await directories.init(options.directory !== undefined ? null : config.ldap);
  const ctx: AppContext = {
    config,
    db: database.db,
    storage,
    processor,
    directories,
    get directory() {
      return directories.directory;
    },
    setup: { token: Number(n) === 0 ? (config.setupToken ?? randomToken(18)) : null },
  };

  await app.register(cookie);
  await app.register(multipart, { limits: { fileSize: config.maxUploadBytes, files: 1 } });
  await app.register(rateLimit, { global: false });
  await app.register(fastifyStatic, { root: storage.root, serve: false });

  const webIndex = path.join(config.webDist, "index.html");
  const hasWeb = existsSync(webIndex);
  if (hasWeb) {
    await app.register(fastifyStatic, {
      root: config.webDist,
      prefix: "/",
      decorateReply: false,
      index: ["index.html"],
      maxAge: "1h",
      setHeaders(res, filePath) {
        // Hashed build assets never change; the HTML shell must always be revalidated.
        if (filePath.includes(`${path.sep}assets${path.sep}`)) res.header("cache-control", "public, max-age=31536000, immutable");
        else if (filePath.endsWith("index.html")) res.header("cache-control", "no-cache");
      },
    });
  }

  registerAuth(app, ctx);

  app.setErrorHandler((err, req, reply) => {
    if (err instanceof HttpError) {
      return reply.status(err.status).send({ error: err.code, message: err.message, details: err.details });
    }
    const e = err as { statusCode?: number; code?: string; message?: string };
    if (e.statusCode && e.statusCode < 500) {
      return reply.status(e.statusCode).send({ error: e.code ?? "bad_request", message: e.message ?? "Bad request" });
    }
    req.log.error({ err }, "request failed");
    return reply.status(500).send({ error: "internal", message: "Internal server error" });
  });

  app.setNotFoundHandler((req, reply) => {
    const wantsPage = req.method === "GET" && !req.url.startsWith("/api/") && !req.url.startsWith("/downloads/");
    if (wantsPage && hasWeb) {
      reply.header("cache-control", "no-cache");
      return reply.sendFile("index.html", config.webDist, { cacheControl: false });
    }
    return reply.status(404).send({ error: "not_found", message: `Route ${req.method} ${req.url.split("?")[0]} not found` });
  });

  app.get("/api/health", async () => {
    await ctx.db.execute(sql`select 1`);
    return { ok: true };
  });

  app.get("/downloads/rev.mjs", async (_req, reply) => {
    if (!existsSync(config.cliBundle)) {
      return reply.status(404).send({ error: "not_found", message: "CLI bundle not built (npm run build -w @rev/cli)" });
    }
    reply.header("content-type", "text/javascript; charset=utf-8");
    reply.header("content-disposition", 'attachment; filename="rev.mjs"');
    reply.header("cache-control", "no-cache");
    return reply.sendFile(path.basename(config.cliBundle), path.dirname(config.cliBundle));
  });

  for (const routes of [
    authRoutes,
    adminRoutes,
    agentRoutes,
    enrollmentRoutes,
    ldapAdminRoutes,
    projectRoutes,
    taskRoutes,
    reviewRoutes,
    roundRoutes,
    mediaRoutes,
    dashboardRoutes,
  ]) {
    await routes(app, ctx);
  }

  app.addHook("onClose", async () => {
    directories.stop();
    await processor.idle();
    await database.close();
  });

  await processor.resume();
  return { app, ctx };
}
