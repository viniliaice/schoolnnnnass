// Real-PostgreSQL test for the supervisor week selector's database side.
//
// PGlite is an actual PostgreSQL engine, so the ACTUAL shipped migration file
// is EXECUTED here (function body, grants, index) on top of the ACTUAL shipped
// lesson_plans DDL from 20260727_lesson_plans.sql. That proves:
//   * list_lesson_plan_weeks aggregates by the STORED week_label,
//   * the status filter parameter works (drafts excluded unless asked for),
//   * the composite index that serves the per-week fetch is created,
//   * no plan row is created or changed by any of it.
//
// HONEST LIMITATIONS:
//   1. PGlite does not reproduce Supabase's PostgREST/JWT plumbing or a hosted
//      project's role bootstrap.
//   2. The shipped 20260727 supervisor/teacher policies read
//      `profiles.id = auth.uid()` / `teacher_id = auth.uid()`, comparing a TEXT
//      column with a UUID. PostgreSQL rejects that (`operator does not exist:
//      text = uuid`, verified while writing this test), so the RLS case below
//      models the documented INTENT through the repo's standard bridge
//      (current_profile_role()/current_profile_id(), from
//      20260708_profiles_auth_session_rls.sql) instead of the broken text.
//      list_lesson_plan_weeks is SECURITY INVOKER precisely so it inherits
//      whatever the live table policies allow — exactly like the page's
//      existing lesson_plans SELECT.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '../../..');

async function pgliteAvailable(): Promise<boolean> {
  try {
    await import('@electric-sql/pglite');
    return true;
  } catch {
    return false;
  }
}

function readMigration(name: string): string {
  return fs.readFileSync(path.join(REPO_ROOT, 'supabase', 'migrations', name), 'utf8');
}

/** Inclusive line range [fromAnchor .. the statement that contains toAnchor]. */
function extractLines(sql: string, fromAnchor: string, toAnchor: string): string {
  const lines = sql.split('\n');
  const start = lines.findIndex((line) => line.includes(fromAnchor));
  if (start < 0) throw new Error(`fromAnchor not found: ${fromAnchor}`);
  const end = lines.findIndex((line, index) => index >= start && line.includes(toAnchor));
  if (end < 0) throw new Error(`toAnchor not found: ${toAnchor}`);
  let stop = end;
  while (stop < lines.length && !lines[stop].trim().endsWith(';')) stop++;
  return lines.slice(start, stop + 1).join('\n');
}

const SUPERVISOR_STATUSES = ['submitted', 'in_review', 'approved', 'rejected', 'ai_failed'];
const SUPERVISOR_UID = '33333333-3333-3333-3333-333333333333';
const TEACHER_UID = '11111111-1111-1111-1111-111111111111';

const BASE = `
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='authenticated') THEN
    CREATE ROLE authenticated NOLOGIN;
  END IF;
END $$;

CREATE SCHEMA IF NOT EXISTS auth;
CREATE OR REPLACE FUNCTION auth.uid() RETURNS UUID
LANGUAGE sql STABLE AS $fn$
  SELECT NULLIF(current_setting('app.current_auth_uid', true), '')::UUID;
$fn$;

CREATE TABLE profiles (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, email TEXT NOT NULL UNIQUE,
  role TEXT NOT NULL, auth_id UUID
);
CREATE TABLE subjects (id TEXT PRIMARY KEY, name TEXT NOT NULL);

-- The repo's standard security bridge (20260708_profiles_auth_session_rls.sql).
CREATE OR REPLACE FUNCTION public.current_profile_id() RETURNS TEXT
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $fn$
  SELECT id FROM public.profiles WHERE auth_id = auth.uid() LIMIT 1;
$fn$;
CREATE OR REPLACE FUNCTION public.current_profile_role() RETURNS TEXT
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $fn$
  SELECT role FROM public.profiles WHERE auth_id = auth.uid() LIMIT 1;
$fn$;
`;

const SEED = `
INSERT INTO profiles (id, name, email, role, auth_id) VALUES
  ('t1', 'Ms. Fatima', 'fatima@mbk.edu', 'teacher',    '11111111-1111-1111-1111-111111111111'),
  ('t2', 'Mr. Omar',   'omar@mbk.edu',   'teacher',    '22222222-2222-2222-2222-222222222222'),
  ('s1', 'Mr. Bashir', 'sup@mbk.edu',    'supervisor', '33333333-3333-3333-3333-333333333333');

-- Three weeks of submissions with deliberately inconsistent teacher titles,
-- plus a draft that must never be counted as reviewable.
INSERT INTO lesson_plans (id, teacher_id, class_name, week_label, title, status, period_count) VALUES
  ('p1', 't1', 'Grade 1-A', '2026-W05', 'Week 05',       'in_review', 5),
  ('p2', 't2', 'Grade 2-C', '2026-W05', 'week 5',        'approved',  5),
  ('p3', 't1', 'Grade 1-A', '2026-W06', 'week6',         'rejected',  5),
  ('p4', 't2', 'Grade 2-C', '2026-W06', 'week6',         'approved',  6),
  ('p5', 't1', 'Grade 1-A', '2026-W07', 'week 7',        'in_review', 5),
  ('p6', 't1', 'Grade 1-A', '2026-W07', 'Week7',         'approved',  5),
  ('p7', 't2', 'Grade 2-C', '2026-W07', 'Week 2026-W07', 'rejected',  5),
  ('p8', 't2', 'Grade 2-C', '2026-W07', 'Week 2026-W07', 'submitted', 5),
  ('p9', 't1', 'Grade 1-A', '2026-W08', 'draft only',    'draft',     5);
`;

const withDb = (await pgliteAvailable()) ? describe : describe.skip;

