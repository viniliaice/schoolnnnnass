-- Create users table (linked to Supabase auth.users)
CREATE TABLE profiles (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE,
  password TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('admin', 'teacher', 'parent', 'supervisor')),
  phone1 TEXT,
  phone2 TEXT,
  xafada TEXT,
  udow TEXT,
  paymentnumber TEXT,
  "assignedClasses" JSONB DEFAULT '[]'::JSONB,
  "assignedSubjects" JSONB DEFAULT '[]'::JSONB,
  fcm_token TEXT,
  auth_id UUID REFERENCES auth.users(id),
  photo_url TIMESTAMP,
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Create students table
CREATE TABLE students (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  "className" TEXT NOT NULL,
  "parentId" TEXT REFERENCES profiles(id) ON DELETE SET NULL,
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Create exams table
CREATE TABLE exams (
  id TEXT PRIMARY KEY,
  "studentId" TEXT NOT NULL REFERENCES students(id) ON DELETE CASCADE,
  "subjectId" TEXT,
  subject TEXT NOT NULL,
  score INTEGER,
  total INTEGER NOT NULL CHECK (total > 0),
  "examType" TEXT NOT NULL CHECK ("examType" IN ('CA', 'Homework', 'Classwork', 'Quiz', 'Midterm', 'Final', 'Attendance', 'Discipline')),
  "assessmentLabel" TEXT CHECK ("assessmentLabel" IS NULL OR "assessmentLabel" IN ('HW1', 'HW2', 'HW3', 'HW4', 'CPW1', 'CPW2', 'CPW3', 'CPW4', 'ATTENDANCE', 'MT', 'AKHLAAQ')),
  "entryState" TEXT NOT NULL DEFAULT 'scored' CHECK ("entryState" IN ('scored', 'absent', 'not_applicable')),
  "termId" TEXT,
  month TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'approved', 'rejected')),
  "parentId" TEXT REFERENCES profiles(id) ON DELETE SET NULL,
  date DATE NOT NULL,
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  "teacherId" TEXT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  "uploadedBy" TEXT REFERENCES profiles(id) ON DELETE SET NULL,
  CHECK (
    ("entryState" = 'scored' AND score IS NOT NULL AND score >= 0 AND score <= total)
    OR ("entryState" IN ('absent', 'not_applicable') AND score IS NULL)
  ),
  CHECK (
    "assessmentLabel" IS NULL
    OR ("assessmentLabel" IN ('HW1', 'HW2', 'HW3', 'HW4') AND "examType" = 'Homework' AND total = 5)
    OR ("assessmentLabel" IN ('CPW1', 'CPW2', 'CPW3', 'CPW4') AND "examType" = 'Classwork' AND total = 15)
    OR ("assessmentLabel" = 'ATTENDANCE' AND "examType" = 'Attendance' AND total = 20)
    OR ("assessmentLabel" = 'MT' AND "examType" = 'Quiz' AND total = 20)
    OR ("assessmentLabel" = 'AKHLAAQ' AND "examType" = 'Discipline' AND total = 10)
  )
);

