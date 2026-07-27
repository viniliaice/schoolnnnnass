import { supabase } from '../supabase';
import type { LessonPlan, LessonPlanPeriod, PeriodActivity, AIReview, DayOfWeek, PlanStatus, ReviewResponse, ReviewErrorResponse, SavePeriodsPayload } from '../../types';

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
    p_periods: JSON.stringify(payload.periods),
  });
  if (error) throw error;
  return data || [];
}

export async function submitForReview(
  planId: string,
  periodInputs: { day: DayOfWeek; period_number: number; topic: string; objective?: string | null; activities: string; slide_number?: string | null; details?: PeriodActivity[] }[]
): Promise<ReviewResponse> {
  const jwt = (await supabase.auth.getSession()).data.session?.access_token;
  if (!jwt) throw new Error('Not authenticated');

  const { data: plan } = await supabase
    .from('lesson_plans')
    .select('id, teacher_id, status')
    .eq('id', planId)
    .single();
  if (!plan) throw new Error('Plan not found');
  if (plan.status === 'in_review' || plan.status === 'approved') {
    throw new Error(`Plan is already ${plan.status}`);
  }

  const res = await fetch(
    `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/generate-lesson-review`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${jwt}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ plan_id: planId, periods: periodInputs }),
    }
  );

  if (!res.ok) {
    const err: ReviewErrorResponse = await res.json();
    throw new Error(err.error);
  }

  return res.json();
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
  periodInputs: { day: DayOfWeek; period_number: number; topic: string; objective?: string | null; activities: string; slide_number?: string | null; details?: PeriodActivity[] }[]
): Promise<ReviewResponse> {
  const jwt = (await supabase.auth.getSession()).data.session?.access_token;
  if (!jwt) throw new Error('Not authenticated');

  const res = await fetch(
    `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/generate-lesson-review`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${jwt}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ plan_id: planId, periods: periodInputs }),
    }
  );

  if (!res.ok) {
    const err: ReviewErrorResponse = await res.json();
    throw new Error(err.error);
  }

  return res.json();
}

export async function approvePlan(id: string): Promise<void> {
  const { error } = await supabase
    .from('lesson_plans')
    .update({ status: 'approved' })
    .eq('id', id);
  if (error) throw error;
}

export async function rejectPlan(id: string): Promise<void> {
  const { error } = await supabase
    .from('lesson_plans')
    .update({ status: 'rejected' })
    .eq('id', id);
  if (error) throw error;
}