withDb('list_lesson_plan_weeks (executed on real Postgres)', () => {
  async function boot(opts: { rlsPolicies?: boolean } = {}) {
    const { PGlite } = await import('@electric-sql/pglite');
    const pg = await PGlite.create();
    await pg.exec(BASE);

    // The ACTUAL shipped lesson_plans table.
    const lessonPlansMigration = readMigration('20260727_lesson_plans.sql');
    await pg.exec(extractLines(lessonPlansMigration, 'CREATE TABLE lesson_plans (', 'previous_reviewed_at TIMESTAMPTZ'));

    // The ACTUAL new migration, verbatim (function + grants + index).
    await pg.exec(readMigration('20260914_supervisor_lesson_plan_week_selector.sql'));

    await pg.exec(`
      GRANT USAGE ON SCHEMA public, auth TO authenticated;
      GRANT SELECT ON public.lesson_plans, public.profiles TO authenticated;
      GRANT EXECUTE ON FUNCTION auth.uid(), public.current_profile_id(), public.current_profile_role() TO authenticated;
    `);

    if (opts.rlsPolicies) {
      await pg.exec(`
        ALTER TABLE lesson_plans ENABLE ROW LEVEL SECURITY;
        CREATE POLICY "teacher_own_plans" ON lesson_plans FOR SELECT
          USING (teacher_id = public.current_profile_id());
        CREATE POLICY "supervisor_all_plans" ON lesson_plans FOR SELECT
          USING (public.current_profile_role() = 'supervisor');
      `);
    }

    await pg.exec(SEED);

    return {
      pg,
      asUser: async (uid: string | null) => {
        await pg.exec('RESET ROLE');
        await pg.query('SELECT set_config($1,$2,false)', ['app.current_auth_uid', uid ?? '']);
        await pg.exec('SET ROLE authenticated');
      },
      asOwner: async () => {
        await pg.exec('RESET ROLE');
      },
      close: async () => {
        await pg.close();
      },
    };
  }

  type Db = Awaited<ReturnType<typeof boot>>;

  async function weeksFor(db: Db, statuses: string[] | null) {
    const sql = statuses
      ? `SELECT week_label, plan_count FROM list_lesson_plan_weeks(ARRAY[${statuses
          .map((status) => `'${status}'`)
          .join(',')}]::TEXT[]) ORDER BY week_label`
      : 'SELECT week_label, plan_count FROM list_lesson_plan_weeks(NULL) ORDER BY week_label';
    const res = await db.pg.query(sql);
    return (res.rows as Array<{ week_label: string; plan_count: string | number }>).map((row) => [
      row.week_label,
      Number(row.plan_count),
    ]);
  }

  it('aggregates every reviewable week by the stored week_label', async () => {
    const db = await boot();
    try {
      expect(await weeksFor(db, SUPERVISOR_STATUSES)).toEqual([
        ['2026-W05', 2],
        ['2026-W06', 2],
        ['2026-W07', 4],
      ]);
    } finally {
      await db.close();
    }
  });

  it('honours the status filter, and counts everything when it is NULL', async () => {
    const db = await boot();
    try {
      expect(await weeksFor(db, ['submitted'])).toEqual([['2026-W07', 1]]);
      expect(await weeksFor(db, ['rejected'])).toEqual([
        ['2026-W06', 1],
        ['2026-W07', 1],
      ]);
      // The draft-only week appears with no status filter and vanishes with one.
      expect(await weeksFor(db, null)).toEqual([
        ['2026-W05', 2],
        ['2026-W06', 2],
        ['2026-W07', 4],
        ['2026-W08', 1],
      ]);
    } finally {
      await db.close();
    }
  });

  it('creates the composite index that serves the per-week fetch', async () => {
    const db = await boot();
    try {
      const res = await db.pg.query(
        `SELECT indexdef FROM pg_indexes
         WHERE tablename = 'lesson_plans' AND indexname = 'idx_lesson_plans_status_week_label'`
      );
      const rows = res.rows as Array<{ indexdef: string }>;
      expect(rows.length).toBe(1);
      expect(rows[0].indexdef).toContain('status');
      expect(rows[0].indexdef).toContain('week_label');
    } finally {
      await db.close();
    }
  });

  it('does not create or change any lesson plan row', async () => {
    const db = await boot();
    try {
      const fingerprint = async () => {
        await db.asOwner();
        const res = await db.pg.query(
          `SELECT count(*)::INT AS n,
                  coalesce(md5(string_agg(id || week_label || status, ',' ORDER BY id)), '') AS hash
           FROM lesson_plans`
        );
        return (res.rows as Array<{ n: number; hash: string }>)[0];
      };

      const before = await fingerprint();
      await weeksFor(db, SUPERVISOR_STATUSES);
      await weeksFor(db, null);
      expect(await fingerprint()).toEqual(before);
      expect(before.n).toBe(9);
    } finally {
      await db.close();
    }
  });

  it('is SECURITY INVOKER, so row-level security still applies', async () => {
    const db = await boot({ rlsPolicies: true });
    try {
      // Supervisor: every reviewable week.
      await db.asUser(SUPERVISOR_UID);
      expect(await weeksFor(db, SUPERVISOR_STATUSES)).toEqual([
        ['2026-W05', 2],
        ['2026-W06', 2],
        ['2026-W07', 4],
      ]);

      // Teacher: only their own rows.
      await db.asUser(TEACHER_UID);
      expect(await weeksFor(db, SUPERVISOR_STATUSES)).toEqual([
        ['2026-W05', 1],
        ['2026-W06', 1],
        ['2026-W07', 2],
      ]);

      // No matching policy, no rows.
      await db.asUser(null);
      expect(await weeksFor(db, SUPERVISOR_STATUSES)).toEqual([]);
    } finally {
      await db.close();
    }
  });
});
