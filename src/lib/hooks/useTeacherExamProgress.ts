import { useQuery, type UseQueryOptions } from '@tanstack/react-query';
import { getTeacherExamProgress } from '../db/progress';
import type { TeacherExamProgress } from '../../types';

type TeacherExamProgressQueryOptions = Omit<
  UseQueryOptions<TeacherExamProgress[], unknown, TeacherExamProgress[], readonly unknown[]>,
  'queryKey' | 'queryFn'
>;

export function useTeacherExamProgress(
  filters: {
    month?: string;
    className?: string;
    classNames?: string[];
    teacherId?: string;
  },
  options?: TeacherExamProgressQueryOptions
) {
  const queryKey = [
    'teacherExamProgress',
    filters.month ?? '',
    filters.className ?? '',
    filters.classNames?.join(',') ?? '',
    filters.teacherId ?? '',
  ];

  return useQuery<TeacherExamProgress[], unknown, TeacherExamProgress[], readonly unknown[]>({
    queryKey,
    queryFn: () => getTeacherExamProgress(filters),
    enabled: options?.enabled ?? true,
    ...options,
  });
}
