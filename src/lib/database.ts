import type { User, Exam, Role, Term, GradeScale, ReportConfig, MonthlyScore, MidtermReport, MidtermScore, FinalReport } from '../types';
import { getGrade } from '../types';
import { getStudentById } from './db/students';
import { supabase } from './supabase';

const isDev = import.meta.env?.MODE !== 'production';
const MAX_QUERY_LIMIT = 500;

function debug(...args: unknown[]) {
  if (isDev) console.debug(...args);
}

// devLog intentionally removed to avoid unused warnings; use `debug` for development logging

function applyLimit(query: any, limit: number) {
  if (typeof query.limit === 'function') {
    return query.limit(Math.min(limit, MAX_QUERY_LIMIT));
  }
  return query;
}

export {
  getExams,
  getExamsPaginated,
  getExamCount,
  getExamsByStudent,
  getExamsByParent,
  getExamsByTeacher,
  getExamsByStatus,
  createExam,
  updateExamStatus,
  approveAllPendingExams,
  approvePendingExamsForClasses,
  updateExam,
  deleteExam,
} from './db/exams';

export {
  bulkCreateUsers,
  bulkCreateStudents,
  bulkCreateExams,
} from './db/bulk';

export { getTeacherExamProgress } from './db/progress';
export {
  getClassSubjects,
  createClassSubject,
  updateClassSubject,
  deleteClassSubject,
} from './db/classes';

export {
  getClassSubjectsForTeacher,
  getClassAssignmentsForTeacher,
  getClasses,
} from './db/classes';

export {
  getAcademicYears,
  createAcademicYear,
  updateAcademicYear,
  deleteAcademicYear,
  getTerms,
  createTerm,
  updateTerm,
  deleteTerm,

} from './db/academic';

export {
  getReportComment,
  upsertReportComment,
  getReportCommentsForStudentTerm,
} from './db/reports';

export {
  getSubjects,
  createSubject,
  updateSubject,
  deleteSubject,
} from './db/subjects';

export async function logAllClassSubjects(limit: number = 100) {
  if (!isDev) {
    console.warn('logAllClassSubjects is disabled in production');
    return [];
  }

  const from = 0;
  const to = Math.max(0, limit - 1);
  const { data, error } = await supabase.from('class_subjects').select('*').range(from, to);
  if (error) {
    console.error('Error fetching class_subjects:', error);
    return [];
  }
  debug(`class_subjects rows (first ${limit}):`, data);
  return data || [];
}

// getClassAssignmentsForTeacher moved to src/lib/db/classes.ts

export async function getSystemStats() {
  const { data: users, error: usersError } = await supabase.from('users').select('id, role');
  if (usersError) throw usersError;
  const userRows = (users || []) as Array<{ id: string; role: string }>;

  const { data: students, error: studentsError } = await supabase.from('students').select('id');
  if (studentsError) throw studentsError;
  const studentRows = students || [];

  const { data: exams, error: examsError } = await supabase.from('exams').select('id, status, score, total');
  if (examsError) throw examsError;
  const examRows = (exams || []) as Array<{ status: string; score: number; total: number }>;

  const totalTeachers = userRows.filter((user) => user.role === 'teacher').length;
  const totalParents = userRows.filter((user) => user.role === 'parent').length;
  const totalStudents = studentRows.length;
  const totalExams = examRows.length;
  const pendingExams = examRows.filter((exam) => exam.status === 'pending').length;
  const approvedExams = examRows.filter((exam) => exam.status === 'approved').length;
  const rejectedExams = examRows.filter((exam) => exam.status === 'rejected').length;

  const averageScore = examRows.length > 0
    ? Math.round(
      examRows.reduce((sum, exam) => sum + (exam.total ? (exam.score / exam.total) * 100 : 0), 0) / examRows.length * 100,
    ) / 100
    : 0;

  return {
    totalTeachers,
    totalParents,
    totalStudents,
    totalExams,
    pendingExams,
    approvedExams,
    rejectedExams,
    averageScore,
  };
}

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
    { email: 'teacher@scholo.com', password: 'teacher123', name: 'Prof. James Wilson', role: 'teacher' as const, assignedClasses: ['Grade 10-A', 'Grade 9-A', 'Grade 8-B'], assignedSubjects: ['Mathematics', 'English', 'Science'] },
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
        debug(`Demo account for ${user.email} already exists`);
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

      debug(`Created demo account for ${user.email}`);
    } catch (error) {
      console.error(`Error creating demo account for ${user.email}:`, error);
    }
  }
}

