-- Migration: supervisor lesson-plan week selector
--
-- The supervisor's Lesson Plan Review page reviews ONE week at a time now:
-- pick a week, then load only that week's submissions. Two things keep that
-- cheap on a growing plan history:
--
--   1. list_lesson_plan_weeks() aggregates week_label -> plan count inside the
--      database, so the week dropdown never downloads the plan history.
--   2. A composite (status, week_label) index serves both that aggregate and
--      the per-week fetch (status IN (...) AND week_label IN (...)).
--
-- SECURITY INVOKER on purpose: row-level security still applies, so a
-- supervisor sees every reviewable week while any other caller only ever sees
-- the rows their existing lesson_plans policies already allow.
--
-- No lesson_plans rows are created or modified here.

CREATE OR REPLACE FUNCTION list_lesson_plan_weeks(p_statuses TEXT[] DEFAULT NULL)
RETURNS TABLE (week_label TEXT, plan_count BIGINT)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public
AS $$
  SELECT lp.week_label, COUNT(*)::BIGINT
  FROM lesson_plans lp
  WHERE p_statuses IS NULL OR lp.status = ANY (p_statuses)
  GROUP BY lp.week_label
$$;

COMMENT ON FUNCTION list_lesson_plan_weeks(TEXT[]) IS
  'Distinct lesson-plan weeks with submission counts for the supervisor week selector. SECURITY INVOKER so RLS still applies.';

REVOKE ALL ON FUNCTION list_lesson_plan_weeks(TEXT[]) FROM PUBLIC;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    EXECUTE 'GRANT EXECUTE ON FUNCTION list_lesson_plan_weeks(TEXT[]) TO authenticated';
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_lesson_plans_status_week_label
  ON lesson_plans (status, week_label);
