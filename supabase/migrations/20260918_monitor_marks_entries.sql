-- ============================================================================
-- Migration 20260918 — Monitor Marks Entries
-- ============================================================================
-- Derived monitoring view for the "Monitor Marks Entries" admin/supervisor
-- feature. It answers, for a selected exam period (academic term + month) and
-- exam type, "which teacher/class/subject mark-entry assignments are complete,
-- in progress, or not started?" — mirroring how Lesson Plan Submission tracking
-- starts from the EXPECTED roster rather than from the data rows.
--
-- Design rules (all reused from existing application behaviour):
--   * The roster of expected entries comes from class_subjects
--     (teacher -> class -> subject). A teacher is only responsible for a
--     class/subject they are actually assigned to — NOT merely because they
--     have a teacher account.
--   * The expected students for a class are the students currently in that
--     class. Students who have officially LEFT the school
--     (students.transport = 'LEFT', see 20260802_mark_student_left.sql) are
--     excluded, so withdrawn/transferred-out students never inflate the
--     denominator.
--   * Marks are read from the existing exams table — no new "mark uploads"
--     table is created. This is a derived read only.
--   * The app's required monthly entry rule is preserved for examType =
--     'Monthly': Coursework is satisfied by CA for every student OR by both
--     Homework and Classwork for every student, and Quiz is always required.
--     Selecting a specific exam type (Midterm, Final, CA, ...) tracks that
--     single type instead.
--   * Teachers may only monitor their own assignments; admin/supervisor see
--     the whole school. Unknown roles see nothing. This mirrors the exams RLS
--     bridge (current_profile_id / current_profile_role).
--
-- The function returns ONE row per expected teacher/class/subject, so entries
-- with ZERO marks appear as 'not_started' instead of disappearing — exactly
-- like the lesson-plan tracker shows "Not Submitted".

