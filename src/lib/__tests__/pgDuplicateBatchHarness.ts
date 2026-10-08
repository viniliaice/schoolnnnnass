// Real-PostgreSQL (PGlite) harness for the Duplicate Students safe batch merge.
//
// Why this exists: the batch eligibility contract lives in SQL, so it must be
// EXECUTED — not inspected — by the tests. This harness boots PGlite (real
// PL/pgSQL, real transactions, real row locks, real rollbacks) and loads:
//
//   * the production security bridge (current_profile_id / current_profile_role)
//   * the loose matching keys the duplicate RPCs use (name_match_key,
//     gov_id_match_key, gov_id_key, normalize_phone, normalize_family_id)
//   * the ACTUAL shipped migration 20260922_duplicate_students_merge.sql
//   * the ACTUAL shipped migration 20260924_duplicate_merge_resolution.sql
//   * the ACTUAL shipped migration 20260925_safe_duplicate_batch.sql
//   * the ACTUAL shipped migration 20260926_fix_get_merge_conflicts_exam_identity.sql
//   * the ACTUAL shipped migration 20261007_safe_batch_post_run_verification.sql
//
// Nothing here talks to a live/production database: PGlite is an in-process
// WASM Postgres that is created and destroyed inside the test run, so the batch
// merge is proven without a single production mutation.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '../../..');

export interface PgDuplicateDb {
  query: <T = Record<string, unknown>>(sql: string, params?: unknown[]) => Promise<{ rows: T[] }>;
  exec: (sql: string) => Promise<void>;
  /** Run subsequent calls as this Supabase auth user (UUID) or anon (null). */
  setAuthUid: (uid: string | null) => Promise<void>;
  /** Call an RPC the way PostgREST would (SELECT public.fn(...)). */
  rpc: <T = unknown>(fn: string, params?: Record<string, unknown>) => Promise<T>;
  close: () => Promise<void>;
}

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

