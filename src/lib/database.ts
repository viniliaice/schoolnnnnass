import { User, Student, Exam, ExamStatus, ExamType, Role } from '../types';
import { supabase } from './supabase';

// ── Authentication ──
export async function signIn(email: string, password: string) {
  const { data, error } = await supabase.auth.signInWithPassword({
    email,
    password,
  });
  if (error) throw error;
  return data;
}

// Sign up a new user (used for first-time password setup)
export async function signUp(email: string, password: string) {
  const { data, error } = await supabase.auth.signUp({
    email,
    password,
  });
  if (error) throw error;
  // Create user profile in our users table
  if (data.user) {
    const { error: profileError } = await supabase
      .from('users')
      .update({ id: data.user.id })
      .eq('email', email);
    if (profileError) throw profileError;
  }
  return data;
}

// ...existing code...

// Helper: check if user exists in Supabase Auth
export async function isUserInAuth(email: string): Promise<boolean> {
  // Supabase does not provide direct API to check, so try signIn with random password
  const { error } = await supabase.auth.signInWithPassword({ email, password: 'invalid-password' });
  if (error && error.message.includes('Invalid login credentials')) {
    // If error is invalid credentials, user exists in Auth
    return true;
  }
  // If error is user not found, user does not exist
  return false;
}

export async function signOut() {
  const { error } = await supabase.auth.signOut();
  if (error) throw error;
}

export async function getCurrentUser() {
  const { data: { user }, error } = await supabase.auth.getUser();
  if (error) throw error;
  return user;
}

export async function getCurrentUserProfile() {
  const user = await getCurrentUser();
  if (!user) return null;

  const { data, error } = await supabase
    .from('users')
    .select('*')
    .eq('id', user.id)
    .maybeSingle();

  if (error) throw error;
  return data;
}

export async function createDemoAccounts() {
  const demoUsers = [
    { email: 'admin@scholo.com', password: 'admin123', name: 'Dr. Sarah Mitchell', role: 'admin' as const },
    { email: 'teacher@scholo.com', password: 'teacher123', name: 'Prof. James Wilson', role: 'teacher' as const, assignedClasses: ['Grade 10-A', 'Grade 9-A', 'Grade 8-B'] },
    { email: 'parent@scholo.com', password: 'parent123', name: 'Michael Johnson', role: 'parent' as const },
  ];

  for (const user of demoUsers) {
    try {
      // Check if user already exists
      const { data: existing } = await supabase
        .from('users')
        .select('id')
        .eq('email', user.email)
        .maybeSingle();

      if (existing) {
        console.log(`Demo account for ${user.email} already exists`);
        continue; // Skip if already exists
      }

      // For demo purposes, create user profile directly with a generated ID
      // In production, you'd use proper authentication
      const userId = `${user.role}-${Date.now()}-${Math.random().toString(36).substring(2, 8)}`;

      const { error: profileError } = await supabase
        .from('users')
        .insert({
          id: userId,
          email: user.email,
          name: user.name,
          role: user.role,
          assignedClasses: user.assignedClasses || [],
        });

      if (profileError) throw profileError;

      console.log(`Created demo account for ${user.email}`);
    } catch (error) {
      console.error(`Error creating demo account for ${user.email}:`, error);
    }
  }
}

// ── Users ──
export async function getUsers(): Promise<User[]> {
  const { data, error } = await supabase.from('users').select('*');
  if (error) throw error;
  return data || [];
}

export async function getUsersByRole(role: Role): Promise<User[]> {
  const { data, error } = await supabase.from('users').select('*').eq('role', role);
  if (error) throw error;
  return data || [];
}

export async function getUserById(id: string): Promise<User | undefined> {
  const { data, error } = await supabase.from('users').select('*').eq('id', id).single();
  if (error) return undefined;
  return data;
}

