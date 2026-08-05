import { useEffect } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  fetchPlansByTeacher,
  fetchPlansBySupervisor,
  fetchPlanById,
  createPlan,
  deletePlan,
  savePeriods,
  submitForReview,
  fetchReviewByPlanId,
  updateReviewStatus,
  approvePlan,
  rejectPlan,
  retryAIReview,
  requestPlanRevision,
  findPlanForWeek,
  expireStuckAiReviews,
  fetchAiReviewLogs,
  AI_REVIEW_TIMEOUT_MINUTES,
} from '../db/lessonPlans';
import { fetchPeriodAiReviews, regeneratePeriodAiReviews } from '../db/lessonPeriodAiReviews';
import { fetchLessonPlanQuizPreviews, generateLessonPlanQuizzes } from '../db/lessonPlanQuizzes';
import { supabase } from '../supabase';
import type { LessonPlan, LessonPlanPeriod, PeriodActivity, AIReview, DayOfWeek, ReviewResponse, SavePeriodsPayload } from '../../types';

const DAY_ORDER: Record<string, number> = {
  Monday: 1,
  Tuesday: 2,
  Wednesday: 3,
  Thursday: 4,
  Friday: 5,
  Saturday: 6,
  Sunday: 7,
};

function sortPeriods(periods: LessonPlanPeriod[]): LessonPlanPeriod[] {
  return [...periods].sort((a, b) => {
    const dayDiff = (DAY_ORDER[a.day] ?? 99) - (DAY_ORDER[b.day] ?? 99);
    return dayDiff || a.period_number - b.period_number;
  });
}

function updatePlanInLists(plans: unknown, updatedPlan: LessonPlan): unknown {
  if (!Array.isArray(plans)) return plans;
  return plans.map((plan) => {
    const item = plan as LessonPlan & Record<string, unknown>;
    return item.id === updatedPlan.id ? { ...item, ...updatedPlan } : item;
  });
}

// ─── Teacher's plans ──────────────────────────────────────────────
export function useTeacherPlans(teacherId: string | undefined) {
  return useQuery({
    queryKey: ['lessonPlans', 'teacher', teacherId],
    queryFn: () => fetchPlansByTeacher(teacherId!),
    enabled: !!teacherId,
    staleTime: 1000 * 60 * 3,
    gcTime: 1000 * 60 * 10,
  });
}

// ─── Supervisor's plans ───────────────────────────────────────────
export function useSupervisorPlans() {
  return useQuery({
    queryKey: ['lessonPlans', 'supervisor'],
    queryFn: fetchPlansBySupervisor,
    staleTime: 1000 * 60 * 3,
    gcTime: 1000 * 60 * 10,
  });
}

// ─── Single plan with periods ─────────────────────────────────────
export function usePlanWithPeriods(planId: string | undefined) {
  const qc = useQueryClient();

  useEffect(() => {
    if (!planId) return;

    const channel = supabase
      .channel(`lesson-plan-detail:${planId}`)
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'lesson_plans', filter: `id=eq.${planId}` },
        (payload) => {
          if (payload.eventType === 'DELETE') {
            qc.setQueryData(['lessonPlan', planId], null);
            qc.setQueriesData({ queryKey: ['lessonPlans'] }, (plans) => {
              if (!Array.isArray(plans)) return plans;
              return plans.filter((plan) => (plan as LessonPlan).id !== planId);
            });
            return;
          }

          const updatedPlan = payload.new as LessonPlan;
          qc.setQueryData<{ plan: LessonPlan; periods: LessonPlanPeriod[] } | null>(['lessonPlan', planId], (current) => (
            current ? { ...current, plan: { ...current.plan, ...updatedPlan } } : current
          ));
          qc.setQueriesData({ queryKey: ['lessonPlans'] }, (plans) => updatePlanInLists(plans, updatedPlan));
        }
      )
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'lesson_plan_periods', filter: `plan_id=eq.${planId}` },
        (payload) => {
          qc.setQueryData<{ plan: LessonPlan; periods: LessonPlanPeriod[] } | null>(['lessonPlan', planId], (current) => {
            if (!current) return current;
            if (payload.eventType === 'DELETE') {
              const deleted = payload.old as Partial<LessonPlanPeriod>;
              return {
                ...current,
                periods: current.periods.filter((period) => period.id !== deleted.id),
              };
            }

            const nextPeriod = payload.new as LessonPlanPeriod;
            const existing = current.periods.filter((period) => period.id !== nextPeriod.id);
            return { ...current, periods: sortPeriods([...existing, nextPeriod]) };
          });
        }
      )
      .subscribe();

    return () => {
      void supabase.removeChannel(channel);
    };
  }, [planId, qc]);

  return useQuery({
    queryKey: ['lessonPlan', planId],
    queryFn: () => fetchPlanById(planId!),
    enabled: !!planId,
    // The selected plan is loaded once per planId. Further changes are pushed
    // into the cache by the realtime channel above or by explicit mutations.
    staleTime: Infinity,
    gcTime: 1000 * 60 * 10,
  });
}