// ── Base schema ─────────────────────────────────────────────────────────────
// Mirrors the production DDL for every table the duplicate-merge RPCs touch.
const BASE_SCHEMA = `
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='authenticated') THEN
    CREATE ROLE authenticated NOLOGIN;
  END IF;
END $$;

CREATE SCHEMA IF NOT EXISTS auth;
CREATE TABLE IF NOT EXISTS auth.users (id UUID PRIMARY KEY);

-- Supabase sets this GUC from the JWT; the security bridge below reads it.
CREATE OR REPLACE FUNCTION auth.uid() RETURNS UUID
LANGUAGE sql STABLE AS $fn$
  SELECT NULLIF(current_setting('app.current_auth_uid', true), '')::UUID;
$fn$;

CREATE TABLE profiles (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  email TEXT,
  role TEXT NOT NULL CHECK (role IN ('admin','teacher','parent','supervisor','office')),
  auth_id UUID,
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE users (
  id TEXT PRIMARY KEY,
  name TEXT,
  role TEXT
);

CREATE TABLE academic_years (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  "startDate" DATE,
  "endDate" DATE,
  "isCurrent" BOOLEAN NOT NULL DEFAULT false
);

CREATE TABLE terms (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  "academicYearId" TEXT REFERENCES academic_years(id) ON DELETE CASCADE,
  "startDate" DATE,
  "endDate" DATE,
  "isCurrent" BOOLEAN NOT NULL DEFAULT false
);

CREATE TABLE subjects (id TEXT PRIMARY KEY, name TEXT NOT NULL);

CREATE TABLE students (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  "className" TEXT NOT NULL,
  "parentId" TEXT REFERENCES profiles(id) ON DELETE SET NULL,
  "govId" TEXT,
  "parentPhone" TEXT,
  transport TEXT,
  "familyId" TEXT,
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
ALTER TABLE public.students ADD CONSTRAINT students_transport_check
  CHECK ("transport" IS NULL OR "transport" IN ('WALKER','CAR','DRIVER','LEFT') OR "transport" ~ '^\\d+$');
CREATE UNIQUE INDEX uniq_students_gov_id ON public.students (public.gov_id_key("govId"))
  WHERE public.gov_id_key("govId") IS NOT NULL;

CREATE TABLE exams (
  id TEXT PRIMARY KEY,
  "studentId" TEXT NOT NULL REFERENCES students(id) ON DELETE CASCADE,
  "subjectId" TEXT REFERENCES subjects(id),
  subject TEXT,
  score NUMERIC,
  total INTEGER NOT NULL DEFAULT 20 CHECK (total > 0),
  "examType" TEXT NOT NULL,
  "assessmentLabel" TEXT,
  "termId" TEXT,
  month TEXT,
  status TEXT NOT NULL DEFAULT 'approved',
  date DATE,
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_exams_studentId ON exams("studentId");

CREATE TABLE attendance (
  id TEXT PRIMARY KEY,
  "studentId" TEXT NOT NULL REFERENCES students(id) ON DELETE CASCADE,
  "className" TEXT NOT NULL,
  date DATE NOT NULL,
  status TEXT NOT NULL DEFAULT 'present',
  note TEXT,
  "teacherId" TEXT,
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE("studentId", date)
);
CREATE INDEX idx_attendance_student ON attendance("studentId");

CREATE TABLE homework (
  id TEXT PRIMARY KEY,
  "studentId" TEXT NOT NULL REFERENCES students(id) ON DELETE CASCADE,
  "className" TEXT NOT NULL,
  subject TEXT,
  title TEXT,
  "dueDate" DATE,
  status TEXT NOT NULL DEFAULT 'assigned',
  "teacherId" TEXT,
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_homework_student ON homework("studentId");

CREATE TABLE student_promotions (
  id TEXT PRIMARY KEY,
  "studentId" TEXT NOT NULL REFERENCES students(id) ON DELETE CASCADE,
  "fromClass" TEXT NOT NULL,
  "toClass" TEXT NOT NULL,
  "academicYearId" TEXT REFERENCES academic_years(id) ON DELETE SET NULL,
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_student_promotions_student ON student_promotions("studentId");

CREATE TABLE quizzes (id TEXT PRIMARY KEY, title TEXT);

CREATE TABLE quiz_attempts (
  id TEXT PRIMARY KEY,
  "quizId" TEXT NOT NULL REFERENCES quizzes(id) ON DELETE CASCADE,
  "studentId" TEXT NOT NULL REFERENCES students(id) ON DELETE CASCADE,
  answers JSONB NOT NULL DEFAULT '[]',
  "totalEarned" INTEGER DEFAULT 0,
  "totalPossible" INTEGER DEFAULT 0,
  "startedAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  "submittedAt" TIMESTAMPTZ,
  status TEXT NOT NULL DEFAULT 'submitted',
  UNIQUE("quizId", "studentId")
);
CREATE INDEX idx_quiz_attempts_student ON quiz_attempts("studentId");

CREATE TABLE report_comments (
  id TEXT PRIMARY KEY,
  "studentId" TEXT NOT NULL REFERENCES students(id) ON DELETE CASCADE,
  "termId" TEXT NOT NULL REFERENCES terms(id) ON DELETE CASCADE,
  "examId" TEXT REFERENCES exams(id) ON DELETE SET NULL,
  "teacherComment" TEXT,
  "principalComment" TEXT,
  "teacherId" TEXT REFERENCES users(id) ON DELETE SET NULL,
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_report_comments_student_term ON report_comments("studentId","termId");

CREATE TABLE release_log (
  id BIGSERIAL PRIMARY KEY,
  "studentId" TEXT NOT NULL REFERENCES students(id) ON DELETE CASCADE,
  "familyId" TEXT NOT NULL,
  "staffId" TEXT NOT NULL REFERENCES profiles(id) ON DELETE RESTRICT,
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_release_log_student ON release_log("studentId");

CREATE TABLE authorized_pickups (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  "phoneNumber" TEXT NOT NULL,
  relationship TEXT,
  "photoPath" TEXT,
  "addedByStaffId" TEXT,
  "addedAt" TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE authorized_pickup_students (
  "authorizedPickupId" TEXT NOT NULL REFERENCES authorized_pickups(id) ON DELETE CASCADE,
  "studentId" TEXT NOT NULL REFERENCES students(id) ON DELETE CASCADE,
  PRIMARY KEY ("authorizedPickupId", "studentId")
);
CREATE INDEX idx_authorized_pickup_students_student ON authorized_pickup_students("studentId");

CREATE TABLE student_enrollments (
  id TEXT PRIMARY KEY,
  "studentId" TEXT NOT NULL REFERENCES students(id) ON DELETE CASCADE,
  "className" TEXT NOT NULL,
  "academicYearId" TEXT REFERENCES academic_years(id) ON DELETE SET NULL,
  "termId" TEXT REFERENCES terms(id) ON DELETE SET NULL,
  "effectiveFrom" DATE NOT NULL,
  "effectiveTo" DATE,
  reason TEXT NOT NULL DEFAULT 'backfill'
    CHECK (reason IN ('backfill','promotion','import','transfer','correction','manual')),
  "sourceRef" TEXT,
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK ("effectiveTo" IS NULL OR "effectiveTo" >= "effectiveFrom")
);
CREATE UNIQUE INDEX uniq_student_enrollments_open ON student_enrollments("studentId") WHERE "effectiveTo" IS NULL;

CREATE TABLE audit_logs (
  id BIGSERIAL PRIMARY KEY,
  action TEXT NOT NULL,
  details JSONB DEFAULT '{}'::jsonb,
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ── Production security bridge (copied UNCHANGED from 20260708) ────────────
CREATE OR REPLACE FUNCTION public.current_profile_id() RETURNS TEXT
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $fn$
  SELECT id FROM public.profiles WHERE auth_id = auth.uid() LIMIT 1;
$fn$;

CREATE OR REPLACE FUNCTION public.current_profile_role() RETURNS TEXT
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $fn$
  SELECT role FROM public.profiles WHERE auth_id = auth.uid() LIMIT 1;
$fn$;

-- ── Loose matching / normalization helpers (copied from shipped migrations) ─
CREATE OR REPLACE FUNCTION public.gov_id_key(p_gov TEXT)
RETURNS TEXT LANGUAGE sql IMMUTABLE SET search_path = public AS $fn$
  SELECT NULLIF(upper(btrim(COALESCE(p_gov,''))), '');
$fn$;

CREATE OR REPLACE FUNCTION public.gov_id_match_key(p_t TEXT)
RETURNS TEXT LANGUAGE sql IMMUTABLE SET search_path = public AS $fn$
  SELECT upper(regexp_replace(COALESCE(p_t,''), '[^a-zA-Z0-9]', '', 'g'));
$fn$;

CREATE OR REPLACE FUNCTION public.name_match_key(p_t TEXT)
RETURNS TEXT LANGUAGE sql IMMUTABLE SET search_path = public AS $fn$
  SELECT btrim(regexp_replace(lower(COALESCE(p_t,'')), '\\s+', ' ', 'g'));
$fn$;

CREATE OR REPLACE FUNCTION public.normalize_phone(p_raw TEXT)
RETURNS TEXT LANGUAGE sql IMMUTABLE SET search_path = public AS $fn$
  SELECT CASE
    WHEN p_raw IS NULL THEN ''
    ELSE regexp_replace(regexp_replace(p_raw, '\\D', '', 'g'), '^252(\\d{9})$', '\\1')
  END;
$fn$;

CREATE OR REPLACE FUNCTION public.normalize_family_id(p_raw TEXT)
RETURNS TEXT LANGUAGE sql IMMUTABLE SET search_path = public AS $fn$
  SELECT regexp_replace(COALESCE(p_raw, ''), '\\D', '', 'g');
$fn$;
`;