export async function seedDatabase(): Promise<void> {
  console.warn('seedDatabase: not implemented in this environment');
}

export async function isSeeded(): Promise<boolean> {
  try {
    const { data } = await supabase.from('users').select('id').limit(1).maybeSingle();
    return !!data;
  } catch (e) {
    return false;
  }
}

// ── Users ──
export async function getUsers(limit: number = MAX_QUERY_LIMIT): Promise<User[]> {
  const { data, error } = await applyLimit(supabase.from('users').select('*'), limit);
  if (error) throw error;
  return data || [];
}

export async function getUsersPaginated(page: number = 1, limit: number = 10, search?: string): Promise<{ users: User[], total: number }> {
  const from = (page - 1) * limit;
  const to = from + limit - 1;

  let query = supabase
    .from('users')
    .select('*', { count: 'exact' });

  if (search && search.trim()) {
    query = query.or(`name.ilike.%${search}%,email.ilike.%${search}%`);
  }

  const { data, error, count } = await query.range(from, to);

  if (error) throw error;
  return { users: data || [], total: count || 0 };
}

export async function getUsersByRole(role: Role, page: number = 1, limit: number = 100): Promise<User[]> {
  // Be tolerant of role casing/whitespace stored in the DB by fetching a page
  // of users and filtering client-side. This avoids missing users when role
  // values are stored inconsistently (e.g. ' Teacher', 'TEACHER', etc.).
  const from = (page - 1) * limit;
  const to = from + limit - 1;

  const { data, error } = await supabase.from('users').select('*', { count: 'exact' }).range(from, to);
  if (error) throw error;
  const rows = (data || []) as User[];
  return rows.filter(u => String(u.role || '').toLowerCase().trim() === String(role).toLowerCase().trim());
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
  // ensure correct column casing: update `parentId` to null for matching students
  await supabase.from('students').update({ parentId: null }).eq('parentId', id);
  return true;
}

// ── New Schema Functions ──
// getAcademicYears moved to src/lib/db/academic.ts

export async function getCurrentTerm(): Promise<Term | null> {
  const { data, error } = await supabase
    .from('terms')
    .select('*, academic_years(*)')
    .eq('isCurrent', true)
    .single();
  if (error) return null;
  return data;
}



export async function getGradeScales(): Promise<GradeScale[]> {
  const { data, error } = await supabase.from('grade_scales').select('*');
  if (error) throw error;
  return data || [];
}

export async function getReportConfig(): Promise<ReportConfig> {
  const { data, error } = await supabase
    .from('report_config')
    .select('*')
    .eq('id', 'default')
    .single();
  if (error) throw error;
  return data;
}

// RPC functions for reports
export async function getMonthlyReport(
  studentId: string,
  termId: string
): Promise<MonthlyScore[]> {
  const { data, error } = await supabase.rpc('get_monthly_report', {
    p_student_id: studentId,
    p_term_id: termId,
  });
  if (error) throw error;
  return data;
}

export async function getMidtermReport(
  studentId: string,
  termId: string
): Promise<MidtermReport> {
  const { data, error } = await supabase.rpc('get_midterm_report', {
    p_student_id: studentId,
    p_term_id: termId,
  });

  if (!error) return data;

  const isMissingRpc = error.code === 'PGRST202'
    || (error as any).status === 404
    || (typeof error.message === 'string' && error.message.includes('Not Found'))
    || (typeof error.details === 'string' && error.details.includes('get_midterm_report'));

  if (isMissingRpc) {
    return getMidtermReportFallback(studentId, termId);
  }

  throw error;
}

