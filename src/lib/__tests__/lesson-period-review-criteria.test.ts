import { describe, expect, it } from 'vitest';
import { previousWeekLabel } from '../../utils/weekDates';
import { reviewPeriodInstruction } from '../lessonPlanReview';
import type { LessonPlanPeriod, UnitPlan } from '../../types';

const unit: UnitPlan = {
  id: 'unit-math',
  name: 'Mathematics Unit: Two-digit addition',
  subject_id: 'math',
  class_name: 'Grade 2-C',
  term_id: 'term1',
  week_number_start: 1,
  week_number_end: 4,
  objectives: 'two digit addition regrouping word problems base ten blocks',
  teacher_id: 't1',
  created_at: '',
  updated_at: '',
};

function period(overrides: Partial<LessonPlanPeriod> = {}): LessonPlanPeriod {
  return {
    id: 'p1',
    plan_id: 'plan1',
    day: 'Saturday',
    period_number: 1,
    class_name: 'Grade 2-C',
    subject: 'math',
    is_free: false,
    topic: 'two digit addition regrouping',
    objective: 'Students will solve two digit addition with regrouping accurately.',
    activities: 'Warm up reviewing last week addition, then use base ten blocks to solve problems.',
    slide_number: null,
    details: [],
    sort_order: 1,
    created_at: '',
    updated_at: '',
    ...overrides,
  };
}

describe('lesson period review criteria', () => {
  it('computes previous ISO week labels across year rollover', () => {
    expect(previousWeekLabel('2026-W02')).toBe('2026-W01');
    expect(previousWeekLabel('2026-W01')).toBe('2025-W52');
    expect(previousWeekLabel('2021-W01')).toBe('2020-W53');
  });

  it('marks revision not applicable when no prior same-day period exists', () => {
    const review = reviewPeriodInstruction(period(), [unit], { weekLabel: '2026-W02', previousSameDay: null });
    expect(review.revisionStatus).toBe('not_applicable');
  });

  it('marks revision included when current activities recap the prior same day topic', () => {
    const review = reviewPeriodInstruction(period(), [unit], {
      weekLabel: '2026-W02',
      previousSameDay: period({ topic: 'addition facts', objective: 'Students practise addition facts.' }),
    });
    expect(review.revisionStatus).toBe('included');
  });

  it('marks topic mismatch as not aligned even when class and subject match', () => {
    const review = reviewPeriodInstruction(period({ topic: 'plant life cycles', activities: 'Discuss plants.' }), [unit], { weekLabel: '2026-W02' });
    expect(review.alignmentStatus).toBe('none');
    expect(review.alignmentGap).toMatch(/not found/i);
  });
});
