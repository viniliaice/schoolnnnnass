// Behavioral RLS harness for the exams direct-table security boundary.
//
// Unlike pgHarness (which exercises the SECURITY DEFINER RPC), this harness
// proves the ROW-LEVEL-SECURITY boundary that governs DIRECT PostgREST-style
// table writes. It runs statements as a real, non-owner `authenticated` role
// with RLS enforced, exactly as Supabase's `authenticated` role experiences it.
//
// It loads the ACTUAL shipped exam RLS policies (from 20260802) and the ACTUAL
// status guard trigger (from 20260909), extracted from the migration files, so
// the test proves the real artifacts — not re-typed SQL.
//
// LIMITATION (stated honestly): PGlite is real PostgreSQL, so RLS/policy/trigger
// semantics match production. What it does NOT reproduce is the Supabase
// PostgREST layer, JWT->GUC plumbing, or the exact GRANT/role bootstrap of a
// hosted project. Those remain to be verified against the live database.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '../../../..');

export interface RlsTestDb {
  query: <T = Record<string, unknown>>(sql: string, params?: unknown[]) => Promise<{ rows: T[] }>;
  exec: (sql: string) => Promise<void>;
  /** Run as the given app profile (uuid) under the non-owner `authenticated` role. */
  asAuthenticated: (uid: string) => Promise<void>;
  /** Return to the owning role (bypasses RLS) for seeding/inspection. */
  asOwner: () => Promise<void>;
  close: () => Promise<void>;
}

export async function pgliteAvailable(): Promise<boolean> {
  try { await import('@electric-sql/pglite'); return true; } catch { return false; }
}

function readMigration(name: string): string {
  return fs.readFileSync(path.join(REPO_ROOT, 'supabase', 'migrations', name), 'utf8');
}

/** Extract an inclusive line range [from,to] (1-based) from a migration file. */
function extractLines(sql: string, fromAnchor: string, toAnchor: string): string {
  const lines = sql.split('\n');
  const start = lines.findIndex(l => l.includes(fromAnchor));
  if (start < 0) throw new Error(`fromAnchor not found: ${fromAnchor}`);
  const end = lines.findIndex((l, i) => i >= start && l.includes(toAnchor));
  if (end < 0) throw new Error(`toAnchor not found: ${toAnchor}`);
  // include the full statement that contains toAnchor (up to its terminating ;)
  let e = end;
  while (e < lines.length && !lines[e].trim().endsWith(';')) e++;
  return lines.slice(start, e + 1).join('\n');
}

/** Extract a `CREATE ... $$ ... $$;` function/trigger region by an anchor. */
function extractDollarStatement(sql: string, anchor: string, terminator = '$$;'): string {
  const anchorPos = sql.indexOf(anchor);
  if (anchorPos < 0) throw new Error(`anchor not found: ${anchor}`);
  const createPos = sql.lastIndexOf('CREATE', anchorPos);
  const endPos = sql.indexOf(terminator, anchorPos);
  return sql.slice(createPos, endPos + terminator.length);
}

