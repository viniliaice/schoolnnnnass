-- Migration: Fix save_lesson_plan_periods RPC (remove unsupported SAVEPOINT in PL/pgSQL)
-- PostgreSQL error 0A000: unsupported transaction command in PL/pgSQL

DROP FUNCTION IF EXISTS save_lesson_plan_periods;

CREATE OR REPLACE FUNCTION save_lesson_plan_periods(
  p_plan_id TEXT,
  p_periods JSONB
) RETURNS SETOF lesson_plan_periods
  LANGUAGE plpgsql
  SECURITY DEFINER
AS $$
BEGIN
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
