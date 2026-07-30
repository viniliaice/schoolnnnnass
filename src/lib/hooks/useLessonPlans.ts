import { useEffect } from 'react';
import { useQuery, useMutation, useQueryClient, type UseQueryOptions } from '@tanstack/react-query';
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
import type { LessonPlan, LessonPlanPeriod, PeriodActivity, AIReview, DayOfWeek, ReviewResponse, SavePeriodsPayload } from '../../types';

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
  return useQuery({
    queryKey: ['lessonPlan', planId],
    queryFn: () => fetchPlanById(planId!),
    enabled: !!planId,
    staleTime: 1000 * 30,
    gcTime: 1000 * 60 * 5,
    // While a plan is waiting on the AI, keep polling so a flip to 'ai_failed'
    // (or 'in_review') surfaces on screen without a manual refresh.
    refetchInterval: (query) => {
      const status = query.state.data?.plan.status;
      return status === 'submitted' ? 5000 : false;
    },
  });
}

/**
 * Watchdog: while the selected plan is waiting on the AI, check whether it has
 * exceeded the timeout and, if so, flip it to `ai_failed` so it can be retried.
 * This is what guarantees no plan sits on "waiting" forever.
 */
export function useAiReviewTimeout(plan: LessonPlan | null | undefined) {
  const qc = useQueryClient();

  useEffect(() => {
    if (!plan || plan.status !== 'submitted') return;

    let cancelled = false;
    const check = async () => {
      const started = new Date(plan.ai_started_at || plan.updated_at).getTime();
      if (!Number.isFinite(started)) return;
      if (Date.now() - started < AI_REVIEW_TIMEOUT_MINUTES * 60_000) return;

      const expired = await expireStuckAiReviews([plan]);
      if (!cancelled && expired.length) {
        qc.invalidateQueries({ queryKey: ['lessonPlan', plan.id] });
        qc.invalidateQueries({ queryKey: ['lessonPlans'] });
      }
    };

    check();
    const timer = setInterval(check, 15_000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [plan, qc]);
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
  return useQuery({
    queryKey: ['aiReview', planId],
    queryFn: () => fetchReviewByPlanId(planId!),
    enabled: !!planId,
    staleTime: 1000 * 30,
    gcTime: 1000 * 60 * 5,
    // Poll until a review exists and is no longer pending. Give up after ~4
    // minutes so a permanently failed AI call doesn't poll forever.
    refetchInterval: (query) => {
      const data = query.state.data;
      if (data && data.status !== 'pending') return false;
      const started = query.state.dataUpdatedAt || Date.now();
      if (Date.now() - started > 1000 * 60 * 4) return false;
      return 5000;
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
      qc.invalidateQueries({ queryKey: ['lessonPlans'] });
    },
  });
}
