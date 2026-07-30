import { describe, it, expect } from 'vitest';
import {
  makeWeekLabel,
  weekNumberFromLabel,
  weekNumberForDate,
  weekRangeForNumber,
  weekRangeFromLabel,
  describePlanWeek,
  formatWeekRange,
} from '../../utils/weekDates';

// Academic year starts Saturday 25 Jul 2026, so:
//   week 1 = 25 Jul – 29 Jul
//   week 2 =  1 Aug –  5 Aug   <- the "existing/submitted" week from the repro
//   week 3 =  8 Aug – 12 Aug   <- the "new/blank" week from the repro
const YEAR_START = '2026-07-25';

describe('week label <-> number', () => {
  it('builds a zero-padded label', () => {
    expect(makeWeekLabel(YEAR_START, 2)).toBe('2026-W02');
    expect(makeWeekLabel(YEAR_START, 13)).toBe('2026-W13');
  });

  it('parses the week number back out', () => {
    expect(weekNumberFromLabel('2026-W02')).toBe(2);
    expect(weekNumberFromLabel('2026-W13')).toBe(13);
  });

  it('treats the legacy W00 label as unresolvable rather than guessing', () => {
    expect(weekNumberFromLabel('2026-W00')).toBeNull();
    expect(weekRangeFromLabel('2026-W00', YEAR_START)).toBeNull();
  });

  it('returns null for junk input instead of throwing', () => {
    expect(weekNumberFromLabel(null)).toBeNull();
    expect(weekNumberFromLabel('')).toBeNull();
    expect(weekNumberFromLabel('not-a-week')).toBeNull();
  });

  it('round-trips label -> number -> label', () => {
    for (const n of [1, 2, 3, 9, 10, 52]) {
      expect(weekNumberFromLabel(makeWeekLabel(YEAR_START, n))).toBe(n);
    }
  });
});

describe('week number for a date', () => {
  it('maps the first teaching week to week 1', () => {
    expect(weekNumberForDate(YEAR_START, '2026-07-25')).toBe(1);
    expect(weekNumberForDate(YEAR_START, '2026-07-29')).toBe(1);
  });

  it('maps 1 Aug 2026 to week 2 and 8 Aug to week 3', () => {
    expect(weekNumberForDate(YEAR_START, '2026-08-01')).toBe(2);
    expect(weekNumberForDate(YEAR_START, '2026-08-08')).toBe(3);
  });

  it('clamps dates before the year start to week 1', () => {
    expect(weekNumberForDate(YEAR_START, '2026-07-01')).toBe(1);
  });
});

describe('week date ranges (#2 — dates must be visible)', () => {
  it('produces the 1 Aug – 5 Aug 2026 range for week 2', () => {
    const range = weekRangeForNumber(YEAR_START, 2);
    expect(range.startShort).toBe('1 Aug');
    expect(range.endShort).toBe('5 Aug');
    expect(range.label).toBe('1 Aug – 5 Aug 2026');
  });

  it('produces the 8 Aug – 12 Aug 2026 range for week 3', () => {
    expect(weekRangeForNumber(YEAR_START, 3).label).toBe('8 Aug – 12 Aug 2026');
  });

  it('returns five teaching days, Saturday through Wednesday', () => {
    const range = weekRangeForNumber(YEAR_START, 2);
    expect(range.dates).toEqual([
      '01/08/2026', '02/08/2026', '03/08/2026', '04/08/2026', '05/08/2026',
    ]);
  });

  it('derives the same range from a stored week_label', () => {
    expect(weekRangeFromLabel('2026-W02', YEAR_START)?.label).toBe('1 Aug – 5 Aug 2026');
    expect(weekRangeFromLabel('2026-W03', YEAR_START)?.label).toBe('8 Aug – 12 Aug 2026');
  });

  it('keeps both years when a week straddles a year boundary', () => {
    const label = formatWeekRange(new Date(2026, 11, 30), new Date(2027, 0, 3));
    expect(label).toBe('30 Dec 2026 – 3 Jan 2027');
  });

  it('falls back to the raw label when the year start is unknown', () => {
    expect(describePlanWeek('2026-W02', null)).toBe('Week 2026-W02');
    expect(describePlanWeek('2026-W02', YEAR_START)).toBe('1 Aug – 5 Aug 2026');
  });
});

describe('week isolation (#3 — regression guard)', () => {
  it('gives every week a distinct label and a distinct range', () => {
    const w2 = weekRangeForNumber(YEAR_START, 2);
    const w3 = weekRangeForNumber(YEAR_START, 3);

    expect(makeWeekLabel(YEAR_START, 2)).not.toBe(makeWeekLabel(YEAR_START, 3));
    expect(w2.label).not.toBe(w3.label);
    // The two weeks must not share a single calendar day.
    expect(w2.dates.some((d) => w3.dates.includes(d))).toBe(false);
  });

  it('is a pure function of the week number — no dependence on "today"', () => {
    // The old bug derived the label from new Date(), so it drifted.
    const a = makeWeekLabel(YEAR_START, 3);
    const b = makeWeekLabel(YEAR_START, 3);
    expect(a).toBe(b);
    expect(a).toBe('2026-W03');
  });
});
