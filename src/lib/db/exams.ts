import { supabase } from '../supabase';
import { getStudentIdsByClasses } from './students';
import { Exam, ExamStatus } from '../../types';

const DEFAULT_EXAM_PAGE_SIZE = 60;
const MAX_QUERY_LIMIT = 10000;

function applyLimit(query: any, limit: number) {
  if (typeof query.limit === 'function') {
    return query.limit(Math.min(limit, MAX_QUERY_LIMIT));
  }
  return query;
}

export interface ExamStatusCounts {
  all: number;
  pending: number;
  approved: number;
  rejected: number;
}

export async function getExams(): Promise<Exam[]> {
  const { data, error } = await applyLimit(
    supabase.from('exams').select('id,studentId,subject,subjectId,score,total,examType,assessmentLabel,entryState,termId,month,status,parentId,date,createdAt,teacherId,uploadedBy'),
    100
  );
  if (error) throw error;
  return data || [];
}

async function getExamStudentIds(classNames?: string[] | null): Promise<string[] | undefined> {
  if (!classNames || classNames.length === 0) return undefined;
  const studentIds = await getStudentIdsByClasses(classNames);
  return studentIds.length > 0 ? studentIds : [];
}

export async function getExamStatusCounts(
  studentIds?: string[],
  classNames?: string[],
  subjectFilter?: string,
  search?: string
): Promise<ExamStatusCounts> {
  const filterStudentIds = studentIds && studentIds.length > 0 ? studentIds : await getExamStudentIds(classNames);

  if (classNames && classNames.length > 0 && (!filterStudentIds || filterStudentIds.length === 0)) {
    return { all: 0, pending: 0, approved: 0, rejected: 0 };
  }

  const classNamesArg = classNames && classNames.length > 0 ? classNames : null;
  const subjectArg = subjectFilter && subjectFilter !== 'All' ? subjectFilter : null;
  const searchArg = search && search.trim() ? search.trim() : null;
  const studentIdsArg = filterStudentIds && filterStudentIds.length > 0 ? filterStudentIds : null;

  try {
    const { data, error } = await supabase.rpc('get_exam_status_counts', {
      class_names: classNamesArg,
      student_ids: studentIdsArg,
      subject_filter: subjectArg,
      search_filter: searchArg,
    });

    if (error) throw error;

    const counts: ExamStatusCounts = { all: 0, pending: 0, approved: 0, rejected: 0 };
    for (const row of (data || []) as Array<{ status: string; count: string | number }>) {
      const count = Number(row.count) || 0;
      counts[row.status as keyof Omit<ExamStatusCounts, 'all'>] = count;
      counts.all += count;
    }

    return counts;
  } catch (rpcError) {
    // Fallback for environments where the RPC function has not been installed.
    const countArgs = {
      studentIds: filterStudentIds,
      subjectFilter,
      search,
    };

    const [pending, approved, rejected] = await Promise.all([
      getExamCount('pending', countArgs.studentIds, countArgs.subjectFilter, countArgs.search),
      getExamCount('approved', countArgs.studentIds, countArgs.subjectFilter, countArgs.search),
      getExamCount('rejected', countArgs.studentIds, countArgs.subjectFilter, countArgs.search),
    ]);

    return {
      all: pending + approved + rejected,
      pending,
      approved,
      rejected,
    };
  }
}

export async function getExamSubjectsByClasses(classNames: string[]): Promise<string[]> {
  if (!classNames || classNames.length === 0) return [];

  const { data, error } = await supabase
    .from('exams')
    .select('subject')
    .in('studentId', (
      await supabase
        .from('students')
        .select('id')
        .in('className', classNames)
    ).data?.map((s: any) => s.id) || [])
    .limit(200);

  if (error) throw error;

  return Array.from(new Set((data || []).map((row: any) => row.subject).filter(Boolean))).sort();
}

