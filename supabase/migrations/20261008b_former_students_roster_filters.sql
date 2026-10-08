-- ============================================================================
-- Migration 20261008b — Former Students: "current students" means ACTIVE
-- ============================================================================
-- Companion to 20261008_former_students_cleanup.sql, which adds
-- students.status ('active' | 'former').
--
-- These two derived, CURRENT-state surfaces are recreated verbatim from their
-- shipped definitions with ONE added predicate each, so a student marked as a
-- Former Student stops inflating them:
--
--   * teacher_exam_progress (view) — the supervisor/admin "Monitor Teacher"
--     denominator. A leaver is no longer counted as a missing CA/Quiz entry
--     against the teacher who used to teach them.
--   * get_class_student_subject_progress() — the Class Progress grid for a
--     class + month, same reasoning.
--
-- Deliberately NOT changed (historical surfaces that must keep leavers):
--   * class_students_for_term() / get_midterm_report() / get_final_report() /
--     get_monthly_report() — these resolve the peer group from
--     student_enrollments for the TERM being reported, so a report issued for a
--     term a leaver attended still ranks and averages them. That is correct
--     history, not stale data.
--   * monitor_marks_entries() — it reads its roster through
--     class_students_for_term() (historical, term-scoped) and therefore keeps
--     the same semantics as the reports.
--
-- No data is modified. Idempotent (CREATE OR REPLACE).
-- ============================================================================

-- ─── 1. teacher_exam_progress: exclude Former Students from the denominator ─
CREATE OR REPLACE VIEW teacher_exam_progress AS
WITH class_subject_students AS (
  SELECT
    cs."teacherId" AS teacher_id,
    u.name AS teacher_name,
    cs."className" AS class_name,
    cs."subjectId" AS subject_id,
    sub.name AS subject_name,
    s.id AS student_id
  FROM class_subjects cs
  JOIN profiles u ON u.id = cs."teacherId"
  JOIN subjects sub ON sub.id = cs."subjectId"
  JOIN students s ON s."className" = cs."className"
   -- Former Students / Student Cleanup (20261008): a leaver is not part of a
   -- teacher's CURRENT expected-entry denominator. Their historical exam rows
   -- are untouched; only this derived monitoring view stops counting them.
   AND COALESCE(s.status, 'active') <> 'former'
), class_subject_counts AS (
  SELECT
    teacher_id,
    teacher_name,
    class_name,
    subject_id,
    subject_name,
    COUNT(DISTINCT student_id) AS total_students
  FROM class_subject_students
  GROUP BY teacher_id, teacher_name, class_name, subject_id, subject_name
), scoped_exams AS (
  SELECT
    css.teacher_id,
    css.teacher_name,
    css.class_name,
    css.subject_id,
    css.subject_name,
    css.student_id,
    e.month,
    e."examType"
  FROM class_subject_students css
  JOIN exams e
    ON e."studentId" = css.student_id
   AND e."teacherId" = css.teacher_id
   AND (e.subject = css.subject_name OR e.subject = css.subject_id)
  WHERE e.month IS NOT NULL
), month_scope AS (
  SELECT DISTINCT teacher_id, teacher_name, class_name, subject_id, subject_name, month
  FROM scoped_exams
), grouped AS (
  SELECT
    ms.teacher_id,
    ms.teacher_name,
    ms.class_name,
    ms.subject_id,
    ms.subject_name,
    ms.month,
    c.total_students,
    COUNT(DISTINCT CASE WHEN se."examType" = 'CA' THEN se.student_id END) AS ca_entered,
    COUNT(DISTINCT CASE WHEN se."examType" = 'Homework' THEN se.student_id END) AS homework_entered,
    COUNT(DISTINCT CASE WHEN se."examType" = 'Classwork' THEN se.student_id END) AS classwork_entered,
    COUNT(DISTINCT CASE WHEN se."examType" = 'Attendance' THEN se.student_id END) AS attendance_entered,
    COUNT(DISTINCT CASE WHEN se."examType" = 'Quiz' THEN se.student_id END) AS quiz_entered
  FROM month_scope ms
  JOIN class_subject_counts c
    ON c.teacher_id = ms.teacher_id
   AND c.class_name = ms.class_name
   AND c.subject_id = ms.subject_id
  LEFT JOIN scoped_exams se
    ON se.teacher_id = ms.teacher_id
   AND se.class_name = ms.class_name
   AND se.subject_id = ms.subject_id
   AND se.month = ms.month
  GROUP BY ms.teacher_id, ms.teacher_name, ms.class_name, ms.subject_id, ms.subject_name, ms.month, c.total_students
)
SELECT
  teacher_id AS "teacherId",
  teacher_name AS "teacherName",
  class_name AS "className",
  subject_id AS "subjectId",
  subject_name AS "subjectName",
  month,
  2 AS "requiredEntries",
  (
    CASE WHEN total_students > 0 AND (ca_entered >= total_students OR (homework_entered >= total_students AND classwork_entered >= total_students)) THEN 1 ELSE 0 END
    + CASE WHEN total_students > 0 AND quiz_entered >= total_students THEN 1 ELSE 0 END
  )::bigint AS "completedEntries",
  CASE
    WHEN total_students > 0
     AND (ca_entered >= total_students OR (homework_entered >= total_students AND classwork_entered >= total_students))
     AND quiz_entered >= total_students
    THEN 'complete'
    ELSE 'incomplete'
  END AS "completionStatus",
  ROUND(
    100.0 * (
      GREATEST(
        LEAST(ca_entered::numeric / NULLIF(total_students, 0), 1),
        (LEAST(homework_entered::numeric / NULLIF(total_students, 0), 1) + LEAST(classwork_entered::numeric / NULLIF(total_students, 0), 1)) / 2.0
      )
      + LEAST(quiz_entered::numeric / NULLIF(total_students, 0), 1)
    ) / 2.0,
    2
  ) AS "completionPercent",
  ca_entered AS "caEntered",
  homework_entered AS "homeworkEntered",
  classwork_entered AS "classworkEntered",
  attendance_entered AS "attendanceEntered",
  quiz_entered AS "quizEntered",
  total_students AS "totalStudents",
  ARRAY(
    SELECT required
    FROM unnest(ARRAY['Coursework (CA or Homework + Classwork)', 'Quiz']) AS required
    WHERE (
      required = 'Coursework (CA or Homework + Classwork)'
      AND NOT (ca_entered >= total_students OR (homework_entered >= total_students AND classwork_entered >= total_students))
    ) OR (
      required = 'Quiz'
      AND quiz_entered < total_students
    )
  ) AS "missingExamTypes"