/**
 * Watchdog: while the selected plan is waiting on the AI, check whether it has
 * exceeded the timeout and, if so, flip it to `ai_failed` so it can be retried.
 * This is what guarantees no plan sits on "waiting" forever.
 */
export function useAiReviewTimeout(plan: LessonPlan | null | undefined) {
  const qc = useQueryClient();
  const planId = plan?.id;
  const status = plan?.status;
  const startedAt = plan?.ai_started_at || plan?.updated_at;
  const teacherId = plan?.teacher_id;

  useEffect(() => {
    if (!planId || status !== 'submitted') return;

    let cancelled = false;
    const check = async () => {
      const started = new Date(startedAt || '').getTime();
      if (!Number.isFinite(started)) return;
      if (Date.now() - started < AI_REVIEW_TIMEOUT_MINUTES * 60_000) return;

      const expired = await expireStuckAiReviews([{ id: planId, status, ai_started_at: startedAt, updated_at: startedAt, teacher_id: teacherId } as LessonPlan]);
      if (!cancelled && expired.includes(planId)) {
        const reason = `AI review timed out after ${AI_REVIEW_TIMEOUT_MINUTES} minutes with no response.`;
        qc.setQueryData<{ plan: LessonPlan; periods: LessonPlanPeriod[] } | null>(['lessonPlan', planId], (current) => (
          current ? { ...current, plan: { ...current.plan, status: 'ai_failed', ai_failure_reason: reason } } : current
        ));
        qc.setQueriesData({ queryKey: ['lessonPlans'] }, (plans) => {
          if (!Array.isArray(plans)) return plans;
          return plans.map((item) => {
            const listPlan = item as LessonPlan & Record<string, unknown>;
            return listPlan.id === planId ? { ...listPlan, status: 'ai_failed', ai_failure_reason: reason } : listPlan;
          });
        });
      }
    };

    void check();
    const timer = setInterval(check, 15_000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [planId, qc, startedAt, status, teacherId]);
}

/** Look up the plan belonging to one exact week + class (never another week's). */
export function usePlanForWeek(teacherId: string | undefined, weekLabel: string, className: string) {
  return useQuery({
    queryKey: ['lessonPlanForWeek', teacherId, weekLabel, className],
    queryFn: () => findPlanForWeek(teacherId!, weekLabel, className),
    enabled: !!teacherId && !!weekLabel && !!className,
    staleTime: 1000 * 15,
  });
}

/** Admin-facing AI failure log. */
export function useAiReviewLogs(limit = 100) {
  return useQuery({
    queryKey: ['aiReviewLogs', limit],
    queryFn: () => fetchAiReviewLogs(limit),
    staleTime: 1000 * 30,
  });
}

/** Supervisor action: reopen a locked plan for teacher edits. */
export function useRequestRevision() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ planId, note }: { planId: string; note?: string }) => requestPlanRevision(planId, note),
    onSuccess: (_d, variables) => {
      qc.invalidateQueries({ queryKey: ['lessonPlan', variables.planId] });
      qc.invalidateQueries({ queryKey: ['lessonPlans'] });
    },
  });
}

// ─── Review for a plan ────────────────────────────────────────────
export function useReview(planId: string | undefined) {
  const qc = useQueryClient();

  useEffect(() => {
    if (!planId) return;

    const channel = supabase
      .channel(`ai-review:${planId}`)
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'ai_reviews', filter: `plan_id=eq.${planId}` },
        (payload) => {
          if (payload.eventType === 'DELETE') {
            qc.setQueryData(['aiReview', planId], null);
            return;
          }
          qc.setQueryData(['aiReview', planId], payload.new as AIReview);
        }
      )
      .subscribe();

    return () => {
      void supabase.removeChannel(channel);
    };
  }, [planId, qc]);

  return useQuery({
    queryKey: ['aiReview', planId],
    queryFn: () => fetchReviewByPlanId(planId!),
    enabled: !!planId,
    // Fetch once per planId. AI review inserts/updates are delivered via the
    // realtime channel above; mutations can still invalidate explicitly.
    staleTime: Infinity,
    gcTime: 1000 * 60 * 10,
  });
}

// ─── Per-period AI reviews ────────────────────────────────────────
export function usePeriodAiReviews(planId: string | undefined) {
  const qc = useQueryClient();

  useEffect(() => {
    if (!planId) return;
    const channel = supabase
      .channel(`lesson-period-ai-reviews:${planId}`)
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'lesson_period_ai_reviews', filter: `plan_id=eq.${planId}` },
        () => qc.invalidateQueries({ queryKey: ['lessonPeriodAiReviews', planId] })
      )
      .subscribe();
    return () => {
      void supabase.removeChannel(channel);
    };
  }, [planId, qc]);

  return useQuery({
    queryKey: ['lessonPeriodAiReviews', planId],
    queryFn: () => fetchPeriodAiReviews(planId!),
    enabled: !!planId,
    staleTime: Infinity,
    gcTime: 1000 * 60 * 10,
  });
}

