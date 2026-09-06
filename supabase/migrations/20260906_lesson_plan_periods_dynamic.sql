-- Migration: Make lesson-plan periods dynamic
--
-- Teachers plan different numbers of periods per day (e.g. Foundation/KG
-- classes may run only 4 periods, while others run 5, 6, or more). This
-- removes the fixed 5-6 period limits introduced in 20260727_lesson_plans.sql
-- so a plan may hold any positive number of periods. No rows are migrated or
-- rewritten: every existing 5- or 6-period plan keeps its rows and count.

-- ============================================================================
-- 1. DYNAMIC PERIOD COUNT
-- ============================================================================
ALTER TABLE lesson_plans
  DROP CONSTRAINT IF EXISTS lesson_plans_period_count_check;

ALTER TABLE lesson_plans
  ADD CONSTRAINT lesson_plans_period_count_check
  CHECK (period_count >= 1);

-- ============================================================================
-- 2. DYNAMIC PERIOD NUMBER
-- ============================================================================
ALTER TABLE lesson_plan_periods
  DROP CONSTRAINT IF EXISTS lesson_plan_periods_period_number_check;

ALTER TABLE lesson_plan_periods
  ADD CONSTRAINT lesson_plan_periods_period_number_check
  CHECK (period_number >= 1);

-- ============================================================================
-- 3. KEEP plan.period_count IN SYNC WITH THE SAVED PERIOD SET
-- ============================================================================
-- The new optional p_period_count is written in the same transaction as the
-- period rows, so a teacher adding/removing periods gets a reloadable plan
-- with the same number of periods. Older callers that omit the argument keep
-- working unchanged.
DROP FUNCTION IF EXISTS save_lesson_plan_periods(TEXT, JSONB);

CREATE OR REPLACE FUNCTION save_lesson_plan_periods(
  p_plan_id TEXT,
  p_periods JSONB,
  p_period_count INTEGER DEFAULT NULL
) RETURNS SETOF lesson_plan_periods
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = public
AS $$
DECLARE
  v_status TEXT;
BEGIN
  SELECT status INTO v_status FROM lesson_plans WHERE id = p_plan_id;

  IF v_status IS NULL THEN
    RAISE EXCEPTION 'Lesson plan % not found', p_plan_id USING ERRCODE = 'no_data_found';
  END IF;

  IF NOT lesson_plan_is_editable(v_status) THEN
    RAISE EXCEPTION
      'Lesson plan % is locked (status: %). Ask a supervisor to request revisions before editing.',
      p_plan_id, v_status
      USING ERRCODE = 'check_violation';
  END IF;

  IF p_period_count IS NOT NULL THEN
    IF p_period_count < 1 THEN
      RAISE EXCEPTION 'A lesson plan must have at least one period per day.'
        USING ERRCODE = 'check_violation';
    END IF;

    UPDATE lesson_plans
    SET period_count = p_period_count
    WHERE id = p_plan_id;
  END IF;

  DELETE FROM lesson_plan_periods WHERE plan_id = p_plan_id;

  INSERT INTO lesson_plan_periods (id, plan_id, day, period_number, topic, objective, activities, slide_number, details, sort_order, subject, class_name, is_free)
  SELECT
    'period-' || p_plan_id || '-' || (elem->>'day') || '-' || (elem->>'period_number'),
    p_plan_id,
    (elem->>'day')::day_of_week,
    (elem->>'period_number')::INTEGER,
    elem->>'topic',
    elem->>'objective',
    elem->>'activities',
    elem->>'slide_number',
    COALESCE(elem->'details', '[]'::jsonb),
    row_number() OVER () - 1,
    elem->>'subject',
    elem->>'class_name',
    COALESCE((elem->>'is_free')::boolean, false)
  FROM jsonb_array_elements(p_periods) AS elem;

  RETURN QUERY
  SELECT * FROM lesson_plan_periods
  WHERE plan_id = p_plan_id
  ORDER BY day, period_number;
END;
$$;
