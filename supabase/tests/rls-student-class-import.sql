-- Assertions for the Student Class Update & New Student Import write path.
--
-- Same philosophy as rls-family-import.sql: the client-side unit tests mock
-- Supabase, so the REAL safety invariants (RLS, admin gating, history
-- protection) are asserted here against the migrated schema.
--
-- Run against a database with the migrations applied:
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f supabase/tests/rls-student-class-import.sql
-- Every DO block RAISE EXCEPTION on failure, so a failing assertion fails
-- the script (exit non-zero under ON_ERROR_STOP).

-- ── 1. students must still have NO UPDATE/INSERT policies ──────────────────
-- All student writes must keep flowing through admin-gated SECURITY DEFINER
-- RPCs; a direct client UPDATE/INSERT path would bypass the role check and
-- the audit trail.
DO $$
DECLARE
  v_bad INT;
BEGIN
  SELECT count(*) INTO v_bad
  FROM pg_policies
  WHERE schemaname = 'public' AND tablename = 'students'
    AND cmd IN ('UPDATE', 'INSERT');
  IF v_bad > 0 THEN
    RAISE EXCEPTION 'students unexpectedly has % UPDATE/INSERT policy(ies) — the class import must stay RPC-only', v_bad;
  END IF;
END $$;

-- ── 2. apply_student_class_import exists, is SECURITY DEFINER, admin-gated ─
DO $$
DECLARE
  v_def TEXT;
  v_secdef BOOLEAN;
  v_count INT;
BEGIN
  SELECT count(*) INTO v_count
  FROM pg_proc
  WHERE proname = 'apply_student_class_import' AND pronamespace = 'public'::regnamespace;
  IF v_count <> 1 THEN
    RAISE EXCEPTION 'apply_student_class_import not found (found %)', v_count;
  END IF;

  SELECT prosecdef INTO v_secdef
  FROM pg_proc
  WHERE proname = 'apply_student_class_import' AND pronamespace = 'public'::regnamespace;
  IF v_secdef IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'apply_student_class_import must be SECURITY DEFINER';
  END IF;

  SELECT pg_get_functiondef(oid) INTO v_def
  FROM pg_proc
  WHERE proname = 'apply_student_class_import' AND pronamespace = 'public'::regnamespace;
  IF v_def IS NULL OR position('<> ''admin''' in v_def) = 0 THEN
    RAISE EXCEPTION 'apply_student_class_import lacks the admin role check';
  END IF;
END $$;

-- ── 3. Historical-data protection: the RPC never touches grades/attendance ─
-- A class move must only update students."className" + record history. If
-- this ever fails, historical grades or attendance could be rewritten by an
-- import — the exact regression this feature must prevent.
DO $$
DECLARE
  v_def TEXT;
BEGIN
  SELECT pg_get_functiondef(oid) INTO v_def
  FROM pg_proc
  WHERE proname = 'apply_student_class_import' AND pronamespace = 'public'::regnamespace;
  IF v_def IS NULL THEN
    RAISE EXCEPTION 'apply_student_class_import not found';
  END IF;
  IF position(' exams' in lower(v_def)) > 0 OR position(' attendance' in lower(v_def)) > 0 THEN
    RAISE EXCEPTION 'apply_student_class_import references exams/attendance — it must never touch historical records';
  END IF;
END $$;

-- ── 4. Import moves are tagged in the promotion history ────────────────────
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'student_promotions' AND column_name = 'source'
  ) THEN
    RAISE EXCEPTION 'student_promotions.source column missing — import moves would block end-of-year promotions';
  END IF;
END $$;

-- ── 5. promote_students only counts real promotions in its re-run guard ────
DO $$
DECLARE
  v_def TEXT;
BEGIN
  SELECT pg_get_functiondef(oid) INTO v_def
  FROM pg_proc
  WHERE proname = 'promote_students' AND pronamespace = 'public'::regnamespace;
  IF v_def IS NULL THEN
    RAISE EXCEPTION 'promote_students not found';
  END IF;
  IF position('class_import' in v_def) = 0 THEN
    RAISE EXCEPTION 'promote_students re-run guard must ignore class_import history rows';
  END IF;
END $$;
