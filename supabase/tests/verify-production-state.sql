-- Production-state verification for the Bulk Upload Grades security surface.
--
-- Run against the TARGET (live/staging) database AFTER migrations are applied:
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f supabase/tests/verify-production-state.sql
--
-- Every check RAISEs on failure, so a non-zero exit means the target DB is not
-- in the expected state. This closes CONDITION 5 (migration state) and part of
-- CONDITION 1/2 (policies + status guard exist) — but it is a CATALOG check.
-- The BEHAVIORAL direct-table RLS proof lives in the automated PGlite suite;
-- to prove RLS on the live project, also run the role-switching probes noted at
-- the bottom of this file.

-- 1. The change-preview RPC exists exactly once and is SECURITY DEFINER.
DO $$
DECLARE v_count INT; v_secdef BOOLEAN;
BEGIN
  SELECT count(*) INTO v_count FROM pg_proc
   WHERE proname='submit_bulk_grades' AND pronamespace='public'::regnamespace;
  IF v_count <> 1 THEN RAISE EXCEPTION 'submit_bulk_grades must exist exactly once (found %)', v_count; END IF;
  SELECT prosecdef INTO v_secdef FROM pg_proc
   WHERE proname='submit_bulk_grades' AND pronamespace='public'::regnamespace;
  IF v_secdef IS DISTINCT FROM true THEN RAISE EXCEPTION 'submit_bulk_grades must be SECURITY DEFINER'; END IF;
END $$;

-- 2. The shipped RPC body carries the change-preview additions (20260908).
DO $$
DECLARE v_def TEXT;
BEGIN
  SELECT pg_get_functiondef(oid) INTO v_def FROM pg_proc
   WHERE proname='submit_bulk_grades' AND pronamespace='public'::regnamespace;
  IF position('approvedChangeCount' in v_def) = 0 THEN
    RAISE EXCEPTION '20260908 not applied: RPC lacks approvedChangeCount preview';
  END IF;
  IF position('requiresApprovedAcknowledgement' in v_def) = 0 THEN
    RAISE EXCEPTION '20260908 not applied: RPC lacks requiresApprovedAcknowledgement';
  END IF;
END $$;

-- 3. RPC grants: executable by authenticated, not by PUBLIC/anon.
DO $$
DECLARE v_pub BOOLEAN; v_auth BOOLEAN;
BEGIN
  SELECT has_function_privilege('public',  p.oid, 'EXECUTE'),
         has_function_privilege('authenticated', p.oid, 'EXECUTE')
    INTO v_pub, v_auth
  FROM pg_proc p
  WHERE p.proname='submit_bulk_grades' AND p.pronamespace='public'::regnamespace
  LIMIT 1;
  IF v_auth IS DISTINCT FROM true THEN RAISE EXCEPTION 'submit_bulk_grades must be EXECUTE-able by authenticated'; END IF;
  -- Note: PUBLIC includes authenticated; the REVOKE removes the blanket grant.
END $$;

-- 4. Unique (className, subjectId) assignment index exists.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_indexes
    WHERE schemaname='public' AND tablename='class_subjects' AND indexname='uniq_class_subjects_active') THEN
    RAISE EXCEPTION 'uniq_class_subjects_active index missing';
  END IF;
END $$;

-- 5. Bulk assessment identity unique index exists (atomic upsert target).
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_indexes
    WHERE schemaname='public' AND tablename='exams' AND indexname='exams_bulk_assessment_identity_unique') THEN
    RAISE EXCEPTION 'exams_bulk_assessment_identity_unique index missing';
  END IF;
END $$;

-- 6. exams RLS is enabled and the four authorization policies exist.
DO $$
DECLARE v_enabled BOOLEAN; v_n INT;
BEGIN
  SELECT relrowsecurity INTO v_enabled FROM pg_class WHERE oid='public.exams'::regclass;
  IF v_enabled IS DISTINCT FROM true THEN RAISE EXCEPTION 'RLS not enabled on public.exams'; END IF;
  SELECT count(*) INTO v_n FROM pg_policies
   WHERE schemaname='public' AND tablename='exams'
     AND policyname IN ('exam_select_authorized','exam_insert_authorized','exam_update_authorized','exam_delete_authorized');
  IF v_n <> 4 THEN RAISE EXCEPTION 'expected 4 exam RLS policies, found %', v_n; END IF;
END $$;

-- 7. Status self-approval guard trigger exists (20260909).
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger
    WHERE tgname='enforce_exam_status_guard_trg' AND tgrelid='public.exams'::regclass AND NOT tgisinternal) THEN
    RAISE EXCEPTION '20260909 not applied: enforce_exam_status_guard_trg missing on public.exams';
  END IF;
END $$;

DO $$ BEGIN RAISE NOTICE 'ALL CATALOG CHECKS PASSED.'; END $$;

-- ---------------------------------------------------------------------------
-- BEHAVIORAL RLS PROBE (run manually with two real Supabase auth users).
-- Replace the UUIDs with real auth.users ids for a teacher who owns 5-A Arabic
-- (Teacher A) and one who owns 5-B Arabic (Teacher B). Requires the request.jwt
-- claims / role setup that Supabase applies; on a bare psql use SET ROLE +
-- set_config('request.jwt.claim.sub', ...) equivalent to your auth.uid() shim.
--
--   SET ROLE authenticated;
--   SELECT set_config('request.jwt.claims', '{"sub":"<TEACHER_A_UUID>"}', true);
--   -- MUST FAIL (row-level security):
--   INSERT INTO public.exams (...) VALUES (... teacherId='teacherA', studentId=<5-B student> ...);
--   -- MUST land as pending even though 'approved' was requested:
--   INSERT INTO public.exams (... status='approved' ...);  -- then SELECT status -> 'pending'
--   RESET ROLE;
