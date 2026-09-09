// Real-PostgreSQL behavioral test harness for submit_bulk_grades.
//
// This uses PGlite — an actual PostgreSQL engine (WASM) with full PL/pgSQL — so
// the RPC is EXECUTED, not inspected. The harness deliberately loads the ACTUAL
// shipped migration file for the RPC and the ACTUAL unique-assignment index
// statement, rather than re-typing SQL, so the test proves the real artifact.
//
// Auth is simulated the same way Supabase does it: a per-connection GUC
// (app.current_auth_uid) backs an auth.uid() shim, and the UNCHANGED
// current_profile_id()/current_profile_role() functions resolve it via
// profiles.auth_id — exactly the production security bridge.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '../../../..');

export interface PgTestDb {
  query: <T = Record<string, unknown>>(sql: string, params?: unknown[]) => Promise<{ rows: T[] }>;
  exec: (sql: string) => Promise<void>;
  /** Run subsequent queries as this Supabase auth user (UUID) or anon (null). */
  setAuthUid: (uid: string | null) => Promise<void>;
  close: () => Promise<void>;
}

/** True when PGlite is installed and can be dynamically imported. */
export async function pgliteAvailable(): Promise<boolean> {
  try {
    await import('@electric-sql/pglite');
    return true;
  } catch {
    return false;
  }
}

export function readMigration(name: string): string {
  return fs.readFileSync(path.join(REPO_ROOT, 'supabase', 'migrations', name), 'utf8');
}

/**
 * Extracts a single top-level `CREATE ... $$ ... $$;` (or `CREATE UNIQUE INDEX
 * ...;`) statement region from a migration by an anchor substring, so we run the
 * real shipped SQL for the piece under test.
 */
export function extractStatementContaining(sql: string, anchor: string, terminator = '$$;'): string {
  const anchorPos = sql.indexOf(anchor);
  if (anchorPos < 0) throw new Error(`anchor not found: ${anchor}`);
  // Walk back to the start of the CREATE that contains the anchor.
  const createPos = sql.lastIndexOf('CREATE', anchorPos);
  if (createPos < 0) throw new Error(`CREATE start not found for: ${anchor}`);
  const endPos = sql.indexOf(terminator, anchorPos);
  if (endPos < 0) throw new Error(`terminator not found for: ${anchor}`);
  return sql.slice(createPos, endPos + terminator.length);
}

