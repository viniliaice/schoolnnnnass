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
    refetchInterval: (query) => {
      const data = query.state.data;
      if (!data || data.status === 'pending') return 5000;
      return false;
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
    }: {
      planId: string;
      periods: { day: DayOfWeek; period_number: number; topic: string; activities: string }[];
    }) => submitForReview(planId, periods),
    onSuccess: (data) => {
      qc.invalidateQueries({ queryKey: ['lessonPlan', data.plan_id] });
      qc.invalidateQueries({ queryKey: ['aiReview', data.plan_id] });
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
      reviewId: string;
      comment: string;
    }) => {
      await updateReviewStatus(reviewId, 'reviewed', comment);
      await approvePlan(planId);
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
      reviewId: string;
      comment: string;
    }) => {
      await updateReviewStatus(reviewId, 'reviewed', comment);
      await rejectPlan(planId);
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
    }: {
      planId: string;
      periods: { day: DayOfWeek; period_number: number; topic: string; activities: string }[];
    }) => {
      return retryAIReview(planId, periods);
    },
    onSuccess: (data) => {
      qc.invalidateQueries({ queryKey: ['lessonPlan', data.plan_id] });
      qc.invalidateQueries({ queryKey: ['aiReview', data.plan_id] });
      qc.invalidateQueries({ queryKey: ['lessonPlans'] });
    },
  });
}
