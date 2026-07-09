import { useQuery, type UseQueryOptions } from '@tanstack/react-query';
import { getExams, getExamsByStudent, getExamsByTeacher, getExamsByStatus } from '../db/exams';
import type { Exam, ExamStatus } from '../../types';

type ExamsQueryOptions = Omit<
  UseQueryOptions<Exam[], unknown, Exam[], readonly unknown[]>,
  'queryKey' | 'queryFn'
>;

export function useExams(
  options?: {
    studentId?: string;
    teacherId?: string;
    status?: ExamStatus;
  },
  queryOptions?: ExamsQueryOptions
) {
  const queryKey = ['exams', options?.studentId ?? 'all', options?.teacherId ?? 'all', options?.status ?? 'all'];

  return useQuery<Exam[], unknown, Exam[], readonly unknown[]>({
    queryKey,
    queryFn: async () => {
      if (options?.studentId) return getExamsByStudent(options.studentId);
      if (options?.teacherId) return getExamsByTeacher(options.teacherId);
      if (options?.status) return getExamsByStatus(options.status);
      return getExams();
    },
    staleTime: 1000 * 60 * 3,
    gcTime: 1000 * 60 * 10,
    refetchOnWindowFocus: false,
    retry: false,
    ...queryOptions,
  });
}
