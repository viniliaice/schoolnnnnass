import { useQuery, type UseQueryOptions } from '@tanstack/react-query';
import { fetchMonitorMarksEntries, type MonitorMarksParams } from '../db/marksUploadMonitoring';
import { getAcademicYears, getTerms } from '../db/academic';
import type { AcademicYear, Term } from '../../types';
import type { MonitorMarksRow } from '../marksUploadTracking';

type MonitorQueryOptions = Omit<
  UseQueryOptions<MonitorMarksRow[], unknown, MonitorMarksRow[], readonly unknown[]>,
  'queryKey' | 'queryFn'
>;

/**
 * The teacher/class/subject mark-entry assignments for the selected exam
 * period. The result comes from the get_monitor_marks_entries RPC (with a
 * client-side fallback), so it already carries expected/entered counts, the
 * three-state status, and completion percentage for every expected entry —
 * including the ones with zero marks (Not Started).
 */
export function useMonitorMarksEntries(
  params: MonitorMarksParams,
  options?: MonitorQueryOptions
) {
  const queryKey = [
    'monitorMarksEntries',
    params.termId ?? '',
    params.month ?? '',
    params.examType ?? 'Monthly',
    params.teacherId ?? '',
    params.className ?? '',
    params.subjectId ?? '',
    params.status ?? '',
  ];
  return useQuery<MonitorMarksRow[], unknown, MonitorMarksRow[], readonly unknown[]>({
    queryKey,
    queryFn: () => fetchMonitorMarksEntries(params),
    enabled: options?.enabled ?? true,
    ...options,
  });
}

/** Academic years, most recent first — drives the period selector. */
export function useAcademicYears() {
  return useQuery<AcademicYear[]>({
    queryKey: ['academicYears', 'all'],
    queryFn: getAcademicYears,
    staleTime: 1000 * 60 * 10,
    gcTime: 1000 * 60 * 30,
  });
}

/** Terms, most recent first. Filtered to a year by the caller. */
export function useTerms() {
  return useQuery<Term[]>({
    queryKey: ['terms', 'all'],
    queryFn: getTerms,
    staleTime: 1000 * 60 * 10,
    gcTime: 1000 * 60 * 30,
  });
}