export async function createUser(data: Omit<User, 'id' | 'createdAt'>): Promise<User> {
  // Generate unique ID based on role and timestamp
  const timestamp = Date.now();
  const random = Math.random().toString(36).substring(2, 8);
  const id = `${data.role}-${timestamp}-${random}`;

  const user: Omit<User, 'id'> = { ...data, createdAt: new Date().toISOString() };
  const { data: created, error } = await supabase.from('users').insert({ id, ...user }).select().single();
  if (error) {
    console.error('Error creating user:', error);
    throw error;
  }
  return created;
}

export async function updateUser(id: string, data: Partial<User>): Promise<User | null> {
  const { data: updated, error } = await supabase.from('users').update(data).eq('id', id).select().single();
  if (error) return null;
  return updated;
}

export async function deleteUser(id: string): Promise<boolean> {
  const { error } = await supabase.from('users').delete().eq('id', id);
  if (error) return false;
  // Also unlink students from deleted parent
  await supabase.from('students').update({ parentid: null }).eq('parentid', id);
  return true;
}

// ── Students ──
export async function getStudents(): Promise<Student[]> {
  const { data, error } = await supabase.from('students').select('*');
  if (error) throw error;
  return data || [];
}

export async function getStudentById(id: string): Promise<Student | undefined> {
  const { data, error } = await supabase.from('students').select('*').eq('id', id).single();
  if (error) return undefined;
  return data;
}

export async function getStudentsByParent(parentId: string): Promise<Student[]> {
  const { data, error } = await supabase.from('students').select('*').eq('parentId', parentId);
  if (error) throw error;
  return data || [];
}


export async function getStudentsByClass(className: string): Promise<Student[]> {
  const { data, error } = await supabase.from('students').select('*').eq('className', className);
  if (error) throw error;
  return data || [];
}


export async function getStudentsByClasses(classNames: string[]): Promise<Student[]> {
  const { data, error } = await supabase.from('students').select('*').in('className', classNames);
  if (error) throw error;
  return data || [];
}

export async function createStudent(data: Omit<Student, 'id' | 'createdAt'>): Promise<Student> {
  // Generate unique ID
  const timestamp = Date.now();
  const random = Math.random().toString(36).substring(2, 8);
  const id = `student-${timestamp}-${random}`;

  // Use PascalCase for DB columns to match Supabase schema
  const student = {
    name: data.name,
    className: data.className,
    parentId: data.parentId,
    createdAt: new Date().toISOString(),
  };
  const { data: created, error } = await supabase.from('students').insert({ id, ...student }).select().single();
  if (error) throw error;
  return created;
}

export async function updateStudent(id: string, data: Partial<Student>): Promise<Student | null> {
  // Use PascalCase for DB columns to match Supabase schema
  const updateData: any = {};
  if (data.name !== undefined) updateData.name = data.name;
  if (data.className !== undefined) updateData.className = data.className;
  if (data.parentId !== undefined) updateData.parentId = data.parentId;
  if (data.createdAt !== undefined) updateData.createdAt = data.createdAt;
  const { data: updated, error } = await supabase.from('students').update(updateData).eq('id', id).select().single();
  if (error) return null;
  return updated;
}

export async function deleteStudent(id: string): Promise<boolean> {
  const { error } = await supabase.from('students').delete().eq('id', id);
  if (error) return false;
  await supabase.from('exams').delete().eq('studentid', id);
  return true;
}

// ── Exams ──
export async function getExams(): Promise<Exam[]> {
  const { data, error } = await supabase.from('exams').select('*');
  if (error) throw error;
  return data || [];
}

export async function getExamsByStudent(studentId: string): Promise<Exam[]> {
  const { data, error } = await supabase.from('exams').select('*').eq('studentId', studentId);
  if (error) throw error;
  return data || [];
}

export async function getExamsByParent(parentId: string, statusFilter?: ExamStatus): Promise<Exam[]> {
  let query = supabase.from('exams').select('*').eq('parentId', parentId);
  if (statusFilter) query = query.eq('status', statusFilter);
  const { data, error } = await query;
  if (error) throw error;
  return data || [];
}

