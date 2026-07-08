import { useQuery, type UseQueryOptions } from '@tanstack/react-query';
import { getStudentClasses } from '../db/students';

type ClassNamesQueryOptions = Omit<
  UseQueryOptions<string[], unknown, string[], readonly unknown[]>,
  'queryKey' | 'queryFn'
>;

export function useClassNames(options?: ClassNamesQueryOptions) {
  return useQuery<string[], unknown, string[], readonly unknown[]>({
    queryKey: ['classNames'],
    queryFn: getStudentClasses,
    staleTime: 1000 * 60 * 10,
    gcTime: 1000 * 60 * 30,
    refetchOnWindowFocus: false,
    retry: false,
    ...options,
  });
}
