/**
 * The lesson-plan completion rule shared by the teacher planner, supervisor
 * monitor, and server-side academic reminders.
 *
 * Free periods are excluded. A required period is complete only when it has a
 * non-empty topic. Empty/missing slots are requirements, never implicit free
 * periods. Keep this calculation as the single source of truth.
 */

export interface DayPlanningPeriodInput {
  is_free?: boolean | null;
  subject?: string | null;
  topic?: string | null;
}

export const FREE_PERIOD_SUBJECT = '__FREE__';

export interface DayPlanningSummary {
  planned: number;
  free: number;
  completed: number;
  total: number;
  percent: number;
}

export function isFreePeriod(period?: DayPlanningPeriodInput | null): boolean {
  if (!period) return false;
  return period.is_free === true || period.subject === FREE_PERIOD_SUBJECT;
}

function roundTo2(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

/**
 * Completion summary for a day or a whole plan (the caller supplies the
 * periods and period count). The denominator is required, non-free periods;
 * an all-free slice has no missing work and is 100% complete.
 */
export function summarizeDay(
  periods: ReadonlyArray<DayPlanningPeriodInput | null | undefined>,
  periodCount: number,
): DayPlanningSummary {
  const total = Math.max(periodCount, periods.length, 1);
  const free = periods.reduce((count, period) => (isFreePeriod(period) ? count + 1 : count), 0);
  const planned = Math.max(total - free, 0);
  const completed = periods.reduce(
    (count, period) => (!isFreePeriod(period) && (period?.topic ?? '').trim() ? count + 1 : count),
    0,
  );
  const percent = planned === 0 ? 100 : roundTo2(Math.min(completed / planned, 1) * 100);
  return { planned, free, completed, total, percent };
}
