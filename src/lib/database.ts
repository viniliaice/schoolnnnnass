import { User, Student, Exam, ExamStatus, ExamType, Role, AcademicYear, Term, Subject, GradeScale, ReportConfig, MonthlyScore, MidtermReport, MidtermScore, FinalReport, getGrade, ReportComment } from '../types';
import { supabase } from './supabase';

const isDev = import.meta.env?.MODE !== 'production';
const MAX_QUERY_LIMIT = 500;

function debug(...args: unknown[]) {
  if (isDev) console.debug(...args);
}

function devLog(...args: unknown[]) {
  if (isDev) console.log(...args);
}

function applyLimit(query: any, limit: number) {
  if (typeof query.limit === 'function') {
    return query.limit(Math.min(limit, MAX_QUERY_LIMIT));
  }
  return query;
}

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

export async function getClassAssignmentsForTeacher(teacherId: string): Promise<{ className: string, subjectId: string }[]> {
  const { data, error } = await supabase
    .from('class_subjects')
    .select('className, subjectId')
    .eq('teacherId', teacherId);
  if (error) return [];
  return data || [];
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
  const from = (page - 1) * limit;
  const to = from + limit - 1;

  const { data, error } = await supabase.from('users').select('*', { count: 'exact' }).eq('role', role).range(from, to);
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

// ── New Schema Functions ──
export async function getAcademicYears(): Promise<AcademicYear[]> {
  const { data, error } = await supabase.from('academic_years').select('*');
  if (error) throw error;
  return data || [];
}

export async function getCurrentTerm(): Promise<Term | null> {
  const { data, error } = await supabase
    .from('terms')
    .select('*, academic_years(*)')
    .eq('isCurrent', true)
    .single();
  if (error) return null;
  return data;
}

export async function getSubjects(): Promise<Subject[]> {
  const { data, error } = await supabase.from('subjects').select('*');
  if (error) throw error;
  return data || [];
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
    || error.status === 404
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

// ── Students ──
export async function getStudents(limit: number = MAX_QUERY_LIMIT): Promise<Student[]> {
  const { data, error } = await applyLimit(supabase.from('students').select('*'), limit);
  if (error) throw error;
  return data || [];
}

export async function getStudentsPaginated(page: number = 1, limit: number = 50, search?: string): Promise<{ students: Student[], total: number }> {
  const from = (page - 1) * limit;
  const to = from + limit - 1;

  let query = supabase
    .from('students')
    .select('*', { count: 'exact' });

  if (search && search.trim()) {
    query = query.ilike('name', `%${search}%`);
  }

  const { data, error, count } = await query.range(from, to);

  if (error) throw error;
  return { students: data || [], total: count || 0 };
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


export async function getStudentsByClass(className: string, limit: number = 100): Promise<Student[]> {
  const { data, error } = await applyLimit(supabase.from('students').select('*').eq('className', className), limit);
  if (error) throw error;
  return data || [];
}

export async function getStudentsByIds(ids: string[], limit: number = MAX_QUERY_LIMIT): Promise<Student[]> {
  if (!Array.isArray(ids) || ids.length === 0) return [];
  const { data, error } = await applyLimit(supabase.from('students').select('*').in('id', ids), limit);
  if (error) throw error;
  return data || [];
}

export async function getStudentsByClasses(classnames: string[], search?: string, limit: number = MAX_QUERY_LIMIT): Promise<Student[]> {
  let query = applyLimit(supabase.from('students').select('*'), limit);
  if (classnames && classnames.length > 0) {
    query = query.in('className', classnames);
  }
  if (search && search.trim()) {
    query = query.ilike('name', `%${search}%`);
  }
  const { data, error } = await query;
  if (error) throw error;
  return data || [];
}

// Return distinct list of classes from students table
export async function getClasses(): Promise<string[]> {
  const { data, error } = await supabase.from('students').select('className');
  if (error) throw error;
  const rows = (data || []) as Array<{ className?: string }>;
  const classes = Array.from(new Set(rows.map(r => r.className).filter(Boolean)));
  classes.sort();
  return classes;
}




// ── Subjects ──
export async function getSubjectById(id: string): Promise<Subject | null> {
  const { data, error } = await supabase.from('subjects').select('*').eq('id', id).single();
  if (error) return null;
  return data;
}

export async function createSubject(data: Omit<Subject, 'id' | 'createdAt'>): Promise<Subject> {
  const timestamp = Date.now();
  const id = `subject-${timestamp}-${Math.random().toString(36).slice(2, 8)}`;
  const item = { id, ...data, createdAt: new Date().toISOString() };
  const { data: created, error } = await supabase.from('subjects').insert(item).select().single();
  if (error) throw error;
  return created;
}

export async function updateSubject(id: string, data: Partial<Subject>): Promise<Subject | null> {
  const { data: updated, error } = await supabase.from('subjects').update(data).eq('id', id).select().single();
  if (error) return null;
  return updated;
}

export async function deleteSubject(id: string): Promise<boolean> {
  const { error } = await supabase.from('subjects').delete().eq('id', id);
  return !error;
}

// ── Academic Years ──
export async function createAcademicYear(data: Omit<AcademicYear, 'id' | 'createdAt'>): Promise<AcademicYear> {
  const timestamp = Date.now();
  const id = `year-${timestamp}-${Math.random().toString(36).slice(2, 8)}`;
  const item = { id, ...data, createdAt: new Date().toISOString() };
  const { data: created, error } = await supabase.from('academic_years').insert(item).select().single();
  if (error) throw error;
  return created;
}

export async function updateAcademicYear(id: string, data: Partial<AcademicYear>): Promise<AcademicYear | null> {
  const { data: updated, error } = await supabase.from('academic_years').update(data).eq('id', id).select().single();
  if (error) return null;
  return updated;
}

export async function deleteAcademicYear(id: string): Promise<boolean> {
  const { error } = await supabase.from('academic_years').delete().eq('id', id);
  return !error;
}

// ── Terms ──
export async function getTerms(): Promise<Term[]> {
  const { data, error } = await supabase.from('terms').select('*, academic_years(*)').order('startDate', { ascending: false });
  if (error) throw error;
  return data || [];
}

export async function createTerm(data: Omit<Term, 'id' | 'createdAt'>): Promise<Term> {
  const timestamp = Date.now();
  const id = `term-${timestamp}-${Math.random().toString(36).slice(2, 8)}`;
  const item = { id, ...data, months: data.months || [], createdAt: new Date().toISOString() };
  const { data: created, error } = await supabase.from('terms').insert(item).select().single();
  if (error) throw error;
  return created;
}
export async function updateTerm(id: string, data: Partial<Term>): Promise<Term | null> {
  const { data: updated, error } = await supabase.from('terms').update(data).eq('id', id).select().single();
  if (error) return null;
  return updated;
}

export async function deleteTerm(id: string): Promise<boolean> {
  const { error } = await supabase.from('terms').delete().eq('id', id);
  return !error;
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
  const { data, error } = await applyLimit(supabase.from('exams').select('*'), 100);
  if (error) throw error;
  return data || [];
}

export async function getExamsPaginated(
  page: number = 1,
  limit: number = 100,
  statusFilter: ExamStatus | 'all' = 'all',
  studentIds?: string[],
  subjectFilter?: string,
  search?: string
): Promise<{ exams: Exam[]; total: number }> {
  const from = (page - 1) * limit;
  const to = from + limit - 1;
  let query: any = supabase.from('exams').select('*', { count: 'exact' });

  if (statusFilter !== 'all') query = query.eq('status', statusFilter);
  if (studentIds && studentIds.length > 0) query = query.in('studentId', studentIds);
  if (subjectFilter && subjectFilter !== 'All') query = query.eq('subject', subjectFilter);
  if (search && search.trim()) query = query.ilike('subject', `%${search}%`);

  const { data, error, count } = await query.range(from, to);
  if (error) throw error;
  return { exams: data || [], total: count || 0 };
}

export async function getExamCount(
  statusFilter: ExamStatus | 'all' = 'all',
  studentIds?: string[],
  subjectFilter?: string,
  search?: string
): Promise<number> {
  let query: any = supabase.from('exams').select('id', { count: 'exact', head: true });

  if (statusFilter !== 'all') query = query.eq('status', statusFilter);
  if (studentIds && studentIds.length > 0) query = query.in('studentId', studentIds);
  if (subjectFilter && subjectFilter !== 'All') query = query.eq('subject', subjectFilter);
  if (search && search.trim()) query = query.ilike('subject', `%${search}%`);

  const { count, error } = await query;
  if (error) throw error;
  return count || 0;
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

// Approve all exams currently pending
export async function approveAllPendingExams(): Promise<Exam[] | null> {
  const { data, error } = await supabase.from('exams').update({ status: 'approved' }).eq('status', 'pending').select();
  if (error) return null;
  return data || [];
}

export async function approvePendingExamsForClasses(classNames: string[]): Promise<Exam[] | null> {
  if (!Array.isArray(classNames) || classNames.length === 0) return [];

  const students = await getStudentsByClasses(classNames);
  const studentIds = students.map(s => s.id);
  if (studentIds.length === 0) return [];

  const { data, error } = await supabase
    .from('exams')
    .update({ status: 'approved' })
    .in('studentId', studentIds)
    .eq('status', 'pending')
    .select();

  if (error) return null;
  return data || [];
}

// Allow admin to edit an exam record
export async function updateExam(id: string, data: Partial<Exam>): Promise<Exam | null> {
  const { data: updated, error } = await supabase.from('exams').update(data).eq('id', id).select().single();
  if (error) return null;
  return updated;
}

// Report comments (teacher/principal remarks)
export async function getReportComment(studentId: string, termId: string, examId?: string): Promise<ReportComment | null> {
  let query = supabase.from('report_comments').select('*').eq('studentId', studentId).eq('termId', termId);
  if (examId) query = query.eq('examId', examId);
  const { data, error } = await query.maybeSingle();
  if (error) return null;
  return data || null;
}

export async function upsertReportComment(comment: Omit<ReportComment, 'id' | 'createdAt'>): Promise<ReportComment | null> {
  if (!comment.examId) {
    throw new Error('examId is required to allow multiple comments for different subjects.');
  }

  const { data: existing, error: findError } = await supabase
    .from('report_comments')
    .select('id')
    .eq('studentId', comment.studentId)
    .eq('termId', comment.termId)
    .eq('examId', comment.examId)
    .maybeSingle();

  if (findError) return null;

  if (existing?.id) {
    const { data, error } = await supabase.from('report_comments').update(comment).eq('id', existing.id).select().single();
    if (error) return null;
    return data || null;
  }

  const id = `rc-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const item = { id, ...comment, createdAt: new Date().toISOString() } as any;
  const { data, error } = await supabase.from('report_comments').insert(item).select().single();
  if (error) return null;
  return data || null;
}

// Return subjects for a class optionally filtered by teacher assignment
export async function getClassSubjectsForTeacher(teacherId?: string, className?: string): Promise<Subject[]> {
  // Attempt to join class_subjects -> subjects
  let query = supabase.from('class_subjects').select('subjectId, teacherId, className, subjects(*)');
  if (teacherId) query = query.eq('teacherId', teacherId);
  if (className) query = query.eq('className', className);
  const { data, error } = await query;
  if (error) return [];
  const rows: any[] = data || [];
  const subjects = rows.map(r => r.subjects).filter(Boolean) as Subject[];
  return subjects;
}

// CRUD for class_subjects
export async function getClassSubjects(): Promise<any[]> {
  const { data, error } = await supabase.from('class_subjects').select('id, className, teacherId, subjectId, subjects(name), users(name)');
  if (error) return [];
  return data || [];
}

export async function createClassSubject(item: { className: string; subjectId: string; teacherId?: string }) {
  const id = `cs-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const payload = { id, ...item, createdAt: new Date().toISOString() } as any;
  const { data, error } = await supabase.from('class_subjects').insert(payload).select().single();
  if (error) throw error;
  return data;
}

export async function updateClassSubject(id: string, dataObj: Partial<{ className: string; subjectId: string; teacherId?: string }>) {
  const { data, error } = await supabase.from('class_subjects').update(dataObj).eq('id', id).select().single();
  if (error) throw error;
  return data;
}

export async function deleteClassSubject(id: string) {
  const { error } = await supabase.from('class_subjects').delete().eq('id', id);
  if (error) throw error;
  return true;
}

// Fetch all report comments for a student & term
export async function getReportCommentsForStudentTerm(studentId: string, termId: string): Promise<ReportComment[]> {
  const { data, error } = await supabase
    .from('report_comments')
    .select('id, studentId, termId, examId, teacherComment, principalComment, teacherId, createdAt')
    .eq('studentId', studentId)
    .eq('termId', termId);
  if (error) return [];
  return data || [];
}

// Update the report configuration (admin only)
export async function updateReportConfig(data: Partial<ReportConfig>): Promise<ReportConfig | null> {
  const { data: updated, error } = await supabase.from('report_config').update(data).eq('id', 'default').select().single();
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
  const [teachersResult, parentsResult, totalStudentsResult, totalExamsResult, pendingExamsResult, approvedExamsResult, rejectedExamsResult, examScoreResult] = await Promise.all([
    supabase.from('users').select('id', { count: 'exact', head: true }).eq('role', 'teacher'),
    supabase.from('users').select('id', { count: 'exact', head: true }).eq('role', 'parent'),
    supabase.from('students').select('id', { count: 'exact', head: true }),
    supabase.from('exams').select('id', { count: 'exact', head: true }),
    supabase.from('exams').select('id', { count: 'exact', head: true }).eq('status', 'pending'),
    supabase.from('exams').select('id', { count: 'exact', head: true }).eq('status', 'approved'),
    supabase.from('exams').select('id', { count: 'exact', head: true }).eq('status', 'rejected'),
    supabase.from('exams').select('score, total'),
  ]);

  if (teachersResult.error) throw teachersResult.error;
  if (parentsResult.error) throw parentsResult.error;
  if (totalStudentsResult.error) throw totalStudentsResult.error;
  if (totalExamsResult.error) throw totalExamsResult.error;
  if (pendingExamsResult.error) throw pendingExamsResult.error;
  if (approvedExamsResult.error) throw approvedExamsResult.error;
  if (rejectedExamsResult.error) throw rejectedExamsResult.error;
  if (examScoreResult.error) throw examScoreResult.error;

  const scoreRows = examScoreResult.data || [];
  const averageScore = scoreRows.length > 0
    ? Math.round(scoreRows.reduce((sum, exam) => sum + (exam.total > 0 ? (exam.score / exam.total) * 100 : 0), 0) / scoreRows.length)
    : 0;

  return {
    totalTeachers: teachersResult.count ?? 0,
    totalParents: parentsResult.count ?? 0,
    totalStudents: totalStudentsResult.count ?? 0,
    totalExams: totalExamsResult.count ?? 0,
    pendingExams: pendingExamsResult.count ?? 0,
    approvedExams: approvedExamsResult.count ?? 0,
    rejectedExams: rejectedExamsResult.count ?? 0,
    averageScore,
  };
}

// ── Seeding ──
export async function isSeeded(): Promise<boolean> {
  const { data, error } = await supabase.from('users').select('id').limit(1);
  if (error) return false;
  return Boolean(data?.length);
}
