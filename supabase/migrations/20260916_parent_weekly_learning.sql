-- Parent-safe weekly learning projection + lesson-plan RLS remediation.
-- Approved is the existing application's parent-publication contract for v1.

-- Authoritative, optional homework relationship. No class/subject/date guessing.
ALTER TABLE public.homework
  ADD COLUMN IF NOT EXISTS lesson_plan_period_id TEXT
  REFERENCES public.lesson_plan_periods(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_homework_lesson_plan_period
  ON public.homework (lesson_plan_period_id)
  WHERE lesson_plan_period_id IS NOT NULL;

-- The original migration used permissive USING (true) policies. Since Postgres
-- OR-combines permissive policies, those policies defeated the intended role
-- policies. Replace every lesson-plan table policy with explicit role checks.
DROP POLICY IF EXISTS "admin_all_plans" ON public.lesson_plans;
DROP POLICY IF EXISTS "teacher_manage_own_plans" ON public.lesson_plans;
DROP POLICY IF EXISTS "supervisor_select_all_plans" ON public.lesson_plans;
DROP POLICY IF EXISTS "lesson_plans_admin_all" ON public.lesson_plans;
DROP POLICY IF EXISTS "lesson_plans_teacher_own" ON public.lesson_plans;
DROP POLICY IF EXISTS "lesson_plans_supervisor_read" ON public.lesson_plans;

CREATE POLICY "lesson_plans_admin_all" ON public.lesson_plans
  FOR ALL TO authenticated
  USING (public.current_profile_role() = 'admin')
  WITH CHECK (public.current_profile_role() = 'admin');
CREATE POLICY "lesson_plans_teacher_own" ON public.lesson_plans
  FOR ALL TO authenticated
  USING (
    public.current_profile_role() = 'teacher'
    AND teacher_id = public.current_profile_id()
  )
  WITH CHECK (
    public.current_profile_role() = 'teacher'
    AND teacher_id = public.current_profile_id()
  );
CREATE POLICY "lesson_plans_supervisor_read" ON public.lesson_plans
  FOR SELECT TO authenticated
  USING (public.current_profile_role() = 'supervisor');

DROP POLICY IF EXISTS "admin_all_periods" ON public.lesson_plan_periods;
DROP POLICY IF EXISTS "teacher_manage_own_periods" ON public.lesson_plan_periods;
DROP POLICY IF EXISTS "supervisor_select_all_periods" ON public.lesson_plan_periods;
DROP POLICY IF EXISTS "lesson_plan_periods_admin_all" ON public.lesson_plan_periods;
DROP POLICY IF EXISTS "lesson_plan_periods_teacher_own" ON public.lesson_plan_periods;
DROP POLICY IF EXISTS "lesson_plan_periods_supervisor_read" ON public.lesson_plan_periods;

CREATE POLICY "lesson_plan_periods_admin_all" ON public.lesson_plan_periods
  FOR ALL TO authenticated
  USING (public.current_profile_role() = 'admin')
  WITH CHECK (public.current_profile_role() = 'admin');
CREATE POLICY "lesson_plan_periods_teacher_own" ON public.lesson_plan_periods
  FOR ALL TO authenticated
  USING (
    public.current_profile_role() = 'teacher'
    AND EXISTS (
      SELECT 1 FROM public.lesson_plans lp
      WHERE lp.id = plan_id AND lp.teacher_id = public.current_profile_id()
    )
  )
  WITH CHECK (
    public.current_profile_role() = 'teacher'
    AND EXISTS (
      SELECT 1 FROM public.lesson_plans lp
      WHERE lp.id = plan_id AND lp.teacher_id = public.current_profile_id()
    )
  );
CREATE POLICY "lesson_plan_periods_supervisor_read" ON public.lesson_plan_periods
  FOR SELECT TO authenticated
  USING (public.current_profile_role() = 'supervisor');

-- The same original defect existed on AI review/audit tables. Keep their
-- established staff/owner policies, but replace the role-blind admin policies.
DROP POLICY IF EXISTS "admin_all_reviews" ON public.ai_reviews;
DROP POLICY IF EXISTS "ai_reviews_admin_all" ON public.ai_reviews;
CREATE POLICY "ai_reviews_admin_all" ON public.ai_reviews
  FOR ALL TO authenticated
  USING (public.current_profile_role() = 'admin')
  WITH CHECK (public.current_profile_role() = 'admin');

DROP POLICY IF EXISTS "admin_all_ai_logs" ON public.ai_review_logs;
DROP POLICY IF EXISTS "ai_review_logs_admin_all" ON public.ai_review_logs;
CREATE POLICY "ai_review_logs_admin_all" ON public.ai_review_logs
  FOR ALL TO authenticated
  USING (public.current_profile_role() = 'admin')
  WITH CHECK (public.current_profile_role() = 'admin');

-- Parents intentionally receive no direct lesson_plans/lesson_plan_periods
-- policy. This function is the sole allowlisted parent boundary.
CREATE OR REPLACE FUNCTION public.get_parent_weekly_learning(
  p_student_id TEXT,
  p_week_label TEXT
) RETURNS TABLE (
  student_id TEXT,
  student_name TEXT,
  class_name TEXT,
  week_label TEXT,
  week_start DATE,
  week_end DATE,
  lesson_id TEXT,
  day TEXT,
  subject TEXT,
  topic TEXT,
  learning_objective TEXT,
  what_we_are_learning TEXT,
  resources JSONB,
  practice_title TEXT,
  practice_description TEXT,
  practice_due_date DATE
)
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_actor TEXT := public.current_profile_id();
  v_role TEXT := public.current_profile_role();
  v_student public.students%ROWTYPE;
  v_week_number INTEGER;
  v_year INTEGER;
  v_academic_start DATE;
  v_week_start DATE;
  v_week_end DATE;
  v_class TEXT;
BEGIN
  IF v_actor IS NULL OR v_role IS DISTINCT FROM 'parent' THEN
    RAISE EXCEPTION 'Parent access required.' USING ERRCODE = 'insufficient_privilege';
  END IF;

  -- Ownership is derived from the session. No parent/class value is accepted.
  SELECT * INTO v_student
  FROM public.students s
  WHERE s.id = p_student_id AND s."parentId" = v_actor;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Student not available.' USING ERRCODE = 'insufficient_privilege';
  END IF;

  IF p_week_label !~ '^\d{4}-W\d{2}$' THEN
    RAISE EXCEPTION 'Invalid week.' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  v_year := substring(p_week_label FROM 1 FOR 4)::INTEGER;
  v_week_number := substring(p_week_label FROM 7 FOR 2)::INTEGER;
  IF v_week_number < 1 OR v_week_number > 54 THEN
    RAISE EXCEPTION 'Invalid week.' USING ERRCODE = 'invalid_parameter_value';
  END IF;

  -- Labels are anchored to academic-year start (not ISO weeks).
  SELECT ay."startDate" INTO v_academic_start
  FROM public.academic_years ay
  WHERE EXTRACT(YEAR FROM ay."startDate")::INTEGER = v_year
  ORDER BY ay."isCurrent" DESC, ay."startDate" DESC
  LIMIT 1;
  IF v_academic_start IS NULL THEN
    RAISE EXCEPTION 'Week not available.' USING ERRCODE = 'invalid_parameter_value';
  END IF;

  v_week_start := v_academic_start + ((v_week_number - 1) * 7);
  v_week_end := v_week_start + 4; -- configured Saturday-Wednesday teaching week

  -- Resolve class for the requested historical week. Prefer the latest
  -- enrollment overlapping the teaching week; current class is only a fallback
  -- when no history exists for that student/week.
  SELECT e."className" INTO v_class
  FROM public.student_enrollments e
  WHERE e."studentId" = p_student_id
    AND e."effectiveFrom" <= v_week_end
    AND COALESCE(e."effectiveTo", DATE '9999-12-31') >= v_week_start
  ORDER BY e."effectiveFrom" DESC
  LIMIT 1;
  IF v_class IS NULL THEN
    -- Current class is a safe fallback only for legacy students with no ledger
    -- at all. A gap in an existing history must not leak the current class into
    -- a historical week.
    IF NOT EXISTS (
      SELECT 1 FROM public.student_enrollments e WHERE e."studentId" = p_student_id
    ) THEN
      v_class := v_student."className";
    ELSE
      RETURN;
    END IF;
  END IF;

  RETURN QUERY
  WITH eligible AS (
    SELECT
      lp.id AS plan_id,
      lpp.id AS period_id,
      lpp.day::TEXT AS lesson_day,
      COALESCE(NULLIF(BTRIM(lpp.subject), ''), NULLIF(BTRIM(su.name), ''), 'Learning') AS lesson_subject,
      BTRIM(lpp.topic) AS lesson_topic,
      NULLIF(BTRIM(lpp.objective), '') AS lesson_objective,
      COALESCE(
        NULLIF((SELECT string_agg(NULLIF(BTRIM(item->>'activity'), ''), ' · ')
                FROM jsonb_array_elements(COALESCE(lpp.details, '[]'::jsonb)) item), ''),
        NULLIF(BTRIM(lpp.activities), '')
      ) AS lesson_learning,
      COALESCE(
        (SELECT jsonb_agg(jsonb_build_object(
                  'label', NULLIF(BTRIM(item->>'resource'), ''),
                  'url', CASE
                    WHEN BTRIM(COALESCE(item->>'place', '')) ~* '^https://'
                    THEN BTRIM(item->>'place') ELSE NULL END
                ))
         FROM jsonb_array_elements(COALESCE(lpp.details, '[]'::jsonb)) item
         WHERE NULLIF(BTRIM(item->>'resource'), '') IS NOT NULL
            OR BTRIM(COALESCE(item->>'place', '')) ~* '^https://'),
        '[]'::jsonb
      ) AS lesson_resources,
      ROW_NUMBER() OVER (
        PARTITION BY lpp.day, lpp.period_number, COALESCE(NULLIF(BTRIM(lpp.subject), ''), su.name)
        ORDER BY lp.updated_at DESC, lp.id DESC
      ) AS slot_rank
    FROM public.lesson_plans lp
    JOIN public.lesson_plan_periods lpp ON lpp.plan_id = lp.id
    LEFT JOIN public.subjects su ON su.id = lp.subject_id
    WHERE lp.status = 'approved'
      AND lp.week_label = p_week_label
      AND lp.class_name = v_class
      AND COALESCE(lpp.is_free, false) = false
      AND (lpp.class_name IS NULL OR lpp.class_name = v_class)
  )
  SELECT
    v_student.id,
    v_student.name,
    v_class,
    p_week_label,
    v_week_start,
    v_week_end,
    e.period_id,
    e.lesson_day,
    e.lesson_subject,
    e.lesson_topic,
    e.lesson_objective,
    e.lesson_learning,
    e.lesson_resources,
    h.title,
    h.description,
    h."dueDate"::DATE
  FROM eligible e
  LEFT JOIN LATERAL (
    SELECT hw.title, hw.description, hw."dueDate"
    FROM public.homework hw
    WHERE hw.lesson_plan_period_id = e.period_id
      AND hw."studentId" = v_student.id
    ORDER BY hw."createdAt" DESC
    LIMIT 1
  ) h ON true
  WHERE e.slot_rank = 1
  ORDER BY
    CASE e.lesson_day
      WHEN 'Saturday' THEN 1 WHEN 'Sunday' THEN 2 WHEN 'Monday' THEN 3
      WHEN 'Tuesday' THEN 4 WHEN 'Wednesday' THEN 5 ELSE 99 END,
    e.period_id;
END;
$$;

REVOKE ALL ON FUNCTION public.get_parent_weekly_learning(TEXT, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.get_parent_weekly_learning(TEXT, TEXT) FROM anon;
GRANT EXECUTE ON FUNCTION public.get_parent_weekly_learning(TEXT, TEXT) TO authenticated;
COMMENT ON FUNCTION public.get_parent_weekly_learning(TEXT, TEXT) IS
  'Parent-only allowlisted weekly lesson projection. Verifies session ownership, historical class, exact week, and approved publication; exposes no workflow or review metadata.';
