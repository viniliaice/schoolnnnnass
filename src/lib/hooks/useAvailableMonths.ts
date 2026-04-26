import { useQuery, type UseQueryOptions } from '@tanstack/react-query';
import { getAvailableMonths } from '../db/progress';

export function useAvailableMonths(options?: UseQueryOptions<string[], unknown, string[], readonly unknown[]>) {
  return useQuery<string[], unknown>({
    queryKey: ['availableMonths'],
    queryFn: getAvailableMonths,
    staleTime: 1000 * 60 * 10,
    cacheTime: 1000 * 60 * 30,
    refetchOnWindowFocus: false,
    retry: false,
    ...options,
  });
}
