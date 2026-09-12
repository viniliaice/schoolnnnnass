-- Migration: lesson plan submission tracking (supervisor accountability page)
--
-- The supervisor's Lesson Plan Submission page answers "who has submitted
-- their lesson plan for this week — and who hasn't?". Its starting point is
-- the roster of teachers who are EXPECTED to submit, not the lesson-plan
-- rows themselves: a teacher with no plan for the week must still appear as
-- "Not Submitted" instead of silently disappearing from the page.
--
-- Who is expected to submit? Exactly the teachers who can create plans in
-- their own planner: profiles with role 'teacher' and a non-empty
-- "assignedClasses" array. LessonPlanner builds its class picker from
-- profiles."assignedClasses", so a teacher without an assigned class cannot
-- submit anything and must NOT be nagged as missing. The same source of
-- truth is used here on purpose.
--
-- Why an RPC: profiles is SELECT-restricted under RLS (own profile + admin
-- only — 20260708_profiles_auth_session_rls), so a supervisor cannot list
-- the teacher roster with a direct query. Supervisors already read every
-- lesson plan school-wide (supervisor_select_all_plans, including each
-- plan's teacher), so exposing the minimal roster projection
-- (id, name, one row per assigned class) to supervisors is consistent with
-- the rights they already hold. The role check keeps every other role out.
--
-- This function is read-only, STABLE, and SECURITY DEFINER (like
-- create_user_profile / set_user_role). No lesson_plans data model changes,
-- no new tables, no indexes — the week-scoped plan fetch is already served
-- by idx_lesson_plans_status_week_label (20260914).

CREATE OR REPLACE FUNCTION list_lesson_plan_submitters()
RETURNS TABLE (teacher_id TEXT, teacher_name TEXT, class_name TEXT)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT
    p.id   AS teacher_id,
    p.name AS teacher_name,
    btrim(c.class_name) AS class_name
  FROM public.profiles p
  CROSS JOIN LATERAL jsonb_array_elements_text(
    CASE
      WHEN jsonb_typeof(COALESCE(p."assignedClasses", '[]'::jsonb)) = 'array'
        THEN p."assignedClasses"
      ELSE '[]'::jsonb
    END
  ) AS c(class_name)
  WHERE lower(btrim(COALESCE(p.role, ''))) = 'teacher'
    AND public.current_profile_role() IN ('supervisor', 'admin')
    AND btrim(c.class_name) <> ''
$$;

COMMENT ON FUNCTION list_lesson_plan_submitters() IS
  'One row per (teacher, assigned class) for the supervisor lesson-plan submission tracker. Read-only roster projection of profiles; supervisor/admin only.';

REVOKE ALL ON FUNCTION list_lesson_plan_submitters() FROM PUBLIC;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    EXECUTE 'GRANT EXECUTE ON FUNCTION list_lesson_plan_submitters() TO authenticated';
  END IF;
END $$;
