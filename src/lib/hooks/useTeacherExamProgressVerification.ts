import { useQuery, type UseQueryOptions } from '@tanstack/react-query';
import { getTeacherExamProgressVerification } from '../db/progress';
import type { TeacherExamProgressVerification } from '../../types';

type TeacherExamProgressVerificationQueryOptions = Omit<
  UseQueryOptions<TeacherExamProgressVerification, unknown, TeacherExamProgressVerification, readonly unknown[]>,
  'queryKey' | 'queryFn'
>;

export function useTeacherExamProgressVerification(
  filters: {
    teacherId: string;
    className: string;
    subjectId: string;
    subjectName: string;
    month: string;
  },
  options?: TeacherExamProgressVerificationQueryOptions
) {
  const queryKey = [
    'teacherExamProgressVerification',
    filters.teacherId,
    filters.className,
    filters.subjectId,
    filters.subjectName,
    filters.month,
  ];

  return useQuery<TeacherExamProgressVerification, unknown, TeacherExamProgressVerification, readonly unknown[]>({
    queryKey,
    queryFn: () => getTeacherExamProgressVerification(filters),
    enabled: options?.enabled ?? false,
    ...options,
  });
}