export async function getExamsByTeacher(teacherId: string): Promise<Exam[]> {
  const { data, error } = await supabase.from('exams').select('*').eq('teacherId', teacherId);
  if (error) throw error;
  return data || [];
}

export async function getExamsByStatus(status: ExamStatus): Promise<Exam[]> {
  const { data, error } = await supabase.from('exams').select('*').eq('status', status);
  if (error) throw error;
  return data || [];
}

export async function createExam(data: Omit<Exam, 'id' | 'created_At'>): Promise<Exam> {
  // Generate unique ID
  const timestamp = Date.now();
  const random = Math.random().toString(36).substring(2, 8);
  const id = `exam-${timestamp}-${random}`;

  const exam: Omit<Exam, 'id'> = { ...data, createdAt: new Date().toISOString() };
  const { data: created, error } = await supabase.from('exams').insert({ id, ...exam }).select().single();
  if (error) throw error;
  return created;
}

export async function updateExamStatus(id: string, status: ExamStatus): Promise<Exam | null> {
  const { data: updated, error } = await supabase.from('exams').update({ status }).eq('id', id).select().single();
  if (error) return null;
  return updated;
}

export async function deleteExam(id: string): Promise<boolean> {
  const { error } = await supabase.from('exams').delete().eq('id', id);
  return !error;
}

// ── Bulk Operations ──
export async function bulkCreateUsers(dataList: Omit<User, 'id' | 'createdAt'>[]): Promise<User[]> {
  const users = dataList.map(data => {
    const timestamp = Date.now();
    const random = Math.random().toString(36).substring(2, 8);
    const id = `${data.role}-${timestamp}-${random}`;
    return { id, ...data, createdAt: new Date().toISOString() };
  });
  const { data, error } = await supabase.from('users').insert(users).select();
  if (error) throw error;
  return data || [];
}

export async function bulkCreateStudents(dataList: Omit<Student, 'id' | 'createdAt'>[]): Promise<Student[]> {
  const studentsWithTimestamps = dataList.map(data => {
    const timestamp = Date.now();
    const random = Math.random().toString(36).substring(2, 8);
    const id = `student-${timestamp}-${random}`;
    return { id, ...data, createdAt: new Date().toISOString() };
  });
  const { data, error } = await supabase.from('students').insert(studentsWithTimestamps).select();
  if (error) throw error;
  return data || [];
}

export async function bulkCreateExams(dataList: Omit<Exam, 'id' | 'createdAt'>[]): Promise<Exam[]> {
  const examsWithTimestamps = dataList.map(data => {
    const timestamp = Date.now();
    const random = Math.random().toString(36).substring(2, 8);
    const id = `exam-${timestamp}-${random}`;
    return { id, ...data, createdAt: new Date().toISOString() };
  });
  const { data, error } = await supabase.from('exams').insert(examsWithTimestamps).select();
  if (error) throw error;
  return data || [];
}

// ── Stats ──
export async function getSystemStats() {
  const [users, students, exams] = await Promise.all([
    getUsers(),
    getStudents(),
    getExams()
  ]);

  return {
    totalTeachers: users.filter(u => u.role === 'teacher').length,
    totalParents: users.filter(u => u.role === 'parent').length,
    totalStudents: students.length,
    totalExams: exams.length,
    pendingExams: exams.filter(e => e.status === 'pending').length,
    approvedExams: exams.filter(e => e.status === 'approved').length,
    rejectedExams: exams.filter(e => e.status === 'rejected').length,
    averageScore: exams.length > 0
      ? Math.round(exams.reduce((sum, e) => sum + (e.score / e.total) * 100, 0) / exams.length)
      : 0,
  };
}

// ── Seeding ──
export async function isSeeded(): Promise<boolean> {
  const users = await getUsers();
  return users.length > 0;
}