-- Basic subjects table used for class_subjects and admin options
CREATE TABLE IF NOT EXISTS subjects (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  "shortName" TEXT,
  color TEXT,
  "weeklyLessons" INTEGER NOT NULL DEFAULT 5,
  department TEXT,
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Create indexes for better performance
CREATE INDEX idx_users_role ON profiles(role);
CREATE INDEX idx_students_parentId ON students("parentId");
CREATE INDEX idx_students_className ON students("className");
CREATE INDEX idx_exams_studentId ON exams("studentId");
CREATE INDEX idx_exams_month ON exams("month");
CREATE INDEX idx_exams_parentId ON exams("parentId");
CREATE INDEX idx_exams_teacherId ON exams("teacherId");
CREATE INDEX idx_exams_status ON exams(status);
CREATE INDEX IF NOT EXISTS idx_exams_teacher_month_examtype ON exams("teacherId", "month", "examType");
CREATE INDEX IF NOT EXISTS idx_exams_bulk_identity_lookup ON exams("studentId", "subjectId", "termId", "assessmentLabel");
CREATE INDEX IF NOT EXISTS idx_exams_uploaded_by ON exams("uploadedBy");
CREATE UNIQUE INDEX IF NOT EXISTS exams_bulk_assessment_identity_unique
  ON exams("studentId", "subjectId", "examType", "assessmentLabel", "termId")
  WHERE "subjectId" IS NOT NULL AND "termId" IS NOT NULL AND "assessmentLabel" IS NOT NULL;

CREATE TABLE IF NOT EXISTS grade_uploads (
  id TEXT PRIMARY KEY,
  "uploadedBy" TEXT NOT NULL REFERENCES profiles(id) ON DELETE RESTRICT,
  payload_hash TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('completed')),
  result JSONB NOT NULL,
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_grade_uploads_uploaded_by ON grade_uploads("uploadedBy", "createdAt" DESC);

-- Class subject mapping for supervisors/teachers
CREATE TABLE class_subjects (
  id TEXT PRIMARY KEY,
  "className" TEXT NOT NULL,
  "subjectId" TEXT NOT NULL REFERENCES subjects(id) ON DELETE CASCADE,
  "teacherId" TEXT REFERENCES profiles(id) ON DELETE SET NULL,
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_class_subjects_class ON class_subjects("className");
CREATE INDEX idx_class_subjects_teacher ON class_subjects("teacherId");
CREATE INDEX idx_class_subjects_subject ON class_subjects("subjectId");

-- Create summary view for supervisor tracking of teacher monthly exam entry progress
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

-- Row-level security policies must be defined on base tables, not on views.

-- Report comments storage
CREATE TABLE report_comments (
  id TEXT PRIMARY KEY,
  "studentId" TEXT NOT NULL REFERENCES students(id) ON DELETE CASCADE,
  "termId" TEXT NOT NULL REFERENCES terms(id) ON DELETE CASCADE,
  "examId" TEXT REFERENCES exams(id) ON DELETE SET NULL,
  "teacherComment" TEXT,
  "principalComment" TEXT,
  "teacherId" TEXT REFERENCES profiles(id) ON DELETE SET NULL,
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_report_comments_student_term ON report_comments("studentId", "termId");

-- Track student promotions across academic years for progression history
CREATE TABLE student_promotions (
  id TEXT PRIMARY KEY,
  "studentId" TEXT NOT NULL REFERENCES students(id) ON DELETE CASCADE,
  "fromClass" TEXT NOT NULL,
  "toClass" TEXT NOT NULL,
  "academicYearId" TEXT REFERENCES academic_years(id) ON DELETE SET NULL,
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_student_promotions_student ON student_promotions("studentId");
CREATE INDEX idx_student_promotions_year ON student_promotions("academicYearId");

-- Attendance records for daily roll-call (streams)
CREATE TABLE IF NOT EXISTS attendance (
  id TEXT PRIMARY KEY,
  "studentId" TEXT NOT NULL REFERENCES students(id) ON DELETE CASCADE,
  "className" TEXT NOT NULL,
  date DATE NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('present', 'absent', 'late')),
  note TEXT,
  "teacherId" TEXT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE("studentId", date)
);
CREATE INDEX idx_attendance_class_date ON attendance("className", date);
CREATE INDEX idx_attendance_student ON attendance("studentId");

-- Homework assignments (streams)
CREATE TABLE IF NOT EXISTS homework (
  id TEXT PRIMARY KEY,
  "studentId" TEXT NOT NULL REFERENCES students(id) ON DELETE CASCADE,
  "className" TEXT NOT NULL,
  subject TEXT NOT NULL,
  title TEXT NOT NULL,
  description TEXT,
  "dueDate" DATE NOT NULL,
  status TEXT NOT NULL DEFAULT 'assigned' CHECK (status IN ('assigned', 'submitted', 'graded')),
  "teacherId" TEXT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_homework_class ON homework("className");
CREATE INDEX idx_homework_student ON homework("studentId");
CREATE INDEX idx_homework_title_class ON homework("title", "className");

-- Quiz/question system (separate from homework)
CREATE TABLE questions (
  id TEXT PRIMARY KEY,
  prompt TEXT NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('multiple_choice', 'direct_answer')),
  options JSONB,
  "correctAnswer" TEXT,
  rubric TEXT,
  "teacherId" TEXT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_questions_teacher ON questions("teacherId");

CREATE TABLE quizzes (
  id TEXT PRIMARY KEY,
  "className" TEXT NOT NULL,
  subject TEXT NOT NULL,
  title TEXT NOT NULL,
  description TEXT,
  "openDate" DATE NOT NULL,
  "dueDate" DATE NOT NULL,
  "timeLimit" INTEGER,
  "questionOrder" TEXT DEFAULT 'created' CHECK ("questionOrder" IN ('created', 'randomized')),
  "teacherId" TEXT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'active', 'closed')),
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_quizzes_class ON quizzes("className");
CREATE INDEX idx_quizzes_teacher ON quizzes("teacherId");

CREATE TABLE quiz_questions (
  id TEXT PRIMARY KEY,
  "quizId" TEXT NOT NULL REFERENCES quizzes(id) ON DELETE CASCADE,
  "questionId" TEXT NOT NULL REFERENCES questions(id),
  "orderIndex" INTEGER NOT NULL,
  points INTEGER NOT NULL DEFAULT 1,
  "promptSnapshot" TEXT NOT NULL,
  "optionsSnapshot" JSONB,
  "correctAnswerSnapshot" TEXT,
  "typeSnapshot" TEXT NOT NULL
);
CREATE INDEX idx_quiz_questions_quiz ON quiz_questions("quizId");

CREATE TABLE quiz_attempts (
  id TEXT PRIMARY KEY,
  "quizId" TEXT NOT NULL REFERENCES quizzes(id) ON DELETE CASCADE,
  "studentId" TEXT NOT NULL REFERENCES students(id) ON DELETE CASCADE,
  answers JSONB NOT NULL DEFAULT '[]',
  "totalEarned" INTEGER DEFAULT 0,
  "totalPossible" INTEGER DEFAULT 0,
  "startedAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  "submittedAt" TIMESTAMPTZ,
  status TEXT NOT NULL DEFAULT 'in_progress' CHECK (status IN ('in_progress', 'submitted', 'graded')),
  UNIQUE("quizId", "studentId")
);
CREATE INDEX idx_quiz_attempts_quiz ON quiz_attempts("quizId");
CREATE INDEX idx_quiz_attempts_student ON quiz_attempts("studentId");

-- Enable Row Level Security (RLS)
ALTER TABLE profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE students ENABLE ROW LEVEL SECURITY;
ALTER TABLE exams ENABLE ROW LEVEL SECURITY;
ALTER TABLE grade_uploads ENABLE ROW LEVEL SECURITY;

-- Create policies (adjust based on your auth requirements)
-- For now, allow all operations (you may want to restrict this)
CREATE POLICY "Allow all operations on profiles" ON profiles FOR ALL USING (true);
CREATE POLICY "Allow all operations on students" ON students FOR ALL USING (true);
-- Exam writes are scoped to the authenticated profile, the student's class,
-- and the corresponding class_subject assignment. auth.uid() is the Supabase
-- UUID, so it is resolved through profiles.auth_id rather than compared with
-- the application text id directly.
CREATE OR REPLACE FUNCTION current_profile_id()
RETURNS TEXT LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT id FROM profiles WHERE auth_id = auth.uid() LIMIT 1;
$$;
CREATE OR REPLACE FUNCTION current_profile_role()
RETURNS TEXT LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT role FROM profiles WHERE auth_id = auth.uid() LIMIT 1;
$$;
CREATE OR REPLACE FUNCTION can_submit_exam_target(p_student_id TEXT, p_subject_id TEXT, p_teacher_id TEXT)
RETURNS BOOLEAN LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT EXISTS (
    SELECT 1 FROM students s
    JOIN class_subjects cs ON cs."className" = s."className"
      AND cs."subjectId" = p_subject_id AND cs."teacherId" = p_teacher_id
    WHERE s.id = p_student_id
  );
$$;

DROP POLICY IF EXISTS "Allow all operations on exams" ON exams;
DROP POLICY IF EXISTS "Teachers can only insert exams for their assigned subjects" ON exams;
DROP POLICY IF EXISTS "Teachers can only update exams for their assigned subjects" ON exams;
DROP POLICY IF EXISTS "Allow select on exams for all" ON exams;

CREATE POLICY "exam_select_authorized" ON exams FOR SELECT TO authenticated USING (
  current_profile_role() IN ('admin', 'supervisor')
  OR "teacherId" = current_profile_id()
  OR "parentId" = current_profile_id()
);
CREATE POLICY "exam_insert_authorized" ON exams FOR INSERT TO authenticated WITH CHECK (
  (current_profile_role() = 'teacher' AND "teacherId" = current_profile_id() AND can_submit_exam_target("studentId", "subjectId", "teacherId"))
  OR (current_profile_role() = 'admin' AND can_submit_exam_target("studentId", "subjectId", "teacherId"))
);
CREATE POLICY "exam_update_authorized" ON exams FOR UPDATE TO authenticated
  USING (current_profile_role() IN ('admin', 'supervisor') OR ("teacherId" = current_profile_id() AND current_profile_role() = 'teacher'))
  WITH CHECK (current_profile_role() IN ('admin', 'supervisor') OR (current_profile_role() = 'teacher' AND "teacherId" = current_profile_id() AND can_submit_exam_target("studentId", "subjectId", "teacherId")));
CREATE POLICY "exam_delete_authorized" ON exams FOR DELETE TO authenticated USING (
  current_profile_role() = 'admin' OR ("teacherId" = current_profile_id() AND current_profile_role() = 'teacher')
);
