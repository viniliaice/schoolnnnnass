import { supabase } from '../supabase';
import type { LessonPlan, LessonPlanPeriod, PeriodActivity, AIReview, AiReviewLog, AiReviewOutcome, DayOfWeek, PlanStatus, ReviewResponse, SavePeriodsPayload } from '../../types';
import { isPlanEditable } from '../../types';

function newId(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).substring(2, 8)}`;
}

/**
 * Thrown when the plan reached the supervisor but the AI review could not be
 * generated. The submission itself succeeded — only the scoring is missing.
 */
export class SubmissionAiError extends Error {
  readonly aiFailedOnly = true;
  constructor(message: string) {
    super(message);
    this.name = 'SubmissionAiError';
  }
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

export async function submitForReview(
  planId: string,
  periodInputs: { day: DayOfWeek; period_number: number; topic: string; objective?: string | null; activities: string; slide_number?: string | null; details?: PeriodActivity[] }[],
  unitContext?: { name: string; objectives: string }
): Promise<ReviewResponse> {
  // First, verify the plan exists and is in a valid state
  const { data: plan, error: fetchError } = await supabase
    .from('lesson_plans')
    .select('id, teacher_id, status')
    .eq('id', planId)
    .single();
  if (fetchError || !plan) throw new Error('Plan not found');
  if (plan.status === 'in_review' || plan.status === 'approved') {
    throw new Error(`Plan is already ${plan.status}`);
  }
  if (plan.status === 'submitted') {
    throw new Error('Plan has already been submitted for review');
  }

  // Stamp the start time so a stuck plan can be timed out later.
  const startedAt = new Date().toISOString();
  await supabase
    .from('lesson_plans')
    .update({ ai_started_at: startedAt, ai_failure_reason: null })
    .eq('id', planId);

  // Call the edge function to generate AI review first
  // The edge function will set status to 'in_review' on success
  // or 'ai_failed' on failure
  const sessionResult = await supabase.auth?.getSession?.();
  const sessionData = sessionResult?.data;
  console.log('[submitForReview] plan.teacher_id:', plan.teacher_id, 'session.user.id:', sessionData?.session?.user?.id);
  const callStart = Date.now();
  const { data, error } = await supabase.functions.invoke('generate-lesson-review', {
    body: { plan_id: planId, periods: periodInputs, unit_context: unitContext },
  });

  if (error) {
    // The edge function normally flips the plan to 'ai_failed' itself. Re-read the
    // status so we can tell "the AI failed but the plan IS with the supervisor"
    // apart from "nothing was submitted at all".
    const { data: currentPlan } = await supabase
      .from('lesson_plans')
      .select('status')
      .eq('id', planId)
      .single();

    const msg = error.context?.message || error.message || 'Review request failed';

    await logAiReviewAttempt({
      planId,
      outcome: classifyAiError(msg),
      errorCode: (error as any)?.code || null,
      message: msg,
      latencyMs: Date.now() - callStart,
    });
    await supabase
      .from('lesson_plans')
      .update({ ai_failure_reason: msg })
      .eq('id', planId);

    if (currentPlan?.status === 'ai_failed' || currentPlan?.status === 'in_review') {
      // Plan is visible to the supervisor; only the AI scoring failed.
      throw new SubmissionAiError(msg);
    }

    // The submission itself never landed — return the plan to draft so the
    // teacher can retry without ending up in a stuck state.
    await supabase
      .from('lesson_plans')
      .update({ status: 'draft', updated_at: new Date().toISOString() })
      .eq('id', planId);

    throw new Error(msg);
  }

  // The edge function already moved the plan to 'in_review' on success, which the
  // supervisor query also picks up. Only nudge the status when it is still sitting
  // in a pre-submission state, so we never overwrite 'in_review' with 'submitted'
  // (that made finished plans look like they were still waiting on the AI).
  const { data: afterPlan } = await supabase
    .from('lesson_plans')
    .select('status')
    .eq('id', planId)
    .single();

  await logAiReviewAttempt({
    planId,
    outcome: 'success',
    latencyMs: Date.now() - callStart,
  });

  if (afterPlan?.status !== 'in_review' && afterPlan?.status !== 'ai_failed') {
    await supabase
      .from('lesson_plans')
      .update({ status: 'submitted', updated_at: new Date().toISOString() })
      .eq('id', planId);
  }

  return data as ReviewResponse;
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

export async function retryAIReview(
  planId: string,
  periodInputs: { day: DayOfWeek; period_number: number; topic: string; objective?: string | null; activities: string; slide_number?: string | null; details?: PeriodActivity[] }[],
  unitContext?: { name: string; objectives: string }
): Promise<ReviewResponse> {
  // First verify the plan exists and is in a retryable state
  const { data: plan, error: fetchError } = await supabase
    .from('lesson_plans')
    .select('id, status')
    .eq('id', planId)
    .single();
  if (fetchError || !plan) throw new Error('Plan not found');
  if (plan.status !== 'ai_failed' && plan.status !== 'submitted') {
    throw new Error('Only plans with a failed or pending AI review can be retried');
  }

  // Reset the clock so the timeout sweep measures THIS attempt.
  await supabase
    .from('lesson_plans')
    .update({ ai_started_at: new Date().toISOString(), ai_failure_reason: null })
    .eq('id', planId);

  // Call the edge function to retry AI review
  // The edge function will set status to 'in_review' on success
  // or 'ai_failed' on failure
  const callStart = Date.now();
  const { data, error } = await supabase.functions.invoke('generate-lesson-review', {
    body: { plan_id: planId, periods: periodInputs, unit_context: unitContext },
  });

  if (error) {
    // If edge function failed, the status should already be set to 'ai_failed' by the edge function
    // But if not (e.g., network error before edge function could update), roll back to 'ai_failed'
    const { data: currentPlan } = await supabase
      .from('lesson_plans')
      .select('status')
      .eq('id', planId)
      .single();
    
    if (currentPlan?.status !== 'ai_failed' && currentPlan?.status !== 'in_review') {
      // Edge function didn't update status, set back to ai_failed
      await supabase
        .from('lesson_plans')
        .update({ status: 'ai_failed', updated_at: new Date().toISOString() })
        .eq('id', planId);
    }
    
    const msg = error.context?.message || error.message || 'Review request failed';

    await logAiReviewAttempt({
      planId,
      outcome: classifyAiError(msg),
      errorCode: (error as any)?.code || null,
      message: msg,
      latencyMs: Date.now() - callStart,
    });
    await supabase
      .from('lesson_plans')
      .update({ ai_failure_reason: msg })
      .eq('id', planId);

    throw new Error(msg);
  }

  await logAiReviewAttempt({ planId, outcome: 'success', latencyMs: Date.now() - callStart });

  return data as ReviewResponse;
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