export async function getExamsPaginated(
  page: number = 1,
  limit: number = DEFAULT_EXAM_PAGE_SIZE,
  statusFilter: ExamStatus | 'all' = 'all',
  studentIds?: string[],
  subjectFilter?: string,
  search?: string,
  classNames?: string[]
): Promise<{ exams: Exam[]; total: number }> {
  const from = (page - 1) * limit;
  const to = from + limit - 1;
  const selectFields = 'id,studentId,subject,subjectId,score,total,examType,assessmentLabel,entryState,termId,month,status,parentId,date,createdAt,teacherId,uploadedBy';
  const filterStudentIds = studentIds && studentIds.length > 0 ? studentIds : await getExamStudentIds(classNames);

  if (classNames && classNames.length > 0 && (!filterStudentIds || filterStudentIds.length === 0)) {
    return { exams: [], total: 0 };
  }

  let query: any = supabase.from('exams').select(selectFields, { count: 'exact' });

  if (statusFilter !== 'all') query = query.eq('status', statusFilter);
  if (filterStudentIds && filterStudentIds.length > 0) query = query.in('studentId', filterStudentIds);
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
  const { data, error } = await supabase
    .from('exams')
    .select('id,studentId,subject,subjectId,score,total,examType,assessmentLabel,entryState,termId,month,status,parentId,date,createdAt,teacherId,uploadedBy')
    .eq('studentId', studentId);
  if (error) throw error;
  return data || [];
}

export async function getExamsByParent(parentId: string, statusFilter?: ExamStatus): Promise<Exam[]> {
  let query = supabase
    .from('exams')
    .select('id,studentId,subject,subjectId,score,total,examType,assessmentLabel,entryState,termId,month,status,parentId,date,createdAt,teacherId,uploadedBy')
    .eq('parentId', parentId);
  if (statusFilter) query = query.eq('status', statusFilter);
  const { data, error } = await query;
  if (error) throw error;
  return data || [];
}

export async function getExamsByTeacher(teacherId: string): Promise<Exam[]> {
  const { data, error } = await supabase
    .from('exams')
    .select('id,studentId,subject,subjectId,score,total,examType,assessmentLabel,entryState,termId,month,status,parentId,date,createdAt,teacherId,uploadedBy')
    .eq('teacherId', teacherId);
  if (error) throw error;
  return data || [];
}

export async function getExamsByStatus(status: ExamStatus): Promise<Exam[]> {
  const { data, error } = await supabase
    .from('exams')
    .select('id,studentId,subject,subjectId,score,total,examType,assessmentLabel,entryState,termId,month,status,parentId,date,createdAt,teacherId,uploadedBy')
    .eq('status', status);
  if (error) throw error;
  return data || [];
}

