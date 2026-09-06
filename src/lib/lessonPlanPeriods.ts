import { DayOfWeek, DAYS_OF_WEEK, LessonPlanPeriod, PeriodActivity } from '../types';

/**
 * Dynamic lesson-plan periods.
 *
 * A teacher's plan may contain any positive number of periods per day (e.g.
 * 4 for Foundation/KG classes, 5, 6, or more for others). Nothing here
 * assumes a fixed 5- or 6-period day: the helper functions below build,
 * resize and read period grids from a single `periodCount` value, which the
 * teacher controls in the Lesson Plan Upload / editor UI.
 */

export interface PeriodCell {
  day: DayOfWeek;
  period_number: number;
  subject: string;
  className: string;
  isFree: boolean;
  topic: string;
  objective: string;
  slide_number: string;
  details: PeriodActivity[];
}

/** Every plan must have at least one period; there is no fixed upper limit. */
export const MIN_PERIOD_COUNT = 1;

export function clampPeriodCount(value: unknown): number {
  const n = Math.floor(Number(value));
  return Number.isFinite(n) && n >= MIN_PERIOD_COUNT ? n : MIN_PERIOD_COUNT;
}

function emptyPeriod(day: DayOfWeek, periodNumber: number): PeriodCell {
  return {
    day,
    period_number: periodNumber,
    subject: '',
    className: '',
    isFree: false,
    topic: '',
    objective: '',
    slide_number: '',
    details: [],
  };
}

/**
 * Build a blank day × period grid (each day has exactly `periodCount` cells).
 * Only periods 1..periodCount exist — no period 5 or 6 is added unless the
 * requested count includes it.
 */
export function createEmptyPeriods(periodCount: number): PeriodCell[] {
  const count = clampPeriodCount(periodCount);
  const cells: PeriodCell[] = [];
  for (const day of DAYS_OF_WEEK) {
    for (let p = 1; p <= count; p++) {
      cells.push(emptyPeriod(day, p));
    }
  }
  return cells;
}

/**
 * Rebuild a blank/loaded grid for the given count, preserving every existing
 * cell that still belongs to periods 1..count and adding empty cells (per
 * day) for any new period above the previous maximum.
 */
export function resizePeriods(periods: PeriodCell[], periodCount: number): PeriodCell[] {
  const count = clampPeriodCount(periodCount);
  if (periods.length === 0) return createEmptyPeriods(count);

  const kept = periods.filter((cell) => cell.period_number <= count);

  for (const day of DAYS_OF_WEEK) {
    const dayMax = Math.max(0, ...periods.filter((cell) => cell.day === day).map((cell) => cell.period_number));
    for (let p = dayMax + 1; p <= count; p++) {
      kept.push(emptyPeriod(day, p));
    }
  }

  return kept;
}

/**
 * Hydrate a grid from the DB rows. Only the plan's own period count is
 * rendered, so a 4-period plan never gains phantom period 5/6 rows and an
 * existing 5- or 6-period plan keeps every historical period.
 */
export function periodsFromDb(periods: LessonPlanPeriod[], periodCount: number): PeriodCell[] {
  const count = clampPeriodCount(periodCount);
  const map = new Map<string, LessonPlanPeriod>();
  for (const p of periods) {
    map.set(`${p.day}-${p.period_number}`, p);
  }
  const cells: PeriodCell[] = [];
  for (const day of DAYS_OF_WEEK) {
    for (let p = 1; p <= count; p++) {
      const existing = map.get(`${day}-${p}`);
      cells.push({
        day,
        period_number: p,
        subject: existing?.subject || '',
        className: existing?.class_name || '',
        isFree: existing?.is_free || false,
        topic: existing?.topic || '',
        objective: existing?.objective || '',
        slide_number: existing?.slide_number || '',
        details: existing?.details || [],
      });
    }
  }
  return cells;
}

/**
 * Instructional periods (not marked free) that still need a topic.
 * Validation is based on the periods that actually exist for the plan, so a
 * four-period plan is only checked against its four periods — missing period
 * 5/6 is never treated as an error.
 */
export function emptyInstructionalPeriods(
  periods: Array<{ isFree?: boolean | null; subject?: string | null; topic?: string | null }>
): Array<{ isFree?: boolean | null; subject?: string | null; topic?: string | null }> {
  return periods.filter((p) => !p?.isFree && p?.subject !== '__FREE__' && !(p?.topic ?? '').trim());
}
