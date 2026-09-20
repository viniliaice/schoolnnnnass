import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '../../..');

export function readMigration(name: string): string {
  return fs.readFileSync(path.join(REPO_ROOT, 'supabase', 'migrations', name), 'utf8');
}

export async function pgliteAvailable(): Promise<boolean> {
  try {
    await import('@electric-sql/pglite');
    return true;
  } catch {
    return false;
  }
}

export interface PgTestDb {
  query: <T = Record<string, unknown>>(sql: string, params?: unknown[]) => Promise<{ rows: T[] }>;
  exec: (sql: string) => Promise<void>;
  setAuthUid: (uid: string | null) => Promise<void>;
  close: () => Promise<void>;
}

const BASE_SCHEMA = `
CREATE SCHEMA IF NOT EXISTS auth;
CREATE TABLE IF NOT EXISTS auth.users (id UUID PRIMARY KEY);

CREATE OR REPLACE FUNCTION auth.uid() RETURNS UUID LANGUAGE sql STABLE AS $fn$
  SELECT NULLIF(current_setting('app.current_auth_uid', true), '')::UUID;
$fn$;

CREATE TABLE IF NOT EXISTS audit_logs (
  id bigserial PRIMARY KEY,
  action text NOT NULL,
  details jsonb DEFAULT '{}'::jsonb,
  "createdAt" timestamptz NOT NULL DEFAULT now()
);

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

CREATE TABLE academic_years (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  "startDate" DATE,
  "endDate" DATE,
  "isCurrent" BOOLEAN DEFAULT false,
  "createdAt" TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE terms (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  "academicYearId" TEXT REFERENCES academic_years(id),
  "startDate" DATE,
  "endDate" DATE,
  "isCurrent" BOOLEAN DEFAULT false,
  months TEXT[],
  "createdAt" TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE students (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  "className" TEXT NOT NULL,
  "parentId" TEXT REFERENCES profiles(id) ON DELETE SET NULL,
  "govId" TEXT,
  "parentPhone" TEXT,
  "familyId" TEXT,
  transport TEXT,
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE class_subjects (
  id TEXT PRIMARY KEY,
  "className" TEXT NOT NULL,
  "subjectId" TEXT NOT NULL REFERENCES subjects(id) ON DELETE CASCADE,
  "teacherId" TEXT REFERENCES profiles(id) ON DELETE SET NULL,
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
  reason TEXT NOT NULL DEFAULT 'backfill' CHECK (reason IN ('backfill','promotion','import','transfer','correction','manual')),
  "sourceRef" TEXT,
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK ("effectiveTo" IS NULL OR "effectiveTo" >= "effectiveFrom")
);

CREATE UNIQUE INDEX uniq_student_enrollments_open ON student_enrollments ("studentId") WHERE "effectiveTo" IS NULL;

CREATE TABLE student_promotions (
  id TEXT PRIMARY KEY,
  "studentId" TEXT NOT NULL REFERENCES students(id) ON DELETE CASCADE,
  "fromClass" TEXT NOT NULL,
  "toClass" TEXT NOT NULL,
  "academicYearId" TEXT REFERENCES academic_years(id) ON DELETE SET NULL,
  source TEXT,
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE exams (
  id TEXT PRIMARY KEY,
  "studentId" TEXT NOT NULL REFERENCES students(id) ON DELETE CASCADE,
  "subjectId" TEXT,
  subject TEXT NOT NULL,
  score NUMERIC,
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
  "teacherId" TEXT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  "uploadedBy" TEXT REFERENCES profiles(id) ON DELETE SET NULL
);

CREATE UNIQUE INDEX exams_bulk_assessment_identity_unique ON exams("studentId", "subjectId", "examType", "assessmentLabel", "termId") WHERE "subjectId" IS NOT NULL AND "termId" IS NOT NULL AND "assessmentLabel" IS NOT NULL;

CREATE TABLE attendance (
  id TEXT PRIMARY KEY,
  "studentId" TEXT NOT NULL REFERENCES students(id) ON DELETE CASCADE,
  "className" TEXT NOT NULL,
  date DATE NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('present','absent','late')),
  note TEXT,
  "teacherId" TEXT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE("studentId", date)
);

CREATE TABLE homework (
  id TEXT PRIMARY KEY,
  "studentId" TEXT NOT NULL REFERENCES students(id) ON DELETE CASCADE,
  "className" TEXT NOT NULL,
  subject TEXT NOT NULL,
  title TEXT NOT NULL,
  description TEXT,
  "dueDate" DATE NOT NULL,
  status TEXT NOT NULL DEFAULT 'assigned' CHECK (status IN ('assigned','submitted','graded')),
  "teacherId" TEXT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE quizzes (
  id TEXT PRIMARY KEY,
  "className" TEXT NOT NULL,
  subject TEXT NOT NULL,
  title TEXT NOT NULL,
  "teacherId" TEXT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE quiz_attempts (
  id TEXT PRIMARY KEY,
  "quizId" TEXT NOT NULL REFERENCES quizzes(id) ON DELETE CASCADE,
  "studentId" TEXT NOT NULL REFERENCES students(id) ON DELETE CASCADE,
  answers JSONB NOT NULL DEFAULT '[]',
  "totalEarned" INTEGER DEFAULT 0,
  "totalPossible" INTEGER DEFAULT 0,
  "startedAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  "submittedAt" TIMESTAMPTZ,
  status TEXT NOT NULL DEFAULT 'in_progress' CHECK (status IN ('in_progress','submitted','graded')),
  UNIQUE("quizId", "studentId")
);

CREATE TABLE authorized_pickups (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  "phoneNumber" TEXT NOT NULL,
  relationship TEXT,
  "photoPath" TEXT,
  "addedByStaffId" TEXT NOT NULL,
  "addedAt" TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE authorized_pickup_students (
  "authorizedPickupId" TEXT NOT NULL REFERENCES authorized_pickups(id) ON DELETE CASCADE,
  "studentId" TEXT NOT NULL REFERENCES students(id) ON DELETE CASCADE,
  PRIMARY KEY ("authorizedPickupId", "studentId")
);

CREATE TABLE release_log (
  id BIGSERIAL PRIMARY KEY,
  "studentId" TEXT NOT NULL REFERENCES students(id) ON DELETE CASCADE,
  "familyId" TEXT NOT NULL,
  "staffId" TEXT NOT NULL REFERENCES profiles(id) ON DELETE RESTRICT,
  "pickupPersonId" TEXT REFERENCES authorized_pickups(id) ON DELETE SET NULL,
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX uniq_release_log_student_day ON release_log ("studentId", (("createdAt" AT TIME ZONE 'UTC')::date));

CREATE TABLE report_comments (
  id TEXT PRIMARY KEY,
  "studentId" TEXT NOT NULL REFERENCES students(id) ON DELETE CASCADE,
  "termId" TEXT NOT NULL REFERENCES terms(id) ON DELETE CASCADE,
  "examId" TEXT REFERENCES exams(id) ON DELETE SET NULL,
  "teacherComment" TEXT,
  "principalComment" TEXT,
  "teacherId" TEXT REFERENCES profiles(id) ON DELETE SET NULL,
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Security bridge
CREATE OR REPLACE FUNCTION public.current_profile_id() RETURNS TEXT LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $fn$
  SELECT id FROM public.profiles WHERE auth_id = auth.uid() LIMIT 1;
$fn$;
CREATE OR REPLACE FUNCTION public.current_profile_role() RETURNS TEXT LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $fn$
  SELECT role FROM public.profiles WHERE auth_id = auth.uid() LIMIT 1;
$fn$;

CREATE OR REPLACE FUNCTION public.assert_admin() RETURNS TEXT LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $fn$
DECLARE v_role TEXT := public.current_profile_role();
BEGIN
  IF v_role IS NULL OR v_role <> 'admin' THEN
    RAISE EXCEPTION 'Only administrators may perform this action.' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN public.current_profile_id();
END;
$fn$;

CREATE OR REPLACE FUNCTION public.current_academic_year_id() RETURNS TEXT LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $fn$
  SELECT id FROM public.academic_years WHERE "isCurrent" = true ORDER BY "startDate" DESC LIMIT 1;
$fn$;

CREATE OR REPLACE FUNCTION public.gov_id_key(p_gov TEXT) RETURNS TEXT LANGUAGE sql IMMUTABLE SET search_path = public AS $fn$
  SELECT NULLIF(upper(btrim(COALESCE(p_gov,''))), '');
$fn$;

CREATE OR REPLACE FUNCTION public.gov_id_match_key(p_t TEXT) RETURNS TEXT LANGUAGE sql IMMUTABLE SET search_path = public AS $fn$
  SELECT upper(regexp_replace(COALESCE(p_t,''), '[^a-zA-Z0-9]', '', 'g'));
$fn$;

CREATE OR REPLACE FUNCTION public.name_match_key(p_t TEXT) RETURNS TEXT LANGUAGE sql IMMUTABLE SET search_path = public AS $fn$
  SELECT btrim(regexp_replace(lower(COALESCE(p_t,'')), '\s+', ' ', 'g'));
$fn$;

CREATE OR REPLACE FUNCTION public.class_match_key(p_t TEXT) RETURNS TEXT LANGUAGE sql IMMUTABLE SET search_path = public AS $fn$
  SELECT btrim(regexp_replace(lower(COALESCE(p_t,'')), '\s+', ' ', 'g'));
$fn$;

CREATE OR REPLACE FUNCTION public.normalize_phone(p TEXT) RETURNS TEXT LANGUAGE sql IMMUTABLE SET search_path = public AS $fn$
  SELECT CASE WHEN btrim(COALESCE(p,'')) = '' THEN '' ELSE regexp_replace(CASE WHEN length(regexp_replace(btrim(p), '\D', '', 'g')) = 9 THEN regexp_replace(btrim(p), '\D', '', 'g') WHEN regexp_replace(btrim(p), '\D', '', 'g') LIKE '252%' THEN substr(regexp_replace(btrim(p), '\D', '', 'g'), 4) WHEN regexp_replace(btrim(p), '\D', '', 'g') LIKE '0%' THEN substr(regexp_replace(btrim(p), '\D', '', 'g'), 2) ELSE regexp_replace(btrim(p), '\D', '', 'g') END, '\D', '', 'g') END;
$fn$;

CREATE OR REPLACE FUNCTION public.normalize_family_id(p TEXT) RETURNS TEXT LANGUAGE sql IMMUTABLE SET search_path = public AS $fn$
  SELECT lpad(regexp_replace(COALESCE(p,''), '\D', '', 'g'), 4, '0');
$fn$;

CREATE OR REPLACE FUNCTION public.valid_transport(p TEXT) RETURNS BOOLEAN LANGUAGE sql IMMUTABLE SET search_path = public AS $fn$
  SELECT p IS NULL OR btrim(p) = '' OR p IN ('WALKER','CAR','DRIVER','LEFT') OR p ~ '^\d+$';
$fn$;

CREATE OR REPLACE FUNCTION public.norm_transport(p TEXT) RETURNS TEXT LANGUAGE sql IMMUTABLE SET search_path = public AS $fn$
  SELECT COALESCE(NULLIF(btrim(COALESCE(p,'')), ''), 'WALKER');
$fn$;

CREATE OR REPLACE FUNCTION public.is_canonical_class(p_class TEXT) RETURNS BOOLEAN LANGUAGE sql IMMUTABLE SET search_path = public AS $fn$
  SELECT btrim(COALESCE(p_class,'')) ~ '^(Foundation [A-Z]|KG-[A-Z]|Grade [0-9]{1,2}-[A-Z]|Year [0-9]{1,2}-[A-Z]|Graduated)$';
$fn$;

CREATE OR REPLACE FUNCTION public.record_class_assignment(
  p_student_id TEXT,
  p_new_class TEXT,
  p_reason TEXT,
  p_effective_from DATE DEFAULT NULL,
  p_academic_year_id TEXT DEFAULT NULL,
  p_term_id TEXT DEFAULT NULL,
  p_source_ref TEXT DEFAULT NULL
) RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $fn$
DECLARE
  v_from DATE := COALESCE(p_effective_from, CURRENT_DATE);
  v_open_class TEXT;
  v_open_from DATE;
  v_close_to DATE;
BEGIN
  IF p_student_id IS NULL OR p_new_class IS NULL OR btrim(p_new_class) = '' THEN
    RAISE EXCEPTION 'record_class_assignment: student and class are required.' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.students WHERE id = p_student_id) THEN
    RAISE EXCEPTION 'Student % does not exist.', p_student_id USING ERRCODE = 'no_data_found';
  END IF;
  SELECT "className", "effectiveFrom" INTO v_open_class, v_open_from FROM public.student_enrollments WHERE "studentId" = p_student_id AND "effectiveTo" IS NULL LIMIT 1;
  IF v_open_class = p_new_class THEN RETURN; END IF;
  IF v_open_class IS NOT NULL THEN
    -- Patched for same-day moves: if open_from >= v_from, update in place to avoid check violation
    IF v_open_from >= v_from THEN
      UPDATE public.student_enrollments SET "className" = p_new_class, "academicYearId" = COALESCE(CASE WHEN p_academic_year_id IS NOT NULL AND EXISTS (SELECT 1 FROM public.academic_years WHERE id = p_academic_year_id) THEN p_academic_year_id ELSE NULL END, "academicYearId") WHERE "studentId" = p_student_id AND "effectiveTo" IS NULL;
      RETURN;
    END IF;
    v_close_to := LEAST(v_from - 1, CURRENT_DATE);
    IF v_close_to < v_open_from THEN
      v_close_to := v_open_from;
    END IF;
    UPDATE public.student_enrollments SET "effectiveTo" = v_close_to WHERE "studentId" = p_student_id AND "effectiveTo" IS NULL;
  END IF;
  INSERT INTO public.student_enrollments (id, "studentId", "className", "academicYearId", "termId", "effectiveFrom", "effectiveTo", reason, "sourceRef")
  VALUES ('enr-' || floor(extract(epoch FROM clock_timestamp())*1000)::text || '-' || substr(md5(random()::text || p_student_id),1,8), p_student_id, p_new_class, CASE WHEN p_academic_year_id IS NOT NULL AND EXISTS (SELECT 1 FROM public.academic_years WHERE id = p_academic_year_id) THEN p_academic_year_id ELSE NULL END, CASE WHEN p_term_id IS NOT NULL AND EXISTS (SELECT 1 FROM public.terms WHERE id = p_term_id) THEN p_term_id ELSE NULL END, GREATEST(v_from, COALESCE(v_open_from, DATE '2000-01-01')), NULL, COALESCE(p_reason,'manual'), p_source_ref);
END;
$fn$;
`;

export async function createDuplicateMergeTestDb(): Promise<PgTestDb> {
  const { PGlite } = await import('@electric-sql/pglite');
  const pg = await PGlite.create();

  await pg.exec(BASE_SCHEMA);

  // Ensure authenticated role exists for GRANT statements in migrations
  await pg.exec(`DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='authenticated') THEN CREATE ROLE authenticated NOLOGIN; END IF; END $$;`);

  // Load the two new migrations verbatim (they are idempotent and include REVOKE/GRANT)
  const mergeSql = readMigration('20260920_student_duplicate_merge.sql');
  await pg.exec(mergeSql);

  const hardenSql = readMigration('20260920b_student_creation_hardening.sql');
  await pg.exec(hardenSql);

  const client: PgTestDb = {
    query: async (sql, params) => {
      const res = await pg.query(sql, params as unknown[] | undefined);
      return { rows: (res.rows ?? []) as never };
    },
    exec: async (sql) => { await pg.exec(sql); },
    setAuthUid: async (uid) => {
      await pg.query('SELECT set_config($1, $2, false)', ['app.current_auth_uid', uid ?? '']);
    },
    close: async () => { await pg.close(); },
  };

  return client;
}
