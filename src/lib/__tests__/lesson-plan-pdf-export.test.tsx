import { describe, expect, it } from 'vitest';
import { pdf } from '@react-pdf/renderer';
import { LessonPlanPdfDocument } from '../../pages/shared/LessonPlanPdfDocument';
import type { LessonPeriodAIReview, LessonPlan, LessonPlanPeriod } from '../../types';

const basePlan: LessonPlan = {
  id: 'plan-pdf-edge',
  teacher_id: 't1',
  subject_id: 'subject-math',
  class_name: 'Grade 2-C',
  week_label: 'Week 1',
  title: 'PDF Edge Case Lesson Plan',
  status: 'in_review',
  period_count: 5,
  previous_score: null,
  previous_reviewed_at: null,
  created_at: '2026-08-05T00:00:00Z',
  updated_at: '2026-08-05T00:00:00Z',
};

function period(overrides: Partial<LessonPlanPeriod>): LessonPlanPeriod {
  return {
    id: `period-${overrides.day}-${overrides.period_number}`,
    plan_id: basePlan.id,
    day: 'Saturday',
    period_number: 1,
    class_name: 'Grade 2-C',
    subject: 'subject-math',
    is_free: false,
    topic: 'Addition 2 digit',
    objective: 'Students will accurately add two 2-digit numbers with regrouping.',
    activities: 'Guided examples and independent practice.',
    slide_number: '4',
    details: [],
    sort_order: 0,
    created_at: basePlan.created_at,
    updated_at: basePlan.updated_at,
    ...overrides,
  };
}

function review(periodId: string, order: number): LessonPeriodAIReview {
  return {
    id: `review-${periodId}`,
    plan_id: basePlan.id,
    period_id: periodId,
    period_order: order,
    alignment_status: 'partially_aligned',
    review_text: 'The objective is measurable, and the activities need a clearer direct practice step. The lesson partly follows the unit plan.',
    alignment_reason: 'Matched unit, but activities need tighter connection.',
    alignment_gap: 'Activities do not directly practise or assess the stated objective.',
    suggested_activities: [
      'Students model two-digit addition with base-ten blocks.',
      'Pairs solve regrouping problems and explain each step aloud.',
      'Students complete an exit ticket with one real-life addition word problem.',
    ],
    unit_plan_id: null,
    created_at: basePlan.created_at,
    updated_at: basePlan.updated_at,
  };
}

async function renderBytes(periods: LessonPlanPeriod[], reviews: LessonPeriodAIReview[] = []) {
  const blob = await pdf(
    <LessonPlanPdfDocument
      plan={basePlan}
      periods={periods}
      periodAiReviews={reviews}
      unitPlans={[]}
      subjects={[{ id: 'subject-math', name: 'Mathematics', createdAt: '' }]}
    />
  ).toBlob();
  return blob.size;
}

describe('LessonPlanPdfDocument export edge cases', () => {
  it('renders a 0% completion plan', async () => {
    const periods = [period({ id: 'p-free', is_free: true, topic: '', activities: '' })];
    await expect(renderBytes(periods)).resolves.toBeGreaterThan(1000);
  });

  it('renders a 100% completion plan', async () => {
    const periods = Array.from({ length: 5 }, (_, i) => period({ id: `p-${i + 1}`, period_number: i + 1 }));
    await expect(renderBytes(periods, periods.map((p, i) => review(p.id, 10 + i + 1)))).resolves.toBeGreaterThan(1000);
  });

  it('renders very long objective/activity text', async () => {
    const longText = 'Students explain, model, practise, compare, and independently solve two-digit addition with regrouping. '.repeat(40);
    const p = period({ id: 'p-long', objective: longText, activities: longText });
    await expect(renderBytes([p], [review(p.id, 11)])).resolves.toBeGreaterThan(1000);
  });

  it('renders a missing unit plan match review', async () => {
    const p = period({ id: 'p-no-unit' });
    const r = { ...review(p.id, 11), unit_plan_id: null, alignment_status: 'not_aligned' as const };
    await expect(renderBytes([p], [r])).resolves.toBeGreaterThan(1000);
  });
});
