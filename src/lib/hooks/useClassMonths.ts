import { useQuery, type UseQueryOptions } from '@tanstack/react-query';
import { getMonthsForClass } from '../db/progress';

export function useClassMonths(
  className: string,
  options?: UseQueryOptions<string[], unknown, string[], readonly unknown[]>
) {
  return useQuery<string[], unknown>({
    queryKey: ['classMonths', className],
    queryFn: () => getMonthsForClass(className),
    enabled: Boolean(className),
    staleTime: 1000 * 60 * 10,
    cacheTime: 1000 * 60 * 30,
    refetchOnWindowFocus: false,
    retry: false,
    ...options,
  });
}
