-- Add indexes to speed up exams and students lookups for dashboard workflows
CREATE INDEX IF NOT EXISTS idx_exams_studentId ON exams("studentId");
CREATE INDEX IF NOT EXISTS idx_exams_month ON exams("month");
CREATE INDEX IF NOT EXISTS idx_students_className ON students("className");
