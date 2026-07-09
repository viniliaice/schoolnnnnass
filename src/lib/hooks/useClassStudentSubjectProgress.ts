import { useQuery, type UseQueryOptions } from '@tanstack/react-query';
import { getClassStudentSubjectProgress } from '../db/progress';
import type { ClassStudentSubjectProgress } from '../../types';

type ClassStudentSubjectProgressQueryOptions = Omit<
  UseQueryOptions<ClassStudentSubjectProgress[], unknown, ClassStudentSubjectProgress[], readonly unknown[]>,
  'queryKey' | 'queryFn'
>;

export function useClassStudentSubjectProgress(
  className: string,
  month: string,
  options?: ClassStudentSubjectProgressQueryOptions
) {
  return useQuery<ClassStudentSubjectProgress[], unknown, ClassStudentSubjectProgress[], readonly unknown[]>({
    queryKey: ['classStudentSubjectProgress', className, month],
    queryFn: () => getClassStudentSubjectProgress(className, month),
    enabled: Boolean(className && month),
    staleTime: 1000 * 60 * 5,
    gcTime: 1000 * 60 * 30,
    refetchOnWindowFocus: false,
    retry: false,
    ...options,
  });
}
