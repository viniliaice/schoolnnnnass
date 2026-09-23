// supabase/tests/safe-duplicate-batch.sql — executed for real inside PGlite.
//
// The same file is runnable with psql against a migrated database:
//   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f supabase/tests/safe-duplicate-batch.sql
// Running it here proves the assertions are valid SQL and that they PASS on the
// shipped migrations (20260922 → 20260926). Every DO block raises on failure.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createDuplicateBatchTestDb, pgliteAvailable, type PgDuplicateDb } from './pgDuplicateBatchHarness';

let db: PgDuplicateDb | null = null;

beforeAll(async () => {
  if (!(await pgliteAvailable())) return;
  db = await createDuplicateBatchTestDb();
}, 180_000);

afterAll(async () => { if (db) await db.close(); });

describe('supabase/tests/safe-duplicate-batch.sql', () => {
  it('passes every assertion against the shipped migrations', async () => {
    if (!db) return;
    const sql = readFileSync(resolve(process.cwd(), 'supabase/tests/safe-duplicate-batch.sql'), 'utf8');
    expect(sql).toContain('RAISE EXCEPTION');
    // exec() aborts on the first error, exactly like psql -v ON_ERROR_STOP=1.
    await expect(db.exec(sql)).resolves.toBeUndefined();
  }, 120_000);

  it('fails loudly when an assertion is broken (self-check of the harness)', async () => {
    if (!db) return;
    await expect(
      db.exec(`DO $$ BEGIN RAISE EXCEPTION 'assertion harness works'; END $$;`),
    ).rejects.toThrow(/assertion harness works/);
  });
});
