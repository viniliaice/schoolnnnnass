import { useQuery, type UseQueryOptions } from '@tanstack/react-query';
import { getStudentClasses } from '../db/students';

export function useClassNames(options?: UseQueryOptions<string[], unknown, string[], readonly unknown[]>) {
  return useQuery<string[], unknown>({
    queryKey: ['classNames'],
    queryFn: getStudentClasses,
    staleTime: 1000 * 60 * 10,
    cacheTime: 1000 * 60 * 30,
    refetchOnWindowFocus: false,
    retry: false,
    ...options,
  });
}
