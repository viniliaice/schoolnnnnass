-- ============================================================================
-- Migration 20260913 — Monthly report CA 40% / Quiz 60%
-- ============================================================================
-- Monthly reports previously averaged every CA-type assessment (CA, Homework,
-- Classwork, Quiz, Attendance) into a single number, and additionally dropped
-- bulk-uploaded Quiz rows stored as examType='Quiz' + assessmentLabel='MT'
-- because those rows were reserved for Midterm.
--
-- That is why Quiz marks did not appear as a first-class Monthly component:
-- Quiz was either mixed into the CA average or excluded entirely (MT).
--
-- Monthly formula (hard-coded; NOT report_config / Midterm / Final weights):
--   Monthly Score = (CA Average × 0.40) + (Quiz Average × 0.60)
--
-- CA component  = examType IN ('CA', 'Homework', 'Classwork', 'Attendance')
-- Quiz component = examType = 'Quiz'  (including assessmentLabel = 'MT')
--
-- Missing CA or missing Quiz is returned as JSON null — never coerced to 0.
-- A recorded Quiz score of 0 remains 0.
--
-- Midterm (get_midterm_report) and Final (get_final_report) are NOT changed.

DROP FUNCTION IF EXISTS public.get_monthly_report(TEXT, TEXT);

CREATE OR REPLACE FUNCTION public.get_monthly_report(
  p_student_id TEXT,
  p_term_id TEXT
) RETURNS JSONB
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  PERFORM public.assert_can_view_student_term_report(p_student_id, p_term_id);

  RETURN (
    WITH term_context AS (
      SELECT t.months
      FROM public.terms t
      WHERE t.id = p_term_id
    ),
    scored AS (
      SELECT
        e.id AS exam_id,
        e.subject,
        e.month,
        e."examType" AS exam_type,
        COALESCE(NULLIF(e."assessmentLabel", ''), e."examType") AS assessment_type,
        e.score,
        e.total,
        e.date,
        round(((e.score::numeric / NULLIF(e.total::numeric, 0)) * 100), 2) AS percentage
      FROM public.exams e
      WHERE e."studentId" = p_student_id
        AND e."termId" = p_term_id
        AND e.status = 'approved'
        AND COALESCE(e."entryState", 'scored') = 'scored'
        AND e.score IS NOT NULL
        AND e."examType" IN ('CA', 'Homework', 'Classwork', 'Quiz', 'Attendance')
    ),
    ca_grouped AS (
      SELECT
        s.subject,
        s.month,
        round(avg(s.percentage), 2) AS ca_avg,
        count(*)::INT AS ca_count,
        jsonb_agg(
          jsonb_build_object(
            'type', s.assessment_type,
            'examType', s.exam_type,
            'score', s.score,
            'total', s.total,
            'percentage', s.percentage,
            'date', s.date,
            'examId', s.exam_id
          )
          ORDER BY s.date, s.assessment_type, s.exam_id
        ) AS ca_details
      FROM scored s
      WHERE s.exam_type IN ('CA', 'Homework', 'Classwork', 'Attendance')
      GROUP BY s.subject, s.month
    ),
    quiz_grouped AS (
      SELECT
        s.subject,
        s.month,
        round(avg(s.percentage), 2) AS quiz_avg,
        count(*)::INT AS quiz_count,
        jsonb_agg(
          jsonb_build_object(
            'type', s.assessment_type,
            'examType', s.exam_type,
            'score', s.score,
            'total', s.total,
            'percentage', s.percentage,
            'date', s.date,
            'examId', s.exam_id
          )
          ORDER BY s.date, s.assessment_type, s.exam_id
        ) AS quiz_details
      FROM scored s
      WHERE s.exam_type = 'Quiz'
      GROUP BY s.subject, s.month
    ),
    subject_months AS (
      SELECT subject, month FROM ca_grouped
      UNION
      SELECT subject, month FROM quiz_grouped
    ),
    assembled AS (
      SELECT
        sm.subject,
        sm.month,
        COALESCE(array_position(tc.months, sm.month), 999) AS month_order,
        ca.ca_avg,
        q.quiz_avg,
        40::numeric AS ca_weight,
        60::numeric AS quiz_weight,
        CASE WHEN ca.ca_avg IS NULL THEN NULL ELSE round(ca.ca_avg * 0.40, 2) END AS ca_weighted,
        CASE WHEN q.quiz_avg IS NULL THEN NULL ELSE round(q.quiz_avg * 0.60, 2) END AS quiz_weighted,
        CASE
          WHEN ca.ca_avg IS NOT NULL AND q.quiz_avg IS NOT NULL
            THEN round(ca.ca_avg * 0.40 + q.quiz_avg * 0.60, 2)
          ELSE NULL
        END AS average,
        COALESCE(ca.ca_count, 0) AS ca_count,
        COALESCE(q.quiz_count, 0) AS quiz_count,
        COALESCE(ca.ca_count, 0) + COALESCE(q.quiz_count, 0) AS assessment_count,
        COALESCE(ca.ca_details, '[]'::jsonb) AS ca_details,
        COALESCE(q.quiz_details, '[]'::jsonb) AS quiz_details
      FROM subject_months sm
      CROSS JOIN term_context tc
      LEFT JOIN ca_grouped ca
        ON ca.subject = sm.subject AND ca.month = sm.month
      LEFT JOIN quiz_grouped q
        ON q.subject = sm.subject AND q.month = sm.month
    )
    SELECT COALESCE(
      jsonb_agg(
        jsonb_build_object(
          'subject', a.subject,
          'month', a.month,
          'average', a.average,
          'assessment_count', a.assessment_count,
          'details', a.ca_details || a.quiz_details,
          'ca_avg', a.ca_avg,
          'quiz_avg', a.quiz_avg,
          'ca_weight', a.ca_weight,
          'quiz_weight', a.quiz_weight,
          'ca_weighted', a.ca_weighted,
          'quiz_weighted', a.quiz_weighted,
          'grade', CASE
            WHEN a.average IS NULL THEN NULL
            WHEN a.average >= 90 THEN 'A'
            WHEN a.average >= 80 THEN 'B'
            WHEN a.average >= 70 THEN 'C'
            WHEN a.average >= 60 THEN 'D'
            ELSE 'F'
          END,
          'remark', CASE
            WHEN a.average IS NULL THEN NULL
            WHEN a.average >= 90 THEN 'Excellent'
            WHEN a.average >= 80 THEN 'Very Good'
            WHEN a.average >= 70 THEN 'Good'
            WHEN a.average >= 60 THEN 'Satisfactory'
            ELSE 'Needs Improvement'
          END,
          'ca_count', a.ca_count,
          'quiz_count', a.quiz_count,
          'ca_details', a.ca_details,
          'quiz_details', a.quiz_details
        )
        ORDER BY a.month_order, a.subject
      ),
      '[]'::jsonb
    )
    FROM assembled a
  );
END;
$$;

REVOKE ALL ON FUNCTION public.get_monthly_report(TEXT, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_monthly_report(TEXT, TEXT) TO authenticated;
