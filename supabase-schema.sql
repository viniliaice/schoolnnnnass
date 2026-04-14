-- Create users table (linked to Supabase auth.users)
CREATE TABLE users (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE,
  password TEXT,
  role TEXT NOT NULL CHECK (role IN ('admin', 'teacher', 'parent', 'supervisor')),
  phone1 TEXT,
  phone2 TEXT,
  xafada TEXT,
  udow TEXT,
  paymentnumber TEXT,
  "assignedClasses" JSONB DEFAULT '[]'::JSONB,
  "assignedSubjects" JSONB DEFAULT '[]'::JSONB,
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Create students table
CREATE TABLE students (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  "className" TEXT NOT NULL,
  "parentId" TEXT REFERENCES users(id) ON DELETE SET NULL,
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Create exams table
CREATE TABLE exams (
  id TEXT PRIMARY KEY,
  "studentId" TEXT NOT NULL REFERENCES students(id) ON DELETE CASCADE,
  subject TEXT NOT NULL,
  score INTEGER NOT NULL,
  total INTEGER NOT NULL,
  "examType" TEXT NOT NULL CHECK ("examType" IN ('CA', 'Homework', 'Classwork', 'Quiz', 'Midterm', 'Final')),
  month TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'approved', 'rejected')),
  "parentId" TEXT REFERENCES users(id) ON DELETE SET NULL,
  date DATE NOT NULL,
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  "teacherId" TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE
);

-- Basic subjects table used for class_subjects and admin options
CREATE TABLE IF NOT EXISTS subjects (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  "shortName" TEXT,
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Create indexes for better performance
CREATE INDEX idx_users_role ON users(role);
CREATE INDEX idx_students_parentId ON students("parentId");
CREATE INDEX idx_students_className ON students("className");
CREATE INDEX idx_exams_studentId ON exams("studentId");
CREATE INDEX idx_exams_parentId ON exams("parentId");
CREATE INDEX idx_exams_teacherId ON exams("teacherId");
CREATE INDEX idx_exams_status ON exams(status);
CREATE INDEX IF NOT EXISTS idx_exams_teacher_month_examtype ON exams("teacherId", "month", "examType");

-- Class subject mapping for supervisors/teachers
CREATE TABLE class_subjects (
  id TEXT PRIMARY KEY,
  "className" TEXT NOT NULL,
  "subjectId" TEXT NOT NULL REFERENCES subjects(id) ON DELETE CASCADE,
  "teacherId" TEXT REFERENCES users(id) ON DELETE SET NULL,
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_class_subjects_class ON class_subjects("className");
CREATE INDEX idx_class_subjects_teacher ON class_subjects("teacherId");
CREATE INDEX idx_class_subjects_subject ON class_subjects("subjectId");

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

-- Report comments storage
CREATE TABLE report_comments (
  id TEXT PRIMARY KEY,
  "studentId" TEXT NOT NULL REFERENCES students(id) ON DELETE CASCADE,
  "termId" TEXT NOT NULL REFERENCES terms(id) ON DELETE CASCADE,
  "examId" TEXT REFERENCES exams(id) ON DELETE SET NULL,
  "teacherComment" TEXT,
  "principalComment" TEXT,
  "teacherId" TEXT REFERENCES users(id) ON DELETE SET NULL,
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_report_comments_student_term ON report_comments("studentId", "termId");

-- Enable Row Level Security (RLS)
ALTER TABLE users ENABLE ROW LEVEL SECURITY;
ALTER TABLE students ENABLE ROW LEVEL SECURITY;
ALTER TABLE exams ENABLE ROW LEVEL SECURITY;

-- Create policies (adjust based on your auth requirements)
-- For now, allow all operations (you may want to restrict this)
CREATE POLICY "Allow all operations on users" ON users FOR ALL USING (true);
CREATE POLICY "Allow all operations on students" ON students FOR ALL USING (true);
-- Remove open policy and add secure RLS for teachers
DROP POLICY IF EXISTS "Allow all operations on exams" ON exams;

-- Allow teachers to insert/update only for their assigned subjects

CREATE POLICY "Teachers can only insert exams for their assigned subjects" ON exams
  FOR INSERT
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM users u
      WHERE u.id = auth.uid()
        AND (
          exams.subjectId = ANY (SELECT jsonb_array_elements_text(u.assignedSubjects))
        )
    )
  );

-- Allow teachers to update exams only for their assigned subjects
CREATE POLICY "Teachers can only update exams for their assigned subjects" ON exams
  FOR UPDATE
  USING (
    EXISTS (
      SELECT 1 FROM users u
      WHERE u.id = auth.uid()
        AND (
          exams.subjectId = ANY (SELECT jsonb_array_elements_text(u.assignedSubjects))
        )
    )
  );

-- Allow select for all roles (adjust as needed)
CREATE POLICY "Allow select on exams for all" ON exams FOR SELECT USING (true);