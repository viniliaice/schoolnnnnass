-- Add supervisor role in users, password field, assignedSubjects, class_subjects, and report_comments

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS password TEXT,
  ADD COLUMN IF NOT EXISTS "assignedSubjects" JSONB DEFAULT '[]'::JSONB;

ALTER TABLE users
  ALTER COLUMN role TYPE TEXT USING role::TEXT;

-- update role constraint to include supervisor
ALTER TABLE users DROP CONSTRAINT IF EXISTS users_role_check;
ALTER TABLE users ADD CONSTRAINT users_role_check CHECK (role IN ('admin', 'teacher', 'parent', 'supervisor'));

-- Ensure subjects table exists
CREATE TABLE IF NOT EXISTS subjects (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  "shortName" TEXT,
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- class_subjects table
CREATE TABLE IF NOT EXISTS class_subjects (
  id TEXT PRIMARY KEY,
  "className" TEXT NOT NULL,
  "subjectId" TEXT NOT NULL REFERENCES subjects(id) ON DELETE CASCADE,
  "teacherId" TEXT REFERENCES users(id) ON DELETE SET NULL,
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_class_subjects_class ON class_subjects("className");
CREATE INDEX IF NOT EXISTS idx_class_subjects_teacher ON class_subjects("teacherId");
CREATE INDEX IF NOT EXISTS idx_class_subjects_subject ON class_subjects("subjectId");

-- report_comments table
CREATE TABLE IF NOT EXISTS report_comments (
  id TEXT PRIMARY KEY,
  "studentId" TEXT NOT NULL REFERENCES students(id) ON DELETE CASCADE,
  "termId" TEXT NOT NULL REFERENCES terms(id) ON DELETE CASCADE,
  "examId" TEXT REFERENCES exams(id) ON DELETE SET NULL,
  "teacherComment" TEXT,
  "principalComment" TEXT,
  "teacherId" TEXT REFERENCES users(id) ON DELETE SET NULL,
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_report_comments_student_term ON report_comments("studentId", "termId");
