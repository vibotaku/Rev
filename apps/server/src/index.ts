import { loadConfig } from "./config";
import { createApp } from "./app";

const config = loadConfig();
const { app, ctx } = await createApp(config);

await app.listen({ port: config.port, host: config.host });

if (!config.databaseUrl) app.log.warn(`DATABASE_URL not set: using embedded PGlite in ${config.dataDir}/pglite (dev only)`);
if (ctx.setup.token) {
  const base = config.publicUrl || `http://localhost:${config.port}`;
  app.log.info(`Rev has no users yet. Create the first admin at ${base}/setup with setup token: ${ctx.setup.token}`);
}

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    app.log.info(`${signal} received, shutting down`);
    app
      .close()
      .then(() => process.exit(0))
      .catch(() => process.exit(1));
  });
}