export function useRegeneratePeriodAiReviews() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (planId: string) => regeneratePeriodAiReviews(planId),
    onSuccess: (_data, planId) => {
      qc.invalidateQueries({ queryKey: ['lessonPeriodAiReviews', planId] });
    },
  });
}

// ─── Auto-generated lesson quizzes ───────────────────────────────
export function useLessonPlanQuizPreviews(planId: string | undefined) {
  return useQuery({
    queryKey: ['lessonPlanQuizzes', planId],
    queryFn: () => fetchLessonPlanQuizPreviews(planId!),
    enabled: !!planId,
    staleTime: 1000 * 60 * 5,
    gcTime: 1000 * 60 * 10,
  });
}

export function useGenerateLessonPlanQuizzes() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (planId: string) => generateLessonPlanQuizzes(planId),
    onSuccess: (_data, planId) => {
      qc.invalidateQueries({ queryKey: ['lessonPlanQuizzes', planId] });
    },
  });
}

// ─── Mutations ────────────────────────────────────────────────────

export function useCreatePlan() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: createPlan,
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['lessonPlans'] });
    },
  });
}

export function useDeletePlan() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: deletePlan,
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['lessonPlans'] });
    },
  });
}

export function useSavePeriods() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (payload: SavePeriodsPayload) => savePeriods(payload),
    onSuccess: (_data, variables) => {
      qc.invalidateQueries({ queryKey: ['lessonPlan', variables.plan_id] });
    },
  });
}

export function useSubmitForReview() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({
      planId,
      periods,
      unitContext,
    }: {
      planId: string;
      periods: { day: DayOfWeek; period_number: number; topic: string; activities: string }[];
      unitContext?: { name: string; objectives: string };
    }) => submitForReview(planId, periods, unitContext),
    onSuccess: (data) => {
      qc.invalidateQueries({ queryKey: ['lessonPlan', data.plan_id] });
      qc.invalidateQueries({ queryKey: ['aiReview', data.plan_id] });
      qc.invalidateQueries({ queryKey: ['lessonPeriodAiReviews', data.plan_id] });
      qc.invalidateQueries({ queryKey: ['lessonPlanQuizzes', data.plan_id] });
      qc.invalidateQueries({ queryKey: ['lessonPlans'] });
    },
  });
}

export function useApprovePlan() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({
      planId,
      reviewId,
      comment,
    }: {
      planId: string;
      // May be absent when the AI review failed — the supervisor decides manually.
      reviewId?: string;
      comment: string;
    }) => {
      if (reviewId) await updateReviewStatus(reviewId, 'reviewed', comment);
      await approvePlan(planId, reviewId ? undefined : comment);
    },
    onSuccess: (_data, variables) => {
      qc.invalidateQueries({ queryKey: ['lessonPlan', variables.planId] });
      qc.invalidateQueries({ queryKey: ['aiReview', variables.planId] });
      qc.invalidateQueries({ queryKey: ['lessonPlans'] });
    },
  });
}

export function useRejectPlan() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({
      planId,
      reviewId,
      comment,
    }: {
      planId: string;
      // May be absent when the AI review failed — the supervisor decides manually.
      reviewId?: string;
      comment: string;
    }) => {
      if (reviewId) await updateReviewStatus(reviewId, 'reviewed', comment);
      await rejectPlan(planId, reviewId ? undefined : comment);
    },
    onSuccess: (_data, variables) => {
      qc.invalidateQueries({ queryKey: ['lessonPlan', variables.planId] });
      qc.invalidateQueries({ queryKey: ['aiReview', variables.planId] });
      qc.invalidateQueries({ queryKey: ['lessonPlans'] });
    },
  });
}

export function useRetryAIReview() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({
      planId,
      periods,
      unitContext,
    }: {
      planId: string;
      periods: { day: DayOfWeek; period_number: number; topic: string; activities: string }[];
      unitContext?: { name: string; objectives: string };
    }) => {
      return retryAIReview(planId, periods, unitContext);
    },
    onSuccess: (data) => {
      qc.invalidateQueries({ queryKey: ['lessonPlan', data.plan_id] });
      qc.invalidateQueries({ queryKey: ['aiReview', data.plan_id] });
      qc.invalidateQueries({ queryKey: ['lessonPeriodAiReviews', data.plan_id] });
      qc.invalidateQueries({ queryKey: ['lessonPlanQuizzes', data.plan_id] });
      qc.invalidateQueries({ queryKey: ['lessonPlans'] });
    },
  });
}
