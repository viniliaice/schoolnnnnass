-- ============================================================================
-- Migration 20260919c — marks monitor: Homework (CA) tile includes legacy CA
-- ============================================================================
-- Entry Details shows the monthly coursework as "Homework (CA)". 20260919b
-- left that tile reading homework_entered only, while the monthly completion
-- rule (coursework = CA for every student OR Homework + Classwork for every
-- student; Quiz for every student) and the blended percentage both honour
-- legacy examType = 'CA' records. Manual marks entry (UploadResults) still
-- writes examType = 'CA' — it is the default type in that form — so a month
-- entered manually as CA + Quiz showed "Complete · 100%" next to
-- "Homework (CA) 0/N": the coursework that made the row complete was
-- invisible in the only coursework tile.
--
-- This migration adds ONE derived column: homework_ca_entered = students with
-- a Homework record OR a legacy CA record — the Homework (CA) component shown
-- in Entry Details. It is a per-student flag union, so a student with both
-- record types is counted once (never double-counted), and homework rows are
-- never recounted through ca_entered. Nothing else changes: ca_entered,
-- homework_entered, the completion rule, the blended percentage, the scopes,
-- the role check, the supervisor assigned-class boundary, term/month scoping,
-- roster and subject-ID matching are identical to 20260919b (which in turn
-- only changed the monthly/quiz MT predicates of 20260919).
--
-- get_monthly_report (20260913) is untouched: there the CA component already
-- folds CA, Homework, Classwork and Attendance records into one average, so
-- legacy CA records have always been part of the reported CA component.

DROP FUNCTION IF EXISTS public.monitor_marks_entries(TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT);