CREATE OR REPLACE FUNCTION public.get_monitor_marks_entries(
  p_term_id TEXT DEFAULT NULL,
  p_month TEXT DEFAULT NULL,
  p_exam_type TEXT DEFAULT 'Monthly',
  p_teacher_id TEXT DEFAULT NULL,
  p_class_name TEXT DEFAULT NULL,
  p_subject_id TEXT DEFAULT NULL,
  p_status TEXT DEFAULT NULL
)
RETURNS TABLE (
  "teacherId" TEXT,
  "teacherName" TEXT,
  "className" TEXT,
  "subjectId" TEXT,
  "subjectName" TEXT,
  "academicYearId" TEXT,
  "termId" TEXT,
  "termName" TEXT,
  "month" TEXT,
  "examType" TEXT,
  "expectedStudents" BIGINT,
  "enteredStudents" BIGINT,
  "caEntered" BIGINT,
  "homeworkEntered" BIGINT,
  "classworkEntered" BIGINT,
  "quizEntered" BIGINT,
  "attendanceEntered" BIGINT,
  "midtermEntered" BIGINT,
  "finalEntered" BIGINT,
  "completionPercent" NUMERIC,
  "status" TEXT,
  "lastUpdate" TIMESTAMPTZ
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_role TEXT := public.current_profile_role();
  v_my_id TEXT := public.current_profile_id();
  v_teacher_filter TEXT := p_teacher_id;
BEGIN
  -- Access control: only staff roles may monitor; teachers are scoped to
  -- their own assignments. Everyone else (parents, unknown) sees nothing.
  IF v_role IS NULL OR v_role NOT IN ('admin', 'supervisor', 'teacher') THEN
    RETURN;
  END IF;
  IF v_role = 'teacher' THEN
    v_teacher_filter := v_my_id;
  END IF;

  RETURN QUERY
  WITH term_ctx AS (
    SELECT t.id AS t_id, t.name AS t_name, t."academicYearId" AS t_ay
    FROM public.terms t
    WHERE t.id = p_term_id
  ),
  -- Expected roster: every (teacher, class, subject) assignment paired with
  -- each active student in that class. This is the accountability baseline.
  expected AS (
    SELECT
      cs."teacherId" AS teacher_id,
      u.name AS teacher_name,
      cs."className" AS class_name,
      cs."subjectId" AS subject_id,
      sub.name AS subject_name,
      s.id AS student_id
    FROM public.class_subjects cs
    JOIN public.profiles u ON u.id = cs."teacherId"
    JOIN public.subjects sub ON sub.id = cs."subjectId"
    JOIN public.students s ON s."className" = cs."className"
    WHERE (s.transport IS NULL OR s.transport <> 'LEFT')
      AND (v_teacher_filter IS NULL OR cs."teacherId" = v_teacher_filter)
      AND (p_class_name IS NULL OR cs."className" = p_class_name)
      AND (p_subject_id IS NULL OR cs."subjectId" = p_subject_id)
  ),
  -- Scope exams for the selected period + exam type, matched to the teacher
  -- and subject. Subject match accepts either subjectId or the subject name,
  -- exactly like the existing teacher_exam_progress view.
  scoped AS (
    SELECT
      e."studentId" AS student_id,
      e."teacherId" AS teacher_id,
      e."subjectId" AS subject_id,
      e.subject AS subject_text,
      e."examType" AS exam_type,
      e."createdAt" AS created_at
    FROM public.exams e
    WHERE (p_term_id IS NULL OR e."termId" = p_term_id)
      AND (p_month IS NULL OR e.month = p_month)
      AND (p_exam_type = 'Monthly' OR e."examType" = p_exam_type)
  ),
  -- Per-student entered flags within each (teacher, class, subject).
  per_student AS (
    SELECT
      ex.teacher_id, ex.teacher_name, ex.class_name, ex.subject_id, ex.subject_name, ex.student_id,
      bool_or(scoped.exam_type = 'CA') AS has_ca,
      bool_or(scoped.exam_type = 'Homework') AS has_hw,
      bool_or(scoped.exam_type = 'Classwork') AS has_cw,
      bool_or(scoped.exam_type = 'Quiz') AS has_quiz,
      bool_or(scoped.exam_type = 'Midterm') AS has_mid,
      bool_or(scoped.exam_type = 'Final') AS has_final,
      bool_or(scoped.exam_type = 'Attendance') AS has_att,
      max(scoped.created_at) AS last_update
    FROM expected ex
    LEFT JOIN scoped
      ON scoped.student_id = ex.student_id
     AND scoped.teacher_id = ex.teacher_id
     AND (scoped.subject_id = ex.subject_id OR scoped.subject_text = ex.subject_name)
    GROUP BY ex.teacher_id, ex.teacher_name, ex.class_name, ex.subject_id, ex.subject_name, ex.student_id
  ),
  -- Whether each student counts as "entered" for the selected exam type.
  with_entered AS (
    SELECT
      ps.teacher_id, ps.teacher_name, ps.class_name, ps.subject_id, ps.subject_name,
      ps.has_ca, ps.has_hw, ps.has_cw, ps.has_quiz, ps.has_mid, ps.has_final, ps.has_att,
      ps.last_update,
      CASE
        WHEN p_exam_type = 'Monthly' THEN (ps.has_ca OR (ps.has_hw AND ps.has_cw)) AND ps.has_quiz
        WHEN p_exam_type = 'Midterm' THEN ps.has_mid
        WHEN p_exam_type = 'Final' THEN ps.has_final
        WHEN p_exam_type = 'Attendance' THEN ps.has_att
        WHEN p_exam_type = 'CA' THEN ps.has_ca
        WHEN p_exam_type = 'Homework' THEN ps.has_hw
        WHEN p_exam_type = 'Classwork' THEN ps.has_cw
        WHEN p_exam_type = 'Quiz' THEN ps.has_quiz
        ELSE ps.has_ca OR ps.has_hw OR ps.has_cw OR ps.has_quiz OR ps.has_mid OR ps.has_final OR ps.has_att
      END AS entered
    FROM per_student ps
  ),
  -- Aggregate to one row per (teacher, class, subject).
  grouped AS (
    SELECT
      we.teacher_id, we.teacher_name, we.class_name, we.subject_id, we.subject_name,
      count(*)::BIGINT AS expected_students,
      count(*) FILTER (WHERE we.entered)::BIGINT AS entered_students,
      count(*) FILTER (WHERE we.has_ca)::BIGINT AS ca_entered,
      count(*) FILTER (WHERE we.has_hw)::BIGINT AS homework_entered,
      count(*) FILTER (WHERE we.has_cw)::BIGINT AS classwork_entered,
      count(*) FILTER (WHERE we.has_quiz)::BIGINT AS quiz_entered,
      count(*) FILTER (WHERE we.has_att)::BIGINT AS attendance_entered,
      count(*) FILTER (WHERE we.has_mid)::BIGINT AS midterm_entered,
      count(*) FILTER (WHERE we.has_final)::BIGINT AS final_entered,
      max(we.last_update) AS last_update
    FROM with_entered we
    GROUP BY we.teacher_id, we.teacher_name, we.class_name, we.subject_id, we.subject_name
  ),
  -- Derive the three-state status and completion percentage.
  rated AS (
    SELECT
      g.*,
      CASE
        WHEN g.expected_students = 0 THEN 'not_started'
        WHEN g.entered_students >= g.expected_students THEN 'complete'
        WHEN g.entered_students > 0 THEN 'in_progress'
        ELSE 'not_started'
      END AS status,
      CASE
        WHEN g.expected_students > 0
          THEN round(100.0 * g.entered_students / g.expected_students, 2)
        ELSE 0
      END AS completion_percent
    FROM grouped g
  )
  SELECT
    r.teacher_id AS "teacherId",
    r.teacher_name AS "teacherName",
    r.class_name AS "className",
    r.subject_id AS "subjectId",
    r.subject_name AS "subjectName",
    tc.t_ay AS "academicYearId",
    tc.t_id AS "termId",
    tc.t_name AS "termName",
    p_month AS "month",
    p_exam_type AS "examType",
    r.expected_students AS "expectedStudents",
    r.entered_students AS "enteredStudents",
    r.ca_entered AS "caEntered",
    r.homework_entered AS "homeworkEntered",
    r.classwork_entered AS "classworkEntered",
    r.quiz_entered AS "quizEntered",
    r.attendance_entered AS "attendanceEntered",
    r.midterm_entered AS "midtermEntered",
    r.final_entered AS "finalEntered",
    r.completion_percent AS "completionPercent",
    r.status AS "status",
    r.last_update AS "lastUpdate"
  FROM rated r
  LEFT JOIN term_ctx tc ON true
  WHERE (p_status IS NULL OR p_status = '' OR r.status = p_status)
  ORDER BY r.class_name, r.subject_name, r.teacher_name;
END;
$$;

REVOKE ALL ON FUNCTION public.get_monitor_marks_entries(
  TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT
) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_monitor_marks_entries(
  TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT
) TO authenticated;
