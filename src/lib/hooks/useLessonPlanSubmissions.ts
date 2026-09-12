import { useQuery } from '@tanstack/react-query';
import { fetchLessonPlanSubmitters, fetchSubmissionTrackingPlans } from '../db/lessonPlanSubmissions';

/**
 * The teachers expected to submit lesson plans (role 'teacher' with at least
 * one assigned class). The submission page starts from this roster — it is
 * what makes "Not Submitted" a statement about teachers, not about rows.
 */
export function useLessonPlanSubmitters() {
  return useQuery({
    queryKey: ['lessonPlans', 'submitters'],
    queryFn: fetchLessonPlanSubmitters,
    staleTime: 1000 * 60,
    gcTime: 1000 * 60 * 10,
  });
}

/**
 * Only the plans stored under the selected week. The week filter runs in the
 * database, so switching weeks replaces the result instead of re-filtering a
 * preloaded history in the browser.
 */
export function useSubmissionTrackingPlans(weekKey: string | null, weekLabels: string[] | undefined) {
  return useQuery({
    queryKey: ['lessonPlans', 'submissionWeek', weekKey],
    queryFn: () => fetchSubmissionTrackingPlans(weekLabels ?? []),
    enabled: !!weekKey && !!weekLabels?.length,
    staleTime: 1000 * 60,
    gcTime: 1000 * 60 * 10,
  });
}
