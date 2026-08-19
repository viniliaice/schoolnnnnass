-- Assertion test for office transport editing (20260820_office_transport_edit.sql).
--
-- Run against a database with the migrations applied:
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f supabase/tests/rls-office-transport.sql
-- Every DO block RAISEs on failure, so a failing assertion fails the script
-- (exit non-zero under ON_ERROR_STOP).
--
-- These are STATIC checks on the function definition: they need no seeded
-- students and no session role, so the script is safe to run against a live
-- database. The dynamic role matrix was verified separately on a scratch
-- Postgres (admin+office allowed; supervisor/teacher/parent/anon blocked).

-- ── 1. set_student_transport admits office ──────────────────────────────────
DO $$
DECLARE
  v_def TEXT;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO v_def
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public' AND p.proname = 'set_student_transport';

  IF v_def IS NULL THEN
    RAISE EXCEPTION 'set_student_transport() is missing';
  END IF;
  IF position('''office''' in v_def) = 0 THEN
    RAISE EXCEPTION 'set_student_transport() does not admit office';
  END IF;
  IF position('''admin''' in v_def) = 0 THEN
    RAISE EXCEPTION 'set_student_transport() no longer admits admin';
  END IF;
END $$;

-- ── 2. it is still hardened (DEFINER + pinned search_path + not PUBLIC) ─────
DO $$
DECLARE
  v_secdef BOOLEAN;
  v_config TEXT[];
BEGIN
  SELECT p.prosecdef, p.proconfig INTO v_secdef, v_config
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public' AND p.proname = 'set_student_transport';

  IF NOT v_secdef THEN
    RAISE EXCEPTION 'set_student_transport() lost SECURITY DEFINER';
  END IF;
  IF v_config IS NULL OR NOT (v_config @> ARRAY['search_path=public']) THEN
    RAISE EXCEPTION 'set_student_transport() lost its pinned search_path: %', v_config;
  END IF;
  IF has_function_privilege('public', 'public.set_student_transport(TEXT,TEXT)', 'EXECUTE') THEN
    RAISE EXCEPTION 'set_student_transport() is executable by PUBLIC';
  END IF;
END $$;

-- ── 3. THE NARROW-WIDENING INVARIANT ────────────────────────────────────────
-- Office gained transport editing and NOTHING else. Each of these must still
-- be admin-only, or a front-desk account could reshape families.
DO $$
DECLARE
  v_name TEXT;
  v_def  TEXT;
BEGIN
  FOREACH v_name IN ARRAY ARRAY[
    'generate_family_ids',
    'assign_family_override',
    'mark_student_left',
    'set_student_import_fields'
  ] LOOP
    SELECT pg_get_functiondef(p.oid) INTO v_def
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.proname = v_name
    ORDER BY p.oid DESC LIMIT 1;

    IF v_def IS NULL THEN
      RAISE NOTICE 'skip: %() not present in this database', v_name;
      CONTINUE;
    END IF;

    IF position('''office''' in v_def) > 0 THEN
      RAISE EXCEPTION
        '%() now admits office — the transport widening leaked into family-ID powers', v_name;
    END IF;
  END LOOP;
END $$;

-- ── 4. office must not hold a direct UPDATE grant on students ───────────────
-- The write must go through the SECURITY DEFINER function, never straight to
-- the table (that is what keeps the value validation and the audit row).
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.role_table_grants
    WHERE table_schema = 'public'
      AND table_name = 'students'
      AND privilege_type = 'UPDATE'
      AND grantee = 'authenticated'
  ) THEN
    RAISE EXCEPTION 'authenticated holds a direct UPDATE grant on students';
  END IF;
END $$;

-- ── 5. the audit row records the actor ──────────────────────────────────────
-- Widening a write from one role to two makes "who changed this?" real.
DO $$
DECLARE
  v_def TEXT;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO v_def
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public' AND p.proname = 'set_student_transport';

  IF position('actorId' in v_def) = 0 OR position('actorRole' in v_def) = 0 THEN
    RAISE EXCEPTION 'set_student_transport() does not record the actor in audit_logs';
  END IF;
  IF position('previous' in v_def) = 0 THEN
    RAISE EXCEPTION 'set_student_transport() does not record the previous value';
  END IF;
END $$;

SELECT 'rls-office-transport: all assertions passed' AS result;
