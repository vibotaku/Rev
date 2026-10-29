import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { afterAll, expect, it } from "vitest";

const folder = path.join(import.meta.dirname, "..", "drizzle");
const tmp = mkdtempSync(path.join(tmpdir(), "rev-migrate-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

/** A copy of the migrations folder that stops after the first `count` migrations. */
function migrationsUpTo(count: number) {
  const dir = path.join(tmp, `upto-${count}`);
  cpSync(folder, dir, { recursive: true });
  const journalPath = path.join(dir, "meta", "_journal.json");
  const journal = JSON.parse(readFileSync(journalPath, "utf8"));
  journal.entries = journal.entries.slice(0, count);
  writeFileSync(journalPath, JSON.stringify(journal));
  return dir;
}

it("backfills who closed tasks that were closed before closure tracking", async () => {
  const client = new PGlite();
  const db = drizzle(client);
  await migrate(db, { migrationsFolder: migrationsUpTo(1) });

  await client.exec(`
    insert into users (id, name, kind, email) values
      ('00000000-0000-0000-0000-000000000001', 'Alice', 'human', 'alice@example.com');
    insert into users (id, name, kind, owner_id) values
      ('00000000-0000-0000-0000-000000000002', 'bot', 'agent', '00000000-0000-0000-0000-000000000001');
    insert into projects (id, key, name) values ('00000000-0000-0000-0000-0000000000a1', 'WEB', 'Web');
    insert into tasks (id, project_id, number, title, status, created_by, completed_at) values
      ('00000000-0000-0000-0000-0000000000b1', '00000000-0000-0000-0000-0000000000a1', 1, 'human done', 'done',
       '00000000-0000-0000-0000-000000000001', '2026-01-02T00:00:00Z'),
      ('00000000-0000-0000-0000-0000000000b2', '00000000-0000-0000-0000-0000000000a1', 2, 'agent cancelled', 'cancelled',
       '00000000-0000-0000-0000-000000000001', null),
      ('00000000-0000-0000-0000-0000000000b3', '00000000-0000-0000-0000-0000000000a1', 3, 'open', 'todo',
       '00000000-0000-0000-0000-000000000001', null);
    insert into task_activity (task_id, actor_id, kind, data, created_at) values
      ('00000000-0000-0000-0000-0000000000b1', '00000000-0000-0000-0000-000000000001', 'status', '{"from":"todo","to":"done"}', '2026-01-02T00:00:00Z'),
      ('00000000-0000-0000-0000-0000000000b2', '00000000-0000-0000-0000-000000000002', 'status', '{"from":"todo","to":"cancelled"}', '2026-01-03T00:00:00Z');
  `);

  await migrate(db, { migrationsFolder: folder });
  const { rows } = await client.query<{
    number: number;
    closed_by: string | null;
    human_reviewed_by: string | null;
    completed_at: Date | null;
  }>("select number, closed_by, human_reviewed_by, completed_at from tasks order by number");

  expect(rows[0]).toMatchObject({
    closed_by: "00000000-0000-0000-0000-000000000001",
    human_reviewed_by: "00000000-0000-0000-0000-000000000001",
  });
  // Closed by the agent: attributed to it and left unreviewed, with its close time recovered.
  expect(rows[1]).toMatchObject({ closed_by: "00000000-0000-0000-0000-000000000002", human_reviewed_by: null });
  expect(rows[1]!.completed_at?.toISOString()).toBe("2026-01-03T00:00:00.000Z");
  expect(rows[2]).toMatchObject({ closed_by: null, human_reviewed_by: null, completed_at: null });
  await client.close();
});
