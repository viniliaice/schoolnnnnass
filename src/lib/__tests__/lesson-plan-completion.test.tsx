/**
 * Lesson-plan completion maths.
 *
 * The bug this file locks down: the completion percentage used EVERY timetable
 * slot as its denominator, so a Saturday with 4 completed periods and 1 free
 * period reported "4 planned · 1 free · 80% done" when the teacher had in fact
 * planned every period they were expected to plan (100%).
 *
 * The rule: free periods are explicit timetable entries that need no lesson
 * plan, so they must never be counted as missing.
 */

import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';

import { isFreePeriod, summarizeDay, type DayPlanningPeriodInput } from '../lessonPlanReview';
import { PlanReadView, type ReadPeriod } from '../../components/lesson-planner/PlanReadView';
import { DAYS_OF_WEEK } from '../../types';

type Slot = DayPlanningPeriodInput | null;

/**
 * Build one day of timetable slots.
 *
 * @param required  periods that need a lesson plan
 * @param completed how many of those `required` periods have a topic
 * @param free      periods explicitly marked Free
 */
function day(required: number, completed: number, free: number): Slot[] {
  const slots: Slot[] = [];
  for (let i = 0; i < required; i += 1) {
    slots.push({
      is_free: false,
      subject: 'subject-math',
      topic: i < completed ? `Topic ${i + 1}` : '',
    });
  }
  for (let i = 0; i < free; i += 1) {
    slots.push({ is_free: true, subject: null, topic: '' });
  }
  return slots;
}

const periodCountFor = (slots: Slot[]) => slots.length;

describe('summarizeDay — the reported Saturday examples', () => {
  it('Grades 1–6: 4 planned + 1 free, all 4 complete → 100%', () => {
    const slots = day(4, 4, 1);
    expect(summarizeDay(slots, periodCountFor(slots))).toEqual({
      planned: 4,
      free: 1,
      completed: 4,
      total: 5,
      percent: 100,
    });
  });

  it('Grades 7–12: 5 planned + 1 free, all 5 complete → 100%', () => {
    const slots = day(5, 5, 1);
    expect(summarizeDay(slots, periodCountFor(slots))).toEqual({
      planned: 5,
      free: 1,
      completed: 5,
      total: 6,
      percent: 100,
    });
  });

  it('Grades 7–12: 6 planned + 0 free, all 6 complete → 100%', () => {
    const slots = day(6, 6, 0);
    expect(summarizeDay(slots, periodCountFor(slots))).toEqual({
      planned: 6,
      free: 0,
      completed: 6,
      total: 6,
      percent: 100,
    });
  });

  it('KG/Foundation: 3 planned + 1 free, all 3 complete → 100%', () => {
    const slots = day(3, 3, 1);
    expect(summarizeDay(slots, periodCountFor(slots))).toEqual({
      planned: 3,
      free: 1,
      completed: 3,
      total: 4,
      percent: 100,
    });
  });

  it('Saturday specifically: 4 planned + 1 free reads 100%, never 80%', () => {
    // The exact scenario from the bug report.
    const saturday: Slot[] = [
      { is_free: false, subject: 'subject-math', topic: 'Counting 1-10' },
      { is_free: false, subject: 'subject-math', topic: 'Number tracing 1-5' },
      { is_free: false, subject: 'subject-math', topic: 'More and less' },
      { is_free: true, subject: null, topic: 'Free Period' },
      { is_free: false, subject: 'subject-math', topic: 'Number matching game' },
    ];
    const summary = summarizeDay(saturday, 5);
    expect(summary.planned).toBe(4);
    expect(summary.free).toBe(1);
    expect(summary.percent).toBe(100);
  });
});

describe('summarizeDay — partial completion', () => {
  it('4 planned + 1 free with 3 complete → 75%', () => {
    const slots = day(4, 3, 1);
    expect(summarizeDay(slots, periodCountFor(slots))).toMatchObject({
      planned: 4,
      free: 1,
      completed: 3,
      percent: 75,
    });
  });

  it('5 planned + 1 free with 4 complete → 80%', () => {
    const slots = day(5, 4, 1);
    expect(summarizeDay(slots, periodCountFor(slots))).toMatchObject({
      planned: 5,
      free: 1,
      completed: 4,
      percent: 80,
    });
  });

  it('6 planned + 0 free with 5 complete → 83.33%', () => {
    const slots = day(6, 5, 0);
    expect(summarizeDay(slots, periodCountFor(slots))).toMatchObject({
      planned: 6,
      free: 0,
      completed: 5,
      percent: 83.33,
    });
  });

  it('1 missing lesson plan drops the day below 100%', () => {
    const slots = day(5, 4, 1); // one required period has no topic
    const summary = summarizeDay(slots, periodCountFor(slots));
    expect(summary.planned - summary.completed).toBe(1);
    expect(summary.percent).toBe(80);
  });

  it('an empty day (nothing filled in yet) is 0%, not complete', () => {
    const slots = day(5, 0, 0);
    expect(summarizeDay(slots, periodCountFor(slots))).toMatchObject({
      planned: 5,
      free: 0,
      completed: 0,
      percent: 0,
    });
  });
});

