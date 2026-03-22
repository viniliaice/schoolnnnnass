-- Create users table (linked to Supabase auth.users)
CREATE TABLE users (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE,
  password TEXT, -- For demo authentication
  role TEXT NOT NULL CHECK (role IN ('admin', 'teacher', 'parent')),
  phone1 TEXT,
  phone2 TEXT,
  xafada TEXT,
  udow TEXT,
  paymentNumber TEXT,
  "assignedClasses" JSONB,
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

-- Create indexes for better performance
CREATE INDEX idx_users_role ON users(role);
CREATE INDEX idx_students_parentId ON students("parentId");
CREATE INDEX idx_students_className ON students("className");
CREATE INDEX idx_exams_studentId ON exams("studentId");
CREATE INDEX idx_exams_parentId ON exams("parentId");
CREATE INDEX idx_exams_teacherId ON exams("teacherId");
CREATE INDEX idx_exams_status ON exams(status);

-- Enable Row Level Security (RLS)
ALTER TABLE users ENABLE ROW LEVEL SECURITY;
ALTER TABLE students ENABLE ROW LEVEL SECURITY;
ALTER TABLE exams ENABLE ROW LEVEL SECURITY;

-- Create policies (adjust based on your auth requirements)
-- For now, allow all operations (you may want to restrict this)
CREATE POLICY "Allow all operations on users" ON users FOR ALL USING (true);
CREATE POLICY "Allow all operations on students" ON students FOR ALL USING (true);
CREATE POLICY "Allow all operations on exams" ON exams FOR ALL USING (true);