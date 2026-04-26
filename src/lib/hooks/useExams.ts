import { useQuery, type UseQueryOptions } from '@tanstack/react-query';
import { getExams, getExamsByStudent, getExamsByTeacher, getExamsByStatus } from '../db/exams';
import type { Exam, ExamStatus } from '../../types';

export function useExams(
  options?: {
    studentId?: string;
    teacherId?: string;
    status?: ExamStatus;
  },
  queryOptions?: UseQueryOptions<Exam[], unknown, Exam[], readonly unknown[]>
) {
  const queryKey = ['exams', options?.studentId ?? 'all', options?.teacherId ?? 'all', options?.status ?? 'all'];

  return useQuery<Exam[], unknown>({
    queryKey,
    queryFn: async () => {
      if (options?.studentId) return getExamsByStudent(options.studentId);
      if (options?.teacherId) return getExamsByTeacher(options.teacherId);
      if (options?.status) return getExamsByStatus(options.status);
      return getExams();
    },
    staleTime: 1000 * 60 * 3,
    cacheTime: 1000 * 60 * 10,
    refetchOnWindowFocus: false,
    retry: false,
    ...queryOptions,
  });
}
