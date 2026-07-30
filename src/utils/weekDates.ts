/**
 * Single source of truth for translating between a plan's `week_label`
 * (e.g. "2026-W02") and the real calendar dates that week covers.
 *
 * Week numbering is 1-based and anchored to the academic year start:
 *   week 1  = academicYearStart .. +4 days
 *   week N  = academicYearStart + (N-1)*7 .. +4 days
 *
 * The teaching week is Saturday–Wednesday (5 days), matching the
 * `day_of_week` enum in the database.
 */

const MONTHS_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

export const TEACHING_DAYS_PER_WEEK = 5;

function atMidnight(value: string | Date): Date {
  const d = new Date(value);
  d.setHours(0, 0, 0, 0);
  return d;
}

/** Build the canonical label for a 1-based week number. */
export function makeWeekLabel(academicYearStart: string | Date, weekNumber: number): string {
  const start = atMidnight(academicYearStart);
  const safe = Math.max(1, Math.floor(weekNumber));
  return `${start.getFullYear()}-W${String(safe).padStart(2, '0')}`;
}

/**
 * Parse the 1-based week number out of a label.
 * Returns null for labels that carry no usable week (e.g. the legacy "W00").
 */
export function weekNumberFromLabel(label: string | null | undefined): number | null {
  if (!label) return null;
  const match = /W(\d+)\s*$/i.exec(label.trim());
  if (!match) return null;
  const n = Number(match[1]);
  if (!Number.isFinite(n) || n < 1) return null;
  return n;
}

/** Which 1-based week number contains `date`? Clamped to >= 1. */
export function weekNumberForDate(academicYearStart: string | Date, date: string | Date = new Date()): number {
  const start = atMidnight(academicYearStart);
  const target = atMidnight(date);
  const diffDays = Math.floor((target.getTime() - start.getTime()) / 86400000);
  if (diffDays < 0) return 1;
  return Math.floor(diffDays / 7) + 1;
}

export interface WeekRange {
  weekNumber: number;
  start: Date;
  end: Date;
  /** dd/mm/yyyy for each teaching day, aligned with DAYS_OF_WEEK */
  dates: string[];
  /** "1 Aug" */
  startShort: string;
  /** "5 Aug" */
  endShort: string;
  /** "1 Aug – 5 Aug 2026" */
  label: string;
}

/** Calendar range for a 1-based week number. */
export function weekRangeForNumber(academicYearStart: string | Date, weekNumber: number): WeekRange {
  const start = atMidnight(academicYearStart);
  const safe = Math.max(1, Math.floor(weekNumber));
  const weekStart = new Date(start);
  weekStart.setDate(weekStart.getDate() + (safe - 1) * 7);

  const dates: string[] = [];
  for (let i = 0; i < TEACHING_DAYS_PER_WEEK; i++) {
    const d = new Date(weekStart);
    d.setDate(d.getDate() + i);
    dates.push(`${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')}/${d.getFullYear()}`);
  }

  const weekEnd = new Date(weekStart);
  weekEnd.setDate(weekEnd.getDate() + (TEACHING_DAYS_PER_WEEK - 1));

  return {
    weekNumber: safe,
    start: weekStart,
    end: weekEnd,
    dates,
    startShort: formatDayMonth(weekStart),
    endShort: formatDayMonth(weekEnd),
    label: formatWeekRange(weekStart, weekEnd),
  };
}

/**
 * Calendar range for a stored `week_label`.
 * Returns null when the label can't be resolved (unknown year start or "W00"),
 * so callers can fall back to showing the raw label instead of a wrong date.
 */
export function weekRangeFromLabel(
  label: string | null | undefined,
  academicYearStart: string | Date | null | undefined
): WeekRange | null {
  if (!academicYearStart) return null;
  const weekNumber = weekNumberFromLabel(label);
  if (weekNumber === null) return null;
  return weekRangeForNumber(academicYearStart, weekNumber);
}

/** "1 Aug" */
export function formatDayMonth(date: Date): string {
  return `${date.getDate()} ${MONTHS_SHORT[date.getMonth()]}`;
}

/**
 * "1 Aug – 5 Aug 2026", collapsing the year when both ends share it and
 * keeping both years when a week straddles a year boundary.
 */
export function formatWeekRange(start: Date, end: Date): string {
  if (start.getFullYear() === end.getFullYear()) {
    return `${formatDayMonth(start)} – ${formatDayMonth(end)} ${end.getFullYear()}`;
  }
  return `${formatDayMonth(start)} ${start.getFullYear()} – ${formatDayMonth(end)} ${end.getFullYear()}`;
}

/**
 * Display helper: the date range for a plan, or the raw label as a fallback.
 * Used anywhere a plan is listed so every plan shows its dates.
 */
export function describePlanWeek(
  label: string | null | undefined,
  academicYearStart: string | Date | null | undefined
): string {
  const range = weekRangeFromLabel(label, academicYearStart);
  if (!range) return label ? `Week ${label}` : 'Week —';
  return range.label;
}