export async function createExam(data: Omit<Exam, 'id' | 'created_At'>): Promise<Exam> {
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

export async function approveAllPendingExams(): Promise<Exam[] | null> {
  const { data, error } = await supabase.from('exams').update({ status: 'approved' }).eq('status', 'pending').select();
  if (error) return null;
  return data || [];
}

export async function approvePendingExamsForClasses(classNames: string[]): Promise<Exam[] | null> {
  if (!Array.isArray(classNames) || classNames.length === 0) return [];

  const { data: students, error: studentError } = await supabase.from('students').select('id').in('className', classNames);
  if (studentError) throw studentError;

  const studentIds = (students || []).map((s: any) => s.id);
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

export async function updateExam(id: string, data: Partial<Exam>): Promise<Exam | null> {
  const { data: updated, error } = await supabase.from('exams').update(data).eq('id', id).select().single();
  if (error) return null;
  return updated;
}

export async function deleteExam(id: string): Promise<boolean> {
  const { error } = await supabase.from('exams').delete().eq('id', id);
  return !error;
}

// ─── Admin Grade Correction: server-side filtered grade search ────────────────

export interface GradeSearchRow {
  id: string;
  studentId: string;
  studentName: string;
  className: string;
  govId: string | null;
  subject: string;
  subjectId: string | null;
  assessmentLabel: string | null;
  examType: string;
  score: number | null;
  total: number;
  entryState: 'scored' | 'absent' | 'not_applicable';
  status: ExamStatus;
  month: string;
  date: string;
  termId: string | null;
  teacherId: string | null;
  uploadedBy: string | null;
}

export interface GradeSearchParams {
  classNames?: string[];
  subject?: string;          // subject display name (exams.subject)
  assessmentLabel?: string;  // e.g. 'CPW1'
  termId?: string;
  month?: string;
  status?: ExamStatus | 'all';
  studentSearch?: string;    // matches student name / id / govId
  page?: number;
  pageSize?: number;
}

/**
 * Server-side filtered/paginated grade search for the Admin Grade Correction
 * page. Filtering happens in the database (never "load everything and filter in
 * React"). Student identity fields (name / id / govId) are resolved through the
 * students table so the admin can search by any of them; the returned rows carry
 * the exact exam.id used by the correction RPC.
 */
export async function searchGradesForCorrection(
  params: GradeSearchParams,
): Promise<{ rows: GradeSearchRow[]; total: number }> {
  const page = Math.max(1, params.page ?? 1);
  const pageSize = Math.min(params.pageSize ?? 50, 200);

  // Resolve the candidate student set from class + student search, in the DB.
  let studentQuery: any = supabase.from('students').select('id,name,className,govId');
  if (params.classNames && params.classNames.length > 0) {
    studentQuery = studentQuery.in('className', params.classNames);
  }
  const term = params.studentSearch?.trim();
  if (term) {
    const like = `%${term}%`;
    studentQuery = studentQuery.or(`name.ilike.${like},id.ilike.${like},govId.ilike.${like}`);
  }
  studentQuery = studentQuery.limit(MAX_QUERY_LIMIT);
  const { data: studentRows, error: studentError } = await studentQuery;
  if (studentError) throw studentError;

  const students = (studentRows || []) as Array<{ id: string; name: string; className: string; govId: string | null }>;
  if ((params.classNames && params.classNames.length > 0 || term) && students.length === 0) {
    return { rows: [], total: 0 };
  }
  const studentById = new Map(students.map(s => [s.id, s]));
  const studentIds = students.map(s => s.id);

  const from = (page - 1) * pageSize;
  const to = from + pageSize - 1;
  const selectFields = 'id,studentId,subject,subjectId,score,total,examType,assessmentLabel,entryState,termId,month,status,date,teacherId,uploadedBy';
  let query: any = supabase.from('exams').select(selectFields, { count: 'exact' });

  // Only constrain by student set when a class or student search is active.
  if (studentIds.length > 0 && (Boolean(term) || (params.classNames?.length ?? 0) > 0)) {
    query = query.in('studentId', studentIds);
  }
  if (params.subject && params.subject !== 'All') query = query.eq('subject', params.subject);
  if (params.assessmentLabel && params.assessmentLabel !== 'All') query = query.eq('assessmentLabel', params.assessmentLabel);
  if (params.termId && params.termId !== 'All') query = query.eq('termId', params.termId);
  if (params.month && params.month !== 'All') query = query.eq('month', params.month);
  if (params.status && params.status !== 'all') query = query.eq('status', params.status);

  const { data, error, count } = await query.order('date', { ascending: false }).range(from, to);
  if (error) throw error;

  // For rows whose student wasn't in the pre-resolved set (no class/search
  // filter active), fetch the missing student identities in one batch.
  const rawRows = (data || []) as any[];
  const missingIds = Array.from(new Set(rawRows.map(r => r.studentId).filter(id => !studentById.has(id))));
  if (missingIds.length > 0) {
    const { data: extra } = await supabase
      .from('students')
      .select('id,name,className,govId')
      .in('id', missingIds)
      .limit(MAX_QUERY_LIMIT);
    for (const s of (extra || []) as any[]) studentById.set(s.id, s);
  }

  const rows: GradeSearchRow[] = rawRows.map(r => {
    const s = studentById.get(r.studentId);
    return {
      id: r.id,
      studentId: r.studentId,
      studentName: s?.name ?? '(unknown student)',
      className: s?.className ?? '',
      govId: s?.govId ?? null,
      subject: r.subject,
      subjectId: r.subjectId ?? null,
      assessmentLabel: r.assessmentLabel ?? null,
      examType: r.examType,
      score: r.score,
      total: r.total,
      entryState: r.entryState ?? 'scored',
      status: r.status,
      month: r.month,
      date: r.date,
      termId: r.termId ?? null,
      teacherId: r.teacherId ?? null,
      uploadedBy: r.uploadedBy ?? null,
    };
  });

  return { rows, total: count || 0 };
}
