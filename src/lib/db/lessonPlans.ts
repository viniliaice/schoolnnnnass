import { supabase } from '../supabase';
import type { LessonPlan, LessonPlanPeriod, PeriodActivity, AIReview, DayOfWeek, PlanStatus, ReviewResponse, SavePeriodsPayload } from '../../types';

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

export async function savePeriods(payload: SavePeriodsPayload): Promise<LessonPlanPeriod[]> {
  const { data, error } = await supabase.rpc('save_lesson_plan_periods', {
    p_plan_id: payload.plan_id,
    p_periods: payload.periods as any,
  });
  if (error) throw error;
  return data || [];
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

  // Call the edge function to generate AI review first
  // The edge function will set status to 'in_review' on success
  // or 'ai_failed' on failure
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
  if (plan.status !== 'ai_failed') {
    throw new Error('Only plans with failed AI reviews can be retried');
  }

  // Call the edge function to retry AI review
  // The edge function will set status to 'in_review' on success
  // or 'ai_failed' on failure
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
    throw new Error(msg);
  }

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
