import { useQuery, type UseQueryOptions } from '@tanstack/react-query';
import { getMonthsForClass } from '../db/progress';

type ClassMonthsQueryOptions = Omit<
  UseQueryOptions<string[], unknown, string[], readonly unknown[]>,
  'queryKey' | 'queryFn'
>;

export function useClassMonths(
  className: string,
  options?: ClassMonthsQueryOptions
) {
  return useQuery<string[], unknown, string[], readonly unknown[]>({
    queryKey: ['classMonths', className],
    queryFn: () => getMonthsForClass(className),
    enabled: Boolean(className),
    staleTime: 1000 * 60 * 10,
    gcTime: 1000 * 60 * 30,
    refetchOnWindowFocus: false,
    retry: false,
    ...options,
  });
}