async function getMidtermReportFallback(studentId: string, termId: string): Promise<MidtermReport> {
  const student = await getStudentById(studentId);
  if (!student) {
    return { scores: [], overall_rank: 0, total_students: 0 };
  }

  const [studentExamsResult, classStudentsResult] = await Promise.all([
    supabase
      .from('exams')
      .select('id, studentId, subject, score, total')
      .eq('studentId', studentId)
      .eq('termId', termId)
      .eq('examType', 'Midterm')
      .eq('status', 'approved')
      .returns<Exam[]>(),
    supabase
      .from('students')
      .select('id')
      .eq('className', student.className)
      .returns<{ id: string }[]>(),
  ]);

  const { data: studentExams, error: studentError } = studentExamsResult;
  const { data: classStudents, error: classError } = classStudentsResult;

  if (studentError) throw studentError;
  if (classError) throw classError;

  const classStudentIds = classStudents?.map(s => s.id) ?? [];

  const { data: classExams, error: classExamsError } = classStudentIds.length > 0
    ? await supabase
        .from('exams')
        .select('id, studentId, subject, score, total')
        .in('studentId', classStudentIds)
        .eq('termId', termId)
        .eq('examType', 'Midterm')
        .eq('status', 'approved')
        .returns<Exam[]>()
    : { data: [], error: null };

  if (classExamsError) throw classExamsError;

  const bySubject = new Map<string, MidtermScore>();

  for (const e of studentExams ?? []) {
    const percentage = e.total > 0 ? Math.round((e.score / e.total) * 100) : 0;
    const grade = getGrade(percentage);
    const remark = grade === 'A' ? 'Excellent' : grade === 'B' ? 'Very Good' : grade === 'C' ? 'Good' : grade === 'D' ? 'Satisfactory' : 'Needs Improvement';

    const sameSubjectClass = (classExams ?? []).filter(ex => ex.subject === e.subject);
    const classAvg = sameSubjectClass.length
      ? Math.round(sameSubjectClass.reduce((sum, ex) => sum + (ex.total > 0 ? (ex.score / ex.total) * 100 : 0), 0) / sameSubjectClass.length)
      : 0;

    const highestInClass = sameSubjectClass.length
      ? Math.max(...sameSubjectClass.map(ex => (ex.total > 0 ? Math.round((ex.score / ex.total) * 100) : 0)))
      : 0;

    const sortedSubject = [...sameSubjectClass]
      .map(ex => (ex.total > 0 ? Math.round((ex.score / ex.total) * 100) : 0))
      .sort((a, b) => b - a);

    const subjectRank = sortedSubject.indexOf(percentage) + 1;

    bySubject.set(e.subject, {
      subject: e.subject,
      score: e.score,
      total: e.total,
      percentage,
      grade,
      remark,
      subject_rank: subjectRank || 1,
      class_average: classAvg,
      highest_in_class: highestInClass,
      examId: e.id,
    });
  }

  const scores = Array.from(bySubject.values());

  const studentAverage = scores.length
    ? Math.round(scores.reduce((sum, s) => sum + s.percentage, 0) / scores.length)
    : 0;

  const classAverages = new Map<string, number>();
  for (const sid of classStudentIds) {
    const exams = (classExams ?? []).filter(ex => ex.studentId === sid);
    const pct = exams.length
      ? Math.round(exams.reduce((sum, ex) => sum + (ex.total > 0 ? (ex.score / ex.total) * 100 : 0), 0) / exams.length)
      : 0;
    classAverages.set(sid, pct);
  }

  const sortedClassAverages = [...classAverages.values()].sort((a, b) => b - a);
  const overall_rank = sortedClassAverages.indexOf(studentAverage) + 1;
  const total_students = classAverages.size;

  return { scores, overall_rank: overall_rank || 0, total_students };
}

export async function getFinalReport(
  studentId: string,
  termId: string
): Promise<FinalReport> {
  const { data, error } = await supabase.rpc('get_final_report', {
    p_student_id: studentId,
    p_term_id: termId,
  });
  if (error) throw error;
  return data;
}

// ── Students (moved to src/lib/db/students.ts) ──
export {
  getStudents,
  getStudentsPaginated,
  getStudentById,
  getStudentsByParent,
  getStudentsByClass,
  getStudentsByIds,
  getStudentsByClasses,
  createStudent,
  updateStudent,
  deleteStudent,
} from './db/students';



// ── Subjects ──