const BASE_SCHEMA = `
CREATE SCHEMA IF NOT EXISTS auth;
CREATE TABLE IF NOT EXISTS auth.users (id UUID PRIMARY KEY);

-- Per-connection simulated authenticated user (Supabase sets this from the JWT).
CREATE OR REPLACE FUNCTION auth.uid() RETURNS UUID
LANGUAGE sql STABLE AS $fn$
  SELECT NULLIF(current_setting('app.current_auth_uid', true), '')::UUID;
$fn$;

CREATE TABLE profiles (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE,
  role TEXT NOT NULL CHECK (role IN ('admin','teacher','parent','supervisor','office')),
  auth_id UUID,
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE subjects (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE students (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  "className" TEXT NOT NULL,
  "parentId" TEXT REFERENCES profiles(id) ON DELETE SET NULL,
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE academic_years (id TEXT PRIMARY KEY, name TEXT NOT NULL);
CREATE TABLE terms (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  "academicYearId" TEXT NOT NULL REFERENCES academic_years(id) ON DELETE CASCADE,
  "startDate" DATE NOT NULL,
  "endDate" DATE NOT NULL,
  "isCurrent" BOOLEAN NOT NULL DEFAULT false,
  months TEXT[] NOT NULL DEFAULT '{}',
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE class_subjects (
  id TEXT PRIMARY KEY,
  "className" TEXT NOT NULL,
  "subjectId" TEXT NOT NULL REFERENCES subjects(id) ON DELETE CASCADE,
  "teacherId" TEXT REFERENCES profiles(id) ON DELETE SET NULL,
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE exams (
  id TEXT PRIMARY KEY,
  "studentId" TEXT NOT NULL REFERENCES students(id) ON DELETE CASCADE,
  "subjectId" TEXT REFERENCES subjects(id),
  subject TEXT NOT NULL,
  score INTEGER,
  total INTEGER NOT NULL CHECK (total > 0),
  "examType" TEXT NOT NULL,
  "assessmentLabel" TEXT,
  "entryState" TEXT NOT NULL DEFAULT 'scored',
  "termId" TEXT,
  month TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending','approved','rejected')),
  "parentId" TEXT REFERENCES profiles(id) ON DELETE SET NULL,
  date DATE NOT NULL,
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  "teacherId" TEXT REFERENCES profiles(id) ON DELETE SET NULL,
  "uploadedBy" TEXT REFERENCES profiles(id) ON DELETE SET NULL
);

CREATE TABLE grade_uploads (
  id TEXT PRIMARY KEY,
  "uploadedBy" TEXT NOT NULL REFERENCES profiles(id) ON DELETE RESTRICT,
  payload_hash TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('completed')),
  result JSONB NOT NULL,
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- The production security bridge, copied UNCHANGED from
-- 20260708_profiles_auth_session_rls.sql.
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
 * Boots a real Postgres, installs the base schema + production security bridge,
 * the ACTUAL unique-assignment index (from 20260906c), and the ACTUAL RPC
 * (from 20260908). Returns a thin client with auth simulation.
 */
export async function createBulkGradesTestDb(
  opts: { includeStatusGuard?: boolean; includeGradeCorrection?: boolean; includeHalfPoints?: boolean } = {},
): Promise<PgTestDb> {
  const { PGlite } = await import('@electric-sql/pglite');
  const pg = await PGlite.create();

  await pg.exec(BASE_SCHEMA);

  // Real unique constraint on (className, subjectId) shipped in 20260906c.
  const uniqueIndexSql = extractStatementContaining(
    readMigration('20260906c_student_write_security.sql'),
    'uniq_class_subjects_active',
    ';',
  );
  await pg.exec(uniqueIndexSql);

  // The bulk assessment identity unique index the RPC upserts against.
  await pg.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS exams_bulk_assessment_identity_unique
      ON public.exams ("studentId", "subjectId", "examType", "assessmentLabel", "termId")
      WHERE "subjectId" IS NOT NULL AND "termId" IS NOT NULL AND "assessmentLabel" IS NOT NULL;
  `);

  // The ACTUAL shipped RPC under test.
  const rpcSql = extractStatementContaining(
    readMigration('20260908_bulk_grade_change_preview.sql'),
    'FUNCTION public.submit_bulk_grades',
    '$$;',
  );
  await pg.exec(rpcSql);

  // Optionally install the ACTUAL status-guard trigger (20260909) to prove the
  // SECURITY DEFINER RPC coexists with it (the RPC always writes 'pending', so
  // the guard must be a no-op for the RPC path).
  if (opts.includeStatusGuard) {
    const guardFn = extractStatementContaining(
      readMigration('20260909_exam_status_teacher_guard.sql'),
      'FUNCTION public.enforce_exam_status_guard',
      '$$;',
    );
    await pg.exec(guardFn);
    await pg.exec(`
      DROP TRIGGER IF EXISTS enforce_exam_status_guard_trg ON public.exams;
      CREATE TRIGGER enforce_exam_status_guard_trg
        BEFORE INSERT OR UPDATE ON public.exams
        FOR EACH ROW EXECUTE FUNCTION public.enforce_exam_status_guard();
    `);
  }

  // Optionally install the ACTUAL shipped Admin Grade Correction artifacts
  // (audit table + immutability trigger + admin_correct_grade +
  // get_grade_correction_history) from 20260910, so those RPCs are EXECUTED
  // against real Postgres, not mocked.
  if (opts.includeGradeCorrection) {
    // The migration's RLS policy targets the `authenticated` role; ensure it
    // exists (Supabase provides it in production). Its GRANT/REVOKE statements
    // are already guarded by pg_roles existence checks.
    await pg.exec(`DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='authenticated') THEN
        CREATE ROLE authenticated NOLOGIN;
      END IF;
    END $$;`);
    const migration = readMigration('20260910_admin_grade_correction.sql');
    // The whole migration is idempotent and self-contained; run it verbatim.
    await pg.exec(migration);
  }

  // Optionally install the ACTUAL shipped half-point migration (20260911): it
  // widens exams.score to NUMERIC, enforces the whole/half-step CHECK, and
  // redefines submit_bulk_grades + admin_correct_grade to accept NUMERIC scores.
  // Requires the grade-correction artifacts to be present so its DROP/CREATE of
  // admin_correct_grade and its audit-column ALTERs apply.
  if (opts.includeHalfPoints) {
    // Mirror the real migration: widen the score column to NUMERIC, then install
    // the whole/half-step CHECK so INSERT/UPDATE of a quarter point is rejected
    // exactly as in production.
    await pg.exec(`ALTER TABLE public.exams ALTER COLUMN score TYPE NUMERIC USING score::NUMERIC;`);
    // The correction-audit before/after columns follow the same numeric domain.
    await pg.exec(`
      ALTER TABLE IF EXISTS public.grade_correction_audit
        ALTER COLUMN old_score TYPE NUMERIC USING old_score::NUMERIC;
      ALTER TABLE IF EXISTS public.grade_correction_audit
        ALTER COLUMN new_score TYPE NUMERIC USING new_score::NUMERIC;
    `);
    await pg.exec(`
      ALTER TABLE public.exams DROP CONSTRAINT IF EXISTS exams_score_entry_state_check;
      ALTER TABLE public.exams ADD CONSTRAINT exams_score_entry_state_check
        CHECK (
          ("entryState" = 'scored' AND score IS NOT NULL AND score >= 0 AND score <= total
            AND total > 0 AND score * 2 = floor(score * 2))
          OR ("entryState" IN ('absent', 'not_applicable') AND score IS NULL AND total > 0)
        );
    `);
    // Redefine both RPCs from the ACTUAL shipped migration.
    const submitRpc = extractStatementContaining(
      readMigration('20260911_half_point_scores.sql'),
      'FUNCTION public.submit_bulk_grades',
      '$$;',
    );
    await pg.exec(submitRpc);
    const dropAndCorrect = readMigration('20260911_half_point_scores.sql');
    const correctRpc = dropAndCorrect.slice(dropAndCorrect.indexOf('DROP FUNCTION IF EXISTS public.admin_correct_grade'));
    await pg.exec(correctRpc);
  }

  const client: PgTestDb = {
    query: async (sql, params) => {
      const res = await pg.query(sql, params as unknown[] | undefined);
      return { rows: (res.rows ?? []) as never };
    },
    exec: async (sql) => { await pg.exec(sql); },
    setAuthUid: async (uid) => {
      // set_config(..., is_local=false) so it persists across the connection.
      await pg.query('SELECT set_config($1, $2, false)', ['app.current_auth_uid', uid ?? '']);
    },
    close: async () => { await pg.close(); },
  };
  return client;
}
