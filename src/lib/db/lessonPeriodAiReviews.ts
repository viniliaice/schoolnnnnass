import { supabase } from '../supabase';
import type { LessonPeriodAIReview, LessonPlan, LessonPlanPeriod, UnitPlan } from '../../types';
import { findMatchingUnitPlan, reviewPeriodInstruction } from '../lessonPlanReview';
import { previousWeekLabel } from '../../utils/weekDates';

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
  const planResult = await supabase
    .from('lesson_plans')
    .select('*')
    .eq('id', planId)
    .single();
  if (planResult.error || !planResult.data) throw planResult.error || new Error('Plan not found');
  const plan = planResult.data as LessonPlan;
  const prevLabel = previousWeekLabel(plan.week_label);

  const [periodsResult, unitsResult, previousPlanResult] = await Promise.all([
    supabase
      .from('lesson_plan_periods')
      .select('*')
      .eq('plan_id', planId),
    supabase
      .from('unit_plans')
      .select('*')
      .eq('class_name', plan.class_name),
    prevLabel
      ? supabase
        .from('lesson_plans')
        .select('*')
        .eq('teacher_id', plan.teacher_id)
        .eq('class_name', plan.class_name)
        .eq('subject_id', plan.subject_id)
        .eq('week_label', prevLabel)
        .maybeSingle()
      : Promise.resolve({ data: null, error: null }),
  ]);

  if (periodsResult.error) throw periodsResult.error;
  if (unitsResult.error) throw unitsResult.error;
  if (previousPlanResult.error) throw previousPlanResult.error;

  const periods = ((periodsResult.data || []) as LessonPlanPeriod[]).sort((a, b) => periodOrder(a) - periodOrder(b));
  const units = (unitsResult.data || []) as UnitPlan[];

  let previousPeriods: LessonPlanPeriod[] = [];
  if (previousPlanResult.data?.id) {
    const previousPeriodsResult = await supabase
      .from('lesson_plan_periods')
      .select('*')
      .eq('plan_id', previousPlanResult.data.id);
    if (previousPeriodsResult.error) throw previousPeriodsResult.error;
    previousPeriods = (previousPeriodsResult.data || []) as LessonPlanPeriod[];
  }

  const rows = periods
    .filter((period) => !(period.is_free || period.subject === '__FREE__'))
    .map((period) => {
      const previousSameDay = previousPeriods.find((prev) => prev.day === period.day && !prev.is_free && prev.subject !== '__FREE__') ?? null;
      const review = reviewPeriodInstruction(period, units, { weekLabel: plan.week_label, previousSameDay });
      const matchedUnit = findMatchingUnitPlan(period, units, plan.week_label);
      return {
        id: id('lpair'),
        plan_id: planId,
        period_id: period.id,
        period_order: periodOrder(period),
        alignment_status: alignmentStatus(review.alignmentStatus),
        review_text: review.aiReview,
        alignment_reason: review.alignmentReason,
        alignment_gap: review.alignmentGap,
        revision_status: review.revisionStatus,
        revision_reason: review.revisionReason,
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

  const missingRevisionCount = rows.filter((row) => row.revision_status === 'missing').length;
  if (missingRevisionCount > 0) {
    const { data: aiReview } = await supabase
      .from('ai_reviews')
      .select('improvements')
      .eq('plan_id', planId)
      .maybeSingle();
    const current = Array.isArray(aiReview?.improvements) ? aiReview.improvements : [];
    const alreadyIncluded = current.some((item: any) => /weekly revision/i.test(item?.area ?? ''));
    if (!alreadyIncluded) {
      await supabase
        .from('ai_reviews')
        .update({
          improvements: [
            ...current,
            {
              area: 'Weekly revision',
              why: `${missingRevisionCount} period(s) do not clearly revise the same-day lesson from the previous week.`,
              recommendation: 'Add a short warm-up, recap question, or retrieval practice task connected to last week’s same-day topic.',
            },
          ],
        })
        .eq('plan_id', planId);
    }
  }

  return (data || []) as LessonPeriodAIReview[];
}