describe('summarizeDay — free periods are excluded from the denominator', () => {
  it('adding free periods to a fully-planned day keeps it at 100%', () => {
    const percents = [0, 1, 2, 3].map((freeCount) =>
      summarizeDay(day(4, 4, freeCount), 4 + freeCount).percent,
    );
    expect(percents).toEqual([100, 100, 100, 100]);
  });

  it('the denominator is the required periods, not the timetable slots', () => {
    // 3 of 4 required periods done, plus 2 free periods.
    const slots = day(4, 3, 2);
    const summary = summarizeDay(slots, periodCountFor(slots));
    // Denominator = 4 (required). Old (buggy) maths used 6 slots → 50%.
    expect(summary.percent).toBe(75);
    expect(summary.percent).not.toBe(Math.round((3 / 6) * 100));
  });

  it('never reports free periods as missing', () => {
    const slots = day(4, 4, 1);
    const summary = summarizeDay(slots, periodCountFor(slots));
    expect(summary.planned - summary.completed).toBe(0);
    expect(summary.free).toBe(1);
  });

  it('a free period that still has text in its topic is not counted as complete', () => {
    const slots: Slot[] = [
      { is_free: true, subject: null, topic: 'Free Period' },
      { is_free: false, subject: 'subject-math', topic: 'Shapes' },
    ];
    const summary = summarizeDay(slots, 2);
    expect(summary).toMatchObject({ planned: 1, free: 1, completed: 1, percent: 100 });
  });
});

describe('summarizeDay — how a Free period is identified', () => {
  it('isFreePeriod is true only when explicitly flagged', () => {
    expect(isFreePeriod({ is_free: true })).toBe(true);
    expect(isFreePeriod({ is_free: false })).toBe(false);
    expect(isFreePeriod({ subject: '__FREE__' })).toBe(true);
    expect(isFreePeriod({ subject: 'subject-math' })).toBe(false);
    expect(isFreePeriod({ topic: '' })).toBe(false);
    expect(isFreePeriod(null)).toBe(false);
    expect(isFreePeriod(undefined)).toBe(false);
  });

  it('treats the __FREE__ sentinel subject as free even if is_free was never set', () => {
    const slots: Slot[] = [
      { subject: '__FREE__', topic: '' },
      { is_free: false, subject: 'subject-math', topic: 'Shapes' },
    ];
    expect(summarizeDay(slots, 2)).toMatchObject({ planned: 1, free: 1, completed: 1, percent: 100 });
  });

  it('counts a slot with no saved row as a REQUIRED period, not a free one', () => {
    // A period the teacher never filled in: not free, and not complete.
    const slots: Slot[] = [
      { is_free: false, subject: 'subject-math', topic: 'Shapes' },
      null,
    ];
    const summary = summarizeDay(slots, 2);
    expect(summary).toMatchObject({ planned: 2, free: 0, completed: 1, percent: 50 });
  });

  it('does not treat a whitespace-only topic as a completed plan', () => {
    const slots: Slot[] = [
      { is_free: false, subject: 'subject-math', topic: '   ' },
      { is_free: false, subject: 'subject-math', topic: 'Shapes' },
    ];
    expect(summarizeDay(slots, 2)).toMatchObject({ completed: 1, percent: 50 });
  });
});

describe('summarizeDay — edge cases', () => {
  it('all periods free → 0 required and 100% (nothing is missing)', () => {
    const slots = day(0, 0, 5);
    const summary = summarizeDay(slots, 5);
    expect(summary).toEqual({ planned: 0, free: 5, completed: 0, total: 5, percent: 100 });
  });

  it('0 planned periods → 100% rather than a divide-by-zero', () => {
    const summary = summarizeDay([{ is_free: true, topic: '' }], 1);
    expect(summary.planned).toBe(0);
    expect(summary.percent).toBe(100);
    expect(Number.isFinite(summary.percent)).toBe(true);
    expect(Number.isNaN(summary.percent)).toBe(false);
  });

  it('an empty timetable with no slots at all still returns a finite percentage', () => {
    const summary = summarizeDay([], 0);
    expect(Number.isFinite(summary.percent)).toBe(true);
    expect(summary.percent).toBe(0);
  });

  it('never returns a percentage above 100 or below 0', () => {
    const cases: Array<[number, number, number]> = [
      [1, 0, 0],
      [6, 6, 0],
      [6, 0, 6],
      [4, 3, 1],
      [5, 5, 1],
    ];
    for (const [required, completed, free] of cases) {
      const { percent } = summarizeDay(day(required, completed, free), required + free);
      expect(percent).toBeGreaterThanOrEqual(0);
      expect(percent).toBeLessThanOrEqual(100);
    }
  });

  it('rounds to two decimals', () => {
    expect(summarizeDay(day(6, 5, 0), 6).percent).toBe(83.33);
    expect(summarizeDay(day(3, 2, 0), 3).percent).toBe(66.67);
    expect(summarizeDay(day(3, 1, 0), 3).percent).toBe(33.33);
  });
});

