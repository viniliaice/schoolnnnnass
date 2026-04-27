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
    supabase.from('exams').select('id,studentId,subject,score,total,examType,month,status,parentId,date,createdAt,teacherId'),
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
  const selectFields = 'id,studentId,subject,score,total,examType,month,status,parentId,date,createdAt,teacherId';
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
    .select('id,studentId,subject,score,total,examType,month,status,parentId,date,createdAt,teacherId')
    .eq('studentId', studentId);
  if (error) throw error;
  return data || [];
}

export async function getExamsByParent(parentId: string, statusFilter?: ExamStatus): Promise<Exam[]> {
  let query = supabase
    .from('exams')
    .select('id,studentId,subject,score,total,examType,month,status,parentId,date,createdAt,teacherId')
    .eq('parentId', parentId);
  if (statusFilter) query = query.eq('status', statusFilter);
  const { data, error } = await query;
  if (error) throw error;
  return data || [];
}

export async function getExamsByTeacher(teacherId: string): Promise<Exam[]> {
  const { data, error } = await supabase
    .from('exams')
    .select('id,studentId,subject,score,total,examType,month,status,parentId,date,createdAt,teacherId')
    .eq('teacherId', teacherId);
  if (error) throw error;
  return data || [];
}

export async function getExamsByStatus(status: ExamStatus): Promise<Exam[]> {
  const { data, error } = await supabase
    .from('exams')
    .select('id,studentId,subject,score,total,examType,month,status,parentId,date,createdAt,teacherId')
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
