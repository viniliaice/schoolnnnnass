import { describe, expect, it } from 'vitest';
import { buildPlanWeeks, parseWeekLabel, plansBelongToWeek } from '../lessonPlanWeeks';

// Academic year starts Saturday 1 Aug 2026, so the teaching weeks are:
//   week 4 = 22 Aug – 26 Aug 2026
//   week 5 = 29 Aug –  2 Sep 2026
//   week 6 =  5 Sep –  9 Sep 2026
//   week 7 = 12 Sep – 16 Sep 2026   <- the "current" week in this fixture
const YEAR_START = '2026-08-01';

const WEEK_ROWS = [
  { week_label: '2026-W04', plan_count: 6 },
  { week_label: '2026-W06', plan_count: 9 },
  { week_label: '2026-W07', plan_count: 18 },
  { week_label: '2026-W05', plan_count: 4 },
];

describe('parseWeekLabel', () => {
  it('reads the canonical stored label', () => {
    expect(parseWeekLabel('2026-W07')).toEqual({ year: 2026, week: 7 });
    expect(parseWeekLabel('2026-W12')).toEqual({ year: 2026, week: 12 });
  });

  it('reads the inconsistent labels teachers end up with', () => {
    expect(parseWeekLabel('week 7')).toEqual({ year: null, week: 7 });
    expect(parseWeekLabel('Week7')).toEqual({ year: null, week: 7 });
    expect(parseWeekLabel('Week 05')).toEqual({ year: null, week: 5 });
    expect(parseWeekLabel('week6')).toEqual({ year: null, week: 6 });
    expect(parseWeekLabel('Week 2026-W07')).toEqual({ year: 2026, week: 7 });
  });

  it('returns nulls for junk instead of guessing a week', () => {
    expect(parseWeekLabel('')).toEqual({ year: null, week: null });
    expect(parseWeekLabel(null)).toEqual({ year: null, week: null });
    expect(parseWeekLabel('Unit 3 — Fractions')).toEqual({ year: null, week: null });
  });
});

describe('buildPlanWeeks — the week selector', () => {
  const weeks = buildPlanWeeks(WEEK_ROWS, YEAR_START);

  it('lists every submitted week, most recent first', () => {
    expect(weeks.map((w) => w.label)).toEqual([
      'Week 2026-W07',
      'Week 2026-W06',
      'Week 2026-W05',
      'Week 2026-W04',
    ]);
  });

  it('shows the real date range next to the week', () => {
    expect(weeks[0].rangeLabel).toBe('12 Sep – 16 Sep 2026');
    expect(weeks[1].rangeLabel).toBe('5 Sep – 9 Sep 2026');
    expect(weeks[2].rangeLabel).toBe('29 Aug – 2 Sep 2026');
    expect(weeks[3].rangeLabel).toBe('22 Aug – 26 Aug 2026');
  });

  it('keeps the plan count stored under each week', () => {
    expect(weeks.map((w) => w.planCount)).toEqual([18, 9, 4, 6]);
  });

  it('exposes the raw stored labels so the week can be fetched from the database', () => {
    expect(weeks[0].weekLabels).toEqual(['2026-W07']);
    expect(weeks.find((w) => w.label === 'Week 2026-W05')?.weekLabels).toEqual(['2026-W05']);
  });

  it('sorts across year boundaries: 2027-W01 is newer than 2026-W52', () => {
    const cross = buildPlanWeeks(
      [
        { week_label: '2026-W52', plan_count: 2 },
        { week_label: '2027-W01', plan_count: 3 },
        { week_label: '2026-W51', plan_count: 1 },
      ],
      '2026-08-01'
    );
    expect(cross.map((w) => w.label)).toEqual(['Week 2027-W01', 'Week 2026-W52', 'Week 2026-W51']);
  });

  it('merges two spellings of the same week into one selectable week', () => {
    const merged = buildPlanWeeks(
      [
        { week_label: '2026-W7', plan_count: 2 },
        { week_label: '2026-W07', plan_count: 5 },
      ],
      YEAR_START
    );
    expect(merged).toHaveLength(1);
    expect(merged[0].label).toBe('Week 2026-W07');
    expect(merged[0].planCount).toBe(7);
    expect(merged[0].weekLabels).toEqual(['2026-W07', '2026-W7']);
    expect(merged[0].rangeLabel).toBe('12 Sep – 16 Sep 2026');
  });

  it('keeps a year-less label in its own bucket rather than guessing a year', () => {
    const mixed = buildPlanWeeks(
      [
        { week_label: '2026-W04', plan_count: 6 },
        { week_label: 'Week 4', plan_count: 1 },
      ],
      YEAR_START
    );
    // Both sit next to each other, newest-week ordering still applies.
    expect(mixed.map((w) => w.label)).toEqual(['Week 2026-W04', 'Week 4']);
    expect(mixed[0].weekLabels).toEqual(['2026-W04']);
    expect(mixed[1].weekLabels).toEqual(['Week 4']);
    expect(mixed[1].rangeLabel).toBe('22 Aug – 26 Aug 2026');
  });

  it('hides dates it cannot place on the current calendar', () => {
    const old = buildPlanWeeks([{ week_label: '2025-W40', plan_count: 1 }], YEAR_START);
    expect(old[0].label).toBe('Week 2025-W40');
    expect(old[0].rangeLabel).toBeNull();
  });

  it('sinks unparseable labels to the bottom', () => {
    const junk = buildPlanWeeks(
      [
        { week_label: 'Intro week', plan_count: 1 },
        { week_label: '2026-W02', plan_count: 2 },
      ],
      YEAR_START
    );
    expect(junk.map((w) => w.label)).toEqual(['Week 2026-W02', 'Intro week']);
  });

  it('returns nothing when there are no submissions', () => {
    expect(buildPlanWeeks([], YEAR_START)).toEqual([]);
    expect(buildPlanWeeks(null, YEAR_START)).toEqual([]);
  });
});

describe('plansBelongToWeek — no cross-week mixing', () => {
  it('accepts only plans stored under the selected week', () => {
    const weeks = buildPlanWeeks(WEEK_ROWS, YEAR_START);
    const week7 = weeks[0];
    expect(plansBelongToWeek(week7, [{ week_label: '2026-W07' }, { week_label: '2026-W07' }])).toBe(true);
    expect(plansBelongToWeek(week7, [{ week_label: '2026-W07' }, { week_label: '2026-W05' }])).toBe(false);
    expect(plansBelongToWeek(week7, [])).toBe(true);
  });
});
