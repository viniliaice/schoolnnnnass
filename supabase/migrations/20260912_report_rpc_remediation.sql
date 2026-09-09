-- ============================================================================
-- Migration 20260912 — Report RPC remediation
-- ============================================================================
-- Fixes two audit gaps:
--   A1/A2 companion database work for reports.
--   * Adds repo-shipped get_monthly_report and get_final_report RPCs.
--   * Replaces get_midterm_report so uploaded MT rows stored as
--     examType='Quiz' + assessmentLabel='MT' are treated as Midterm.
--   * Preserves decimal / half-point fidelity by calculating percentages and
--     weighted totals with numeric math and explicit 2-decimal rounding.
--   * Uses historical class helpers class_for_term() / class_students_for_term()
--     so peer averages and ranks stay term-correct after class changes.
--   * Enforces explicit report access in SECURITY DEFINER functions.

CREATE OR REPLACE FUNCTION public.assert_can_view_student_term_report(
  p_student_id TEXT,
  p_term_id TEXT
) RETURNS VOID
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_role TEXT := public.current_profile_role();
  v_profile_id TEXT := public.current_profile_id();
  v_parent_id TEXT;
  v_class_name TEXT;
BEGIN
  IF p_student_id IS NULL OR btrim(p_student_id) = '' THEN
    RAISE EXCEPTION 'student_id is required' USING ERRCODE = 'invalid_parameter_value';
  END IF;

  IF p_term_id IS NULL OR btrim(p_term_id) = '' THEN
    RAISE EXCEPTION 'term_id is required' USING ERRCODE = 'invalid_parameter_value';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM public.terms t WHERE t.id = p_term_id) THEN
    RAISE EXCEPTION 'Term % does not exist.', p_term_id USING ERRCODE = 'no_data_found';
  END IF;

  SELECT s."parentId", public.class_for_term(s.id, p_term_id)
    INTO v_parent_id, v_class_name
  FROM public.students s
  WHERE s.id = p_student_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Student % does not exist.', p_student_id USING ERRCODE = 'no_data_found';
  END IF;

  IF v_role IN ('admin', 'supervisor', 'office') THEN
    RETURN;
  END IF;

  IF v_role = 'parent' AND v_parent_id = v_profile_id THEN
    RETURN;
  END IF;

  IF v_role = 'teacher' AND EXISTS (
    SELECT 1
    FROM public.class_subjects cs
    WHERE cs."className" = v_class_name
      AND cs."teacherId" = v_profile_id
  ) THEN
    RETURN;
  END IF;

  RAISE EXCEPTION 'You are not allowed to view reports for student %.', p_student_id
    USING ERRCODE = '42501';
