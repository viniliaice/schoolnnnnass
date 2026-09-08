-- Assertions for the class-specific Bulk Upload Grades write path.
--
-- The browser unit tests mock Supabase, so the REAL safety invariants (server
-- authorization, wrong-class rejection, teacher/class/subject binding, atomic
-- upsert, idempotency) are asserted here against the migrated schema created by
-- 20260802_bulk_grade_integrity.sql.
--
-- Run against a database with the migrations applied:
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f supabase/tests/rls-bulk-grades.sql
-- Every DO block RAISE EXCEPTION on failure, so a failing assertion fails the
-- script (exit non-zero under ON_ERROR_STOP).

-- ── 1. submit_bulk_grades exists exactly once and is SECURITY DEFINER ──────
DO $$
DECLARE
  v_count INT;
  v_secdef BOOLEAN;
BEGIN
  SELECT count(*) INTO v_count
  FROM pg_proc
  WHERE proname = 'submit_bulk_grades' AND pronamespace = 'public'::regnamespace;
  IF v_count <> 1 THEN
    RAISE EXCEPTION 'submit_bulk_grades must exist exactly once (found %) — no second grade-upload system', v_count;
  END IF;

  SELECT prosecdef INTO v_secdef
  FROM pg_proc
  WHERE proname = 'submit_bulk_grades' AND pronamespace = 'public'::regnamespace;
  IF v_secdef IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'submit_bulk_grades must be SECURITY DEFINER';
  END IF;
END $$;

-- ── 2. The RPC derives the actor and re-checks role server-side ────────────
-- Teacher/admin-only, and the teacher's ownership of the class subject is not
-- trusted from the client.
DO $$
DECLARE
  v_def TEXT;
BEGIN
  SELECT pg_get_functiondef(oid) INTO v_def
  FROM pg_proc WHERE proname = 'submit_bulk_grades' AND pronamespace = 'public'::regnamespace;
  IF v_def IS NULL THEN RAISE EXCEPTION 'submit_bulk_grades not found'; END IF;
  IF position('current_profile_id()' in v_def) = 0 THEN
    RAISE EXCEPTION 'submit_bulk_grades must derive the actor via current_profile_id()';
  END IF;
  IF position('current_profile_role()' in v_def) = 0 THEN
    RAISE EXCEPTION 'submit_bulk_grades must re-check role via current_profile_role()';
  END IF;
  IF position('Teachers may upload only their assigned class subjects' in v_def) = 0 THEN
    RAISE EXCEPTION 'submit_bulk_grades must enforce teacher/class/subject ownership';
  END IF;
END $$;

-- ── 3. Wrong-class protection: student class is read from students, not sheet
-- The teacher-assignment lookup joins on the student's CURRENT className, so a
-- student who belongs to another class cannot be uploaded even if the workbook
-- lists them.
DO $$
DECLARE
  v_def TEXT;
BEGIN
  SELECT pg_get_functiondef(oid) INTO v_def
  FROM pg_proc WHERE proname = 'submit_bulk_grades' AND pronamespace = 'public'::regnamespace;
  IF position('FROM public.students WHERE id = v_student_id' in v_def) = 0 THEN
    RAISE EXCEPTION 'submit_bulk_grades must read the student''s current class from students';
  END IF;
  IF position('"className" = v_student_class' in v_def) = 0 THEN
    RAISE EXCEPTION 'submit_bulk_grades must bind teacher authorization to the student''s current class';
  END IF;
END $$;

-- ── 4. Maximum scores / assessment identity match the shared definitions ───
DO $$
DECLARE
  v_def TEXT;
BEGIN
  SELECT pg_get_functiondef(oid) INTO v_def
  FROM pg_proc WHERE proname = 'submit_bulk_grades' AND pronamespace = 'public'::regnamespace;
  IF position('v_assessment_label = ''AKHLAAQ'' AND v_exam_type = ''Discipline'' AND v_total = 10' in v_def) = 0 THEN
    RAISE EXCEPTION 'submit_bulk_grades must enforce Akhlaaq max 10 / Discipline';
  END IF;
  IF position('v_assessment_label = ''MT'' AND v_exam_type = ''Quiz'' AND v_total = 20' in v_def) = 0 THEN
    RAISE EXCEPTION 'submit_bulk_grades must enforce MT max 20 / Quiz';
  END IF;
  IF position('v_assessment_label = ''ATTENDANCE'' AND v_exam_type = ''Attendance'' AND v_total = 20' in v_def) = 0 THEN
    RAISE EXCEPTION 'submit_bulk_grades must enforce Attendance max 20';
  END IF;
END $$;

-- ── 5. Preview (p_confirm_updates=false) performs NO writes ────────────────
DO $$
DECLARE
  v_def TEXT;
  v_preview_pos INT;
  v_insert_pos INT;
BEGIN
  SELECT pg_get_functiondef(oid) INTO v_def
  FROM pg_proc WHERE proname = 'submit_bulk_grades' AND pronamespace = 'public'::regnamespace;
  v_preview_pos := position('IF NOT p_confirm_updates THEN' in v_def);
  v_insert_pos := position('INSERT INTO public.exams' in v_def);
  IF v_preview_pos = 0 OR v_insert_pos = 0 OR v_preview_pos > v_insert_pos THEN
    RAISE EXCEPTION 'submit_bulk_grades must return the preview before any INSERT INTO exams';
  END IF;
END $$;

-- ── 6. Atomic upsert on the classified bulk identity + idempotency ledger ──
DO $$
DECLARE
  v_def TEXT;
  v_idx INT;
BEGIN
  SELECT pg_get_functiondef(oid) INTO v_def
  FROM pg_proc WHERE proname = 'submit_bulk_grades' AND pronamespace = 'public'::regnamespace;
  IF position('ON CONFLICT ("studentId", "subjectId", "examType", "assessmentLabel", "termId")' in v_def) = 0 THEN
    RAISE EXCEPTION 'submit_bulk_grades must upsert on the bulk assessment identity';
  END IF;
  IF position('INSERT INTO public.grade_uploads' in v_def) = 0 THEN
    RAISE EXCEPTION 'submit_bulk_grades must record an idempotency ledger row';
  END IF;

  -- The unique index that makes the upsert (and duplicate protection) real.
  SELECT count(*) INTO v_idx
  FROM pg_indexes
  WHERE schemaname = 'public' AND tablename = 'exams'
    AND indexname = 'exams_bulk_assessment_identity_unique';
  IF v_idx <> 1 THEN
    RAISE EXCEPTION 'exams_bulk_assessment_identity_unique index is required for atomic bulk upserts';
  END IF;
END $$;

-- ── 7. exams remains RLS-protected with authorized-only write policies ─────
DO $$
DECLARE
  v_rls BOOLEAN;
  v_insert INT;
BEGIN
  SELECT relrowsecurity INTO v_rls FROM pg_class WHERE oid = 'public.exams'::regclass;
  IF v_rls IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'RLS must be enabled on public.exams';
  END IF;
  SELECT count(*) INTO v_insert
  FROM pg_policies
  WHERE schemaname = 'public' AND tablename = 'exams' AND policyname = 'exam_insert_authorized';
  IF v_insert <> 1 THEN
    RAISE EXCEPTION 'exam_insert_authorized policy is required';
  END IF;
END $$;

\echo 'rls-bulk-grades.sql: all assertions passed'