describe('summarizeDay — invariants across every day and grade group', () => {
  it('planned + free === total for every combination', () => {
    for (const required of [0, 1, 3, 4, 5, 6]) {
      for (const free of [0, 1, 2]) {
        for (const completed of [0, Math.min(required, 1), required]) {
          const slots = day(required, completed, free);
          const summary = summarizeDay(slots, required + free);
          expect(summary.planned + summary.free).toBe(summary.total);
          expect(summary.completed).toBeLessThanOrEqual(summary.planned);
        }
      }
    }
  });

  it('gives the same answer for every day of the school week', () => {
    // The rule is day-agnostic: Saturday must not behave differently.
    const percents = DAYS_OF_WEEK.map(() => summarizeDay(day(4, 4, 1), 5).percent);
    expect(percents).toEqual(DAYS_OF_WEEK.map(() => 100));
  });

  it('handles the period counts used by each grade group', () => {
    // KG / Foundation 3+1, Grades 1–6 4+1, Grades 7–12 5+1 and 6+0.
    const groups = [
      { group: 'KG/Foundation', required: 3, free: 1 },
      { group: 'Grades 1–6', required: 4, free: 1 },
      { group: 'Grades 7–12 (5+1)', required: 5, free: 1 },
      { group: 'Grades 7–12 (6+0)', required: 6, free: 0 },
    ];
    for (const { group, required, free } of groups) {
      const slots = day(required, required, free);
      const summary = summarizeDay(slots, required + free);
      expect(summary, group).toMatchObject({ planned: required, free, percent: 100 });
    }
  });

  it('clamps to the timetable size when fewer rows are stored than periodCount', () => {
    // A legacy plan that only saved 2 of its 5 slots: the unsaved three are
    // required periods with no plan, so the day is 50%.
    const slots: Slot[] = [
      { is_free: false, subject: 'subject-math', topic: 'Shapes' },
      { is_free: false, subject: 'subject-math', topic: '' },
    ];
    expect(summarizeDay(slots, 5)).toMatchObject({ planned: 5, free: 0, completed: 1, total: 5 });
    expect(summarizeDay(slots, 5).percent).toBe(20);
  });
});

describe('PlanReadView renders the corrected Saturday summary', () => {
  function readPeriod(dayName: string, periodNumber: number, topic: string, isFree = false): ReadPeriod {
    return {
      day: dayName as ReadPeriod['day'],
      period_number: periodNumber,
      subject: isFree ? '' : 'subject-math',
      className: 'Grade 5-A',
      isFree,
      topic,
      objective: '',
      slide_number: '',
      details: [],
    };
  }

  /** Every day: 4 planned (all complete) + 1 explicitly free. */
  function fullWeek(): ReadPeriod[] {
    return DAYS_OF_WEEK.flatMap((d) => [
      readPeriod(d, 1, 'Counting 1-10'),
      readPeriod(d, 2, 'Number tracing'),
      readPeriod(d, 3, 'More and less'),
      readPeriod(d, 4, 'Number matching'),
      readPeriod(d, 5, '', true),
    ]);
  }

  const countOf = (haystack: string, needle: string) => haystack.split(needle).length - 1;

  it('shows "4 planned · 1 free · 100% done" instead of 80% for Saturday', () => {
    const markup = renderToStaticMarkup(
      <PlanReadView periods={fullWeek()} periodCount={5} planClassName="Grade 5-A" />,
    );
    expect(countOf(markup, '100% done')).toBe(DAYS_OF_WEEK.length);
    expect(countOf(markup, '1 free')).toBe(DAYS_OF_WEEK.length);
    expect(countOf(markup, '4 planned')).toBe(DAYS_OF_WEEK.length);
    expect(markup).not.toContain('80% done');
  });

  it('does not call an unfilled period "free" — it is reported as missing', () => {
    // Period 5 is simply blank: not marked free, so it still needs a plan.
    const week = DAYS_OF_WEEK.flatMap((d) => [
      readPeriod(d, 1, 'Counting 1-10'),
      readPeriod(d, 2, 'Number tracing'),
      readPeriod(d, 3, 'More and less'),
      readPeriod(d, 4, 'Number matching'),
      readPeriod(d, 5, ''),
    ]);
    const markup = renderToStaticMarkup(
      <PlanReadView periods={week} periodCount={5} planClassName="Grade 5-A" />,
    );
    expect(countOf(markup, '0 free')).toBe(DAYS_OF_WEEK.length);
    expect(countOf(markup, '80% done')).toBe(DAYS_OF_WEEK.length);
    expect(markup).not.toContain('Free period');
  });

  it('renders an explicitly free period as a free period', () => {
    const markup = renderToStaticMarkup(
      <PlanReadView periods={fullWeek()} periodCount={5} planClassName="KG-A" defaultCollapsed={false} />,
    );
    expect(countOf(markup, 'Free period')).toBe(DAYS_OF_WEEK.length);
  });
});
