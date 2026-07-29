/* Add per-period class_name, subject, and is_free columns */
/* These columns are used by the UI to track which class and subject each period belongs to */

ALTER TABLE lesson_plan_periods
  ADD COLUMN IF NOT EXISTS class_name TEXT,
  ADD COLUMN IF NOT EXISTS subject TEXT,
  ADD COLUMN IF NOT EXISTS is_free BOOLEAN NOT NULL DEFAULT false;

/* Update the atomic save RPC to include the new columns */
DROP FUNCTION IF EXISTS save_lesson_plan_periods(TEXT, JSONB);

CREATE OR REPLACE FUNCTION save_lesson_plan_periods(
  p_plan_id TEXT,
  p_periods JSONB
) RETURNS SETOF lesson_plan_periods
  LANGUAGE plpgsql
  SECURITY DEFINER
AS $$
DECLARE
  _sp TEXT := 'save_periods';
BEGIN
  SAVEPOINT _sp;

  DELETE FROM lesson_plan_periods WHERE plan_id = p_plan_id;

  INSERT INTO lesson_plan_periods (id, plan_id, day, period_number, class_name, subject, is_free, topic, objective, activities, slide_number, details, sort_order)
  SELECT
    'period-' || p_plan_id || '-' || (elem->>'day') || '-' || (elem->>'period_number'),
    p_plan_id,
    (elem->>'day')::day_of_week,
    (elem->>'period_number')::INTEGER,
    elem->>'class_name',
    elem->>'subject',
    COALESCE((elem->>'is_free')::BOOLEAN, false),
    elem->>'topic',
    elem->>'objective',
    elem->>'activities',
    elem->>'slide_number',
    COALESCE(elem->'details', '[]'::jsonb),
    row_number() OVER () - 1
  FROM jsonb_array_elements(p_periods) AS elem;

  RELEASE SAVEPOINT _sp;

  RETURN QUERY
  SELECT * FROM lesson_plan_periods
  WHERE plan_id = p_plan_id
  ORDER BY day, period_number;
EXCEPTION
  WHEN OTHERS THEN
    ROLLBACK TO SAVEPOINT _sp;
    RAISE;
END;
$$;
