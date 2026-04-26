import { useQuery, type UseQueryOptions } from '@tanstack/react-query';
import { getClassStudentSubjectProgress } from '../db/progress';
import { ClassStudentSubjectProgress } from '../../types';

export function useClassStudentSubjectProgress(
  className: string,
  month: string,
  options?: UseQueryOptions<ClassStudentSubjectProgress[], unknown, ClassStudentSubjectProgress[], readonly unknown[]>
) {
  return useQuery<ClassStudentSubjectProgress[], unknown>({
    queryKey: ['classStudentSubjectProgress', className, month],
    queryFn: () => getClassStudentSubjectProgress(className, month),
    enabled: Boolean(className && month),
    staleTime: 1000 * 60 * 5,
    cacheTime: 1000 * 60 * 30,
    refetchOnWindowFocus: false,
    retry: false,
    ...options,
  });
}