CREATE OR REPLACE FUNCTION public.monitor_marks_entries(
  p_academic_year_id TEXT,
  p_term_id TEXT,
  p_exam_scope TEXT DEFAULT 'monthly',
  p_month TEXT DEFAULT NULL,
  p_teacher_id TEXT DEFAULT NULL,
  p_class_name TEXT DEFAULT NULL,
  p_subject_id TEXT DEFAULT NULL
)
RETURNS TABLE (
  assignment_id TEXT,
  teacher_id TEXT,
  teacher_name TEXT,
  class_name TEXT,
  subject_id TEXT,
  subject_name TEXT,
  academic_year_id TEXT,
  term_id TEXT,
  exam_scope TEXT,
  month TEXT,
  expected_students INTEGER,
  entered_students INTEGER,
  missing_students JSONB,
  percentage NUMERIC,
  completion_status TEXT,
  last_updated TIMESTAMPTZ,
  ca_entered INTEGER,
  homework_entered INTEGER,
  homework_ca_entered INTEGER,
  classwork_entered INTEGER,
  quiz_entered INTEGER,
  attendance_entered INTEGER,
  coursework_complete BOOLEAN,
  quiz_complete BOOLEAN,
  monthly_complete_students INTEGER
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_role TEXT := public.current_profile_role();
  v_scope TEXT := lower(NULLIF(btrim(COALESCE(p_exam_scope, '')), ''));
  v_month TEXT := NULLIF(btrim(COALESCE(p_month, '')), '');
  v_term_year_id TEXT;
  v_term_start DATE;
  v_term_end DATE;
BEGIN
  IF v_role IS NULL OR v_role NOT IN ('admin', 'supervisor') THEN
    RAISE EXCEPTION 'Only admins and supervisors may monitor marks entries.'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  IF NULLIF(btrim(COALESCE(p_academic_year_id, '')), '') IS NULL
     OR NULLIF(btrim(COALESCE(p_term_id, '')), '') IS NULL THEN
    RAISE EXCEPTION 'Academic year and term are required.'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  IF v_scope IS NULL OR v_scope NOT IN (
    'monthly', 'midterm', 'final', 'ca', 'homework', 'classwork',
    'quiz', 'attendance', 'discipline'
  ) THEN
    RAISE EXCEPTION 'Unsupported marks monitor exam scope: %.', p_exam_scope
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  SELECT t."academicYearId", t."startDate", t."endDate"
    INTO v_term_year_id, v_term_start, v_term_end
  FROM public.terms t
  WHERE t.id = p_term_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Term % does not exist.', p_term_id
      USING ERRCODE = 'no_data_found';
  END IF;

  IF v_term_year_id IS DISTINCT FROM p_academic_year_id
     OR NOT EXISTS (
       SELECT 1 FROM public.academic_years ay
       WHERE ay.id = p_academic_year_id
     ) THEN
    RAISE EXCEPTION 'Term % does not belong to academic year %.', p_term_id, p_academic_year_id
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  RETURN QUERY
  WITH assignments AS (
    SELECT
      cs.id AS assignment_id,
      cs."teacherId" AS teacher_id,
      p.name AS teacher_name,
      cs."className" AS class_name,
      cs."subjectId" AS subject_id,
      sub.name AS subject_name
    FROM public.class_subjects cs
    JOIN public.profiles p ON p.id = cs."teacherId"
    JOIN public.subjects sub ON sub.id = cs."subjectId"
    WHERE cs."teacherId" IS NOT NULL
      -- A teacher account with no class_subjects row is never expected.
      AND lower(btrim(COALESCE(p.role, ''))) = 'teacher'
      AND (p_teacher_id IS NULL OR cs."teacherId" = p_teacher_id)
      AND (p_class_name IS NULL OR cs."className" = p_class_name)
      AND (p_subject_id IS NULL OR cs."subjectId" = p_subject_id)
      -- Supervisors see only their assigned classes; admins see all.
      AND (
        v_role = 'admin'
        OR EXISTS (
          SELECT 1
          FROM public.profiles viewer
          CROSS JOIN LATERAL jsonb_array_elements_text(
            CASE
              WHEN jsonb_typeof(COALESCE(viewer."assignedClasses", '[]'::jsonb)) = 'array'
                THEN viewer."assignedClasses"
              ELSE '[]'::jsonb
            END
          ) assigned(class_name)
          WHERE viewer.id = public.current_profile_id()
            AND btrim(assigned.class_name) = cs."className"
        )
      )
  ),
  -- The historical helper is the roster authority. The LEFT check uses
  -- to_jsonb so this migration remains safe for old databases that predate
  -- the transport column while still applying the production LEFT rule.
  eligible_roster AS (
    SELECT DISTINCT
      a.assignment_id,
      a.teacher_id,
      a.teacher_name,
      a.class_name,
      a.subject_id,
      a.subject_name,
      s.id AS student_id,
      s.name AS student_name
    FROM assignments a
    JOIN LATERAL public.class_students_for_term(a.class_name, p_term_id) term_roster
      ON TRUE
    JOIN public.students s ON s.id = term_roster.student_id
    WHERE upper(COALESCE(to_jsonb(s) ->> 'transport', '')) <> 'LEFT'
  ),
  scoped_exams AS (
    SELECT DISTINCT
      r.assignment_id,
      r.student_id,
      e."examType" AS exam_type,
      e."assessmentLabel" AS assessment_label,
      e."createdAt" AS created_at
    FROM eligible_roster r
    JOIN assignments a ON a.assignment_id = r.assignment_id
    JOIN public.exams e
      ON e."studentId" = r.student_id
     AND e."teacherId" = a.teacher_id
     AND (
       e."subjectId" = a.subject_id
       OR e.subject = a.subject_id
       OR e.subject = a.subject_name
     )
    WHERE (
      e."termId" = p_term_id
      OR (
        e."termId" IS NULL
        AND e.date >= v_term_start
        AND e.date <= v_term_end
      )
    )
      AND (v_month IS NULL OR e.month = v_month)
      AND (
        -- Monthly follows the existing coursework + quiz workflow. Every Quiz
        -- row is the monthly Quiz component, including bulk-uploaded monthly
        -- tests stored as assessmentLabel = 'MT' (same rule as
        -- get_monthly_report and teacher_exam_progress).
        (v_scope = 'monthly' AND e."examType" IN ('CA', 'Homework', 'Classwork', 'Quiz', 'Attendance'))
        -- Midterm is unchanged: explicit Midterm rows plus Quiz/MT rows,
        -- exactly as get_midterm_report reads them.
        OR (v_scope = 'midterm' AND (
          e."examType" = 'Midterm'
          OR (e."examType" = 'Quiz' AND COALESCE(NULLIF(e."assessmentLabel", ''), '') = 'MT')
        ))
        OR (v_scope = 'final' AND e."examType" = 'Final')
        OR (v_scope = 'ca' AND e."examType" = 'CA')
        OR (v_scope = 'homework' AND e."examType" = 'Homework')
        OR (v_scope = 'classwork' AND e."examType" = 'Classwork')
        OR (v_scope = 'quiz' AND e."examType" = 'Quiz')
        OR (v_scope = 'attendance' AND e."examType" = 'Attendance')
        OR (v_scope = 'discipline' AND e."examType" = 'Discipline')
      )
  ),
  student_flags AS (
    SELECT
      r.assignment_id,
      r.teacher_id,
      r.teacher_name,
      r.class_name,
      r.subject_id,
      r.subject_name,
      r.student_id,
      r.student_name,
      COALESCE(bool_or(se.exam_type = 'CA'), FALSE) AS ca_present,
      COALESCE(bool_or(se.exam_type = 'Homework'), FALSE) AS homework_present,
      COALESCE(bool_or(se.exam_type = 'Classwork'), FALSE) AS classwork_present,
      COALESCE(bool_or(se.exam_type = 'Quiz'), FALSE) AS quiz_present,
      COALESCE(bool_or(se.exam_type = 'Attendance'), FALSE) AS attendance_present,
      COALESCE(bool_or(se.exam_type = 'Discipline'), FALSE) AS discipline_present,
      COALESCE(bool_or(se.student_id IS NOT NULL), FALSE) AS any_entry,
      MAX(se.created_at) AS last_updated
    FROM eligible_roster r
    LEFT JOIN scoped_exams se
      ON se.assignment_id = r.assignment_id
     AND se.student_id = r.student_id
    GROUP BY
      r.assignment_id, r.teacher_id, r.teacher_name, r.class_name,
      r.subject_id, r.subject_name, r.student_id, r.student_name
  ),
  evaluated_students AS (
    SELECT
      sf.*,
      (
        CASE
          WHEN v_scope = 'monthly'
            THEN ((sf.ca_present OR (sf.homework_present AND sf.classwork_present))
              AND sf.quiz_present)
          ELSE sf.any_entry
        END
      ) AS entry_complete,
      (sf.ca_present OR (sf.homework_present AND sf.classwork_present)) AS coursework_complete_for_student
    FROM student_flags sf
  ),
  counts AS (
    SELECT
      a.assignment_id,
      a.teacher_id,
      a.teacher_name,
      a.class_name,
      a.subject_id,
      a.subject_name,
      COUNT(es.student_id)::INTEGER AS expected_students,
      COUNT(es.student_id) FILTER (WHERE es.entry_complete)::INTEGER AS entered_students,
      COUNT(es.student_id) FILTER (WHERE es.ca_present)::INTEGER AS ca_entered,
      COUNT(es.student_id) FILTER (WHERE es.homework_present)::INTEGER AS homework_entered,
      -- Homework (CA) tile: students with a Homework record or a legacy CA
      -- record (the same component). Per-student union, so a student with both
      -- is counted once. Not used by the completion rule or the percentage,
      -- which keep their existing definitions.
      COUNT(es.student_id) FILTER (WHERE es.ca_present OR es.homework_present)::INTEGER AS homework_ca_entered,
      COUNT(es.student_id) FILTER (WHERE es.classwork_present)::INTEGER AS classwork_entered,
      COUNT(es.student_id) FILTER (WHERE es.quiz_present)::INTEGER AS quiz_entered,
      COUNT(es.student_id) FILTER (WHERE es.attendance_present)::INTEGER AS attendance_entered,
      COUNT(es.student_id) FILTER (WHERE es.entry_complete)::INTEGER AS monthly_complete_students,
      COUNT(es.student_id) FILTER (WHERE es.coursework_complete_for_student)::INTEGER AS coursework_students,
      MAX(es.last_updated) AS last_updated
    FROM assignments a
    LEFT JOIN evaluated_students es ON es.assignment_id = a.assignment_id
    GROUP BY a.assignment_id, a.teacher_id, a.teacher_name, a.class_name, a.subject_id, a.subject_name
  ),
  missing AS (
    SELECT
      es.assignment_id,
      COALESCE(
        jsonb_agg(
          jsonb_build_object('id', es.student_id, 'name', es.student_name)
          ORDER BY es.student_name, es.student_id
        ) FILTER (WHERE NOT es.entry_complete),
        '[]'::jsonb
      ) AS missing_students
    FROM evaluated_students es
    GROUP BY es.assignment_id
  ),
  derived AS (
    SELECT
      c.*,
      CASE
        WHEN c.expected_students = 0 THEN 0::NUMERIC
        WHEN v_scope = 'monthly' THEN ROUND(
          100.0 * (
            GREATEST(
              LEAST(c.ca_entered::NUMERIC / c.expected_students, 1),
              (
                LEAST(c.homework_entered::NUMERIC / c.expected_students, 1)
                + LEAST(c.classwork_entered::NUMERIC / c.expected_students, 1)
              ) / 2.0
            )
            + LEAST(c.quiz_entered::NUMERIC / c.expected_students, 1)
          ) / 2.0,
          2
        )
        ELSE ROUND(100.0 * c.entered_students / c.expected_students, 2)
      END AS percentage,
      (c.expected_students > 0 AND (
        c.ca_entered >= c.expected_students
        OR (c.homework_entered >= c.expected_students AND c.classwork_entered >= c.expected_students)
      )) AS coursework_complete,
      (c.expected_students > 0 AND c.quiz_entered >= c.expected_students) AS quiz_complete
    FROM counts c
  )
  SELECT
    d.assignment_id,
    d.teacher_id,
    d.teacher_name,
    d.class_name,
    d.subject_id,
    d.subject_name,
    p_academic_year_id,
    p_term_id,
    v_scope,
    v_month,
    d.expected_students,
    d.entered_students,
    COALESCE(m.missing_students, '[]'::jsonb),
    d.percentage,
    CASE
      WHEN d.expected_students = 0 THEN 'not_started'
      WHEN v_scope = 'monthly' AND d.coursework_complete AND d.quiz_complete THEN 'complete'
      WHEN v_scope <> 'monthly' AND d.entered_students >= d.expected_students THEN 'complete'
      WHEN d.percentage > 0 OR d.ca_entered > 0 OR d.homework_entered > 0
        OR d.classwork_entered > 0 OR d.quiz_entered > 0
        OR d.attendance_entered > 0 THEN 'in_progress'
      ELSE 'not_started'
    END,
    d.last_updated,
    d.ca_entered,
    d.homework_entered,
    d.homework_ca_entered,
    d.classwork_entered,
    d.quiz_entered,
    d.attendance_entered,
    d.coursework_complete,
    d.quiz_complete,
    d.monthly_complete_students
  FROM derived d
  LEFT JOIN missing m ON m.assignment_id = d.assignment_id
  ORDER BY d.class_name, d.subject_name, d.teacher_name;
END;
$$;

COMMENT ON FUNCTION public.monitor_marks_entries(TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT) IS
  'Derived admin/supervisor marks-entry monitor. Expected rows come from class_subjects; rosters come from class_students_for_term; entered rows come from exams; every Quiz row (including bulk MT) is the monthly Quiz component; homework_ca_entered is the Homework (CA) tile count (Homework records plus legacy CA records, once per student); no duplicate marks data is stored.';

REVOKE ALL ON FUNCTION public.monitor_marks_entries(TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT) FROM PUBLIC;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    EXECUTE 'GRANT EXECUTE ON FUNCTION public.monitor_marks_entries(TEXT,TEXT,TEXT,TEXT,TEXT,TEXT,TEXT) TO authenticated';
  END IF;
END $$;