const BASE = `
-- The Supabase client role. Must exist before any policy references it.
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
  role TEXT NOT NULL CHECK (role IN ('admin','teacher','parent','supervisor')),
  auth_id UUID
);
CREATE TABLE subjects (id TEXT PRIMARY KEY, name TEXT NOT NULL);
CREATE TABLE students (id TEXT PRIMARY KEY, name TEXT NOT NULL, "className" TEXT NOT NULL, "parentId" TEXT);
CREATE TABLE class_subjects (
  id TEXT PRIMARY KEY, "className" TEXT NOT NULL,
  "subjectId" TEXT NOT NULL, "teacherId" TEXT
);
CREATE TABLE exams (
  id TEXT PRIMARY KEY,
  "studentId" TEXT NOT NULL,
  "subjectId" TEXT,
  subject TEXT NOT NULL,
  score INTEGER,
  total INTEGER NOT NULL CHECK (total > 0),
  "examType" TEXT NOT NULL,
  "assessmentLabel" TEXT,
  "entryState" TEXT NOT NULL DEFAULT 'scored',
  "termId" TEXT,
  month TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending','approved','rejected')),
  "parentId" TEXT,
  date DATE NOT NULL,
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  "teacherId" TEXT,
  "uploadedBy" TEXT
);

-- Production security bridge (SECURITY DEFINER so it reads profiles under RLS).
CREATE OR REPLACE FUNCTION public.current_profile_id() RETURNS TEXT
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $fn$
  SELECT id FROM public.profiles WHERE auth_id = auth.uid() LIMIT 1;
$fn$;
CREATE OR REPLACE FUNCTION public.current_profile_role() RETURNS TEXT
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $fn$
  SELECT role FROM public.profiles WHERE auth_id = auth.uid() LIMIT 1;
$fn$;
`;

/**
 * Boots a real Postgres with the exams table under RLS, the ACTUAL shipped exam
 * policies + can_submit_exam_target, and (when includeStatusGuard) the ACTUAL
 * status-guard trigger. Runs client statements as a non-owner `authenticated`
 * role so RLS genuinely applies.
 */
export async function createExamRlsTestDb(opts: { includeStatusGuard: boolean }): Promise<RlsTestDb> {
  const { PGlite } = await import('@electric-sql/pglite');
  const pg = await PGlite.create();

  await pg.exec(BASE);

  // Real can_submit_exam_target + exam RLS policies, extracted from 20260802.
  const mig802 = readMigration('20260802_bulk_grade_integrity.sql');
  const canSubmit = extractDollarStatement(mig802, 'FUNCTION public.can_submit_exam_target');
  const examRls = extractLines(mig802, 'ALTER TABLE public.exams ENABLE ROW LEVEL SECURITY', 'CREATE POLICY "exam_delete_authorized"');
  await pg.exec(canSubmit);
  await pg.exec(examRls);

  if (opts.includeStatusGuard) {
    const mig909 = readMigration('20260909_exam_status_teacher_guard.sql');
    const guardFn = extractDollarStatement(mig909, 'FUNCTION public.enforce_exam_status_guard');
    await pg.exec(guardFn);
    await pg.exec(`
      DROP TRIGGER IF EXISTS enforce_exam_status_guard_trg ON public.exams;
      CREATE TRIGGER enforce_exam_status_guard_trg
        BEFORE INSERT OR UPDATE ON public.exams
        FOR EACH ROW EXECUTE FUNCTION public.enforce_exam_status_guard();
    `);
  }

  // Grant the (already-created) non-owner role exactly the surface Supabase's
  // `authenticated` role gets, so it experiences RLS just like production.
  await pg.exec(`
    GRANT USAGE ON SCHEMA public, auth TO authenticated;
    GRANT SELECT, INSERT, UPDATE, DELETE ON public.exams TO authenticated;
    GRANT SELECT ON public.profiles, public.students, public.subjects, public.class_subjects TO authenticated;
    GRANT EXECUTE ON FUNCTION public.current_profile_id(), public.current_profile_role(),
      public.can_submit_exam_target(TEXT,TEXT,TEXT), auth.uid() TO authenticated;
  `);

  const db: RlsTestDb = {
    query: async (sql, params) => {
      const res = await pg.query(sql, params as unknown[] | undefined);
      return { rows: (res.rows ?? []) as never };
    },
    exec: async (sql) => { await pg.exec(sql); },
    asAuthenticated: async (uid) => {
      await pg.exec('RESET ROLE');
      await pg.query('SELECT set_config($1,$2,false)', ['app.current_auth_uid', uid]);
      await pg.exec('SET ROLE authenticated');
    },
    asOwner: async () => { await pg.exec('RESET ROLE'); },
    close: async () => { await pg.close(); },
  };
  return db;
}
