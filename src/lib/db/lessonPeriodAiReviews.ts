import { supabase } from '../supabase';
import type { LessonPeriodAIReview, LessonPlanPeriod, UnitPlan } from '../../types';
import { findMatchingUnitPlan, reviewPeriodInstruction } from '../lessonPlanReview';

function id(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).substring(2, 8)}`;
}

function alignmentStatus(status: string): LessonPeriodAIReview['alignment_status'] {
  if (status === 'full') return 'fully_aligned';
  if (status === 'partial') return 'partially_aligned';
  return 'not_aligned';
}

function periodOrder(period: LessonPlanPeriod): number {
  // Stable numeric order, deliberately not derived from timestamp/id strings.
  const dayOrder: Record<string, number> = { Saturday: 1, Sunday: 2, Monday: 3, Tuesday: 4, Wednesday: 5, Thursday: 6, Friday: 7 };
  return (dayOrder[period.day] ?? 99) * 10 + period.period_number;
}

export async function fetchPeriodAiReviews(planId: string): Promise<LessonPeriodAIReview[]> {
  const { data, error } = await supabase
    .from('lesson_period_ai_reviews')
    .select('*')
    .eq('plan_id', planId)
    .order('period_order', { ascending: true });
  if (error) throw error;
  return (data || []) as LessonPeriodAIReview[];
}

export async function regeneratePeriodAiReviews(planId: string): Promise<LessonPeriodAIReview[]> {
  const [periodsResult, unitsResult] = await Promise.all([
    supabase
      .from('lesson_plan_periods')
      .select('*')
      .eq('plan_id', planId),
    supabase
      .from('unit_plans')
      .select('*'),
  ]);

  if (periodsResult.error) throw periodsResult.error;
  if (unitsResult.error) throw unitsResult.error;

  const periods = ((periodsResult.data || []) as LessonPlanPeriod[]).sort((a, b) => periodOrder(a) - periodOrder(b));
  const units = (unitsResult.data || []) as UnitPlan[];

  const rows = periods
    .filter((period) => !(period.is_free || period.subject === '__FREE__'))
    .map((period) => {
      const review = reviewPeriodInstruction(period, units);
      const matchedUnit = findMatchingUnitPlan(period, units);
      return {
        id: id('lpair'),
        plan_id: planId,
        period_id: period.id,
        period_order: periodOrder(period),
        alignment_status: alignmentStatus(review.alignmentStatus),
        review_text: review.aiReview,
        alignment_reason: review.alignmentReason,
        alignment_gap: review.alignmentGap,
        suggested_activities: review.suggestedActivities.length ? review.suggestedActivities : null,
        unit_plan_id: matchedUnit?.id ?? null,
      };
    });

  const { error: deleteError } = await supabase
    .from('lesson_period_ai_reviews')
    .delete()
    .eq('plan_id', planId);
  if (deleteError) throw deleteError;

  if (!rows.length) return [];

  const { data, error } = await supabase
    .from('lesson_period_ai_reviews')
    .insert(rows)
    .select('*')
    .order('period_order', { ascending: true });
  if (error) throw error;
  return (data || []) as LessonPeriodAIReview[];
}
