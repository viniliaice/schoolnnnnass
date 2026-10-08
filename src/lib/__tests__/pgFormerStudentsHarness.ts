// Real-PostgreSQL (PGlite) harness for the Former Students / Student Cleanup
// feature (supabase/migrations/20261008_former_students_cleanup.sql +
// 20261008b_former_students_roster_filters.sql).
//
// Why this exists: every safety rule of the cleanup ("System ID is the only
// match key", "a name match never deactivates anyone", "an ambiguous file row
// needs an explicit confirmation", "rollback checks the audit history first")
// is enforced in SQL, so the tests must EXECUTE that SQL rather than inspect
// it. PGlite is an in-process WASM Postgres: it is created, seeded with
// synthetic students and destroyed inside the test run — no live or production
// database is ever contacted.
//
// The harness deliberately loads the ACTUAL shipped migration files (the same
// convention as pgDuplicateBatchHarness.ts / bulk-grades/pgHarness.ts) so a
// test failure means the shipped artifact is wrong, not that a copy drifted.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '../../..');

export interface PgFormerDb {
  query: <T = Record<string, unknown>>(sql: string, params?: unknown[]) => Promise<{ rows: T[] }>;
  exec: (sql: string) => Promise<void>;
  /** Run subsequent calls as this Supabase auth user (UUID) or anon (null). */
  setAuthUid: (uid: string | null) => Promise<void>;
  /** Call an RPC the way PostgREST would (named notation, jsonb as JSON text). */
  rpc: <T = unknown>(fn: string, params?: Record<string, unknown>) => Promise<T>;
  /** Call an RPC and surface the server error instead of throwing. */
  rpcSafe: <T = unknown>(fn: string, params?: Record<string, unknown>) => Promise<{ data: T | null; error: { message: string; code?: string } | null }>;
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
// Mirrors the production DDL for every table the cleanup migrations touch.
// NOTE: `students` is created WITHOUT the status columns on purpose — the
// migration's ALTER TABLE ... ADD COLUMN IF NOT EXISTS path is part of what is
// under test.
const BASE_SCHEMA = `
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='authenticated') THEN
    CREATE ROLE authenticated NOLOGIN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='anon') THEN
    CREATE ROLE anon NOLOGIN;
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
  phone1 TEXT,
  phone2 TEXT,
  auth_id UUID,
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW()
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
  "teacherId" TEXT,
  date DATE,
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE attendance (
  id TEXT PRIMARY KEY,
  "studentId" TEXT NOT NULL REFERENCES students(id) ON DELETE CASCADE,
  "className" TEXT NOT NULL,
  date DATE NOT NULL,
  status TEXT NOT NULL DEFAULT 'present',
  "teacherId" TEXT,
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

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

CREATE TABLE quizzes (id TEXT PRIMARY KEY, title TEXT, "className" TEXT, status TEXT DEFAULT 'active');

CREATE TABLE quiz_attempts (
  id TEXT PRIMARY KEY,
  "quizId" TEXT NOT NULL REFERENCES quizzes(id) ON DELETE CASCADE,
  "studentId" TEXT NOT NULL REFERENCES students(id) ON DELETE CASCADE,
  "totalEarned" INTEGER DEFAULT 0,
  "totalPossible" INTEGER DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'submitted'
);

CREATE TABLE report_comments (
  id TEXT PRIMARY KEY,
  "studentId" TEXT NOT NULL REFERENCES students(id) ON DELETE CASCADE,
  "termId" TEXT NOT NULL REFERENCES terms(id) ON DELETE CASCADE,
  "teacherComment" TEXT,
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE class_subjects (
  id TEXT PRIMARY KEY,
  "className" TEXT NOT NULL,
  "subjectId" TEXT NOT NULL REFERENCES subjects(id) ON DELETE CASCADE,
  "teacherId" TEXT REFERENCES profiles(id) ON DELETE SET NULL,
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE student_promotions (
  id TEXT PRIMARY KEY,
  "studentId" TEXT NOT NULL REFERENCES students(id) ON DELETE CASCADE,
  "fromClass" TEXT NOT NULL,
  "toClass" TEXT NOT NULL,
  "academicYearId" TEXT REFERENCES academic_years(id) ON DELETE SET NULL,
  source TEXT NOT NULL DEFAULT 'promotion' CHECK (source IN ('promotion','class_import')),
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

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

CREATE TABLE release_log (
  id BIGSERIAL PRIMARY KEY,
  "studentId" TEXT NOT NULL REFERENCES students(id) ON DELETE CASCADE,
  "familyId" TEXT NOT NULL,
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

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

-- ── Dependencies of the functions the migration recreates ──────────────────
-- assert_admin() / record_class_assignment() are copied from the shipped
-- 20260906b + 20260906c migrations: promote_students() (recreated by the
-- cleanup migration to skip leavers) calls both.
CREATE OR REPLACE FUNCTION public.assert_admin()
RETURNS TEXT LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $fn$
DECLARE v_role TEXT := public.current_profile_role();
BEGIN
  IF v_role IS NULL OR v_role <> 'admin' THEN
    RAISE EXCEPTION 'Only administrators may perform this action.'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN public.current_profile_id();
END;
$fn$;

CREATE OR REPLACE FUNCTION public.record_class_assignment(
  p_student_id TEXT,
  p_new_class TEXT,
  p_reason TEXT,
  p_effective_from DATE DEFAULT NULL,
  p_academic_year_id TEXT DEFAULT NULL,
  p_term_id TEXT DEFAULT NULL,
  p_source_ref TEXT DEFAULT NULL
) RETURNS VOID
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $fn$
DECLARE
  v_from DATE := COALESCE(p_effective_from, CURRENT_DATE);
  v_open_class TEXT;
  v_open_from DATE;
BEGIN
  IF p_student_id IS NULL OR p_new_class IS NULL OR btrim(p_new_class) = '' THEN
    RAISE EXCEPTION 'record_class_assignment: student and class are required.'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.students WHERE id = p_student_id) THEN
    RAISE EXCEPTION 'Student % does not exist.', p_student_id USING ERRCODE = 'no_data_found';
  END IF;

  SELECT "className", "effectiveFrom" INTO v_open_class, v_open_from
  FROM public.student_enrollments
  WHERE "studentId" = p_student_id AND "effectiveTo" IS NULL
  LIMIT 1;

  IF v_open_class = p_new_class THEN
    RETURN;
  END IF;

  IF v_open_class IS NOT NULL THEN
    UPDATE public.student_enrollments
       SET "effectiveTo" = LEAST(v_from - 1, CURRENT_DATE)
     WHERE "studentId" = p_student_id AND "effectiveTo" IS NULL;
  END IF;

  INSERT INTO public.student_enrollments
    (id, "studentId", "className", "academicYearId", "termId", "effectiveFrom", "effectiveTo", reason, "sourceRef")
  VALUES (
    'enr-' || floor(extract(epoch FROM clock_timestamp())*1000)::text || '-' || substr(md5(random()::text || p_student_id),1,8),
    p_student_id, p_new_class,
    CASE WHEN p_academic_year_id IS NOT NULL AND EXISTS (SELECT 1 FROM public.academic_years WHERE id = p_academic_year_id)
         THEN p_academic_year_id ELSE NULL END,
    CASE WHEN p_term_id IS NOT NULL AND EXISTS (SELECT 1 FROM public.terms WHERE id = p_term_id)
         THEN p_term_id ELSE NULL END,
    GREATEST(v_from, COALESCE(v_open_from, DATE '2000-01-01')),
    NULL, COALESCE(p_reason,'manual'), p_source_ref
  );
END;
$fn$;

-- The pre-cleanup behaviour of get_system_stats (20260707) — the migration
-- replaces it, and the test asserts totalStudents becomes an ACTIVE count.
CREATE OR REPLACE FUNCTION public.get_system_stats()
RETURNS JSONB LANGUAGE sql STABLE AS $fn$
  select jsonb_build_object(
    'totalTeachers', (select count(*) from public.profiles where lower(trim(role::text)) = 'teacher'),
    'totalParents', (select count(*) from public.profiles where lower(trim(role::text)) = 'parent'),
    'totalStudents', (select count(*) from public.students),
    'totalExams', (select count(*) from public.exams)
  );
$fn$;
`;

/**
 * Boots PGlite, installs the base schema and the ACTUAL shipped Former
 * Students migrations.
 */
export async function createFormerStudentsTestDb(): Promise<PgFormerDb> {
  const { PGlite } = await import('@electric-sql/pglite');
  const pg = await PGlite.create();

  await pg.exec(BASE_SCHEMA);
  await pg.exec(readMigration('20261008_former_students_cleanup.sql'));
  await pg.exec(readMigration('20261008b_former_students_roster_filters.sql'));

  const callRpc = async <T,>(fn: string, params: Record<string, unknown>) => {
    const keys = Object.keys(params);
    const sql = keys.length > 0
      ? `SELECT public.${fn}(${keys.map((k, idx) => `${k} => $${idx + 1}`).join(', ')}) AS result`
      : `SELECT public.${fn}() AS result`;
    const values = keys.map((k) => {
      const v = params[k];
      return v !== null && typeof v === 'object' ? JSON.stringify(v) : v;
    });
    return pg.query(sql, values) as Promise<{ rows?: Array<{ result?: T }> }>;
  };

  const client: PgFormerDb = {
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
      const res = await callRpc<T>(fn, params);
      return (res.rows?.[0] ?? {}).result as T;
    },
    rpcSafe: async <T,>(fn: string, params: Record<string, unknown> = {}) => {
      try {
        const res = await callRpc<T>(fn, params);
        return { data: (res.rows?.[0] ?? {}).result as T, error: null };
      } catch (err) {
        const e = err as { message?: string; code?: string };
        return { data: null, error: { message: e.message ?? String(err), code: e.code } };
      }
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
  status?: 'active' | 'former';
  createdAt?: string;
}

export async function seedProfile(
  db: PgFormerDb,
  id: string,
  role: string,
  name = id,
  authUid?: string | null,
) {
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

/**
 * Seeds a student the way production data looks: the status column is written
 * through the SAME path the app uses (a direct insert for 'active', the
 * set_student_former_status RPC is used by the tests that need a former
 * student with a ledger row).
 */
export async function seedStudent(db: PgFormerDb, s: SeedStudent) {
  await db.query(
    `INSERT INTO public.students
       (id, name, "className", "parentId", "govId", "parentPhone", transport, "familyId", status, "createdAt")
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9, COALESCE($10::timestamptz, NOW()))`,
    [
      s.id, s.name, s.className, s.parentId ?? null, s.govId ?? null,
      s.parentPhone ?? null, s.transport ?? null, s.familyId ?? null,
      s.status ?? 'active', s.createdAt ?? null,
    ],
  );
}

export async function seedExam(
  db: PgFormerDb,
  opts: { id: string; studentId: string; month?: string; examType?: string; teacherId?: string },
) {
  await db.query(
    `INSERT INTO public.exams (id, "studentId", subject, score, total, "examType", month, status, "teacherId", date)
     VALUES ($1,$2,'Mathematics',15,20,$3,$4,'approved',$5, CURRENT_DATE)`,
    [opts.id, opts.studentId, opts.examType ?? 'Quiz', opts.month ?? 'September', opts.teacherId ?? 'teacher-1'],
  );
}

/** Rows shaped exactly like the client sends them to the RPCs. */
export interface UploadedRow {
  rowNumber: number;
  name: string;
  systemId: string;
  action?: 'deactivate' | 'keep_active' | 'review';
  adminConfirmed?: boolean;
}
