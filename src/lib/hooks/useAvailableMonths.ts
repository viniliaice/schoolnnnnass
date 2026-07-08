import { useQuery, type UseQueryOptions } from '@tanstack/react-query';
import { getAvailableMonths } from '../db/progress';

type AvailableMonthsQueryOptions = Omit<
  UseQueryOptions<string[], unknown, string[], readonly unknown[]>,
  'queryKey' | 'queryFn'
>;

export function useAvailableMonths(options?: AvailableMonthsQueryOptions) {
  return useQuery<string[], unknown, string[], readonly unknown[]>({
    queryKey: ['availableMonths'],
    queryFn: getAvailableMonths,
    staleTime: 1000 * 60 * 10,
    gcTime: 1000 * 60 * 30,
    refetchOnWindowFocus: false,
    retry: false,
    ...options,
  });
}
