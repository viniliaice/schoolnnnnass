import { supabase } from '../supabase';
import { warnFallback } from '../logger';

export type SystemStats = {
  totalTeachers: number;
  totalParents: number;
  totalStudents: number;
  totalExams: number;
  pendingExams: number;
  approvedExams: number;
  rejectedExams: number;
  averageScore: number;
};

const EMPTY_STATS: SystemStats = {
  totalTeachers: 0,
  totalParents: 0,
  totalStudents: 0,
  totalExams: 0,
  pendingExams: 0,
  approvedExams: 0,
  rejectedExams: 0,
  averageScore: 0,
};

function normalizeSystemStats(value: unknown): SystemStats {
  const stats = (value ?? {}) as Partial<SystemStats>;
  return {
    totalTeachers: Number(stats.totalTeachers ?? 0),
    totalParents: Number(stats.totalParents ?? 0),
    totalStudents: Number(stats.totalStudents ?? 0),
    totalExams: Number(stats.totalExams ?? 0),
    pendingExams: Number(stats.pendingExams ?? 0),
    approvedExams: Number(stats.approvedExams ?? 0),
    rejectedExams: Number(stats.rejectedExams ?? 0),
    averageScore: Number(stats.averageScore ?? 0),
  };
}

function isMissingRpcError(error: { code?: string; message?: string; details?: string } | null) {
  if (!error) return false;
  return error.code === 'PGRST202'
    || error.code === '42883'
    || error.message?.toLowerCase().includes('function')
    || error.details?.includes('get_system_stats');
}

async function countRows(table: string, filter?: (query: any) => any): Promise<number> {
  let query = supabase.from(table).select('*', { count: 'exact', head: true });
  if (filter) query = filter(query);
  const { count, error } = await query;
  if (error) throw error;
  return count ?? 0;
}

async function getSystemStatsFallback(): Promise<SystemStats> {
  const [
    totalTeachers,
    totalParents,
    totalStudents,
    totalExams,
    pendingExams,
    approvedExams,
    rejectedExams,
    examsForAverage,
  ] = await Promise.all([
    countRows('profiles', query => query.ilike('role', 'teacher')),
    countRows('profiles', query => query.ilike('role', 'parent')),
    countRows('students'),
    countRows('exams'),
    countRows('exams', query => query.eq('status', 'pending')),
    countRows('exams', query => query.eq('status', 'approved')),
    countRows('exams', query => query.eq('status', 'rejected')),
    supabase.from('exams').select('score,total').limit(30000),
  ]);

  const { data: examRows, error: examError } = examsForAverage;
  if (examError) throw examError;

  const rows = (examRows ?? []) as Array<{ score: number; total: number }>;
  const averageScore = rows.length > 0
    ? Math.round(
      rows.reduce((sum, exam) => sum + (exam.total ? (exam.score / exam.total) * 100 : 0), 0) / rows.length * 100,
    ) / 100
    : 0;

  return {
    ...EMPTY_STATS,
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

export async function getSystemStats(): Promise<SystemStats> {
  const { data, error } = await supabase.rpc('get_system_stats');

  if (!error) return normalizeSystemStats(data);
  if (isMissingRpcError(error)) {
    warnFallback('get_system_stats RPC missing; using count-query fallback', error);
    return getSystemStatsFallback();
  }

  throw error;
}
