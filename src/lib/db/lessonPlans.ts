import { supabase } from '../supabase';
import { generateLessonPlanQuizzes } from './lessonPlanQuizzes';
import type { LessonPlan, LessonPlanPeriod, AIReview, AiReviewLog, AiReviewOutcome, PlanStatus, ReviewDispatchResponse, SavePeriodsPayload } from '../../types';
import { isPlanEditable } from '../../types';

function newId(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).substring(2, 8)}`;
}

export async function fetchPlansByTeacher(teacherId: string): Promise<LessonPlan[]> {
  const { data, error } = await supabase
    .from('lesson_plans')
    .select('*')
    .eq('teacher_id', teacherId)
    .order('created_at', { ascending: false });
  if (error) throw error;
  return data || [];
}

export async function fetchPlansBySupervisor(): Promise<(LessonPlan & { teacher_name?: string })[]> {
  const { data, error } = await supabase
    .from('lesson_plans')
    .select('*, profiles!lesson_plans_teacher_id_fkey(name)')
    .in('status', ['submitted', 'in_review', 'approved', 'rejected', 'ai_failed'])
    .order('created_at', { ascending: false });
  if (error) throw error;
  return (data || []).map((p: any) => ({
    ...p,
    teacher_name: p.profiles?.name,
  }));
}

export async function fetchPlanById(id: string): Promise<{ plan: LessonPlan; periods: LessonPlanPeriod[] } | null> {
  const [planResult, periodsResult] = await Promise.all([
    supabase.from('lesson_plans').select('*').eq('id', id).single(),
    supabase.from('lesson_plan_periods').select('*').eq('plan_id', id).order('day').order('period_number'),
  ]);
  if (planResult.error || !planResult.data) return null;
  return { plan: planResult.data, periods: periodsResult.data || [] };
}

export async function createPlan(plan: {
  teacher_id: string;
  subject_id: string | null;
  class_name: string;
  week_label: string;
  title: string;
  period_count: number;
}): Promise<LessonPlan> {
  const id = newId('plan');
  const { data, error } = await supabase
    .from('lesson_plans')
    .insert({ id, ...plan })
    .select()
    .single();
  if (error) throw error;
  return data;
}

export async function deletePlan(id: string): Promise<void> {
  const { error } = await supabase.from('lesson_plans').delete().eq('id', id);
  if (error) throw error;
}

/** Bucket an AI error message into a monitorable outcome. */
export function classifyAiError(message: string): AiReviewOutcome {
  const m = (message || '').toLowerCase();
  if (m.includes('timeout') || m.includes('timed out') || m.includes('504')) return 'timeout';
  if (m.includes('rate limit') || m.includes('429')) return 'rate_limit';
  if (m.includes('json') || m.includes('malformed')) return 'malformed_json';
  if (m.includes('unit')) return 'unit_match_error';
  if (m.includes('save')) return 'save_error';
  if (m.includes('api') || m.includes('key') || m.includes('50')) return 'api_error';
  return 'unknown';
}

/** Raised when an edit is attempted on a submitted (locked) plan. */
export class PlanLockedError extends Error {
  readonly isLocked = true;
  constructor(public readonly status: PlanStatus) {
    super(
      `This plan is ${status.replace('_', ' ')} and can no longer be edited. ` +
      'Ask your supervisor to request revisions if you need to change it.'
    );
    this.name = 'PlanLockedError';
  }
}

export async function savePeriods(payload: SavePeriodsPayload): Promise<LessonPlanPeriod[]> {
  // Fail fast with a friendly message. The database enforces this too (trigger
  // + RPC guard), so a stale client cannot bypass the lock.
  const { data: plan } = await supabase
    .from('lesson_plans')
    .select('status')
    .eq('id', payload.plan_id)
    .single();

  if (plan && !isPlanEditable(plan.status)) {
    throw new PlanLockedError(plan.status as PlanStatus);
  }

  const { data, error } = await supabase.rpc('save_lesson_plan_periods', {
    p_plan_id: payload.plan_id,
    p_periods: payload.periods as any,
  });
  if (error) {
    // Surface the server-side lock as the same typed error.
    if (/locked/i.test(error.message || '')) {
      throw new PlanLockedError((plan?.status as PlanStatus) || 'submitted');
    }
    throw error;
  }
  return data || [];
}

/**
 * Find this teacher's plan for one exact week + class.
 * Used so selecting a week loads that week's own plan and never repurposes
 * another week's record.
 */
export async function findPlanForWeek(
  teacherId: string,
  weekLabel: string,
  className: string
): Promise<LessonPlan | null> {
  const { data, error } = await supabase
    .from('lesson_plans')
    .select('*')
    .eq('teacher_id', teacherId)
    .eq('week_label', weekLabel)
    .eq('class_name', className)
    .order('created_at', { ascending: false })
    .limit(1);
  if (error) throw error;
  return data?.[0] || null;
}

/** Supervisor/admin action: reopen a locked plan so the teacher can edit it. */
export async function requestPlanRevision(planId: string, note?: string): Promise<void> {
  const { error } = await supabase.rpc('request_lesson_plan_revision', {
    p_plan_id: planId,
    p_note: note ?? null,
  });
  if (error) {
    // Fall back to a direct update if the RPC has not been deployed yet.
    const { error: updateError } = await supabase
      .from('lesson_plans')
      .update({
        status: 'revision_requested',
        revision_note: note ?? null,
        revision_requested_at: new Date().toISOString(),
      })
      .eq('id', planId);
    if (updateError) throw updateError;
  }
}

// ─── AI review reliability ────────────────────────────────────────

/** Minutes a plan may sit in "submitted" with no review before we call it failed. */
export const AI_REVIEW_TIMEOUT_MINUTES = 3;

/** Record one AI review attempt so failures are inspectable later. */
export async function logAiReviewAttempt(entry: {
  planId: string;
  teacherId?: string | null;
  outcome: AiReviewOutcome;
  errorCode?: string | null;
  message?: string | null;
  latencyMs?: number | null;
}): Promise<void> {
  const { error } = await supabase.from('ai_review_logs').insert({
    id: newId('ailog'),
    plan_id: entry.planId,
    teacher_id: entry.teacherId ?? null,
    outcome: entry.outcome,
    error_code: entry.errorCode ?? null,
    message: entry.message ?? null,
    latency_ms: entry.latencyMs ?? null,
  });
  // Logging must never break the user-facing flow.
  if (error) console.error('Failed to write ai_review_logs entry:', error);
}

export async function fetchAiReviewLogs(limit = 100): Promise<AiReviewLog[]> {
  const { data, error } = await supabase
    .from('ai_review_logs')
    .select('*')
    .order('created_at', { ascending: false })
    .limit(limit);
  if (error) throw error;
  return data || [];
}

/**
 * Flip any plan stuck waiting on the AI past the timeout to `ai_failed`,
 * so it can be retried instead of hanging forever.
 *
 * Prefers the SQL sweep (covers every teacher); falls back to a client-side
 * update for the given plans if the RPC is not deployed.
 */
export async function expireStuckAiReviews(candidates?: LessonPlan[]): Promise<string[]> {
  const { data, error } = await supabase.rpc('expire_stuck_ai_reviews', {
    p_timeout_minutes: AI_REVIEW_TIMEOUT_MINUTES,
  });

  if (!error) return (data || []).map((p: LessonPlan) => p.id);

  // ── Fallback path ──
  if (!candidates?.length) return [];
  const cutoff = Date.now() - AI_REVIEW_TIMEOUT_MINUTES * 60_000;
  const stuck = candidates.filter((p) => {
    if (p.status !== 'submitted') return false;
    const started = new Date(p.ai_started_at || p.updated_at).getTime();
    return Number.isFinite(started) && started < cutoff;
  });
  if (!stuck.length) return [];

  const reason = `AI review timed out after ${AI_REVIEW_TIMEOUT_MINUTES} minutes with no response.`;
  const expired: string[] = [];
  for (const plan of stuck) {
    const { error: updateError } = await supabase
      .from('lesson_plans')
      .update({ status: 'ai_failed', ai_failure_reason: reason, updated_at: new Date().toISOString() })
      .eq('id', plan.id)
      .eq('status', 'submitted');
    if (!updateError) {
      expired.push(plan.id);
      await logAiReviewAttempt({
        planId: plan.id,
        teacherId: plan.teacher_id,
        outcome: 'timeout',
        errorCode: 'TIMEOUT',
        message: reason,
      });
    }
  }
  return expired;
}

/**
 * Dispatch review generation after the database has confirmed the submitted
 * status. This promise is intentionally not awaited by submitForReview: once
 * the status RPC returns, the teacher's submission is complete and locked.
 */
async function dispatchLessonPlanReview(
  planId: string,
  attemptStartedAt: string,
): Promise<boolean> {
  const { error } = await supabase.functions.invoke('generate-lesson-review', {
    body: { plan_id: planId },
  });

  if (error) {
    const message = error.context?.message || error.message || 'Review request could not be dispatched';

    // The SECURITY DEFINER RPC checks both status and attempt timestamp. A
    // newer retry, successful result, or supervisor decision always wins over
    // a late browser-side dispatch failure.
    const { error: persistError } = await supabase.rpc('mark_lesson_plan_review_dispatch_failed', {
      p_plan_id: planId,
      p_ai_started_at: attemptStartedAt,
      p_reason: message,
    });
    if (persistError) {
      console.error('[lesson-plan-review] failed to persist dispatch failure', persistError);
    }
    return false;
  }

  // Quiz generation is independent of submission and review persistence. Keep
  // the existing automation, but never put it back on the teacher's critical
  // path.
  void generateLessonPlanQuizzes(planId).catch((quizError) => {
    console.error('[lesson-plan-quizzes] background generation failed', quizError);
  });
  return true;
}

export async function submitForReview(planId: string): Promise<ReviewDispatchResponse> {
  // This transaction verifies ownership, removes stale review rows, changes the
  // status to submitted, and stamps ai_started_at. The status activates both
  // existing server-side edit-lock triggers before this call returns.
  const { data, error } = await supabase.rpc('submit_lesson_plan_for_review', {
    p_plan_id: planId,
  });
  if (error) throw error;

  const submittedPlan = Array.isArray(data) ? data[0] : data;
  if (!submittedPlan?.id || submittedPlan.status !== 'submitted') {
    throw new Error('Submission was not confirmed by the database.');
  }

  // Fire-and-forget only after the confirmed status transition above. The Edge
  // Function acknowledges quickly and owns the durable background task.
  void dispatchLessonPlanReview(planId, submittedPlan.ai_started_at).catch((dispatchError) => {
    // dispatchLessonPlanReview handles expected invocation failures itself;
    // this guard prevents an unexpected exception becoming unhandled.
    console.error('[lesson-plan-review] background dispatch failed', dispatchError);
  });

  return {
    plan_id: planId,
    status: 'submitted',
    ai_started_at: submittedPlan.ai_started_at,
  };
}

export async function fetchReviewByPlanId(planId: string): Promise<AIReview | null> {
  const { data, error } = await supabase
    .from('ai_reviews')
    .select('*')
    .eq('plan_id', planId)
    .maybeSingle();
  if (error) return null;
  return data;
}

export async function updateReviewStatus(
  id: string,
  status: 'reviewed',
  supervisorComment: string
): Promise<void> {
  const { error } = await supabase
    .from('ai_reviews')
    .update({ status, supervisor_comment: supervisorComment })
    .eq('id', id);
  if (error) throw error;
}

export async function retryAIReview(planId: string): Promise<ReviewDispatchResponse> {
  // Reset to an explicit pending state and create a fresh attempt timestamp.
  // The RPC allows the owner or a supervisor/admin and rejects final statuses.
  const { data: queued, error: queueError } = await supabase.rpc('retry_lesson_plan_ai_review', {
    p_plan_id: planId,
  });
  if (queueError) throw queueError;

  const queuedPlan = Array.isArray(queued) ? queued[0] : queued;
  if (!queuedPlan?.id || queuedPlan.status !== 'submitted') {
    throw new Error('AI review retry was not confirmed by the database.');
  }

  // A retry button may report immediate dispatch/auth failures, while all slow
  // generation failures are persisted by the background Edge job and arrive
  // through the existing realtime/polling status path.
  const dispatched = await dispatchLessonPlanReview(planId, queuedPlan.ai_started_at);
  if (!dispatched) throw new Error('Review retry could not be dispatched');

  return {
    plan_id: planId,
    status: 'submitted',
    ai_started_at: queuedPlan.ai_started_at,
  };
}

/**
 * When the AI review never landed (ai_failed / still pending) the supervisor can
 * still decide. We persist their comment as a manual review row so the teacher
 * sees the feedback in exactly the same place as an AI review.
 */
async function saveManualDecisionComment(planId: string, comment: string): Promise<void> {
  const trimmed = comment.trim();
  if (!trimmed) return;

  const emptyScore = { score: 0, explanation: 'Not scored — reviewed manually by the supervisor.' };
  const { error } = await supabase.from('ai_reviews').upsert(
    {
      id: newId('review'),
      plan_id: planId,
      scores: {
        learning_objectives: emptyScore,
        lesson_structure: emptyScore,
        student_engagement: emptyScore,
        teaching_strategies: emptyScore,
        differentiation: emptyScore,
        assessment_methods: emptyScore,
        curriculum_alignment: emptyScore,
        classroom_management: emptyScore,
        resources_materials: emptyScore,
        overall_quality: emptyScore,
      },
      executive_summary: 'The AI review was unavailable for this plan. The supervisor reviewed it manually.',
      total_score: 0,
      percentage: 0,
      performance_level: 'Manual review',
      strengths: [],
      improvements: [],
      ai_summary_notes: { status_recommendation: 'Manual review', reasoning: trimmed },
      additional_data: { manual: true },
      status: 'reviewed',
      supervisor_comment: trimmed,
    },
    { onConflict: 'plan_id' }
  );
  // A failed comment write must not block the approval itself.
  if (error) console.error('Failed to save manual supervisor comment:', error);
}

export async function approvePlan(id: string, manualComment?: string): Promise<void> {
  if (manualComment) await saveManualDecisionComment(id, manualComment);
  const { error } = await supabase
    .from('lesson_plans')
    .update({ status: 'approved' })
    .eq('id', id);
  if (error) throw error;
}

export async function rejectPlan(id: string, manualComment?: string): Promise<void> {
  if (manualComment) await saveManualDecisionComment(id, manualComment);
  const { error } = await supabase
    .from('lesson_plans')
    .update({ status: 'rejected' })
    .eq('id', id);
  if (error) throw error;
}
