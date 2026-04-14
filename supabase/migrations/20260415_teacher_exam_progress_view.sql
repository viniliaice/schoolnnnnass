-- Create summary view for supervisor tracking of teacher monthly exam entry progress
CREATE OR REPLACE VIEW teacher_exam_progress AS
SELECT
  cs."teacherId" AS "teacherId",
  u.name AS "teacherName",
  cs."className" AS "className",
  cs."subjectId" AS "subjectId",
  sub.name AS "subjectName",
  e.month AS "month",
  4 AS "requiredEntries",
  COUNT(DISTINCT CASE WHEN e."examType" IN ('CA', 'Homework', 'Classwork', 'Quiz') THEN e."examType" END) AS "completedEntries",
  CASE WHEN COUNT(DISTINCT CASE WHEN e."examType" IN ('CA', 'Homework', 'Classwork', 'Quiz') THEN e."examType" END) = 4
       THEN 'complete' ELSE 'incomplete' END AS "completionStatus",
  ROUND(100.0 * COUNT(DISTINCT CASE WHEN e."examType" IN ('CA', 'Homework', 'Classwork', 'Quiz') THEN e."examType" END) / 4.0, 2) AS "completionPercent",
  COUNT(DISTINCT CASE WHEN e."examType" = 'CA' THEN e."studentId" END) AS "caEntered",
  COUNT(DISTINCT CASE WHEN e."examType" = 'Homework' THEN e."studentId" END) AS "homeworkEntered",
  COUNT(DISTINCT CASE WHEN e."examType" = 'Classwork' THEN e."studentId" END) AS "classworkEntered",
  COUNT(DISTINCT CASE WHEN e."examType" = 'Attendance' THEN e."studentId" END) AS "attendanceEntered",
  COUNT(DISTINCT CASE WHEN e."examType" = 'Quiz' THEN e."studentId" END) AS "quizEntered",
  COUNT(DISTINCT s.id) AS "totalStudents",
  ARRAY(
    SELECT required
    FROM unnest(ARRAY['CA', 'Homework', 'Classwork', 'Quiz']) AS required
    WHERE required NOT IN (
      SELECT DISTINCT e2."examType"
      FROM exams e2
      JOIN students s2 ON s2.id = e2."studentId"
      WHERE e2."teacherId" = cs."teacherId"
        AND s2."className" = cs."className"
        AND e2.month = e.month
        AND e2.subject = sub.name
    )
  ) AS "missingExamTypes"
FROM class_subjects cs
JOIN users u ON u.id = cs."teacherId"
JOIN subjects sub ON sub.id = cs."subjectId"
JOIN students s ON s."className" = cs."className"
JOIN exams e ON e."studentId" = s.id AND e.subject = sub.name
GROUP BY cs."teacherId", u.name, cs."className", cs."subjectId", sub.name, e.month;

-- Row-level security policies must be defined on base tables, not on views.
CREATE INDEX IF NOT EXISTS idx_exams_teacher_month_examtype ON exams("teacherId", "month", "examType");
CREATE INDEX IF NOT EXISTS idx_class_subjects_teacher ON class_subjects("teacherId");
