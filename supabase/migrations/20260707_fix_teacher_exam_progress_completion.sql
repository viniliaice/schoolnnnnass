-- Align Monitor Teacher Entries completion with the app's required monthly entry rule:
-- Quiz is always required for every student.
-- Coursework is required and can be satisfied either by CA for every student OR
-- by both Homework and Classwork for every student. Attendance is visible but not required.
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
  SELECT DISTINCT
    teacher_id,
    teacher_name,
    class_name,
    subject_id,
    subject_name,
    month
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
    CASE
      WHEN total_students > 0 AND (
        ca_entered >= total_students OR (homework_entered >= total_students AND classwork_entered >= total_students)
      ) THEN 1 ELSE 0
    END
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
        (
          LEAST(homework_entered::numeric / NULLIF(total_students, 0), 1)
          + LEAST(classwork_entered::numeric / NULLIF(total_students, 0), 1)
        ) / 2.0
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

CREATE INDEX IF NOT EXISTS idx_exams_teacher_month_examtype ON exams("teacherId", "month", "examType");
CREATE INDEX IF NOT EXISTS idx_class_subjects_teacher ON class_subjects("teacherId");