FROM grouped;

-- ─── 2. get_class_student_subject_progress: exclude Former Students ─────────
create or replace function public.get_class_student_subject_progress(
  p_class_name text,
  p_month text
)
returns jsonb
language sql
stable
as $$
  with class_students as (
    select s.id, s.name, s."className"
    from public.students s
    where s."className" = p_class_name
      -- Former Students / Student Cleanup (20261008): the class progress grid is
      -- a CURRENT-entry monitor, so leavers are not expected to have this
      -- month's marks. Reports for a term they attended still include them
      -- (those resolve through student_enrollments, not this function).
      and COALESCE(s.status, 'active') <> 'former'
  ),
  class_subject_rows as (
    select
      cs."subjectId" as subject_id,
      coalesce(sub.name, cs."subjectId") as subject_name
    from public.class_subjects cs
    left join public.subjects sub on sub.id = cs."subjectId"
    where cs."className" = p_class_name
  ),
  baseline as (
    select
      st.id as student_id,
      st.name as student_name,
      st."className" as class_name,
      csr.subject_id,
      csr.subject_name
    from class_students st
    cross join class_subject_rows csr
  ),
  matched_exams as (
    select
      b.student_id,
      b.subject_name,
      e."examType" as exam_type,
      e.score,
      e.total
    from baseline b
    join public.exams e
      on e."studentId" = b.student_id
     and e.month = p_month
     and (e.subject = b.subject_id or e.subject = b.subject_name)
  )
  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'studentId', b.student_id,
        'studentName', b.student_name,
        'className', b.class_name,
        'month', p_month,
        'subject', b.subject_name,
        'caEntered', exists (
          select 1 from matched_exams me
          where me.student_id = b.student_id and me.subject_name = b.subject_name and me.exam_type = 'CA'
        ),
        'homeworkEntered', exists (
          select 1 from matched_exams me
          where me.student_id = b.student_id and me.subject_name = b.subject_name and me.exam_type = 'Homework'
        ),
        'classworkEntered', exists (
          select 1 from matched_exams me
          where me.student_id = b.student_id and me.subject_name = b.subject_name and me.exam_type = 'Classwork'
        ),
        'attendanceEntered', exists (
          select 1 from matched_exams me
          where me.student_id = b.student_id and me.subject_name = b.subject_name and me.exam_type = 'Attendance'
        ),
        'quizEntered', exists (
          select 1 from matched_exams me
          where me.student_id = b.student_id and me.subject_name = b.subject_name and me.exam_type = 'Quiz'
        ),
        'totalExamRows', (
          select count(*) from matched_exams me
          where me.student_id = b.student_id and me.subject_name = b.subject_name
        ),
        'examEntries', coalesce((
          select jsonb_agg(
            jsonb_build_object(
              'examType', me.exam_type,
              'score', me.score,
              'total', me.total
            )
            order by me.exam_type
          )
          from matched_exams me
          where me.student_id = b.student_id and me.subject_name = b.subject_name
        ), '[]'::jsonb)
      )
      order by b.student_name, b.subject_name
    ),
    '[]'::jsonb
  )
  from baseline b;
$$;