// The unique gov-id index needs gov_id_key() to exist first, so it is created
// after the helpers above (kept separate for clarity).
const POST_HELPER_SCHEMA = `
DROP INDEX IF EXISTS uniq_students_gov_id;
CREATE UNIQUE INDEX uniq_students_gov_id ON public.students (public.gov_id_key("govId"))
  WHERE public.gov_id_key("govId") IS NOT NULL;
`;

/**
 * Boots PGlite, installs the base schema and the ACTUAL shipped duplicate-merge
 * migrations (20260922 + 20260924 + 20260925 + 20260926).
 */
export async function createDuplicateBatchTestDb(): Promise<PgDuplicateDb> {
  const { PGlite } = await import('@electric-sql/pglite');
  const pg = await PGlite.create();

  await pg.exec(BASE_SCHEMA.replace(/CREATE UNIQUE INDEX uniq_students_gov_id[\s\S]*?IS NOT NULL;/, ''));
  await pg.exec(POST_HELPER_SCHEMA);

  // Real shipped migrations, in order. They are idempotent and self-contained.
  await pg.exec(readMigration('20260922_duplicate_students_merge.sql'));
  await pg.exec(readMigration('20260924_duplicate_merge_resolution.sql'));
  await pg.exec(readMigration('20260925_safe_duplicate_batch.sql'));
  await pg.exec(readMigration('20260926_fix_get_merge_conflicts_exam_identity.sql'));
  await pg.exec(readMigration('20261007_safe_batch_post_run_verification.sql'));
  await pg.exec(readMigration('20261008_safe_batch_field_consolidation.sql'));
  await pg.exec(readMigration('20261009_authoritative_parent_phone_registry.sql'));

  const client: PgDuplicateDb = {
    query: async (sql, params) => {
      const res = await pg.query(sql, params as unknown[] | undefined);
      return { rows: (res.rows ?? []) as never };
    },
    exec: async (sql) => {
      await pg.exec(sql);
    },
    setAuthUid: async (uid) => {
      await pg.query('SELECT set_config($1, $2, false)', ['app.current_auth_uid', uid ?? '']);
    },
    rpc: async <T,>(fn: string, params: Record<string, unknown> = {}) => {
      // Named notation (p_x => $n) so argument order can never be wrong.
      const keys = Object.keys(params);
      const sql = `SELECT public.${fn}(${keys.map((k, idx) => `${k} => $${idx + 1}`).join(', ')}) AS result`;
      const values = keys.map((k) => {
        const v = params[k];
        // jsonb parameters travel as JSON text (exactly like PostgREST).
        return v !== null && typeof v === 'object' ? JSON.stringify(v) : v;
      });
      const res = await pg.query(sql, values);
      const row = (res.rows?.[0] ?? {}) as { result?: T };
      return row.result as T;
    },
    close: async () => {
      await pg.close();
    },
  };
  return client;
}

