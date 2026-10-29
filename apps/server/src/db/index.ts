import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import * as schema from "./schema";

export type Db = PgDatabase<PgQueryResultHKT, typeof schema>;
export type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];
export { schema };

const here = path.dirname(fileURLToPath(import.meta.url));

function migrationsFolder() {
  if (process.env.MIGRATIONS_DIR) return process.env.MIGRATIONS_DIR;
  // Source layout is src/db/, the bundled layout is dist/; both sit next to apps/server/drizzle.
  const candidates = [path.join(here, "../../drizzle"), path.join(here, "../drizzle")];
  return candidates.find((p) => existsSync(path.join(p, "meta"))) ?? candidates[0];
}

export interface Database {
  db: Db;
  close(): Promise<void>;
}

/**
 * Opens Postgres when a URL is given, otherwise an embedded PGlite database
 * (in-memory when dataDir is null). Runs pending migrations either way.
 */
export async function openDatabase(databaseUrl: string, dataDir: string | null): Promise<Database> {
  const folder = migrationsFolder();
  if (databaseUrl) {
    const { Pool } = await import("pg");
    const { drizzle } = await import("drizzle-orm/node-postgres");
    const { migrate } = await import("drizzle-orm/node-postgres/migrator");
    const pool = new Pool({ connectionString: databaseUrl, max: 10 });
    const db = drizzle(pool, { schema });
    await migrate(db, { migrationsFolder: folder });
    return { db: db as unknown as Db, close: () => pool.end() };
  }
  const { PGlite } = await import("@electric-sql/pglite");
  const { drizzle } = await import("drizzle-orm/pglite");
  const { migrate } = await import("drizzle-orm/pglite/migrator");
  let client;
  if (dataDir) {
    const dir = path.join(dataDir, "pglite");
    await mkdir(dir, { recursive: true });
    client = new PGlite(dir);
  } else {
    client = new PGlite();
  }
  const db = drizzle(client, { schema });
  await migrate(db, { migrationsFolder: folder });
  return { db: db as unknown as Db, close: () => client.close() };
}
