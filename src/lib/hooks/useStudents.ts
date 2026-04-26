import { useQuery, type UseQueryOptions } from '@tanstack/react-query';
import { getStudents, getStudentsByClass, getStudentsByClasses } from '../db/students';
import type { Student } from '../../types';

export function useStudents(
  classNames?: string[] | string,
  search?: string,
  limit = 100
) {
  const normalizedClassNames = Array.isArray(classNames)
    ? classNames
    : classNames
    ? [classNames]
    : undefined;

  const queryKey = ['students', normalizedClassNames ?? 'all', search ?? '', limit];

  return useQuery<Student[], unknown>({
    queryKey,
    queryFn: async () => {
      if (normalizedClassNames && normalizedClassNames.length > 0) {
        return getStudentsByClasses(normalizedClassNames, search, limit);
      }
      if (typeof classNames === 'string' && classNames) {
        return getStudentsByClass(classNames, limit);
      }
      if (search && search.trim()) {
        return getStudentsByClasses([], search, limit);
      }
      return getStudents(limit);
    },
    staleTime: 1000 * 60 * 5,
    cacheTime: 1000 * 60 * 15,
    refetchOnWindowFocus: false,
    retry: false,
  });
}