// ── Seed helpers ────────────────────────────────────────────────────────────
export interface SeedStudent {
  id: string;
  name: string;
  className: string;
  parentId?: string | null;
  govId?: string | null;
  parentPhone?: string | null;
  transport?: string | null;
  familyId?: string | null;
  createdAt?: string;
}

export async function seedProfile(db: PgDuplicateDb, id: string, role: string, name = id, authUid?: string | null) {
  await db.query(
    `INSERT INTO public.profiles (id, name, email, role, auth_id)
     VALUES ($1,$2,$3,$4,$5)
     ON CONFLICT (id) DO UPDATE SET role = EXCLUDED.role, auth_id = EXCLUDED.auth_id`,
    [id, name, `${id}@example.test`, role, authUid ?? null],
  );
  if (authUid) {
    await db.query(`INSERT INTO auth.users (id) VALUES ($1::uuid) ON CONFLICT DO NOTHING`, [authUid]);
  }
}

export async function seedStudent(db: PgDuplicateDb, s: SeedStudent) {
  await db.query(
    `INSERT INTO public.students (id, name, "className", "parentId", "govId", "parentPhone", transport, "familyId", "createdAt")
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8, COALESCE($9::timestamptz, NOW()))`,
    [
      s.id, s.name, s.className, s.parentId ?? null, s.govId ?? null,
      s.parentPhone ?? null, s.transport ?? null, s.familyId ?? null, s.createdAt ?? null,
    ],
  );
}

export async function seedEnrollment(
  db: PgDuplicateDb,
  opts: { id: string; studentId: string; className: string; academicYearId?: string | null; effectiveFrom?: string; effectiveTo?: string | null },
) {
  await db.query(
    `INSERT INTO public.student_enrollments
       (id, "studentId", "className", "academicYearId", "effectiveFrom", "effectiveTo", reason, "sourceRef")
     VALUES ($1,$2,$3,$4, COALESCE($5::date,'2026-06-01'), $6::date, 'import', 'seed')`,
    [opts.id, opts.studentId, opts.className, opts.academicYearId ?? null, opts.effectiveFrom ?? null, opts.effectiveTo ?? null],
  );
}
