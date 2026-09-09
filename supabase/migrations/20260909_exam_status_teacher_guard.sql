-- Exam status self-approval guard.
--
-- CONTEXT / VULNERABILITY
-- -----------------------------------------------------------------------------
-- The exam RLS policies from 20260802_bulk_grade_integrity.sql correctly bind
-- row ownership (teacherId = current_profile_id, plus can_submit_exam_target for
-- the student/class/subject), but their WITH CHECK clauses do NOT constrain the
-- `status` column. Via a direct PostgREST table write an authenticated teacher
-- could therefore INSERT or UPDATE one of their OWN rows with status='approved',
-- self-approving a grade without going through the authorized approval path.
--
-- The audited bulk-upload RPC (submit_bulk_grades) is not the problem: it is
-- SECURITY DEFINER and always writes status='pending'. The gap is the direct
-- table surface that PostgREST exposes to the `authenticated` role.
--
-- FIX (defense in depth, minimal, non-breaking)
-- -----------------------------------------------------------------------------
-- A BEFORE INSERT OR UPDATE trigger forces status='pending' for any write made
-- by an authenticated actor whose profile role is NOT admin/supervisor. This:
--   * makes it IMPOSSIBLE for a teacher to set or transition a grade to
--     'approved' (or 'rejected') by any path — direct table write included;
--   * leaves the approval path intact: admin/supervisor writes are untouched, so
--     updateExamStatus / approveAllPendingExams / approvePendingExamsForClasses
--     continue to work;
--   * is a no-op for submit_bulk_grades, which already writes 'pending';
--   * does not weaken any existing authorization (RLS still applies first);
--   * does not touch service-role / migration / seed writes (auth.uid() IS NULL),
--     so it fails closed for authenticated clients while preserving backend seeds.
--
-- Idempotent.

CREATE OR REPLACE FUNCTION public.enforce_exam_status_guard()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid UUID := auth.uid();
  v_role TEXT := public.current_profile_role();
BEGIN
  -- Only an authenticated, non-privileged actor is constrained. Anonymous /
  -- service-role / superuser contexts (no JWT, auth.uid() IS NULL) are left
  -- untouched so backend seeds and migrations behave normally; RLS already bars
  -- unauthenticated clients from writing.
  IF v_uid IS NOT NULL
     AND v_role IS DISTINCT FROM 'admin'
     AND v_role IS DISTINCT FROM 'supervisor' THEN
    NEW.status := 'pending';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS enforce_exam_status_guard_trg ON public.exams;
CREATE TRIGGER enforce_exam_status_guard_trg
  BEFORE INSERT OR UPDATE ON public.exams
  FOR EACH ROW
  EXECUTE FUNCTION public.enforce_exam_status_guard();