END;
$$;

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
        AND COALESCE(NULLIF(e."assessmentLabel", ''), '') <> 'MT'
    ),
    grouped AS (
      SELECT
        s.subject,
        s.month,
        COALESCE(array_position(tc.months, s.month), 999) AS month_order,
        round(avg(s.percentage), 2) AS average,
        count(*)::INT AS assessment_count,
        jsonb_agg(
          jsonb_build_object(
            'type', s.assessment_type,
            'score', s.score,
            'total', s.total,
            'percentage', s.percentage,
            'date', s.date,
            'examId', s.exam_id
          )
          ORDER BY s.date, s.assessment_type, s.exam_id
        ) AS details
      FROM scored s
      CROSS JOIN term_context tc
      GROUP BY s.subject, s.month, month_order
    )
    SELECT COALESCE(
      jsonb_agg(
        jsonb_build_object(
          'subject', g.subject,
          'month', g.month,
          'average', g.average,
          'assessment_count', g.assessment_count,
          'details', g.details
        )
        ORDER BY g.month_order, g.subject
      ),
      '[]'::jsonb
    )
    FROM grouped g
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.get_midterm_report(
  p_student_id TEXT,
  p_term_id TEXT
) RETURNS JSONB
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_class_name TEXT;
BEGIN
  PERFORM public.assert_can_view_student_term_report(p_student_id, p_term_id);
  v_class_name := public.class_for_term(p_student_id, p_term_id);

  RETURN (
    WITH class_midterms AS (
      SELECT
        e.id,
        e."studentId" AS student_id,
        e.subject,
        e.score,
        e.total,
        round(((e.score::numeric / NULLIF(e.total::numeric, 0)) * 100), 2) AS percentage
      FROM public.exams e
      WHERE e."termId" = p_term_id
        AND e.status = 'approved'
        AND COALESCE(e."entryState", 'scored') = 'scored'
        AND e.score IS NOT NULL
        AND (
          e."examType" = 'Midterm'
          OR (e."examType" = 'Quiz' AND COALESCE(NULLIF(e."assessmentLabel", ''), '') = 'MT')
        )
        AND e."studentId" IN (
          SELECT student_id
          FROM public.class_students_for_term(v_class_name, p_term_id)
        )
    ),
    subject_scores AS (
      SELECT
        cm.id AS exam_id,
        cm.subject,
        cm.score,
        cm.total,
        cm.percentage,
        CASE
          WHEN cm.percentage >= 90 THEN 'A'
          WHEN cm.percentage >= 80 THEN 'B'
          WHEN cm.percentage >= 70 THEN 'C'
          WHEN cm.percentage >= 60 THEN 'D'
          ELSE 'F'
        END AS grade,
        CASE
          WHEN cm.percentage >= 90 THEN 'Excellent'
          WHEN cm.percentage >= 80 THEN 'Very Good'
          WHEN cm.percentage >= 70 THEN 'Good'
          WHEN cm.percentage >= 60 THEN 'Satisfactory'
          ELSE 'Needs Improvement'
        END AS remark,
        (
          SELECT count(*) + 1
          FROM class_midterms peers
          WHERE peers.subject = cm.subject
            AND peers.percentage > cm.percentage
        ) AS subject_rank,
        COALESCE((
          SELECT round(avg(peers.percentage), 2)
          FROM class_midterms peers
          WHERE peers.subject = cm.subject
        ), 0) AS class_average,
        COALESCE((
          SELECT round(max(peers.percentage), 2)
          FROM class_midterms peers
          WHERE peers.subject = cm.subject
        ), 0) AS highest_in_class
      FROM class_midterms cm
      WHERE cm.student_id = p_student_id
    ),
    student_averages AS (
      SELECT
        cm.student_id,
        round(avg(cm.percentage), 2) AS average_percentage
      FROM class_midterms cm
      GROUP BY cm.student_id
    ),
    target_average AS (
      SELECT COALESCE((
        SELECT sa.average_percentage
        FROM student_averages sa
        WHERE sa.student_id = p_student_id
      ), 0) AS average_percentage
    )
    SELECT jsonb_build_object(
      'scores', COALESCE((
        SELECT jsonb_agg(
          jsonb_build_object(
            'subject', ss.subject,
            'score', ss.score,
            'total', ss.total,
            'percentage', ss.percentage,
            'grade', ss.grade,
            'remark', ss.remark,
            'subject_rank', ss.subject_rank,
            'class_average', ss.class_average,
            'highest_in_class', ss.highest_in_class,
            'examId', ss.exam_id
          )
          ORDER BY ss.subject
        )
        FROM subject_scores ss
      ), '[]'::jsonb),
      'overall_rank', COALESCE((
        SELECT count(*) + 1
        FROM student_averages sa, target_average ta
        WHERE sa.average_percentage > ta.average_percentage
      ), 0),
      'total_students', (SELECT count(*) FROM student_averages)
    )
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.get_final_report(
  p_student_id TEXT,
  p_term_id TEXT
) RETURNS JSONB
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_class_name TEXT;
BEGIN
  PERFORM public.assert_can_view_student_term_report(p_student_id, p_term_id);
  v_class_name := public.class_for_term(p_student_id, p_term_id);

  RETURN (
    WITH cfg AS (
      SELECT
        COALESCE(rc."caWeight", 60)::numeric AS ca_weight,
        COALESCE(rc."midtermWeight", 20)::numeric AS midterm_weight,
        COALESCE(rc."finalWeight", 20)::numeric AS final_weight,
        COALESCE(rc."caTypes", ARRAY['CA', 'Homework', 'Classwork', 'Quiz', 'Attendance']) AS ca_types
      FROM public.report_config rc
      WHERE rc.id = 'default'
      UNION ALL
      SELECT 60::numeric, 20::numeric, 20::numeric, ARRAY['CA', 'Homework', 'Classwork', 'Quiz', 'Attendance']::TEXT[]
      WHERE NOT EXISTS (SELECT 1 FROM public.report_config WHERE id = 'default')
      LIMIT 1
    ),
    peer_students AS (
      SELECT student_id
      FROM public.class_students_for_term(v_class_name, p_term_id)
    ),
    ca_scores AS (
      SELECT
        e."studentId" AS student_id,
        e.subject,
        round(avg(((e.score::numeric / NULLIF(e.total::numeric, 0)) * 100)), 2) AS ca_avg
      FROM public.exams e
      CROSS JOIN cfg
      WHERE e."termId" = p_term_id
        AND e.status = 'approved'
        AND COALESCE(e."entryState", 'scored') = 'scored'
        AND e.score IS NOT NULL
        AND e."studentId" IN (SELECT student_id FROM peer_students)
        AND e."examType" = ANY(cfg.ca_types)
        AND COALESCE(NULLIF(e."assessmentLabel", ''), '') <> 'MT'
      GROUP BY e."studentId", e.subject
    ),
    midterm_scores AS (
      SELECT
        e."studentId" AS student_id,
        e.subject,
        round(avg(((e.score::numeric / NULLIF(e.total::numeric, 0)) * 100)), 2) AS midterm_score
      FROM public.exams e
      WHERE e."termId" = p_term_id
        AND e.status = 'approved'
        AND COALESCE(e."entryState", 'scored') = 'scored'
        AND e.score IS NOT NULL
        AND e."studentId" IN (SELECT student_id FROM peer_students)
        AND (
          e."examType" = 'Midterm'
          OR (e."examType" = 'Quiz' AND COALESCE(NULLIF(e."assessmentLabel", ''), '') = 'MT')
        )
      GROUP BY e."studentId", e.subject
    ),
    final_scores AS (
      SELECT
        e."studentId" AS student_id,
        e.subject,
        round(avg(((e.score::numeric / NULLIF(e.total::numeric, 0)) * 100)), 2) AS final_score
      FROM public.exams e
      WHERE e."termId" = p_term_id
        AND e.status = 'approved'
        AND COALESCE(e."entryState", 'scored') = 'scored'
        AND e.score IS NOT NULL
        AND e."studentId" IN (SELECT student_id FROM peer_students)
        AND e."examType" = 'Final'
      GROUP BY e."studentId", e.subject
    ),
    subject_union AS (
      SELECT student_id, subject FROM ca_scores
      UNION
      SELECT student_id, subject FROM midterm_scores
      UNION
      SELECT student_id, subject FROM final_scores
    ),
    subject_totals AS (
      SELECT
        su.student_id,
        su.subject,
        COALESCE(ca.ca_avg, 0) AS ca_avg,
        round(COALESCE(ca.ca_avg, 0) * cfg.ca_weight / 100.0, 2) AS ca_weighted,
        COALESCE(mt.midterm_score, 0) AS midterm_score,
        round(COALESCE(mt.midterm_score, 0) * cfg.midterm_weight / 100.0, 2) AS midterm_weighted,
        COALESCE(fs.final_score, 0) AS final_score,
        round(COALESCE(fs.final_score, 0) * cfg.final_weight / 100.0, 2) AS final_weighted,
        round(
          round(COALESCE(ca.ca_avg, 0) * cfg.ca_weight / 100.0, 2)
          + round(COALESCE(mt.midterm_score, 0) * cfg.midterm_weight / 100.0, 2)
          + round(COALESCE(fs.final_score, 0) * cfg.final_weight / 100.0, 2),
          2
        ) AS total
      FROM subject_union su
      LEFT JOIN ca_scores ca
        ON ca.student_id = su.student_id
       AND ca.subject = su.subject
      LEFT JOIN midterm_scores mt
        ON mt.student_id = su.student_id
       AND mt.subject = su.subject
      LEFT JOIN final_scores fs
        ON fs.student_id = su.student_id
       AND fs.subject = su.subject
      CROSS JOIN cfg
    ),
    student_averages AS (
      SELECT
        st.student_id,
        round(avg(st.total), 2) AS average_total
      FROM subject_totals st
      GROUP BY st.student_id
    ),
    target_average AS (
      SELECT COALESCE((
        SELECT sa.average_total
        FROM student_averages sa
        WHERE sa.student_id = p_student_id
      ), 0) AS average_total
    ),
    latest_comment AS (
      SELECT
        COALESCE(rc."teacherComment", '') AS teacher_comment,
        COALESCE(rc."principalComment", '') AS principal_comment
      FROM public.report_comments rc
      WHERE rc."studentId" = p_student_id
        AND rc."termId" = p_term_id
        AND rc."examId" IS NULL
      ORDER BY rc."createdAt" DESC, rc.id DESC
      LIMIT 1
    )
    SELECT jsonb_build_object(
      'weights', jsonb_build_object(
        'ca', cfg.ca_weight,
        'midterm', cfg.midterm_weight,
        'final', cfg.final_weight
      ),
      'results', COALESCE((
        SELECT jsonb_agg(
          jsonb_build_object(
            'subject', st.subject,
            'ca_avg', st.ca_avg,
            'ca_weighted', st.ca_weighted,
            'midterm_score', st.midterm_score,
            'midterm_weighted', st.midterm_weighted,
            'final_score', st.final_score,
            'final_weighted', st.final_weighted,
            'total', st.total
          )
          ORDER BY st.subject
        )
        FROM subject_totals st
        WHERE st.student_id = p_student_id
      ), '[]'::jsonb),
      'overall_rank', COALESCE((
        SELECT count(*) + 1
        FROM student_averages sa, target_average ta
        WHERE sa.average_total > ta.average_total
      ), 0),
      'total_students', (SELECT count(*) FROM student_averages),
      'comment', jsonb_build_object(
        'teacher', COALESCE((SELECT lc.teacher_comment FROM latest_comment lc), ''),
        'principal', COALESCE((SELECT lc.principal_comment FROM latest_comment lc), '')
      )
    )
    FROM cfg
  );
END;
$$;

REVOKE ALL ON FUNCTION public.assert_can_view_student_term_report(TEXT, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.assert_can_view_student_term_report(TEXT, TEXT) TO authenticated;

REVOKE ALL ON FUNCTION public.get_monthly_report(TEXT, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_monthly_report(TEXT, TEXT) TO authenticated;

REVOKE ALL ON FUNCTION public.get_midterm_report(TEXT, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_midterm_report(TEXT, TEXT) TO authenticated;

REVOKE ALL ON FUNCTION public.get_final_report(TEXT, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_final_report(TEXT, TEXT) TO authenticated;
