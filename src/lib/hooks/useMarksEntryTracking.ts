import { useQuery } from '@tanstack/react-query';
import { fetchMarksEntryTracking, type MarksEntryTrackingQuery } from '../db/marksEntryTracking';

export function useMarksEntryTracking(query: MarksEntryTrackingQuery | null) {
  return useQuery({
    queryKey: ['marksEntryTracking', query],
    queryFn: () => fetchMarksEntryTracking(query as MarksEntryTrackingQuery),
    enabled: Boolean(query?.academicYearId && query?.termId && query?.examScope),
    staleTime: 1000 * 60,
    gcTime: 1000 * 60 * 10,
  });
}