export async function seedDatabase(): Promise<void> {
  // Clear existing data
  await supabase.from('exams').delete().neq('id', ''); // Delete all
  await supabase.from('students').delete().neq('id', '');
  await supabase.from('users').delete().neq('id', '');

  const now = new Date().toISOString();

  // Users
  const admin: User = {
    id: 'admin-001', name: 'Dr. Sarah Mitchell', email: 'admin@campus.edu',
    role: 'admin', createdAt: now,
  };

  const teacher1: User = {
    id: 'teacher-001', name: 'Prof. James Wilson', email: 'jwilson@campus.edu',
    role: 'teacher', assignedClasses: ['Grade 10-A', 'Grade 9-A', 'Grade 8-B'],
    createdAt: now,
  };

  const teacher2: User = {
    id: 'teacher-002', name: 'Ms. Emily Chen', email: 'echen@campus.edu',
    role: 'teacher', assignedClasses: ['Grade 7-C', 'Grade 10-A'],
    createdAt: now,
  };

  const parent1: User = {
    id: 'parent-001', name: 'Michael Johnson', email: 'mjohnson@email.com',
    role: 'parent', phone1: '0612345678', phone2: '0612345679',
    xafada: 'Hodan', udow: 'Bakaaraha', 
    createdAt: now,
  };

  const parent2: User = {
    id: 'parent-002', name: 'Lisa Rodriguez', email: 'lrodriguez@email.com',
    role: 'parent', phone1: '0617654321', phone2: '0617654322',
    xafada: 'Warta Nabadda', udow: 'Km4 Junction',
createdAt: now,
  };

  const parent3: User = {
    id: 'parent-003', name: 'David Thompson', email: 'dthompson@email.com',
    role: 'parent', phone1: '0615551234', phone2: '0615551235',
    xafada: 'Dharkenley', udow: 'Ex-Control', 
    createdAt: now,
  };

  const users = [admin, teacher1, teacher2, parent1, parent2, parent3];

  // Students
  const students: Student[] = [
    { id: 'student-001', name: 'Emma Johnson', className: 'Grade 10-A', parentId: 'parent-001', createdAt: now },
    { id: 'student-002', name: 'Liam Johnson', className: 'Grade 8-B', parentId: 'parent-001', createdAt: now },
    { id: 'student-003', name: 'Sofia Rodriguez', className: 'Grade 10-A', parentId: 'parent-002', createdAt: now },
    { id: 'student-004', name: 'Noah Thompson', className: 'Grade 9-A', parentId: 'parent-003', createdAt: now },
    { id: 'student-005', name: 'Ava Thompson', className: 'Grade 7-C', parentId: 'parent-003', createdAt: now },
  ];

  // Comprehensive exam data for reports
  const subjects = ['Mathematics', 'English', 'Science', 'Somali', 'Islamic Studies'];
  const exams: Exam[] = [];
  let examCounter = 1;

  function addExam(
    studentId: string, subject: string, score: number, total: number,
    examType: ExamType, month: string, status: ExamStatus,
    parentId: string, teacherId: string, dateStr: string
  ) {
    exams.push({
      id: `exam-${String(examCounter++).padStart(3, '0')}`,
      studentId, subject, score, total, examType, month, status,
      parentId, date: dateStr, createdAt: now, teacherId,
    });
  }

  // ─── Student 1: Emma Johnson (Grade 10-A, parent-001) ───
  // January CA work
  subjects.forEach((sub, i) => {
    addExam('student-001', sub, [85, 78, 92, 88, 76][i], 100, 'CA', 'January', 'approved', 'parent-001', 'teacher-001', '2025-01-15');
    addExam('student-001', sub, [80, 82, 88, 85, 70][i], 100, 'Homework', 'January', 'approved', 'parent-001', 'teacher-001', '2025-01-20');
  });
  // February CA work
  subjects.forEach((sub, i) => {
    addExam('student-001', sub, [90, 85, 95, 82, 80][i], 100, 'CA', 'February', 'approved', 'parent-001', 'teacher-001', '2025-02-10');
    addExam('student-001', sub, [88, 80, 90, 86, 78][i], 100, 'Classwork', 'February', 'approved', 'parent-001', 'teacher-002', '2025-02-18');
    addExam('student-001', sub, [82, 76, 88, 84, 72][i], 100, 'Quiz', 'February', 'approved', 'parent-001', 'teacher-001', '2025-02-25');
  });
  // March - Midterm
  subjects.forEach((sub, i) => {
    addExam('student-001', sub, [88, 82, 94, 86, 78][i], 100, 'Midterm', 'March', 'approved', 'parent-001', 'teacher-001', '2025-03-15');
  });
  // April CA
  subjects.forEach((sub, i) => {
    addExam('student-001', sub, [92, 88, 96, 90, 82][i], 100, 'CA', 'April', 'approved', 'parent-001', 'teacher-001', '2025-04-10');
    addExam('student-001', sub, [86, 84, 90, 88, 80][i], 100, 'Homework', 'April', 'approved', 'parent-001', 'teacher-002', '2025-04-20');
  });
  // May - Final
  subjects.forEach((sub, i) => {
    addExam('student-001', sub, [90, 86, 95, 88, 80][i], 100, 'Final', 'May', 'approved', 'parent-001', 'teacher-001', '2025-05-20');
  });

  // ─── Student 2: Liam Johnson (Grade 8-B, parent-001) ───
  subjects.forEach((sub, i) => {
    addExam('student-002', sub, [72, 68, 80, 75, 65][i], 100, 'CA', 'January', 'approved', 'parent-001', 'teacher-001', '2025-01-15');
    addExam('student-002', sub, [70, 72, 78, 74, 60][i], 100, 'Homework', 'January', 'approved', 'parent-001', 'teacher-001', '2025-01-22');
  });
  subjects.forEach((sub, i) => {
    addExam('student-002', sub, [78, 74, 82, 80, 68][i], 100, 'CA', 'February', 'approved', 'parent-001', 'teacher-001', '2025-02-12');
    addExam('student-002', sub, [75, 70, 80, 76, 66][i], 100, 'Quiz', 'February', 'approved', 'parent-001', 'teacher-001', '2025-02-26');
  });
  subjects.forEach((sub, i) => {
    addExam('student-002', sub, [76, 72, 84, 78, 66][i], 100, 'Midterm', 'March', 'approved', 'parent-001', 'teacher-001', '2025-03-15');
  });
  subjects.forEach((sub, i) => {
    addExam('student-002', sub, [80, 76, 86, 82, 70][i], 100, 'CA', 'April', 'approved', 'parent-001', 'teacher-001', '2025-04-12');
  });
  subjects.forEach((sub, i) => {
    addExam('student-002', sub, [78, 74, 85, 80, 68][i], 100, 'Final', 'May', 'approved', 'parent-001', 'teacher-001', '2025-05-22');
  });

  // ─── Student 3: Sofia Rodriguez (Grade 10-A, parent-002) ───
  subjects.forEach((sub, i) => {
    addExam('student-003', sub, [95, 90, 88, 92, 86][i], 100, 'CA', 'January', 'approved', 'parent-002', 'teacher-001', '2025-01-15');
    addExam('student-003', sub, [92, 88, 85, 90, 84][i], 100, 'Homework', 'January', 'approved', 'parent-002', 'teacher-002', '2025-01-21');
  });
  subjects.forEach((sub, i) => {
    addExam('student-003', sub, [96, 92, 90, 94, 88][i], 100, 'CA', 'February', 'approved', 'parent-002', 'teacher-001', '2025-02-14');
    addExam('student-003', sub, [90, 86, 88, 92, 82][i], 100, 'Classwork', 'February', 'approved', 'parent-002', 'teacher-002', '2025-02-20');
  });
  subjects.forEach((sub, i) => {
    addExam('student-003', sub, [94, 90, 92, 96, 88][i], 100, 'Midterm', 'March', 'approved', 'parent-002', 'teacher-001', '2025-03-15');
  });
  subjects.forEach((sub, i) => {
    addExam('student-003', sub, [98, 94, 92, 96, 90][i], 100, 'CA', 'April', 'approved', 'parent-002', 'teacher-001', '2025-04-10');
  });
  subjects.forEach((sub, i) => {
    addExam('student-003', sub, [96, 92, 94, 98, 90][i], 100, 'Final', 'May', 'approved', 'parent-002', 'teacher-001', '2025-05-20');
  });

  // ─── Student 4: Noah Thompson (Grade 9-A, parent-003) ───
  subjects.forEach((sub, i) => {
    addExam('student-004', sub, [65, 70, 58, 72, 60][i], 100, 'CA', 'January', 'approved', 'parent-003', 'teacher-001', '2025-01-16');
    addExam('student-004', sub, [60, 68, 55, 70, 58][i], 100, 'Homework', 'January', 'approved', 'parent-003', 'teacher-001', '2025-01-23');
  });
  subjects.forEach((sub, i) => {
    addExam('student-004', sub, [70, 72, 62, 76, 64][i], 100, 'CA', 'February', 'approved', 'parent-003', 'teacher-001', '2025-02-11');
    addExam('student-004', sub, [68, 74, 60, 72, 62][i], 100, 'Quiz', 'February', 'approved', 'parent-003', 'teacher-001', '2025-02-24');
  });
  subjects.forEach((sub, i) => {
    addExam('student-004', sub, [72, 76, 64, 78, 66][i], 100, 'Midterm', 'March', 'approved', 'parent-003', 'teacher-001', '2025-03-16');
  });
  subjects.forEach((sub, i) => {
    addExam('student-004', sub, [74, 78, 66, 80, 68][i], 100, 'CA', 'April', 'pending', 'parent-003', 'teacher-001', '2025-04-14');
  });
  subjects.forEach((sub, i) => {
    addExam('student-004', sub, [70, 74, 62, 76, 64][i], 100, 'Final', 'May', 'pending', 'parent-003', 'teacher-001', '2025-05-21');
  });

  // ─── Student 5: Ava Thompson (Grade 7-C, parent-003) ───
  subjects.forEach((sub, i) => {
    addExam('student-005', sub, [88, 82, 90, 84, 78][i], 100, 'CA', 'January', 'approved', 'parent-003', 'teacher-002', '2025-01-17');
    addExam('student-005', sub, [85, 80, 88, 82, 76][i], 100, 'Classwork', 'January', 'approved', 'parent-003', 'teacher-002', '2025-01-24');
  });
  subjects.forEach((sub, i) => {
    addExam('student-005', sub, [90, 86, 92, 88, 82][i], 100, 'CA', 'February', 'approved', 'parent-003', 'teacher-002', '2025-02-13');
    addExam('student-005', sub, [86, 82, 90, 84, 78][i], 100, 'Quiz', 'February', 'approved', 'parent-003', 'teacher-002', '2025-02-27');
  });
  subjects.forEach((sub, i) => {
    addExam('student-005', sub, [88, 84, 92, 86, 80][i], 100, 'Midterm', 'March', 'approved', 'parent-003', 'teacher-002', '2025-03-17');
  });
  subjects.forEach((sub, i) => {
    addExam('student-005', sub, [92, 88, 94, 90, 84][i], 100, 'CA', 'April', 'approved', 'parent-003', 'teacher-002', '2025-04-11');
  });
  subjects.forEach((sub, i) => {
    addExam('student-005', sub, [90, 86, 94, 88, 82][i], 100, 'Final', 'May', 'approved', 'parent-003', 'teacher-002', '2025-05-22');
  });

  await bulkCreateUsers(users);
  await bulkCreateStudents(students);
  await bulkCreateExams(exams);
}

export async function clearDatabase(): Promise<void> {
  await supabase.from('exams').delete().neq('id', '');
  await supabase.from('students').delete().neq('id', '');
  await supabase.from('users').delete().neq('id', '');
}
