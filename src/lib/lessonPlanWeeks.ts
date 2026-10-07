/**
 * Week buckets for the supervisor's Lesson Plan Review page.
 *
 * A supervisor reviews one week at a time, so the page needs two things:
 *   1. the list of weeks that actually have submissions, newest first, and
 *   2. the set of stored `week_label` values belonging to each of them, so the
 *      week's plans can be fetched from the database directly.
 *
 * Grouping always uses the stored `week_label` column — never the
 * teacher-entered `title`, which is free text ("week 7", "Week7", "Week 05"
 * and "Week 2026-W07" can all describe the same week). Nothing here writes or
 * reshapes plan rows; it only describes what is already stored.
 */

import { weekRangeForNumber } from '../utils/weekDates.js';

/** One row of `week_label -> number of plans`, as stored in the database. */
export interface PlanWeekCount {
  week_label: string;
  plan_count: number;
}

/** A selectable week in the supervisor's week dropdown. */
export interface PlanWeek {
  /** Stable `<select>` value: `2026#7`, `#7` (no year), or `raw:<label>`. */
  key: string;
  /** "Week 2026-W07" */
  label: string;
  /** "12 Sep – 16 Sep 2026", or null when the dates can't be resolved. */
  rangeLabel: string | null;
  /** Every raw `week_label` stored under this week (legacy variants included). */
  weekLabels: string[];
  planCount: number;
  year: number | null;
  week: number | null;
}

export interface ParsedWeekLabel {
  year: number | null;
  week: number | null;
}

const CANONICAL_LABEL = /^(\d{4})-W(\d{1,2})$/i;
const TRAILING_WEEK = /W(\d+)\s*$/i;
const YEAR_ANYWHERE = /\b(\d{4})\b/;
const LOOSE_WEEK = /\bW(?:eek)?\.?\s*0*(\d+)\b/i;

/**
 * Pull the calendar year and 1-based week number out of a stored label.
 *
 * Handles the canonical "2026-W07" plus the loose variants that exist in
 * older rows ("Week 7", "Week7", "Week 05", "week 5"). Anything unparseable
 * returns nulls so callers can show the raw label instead of guessing.
 */
export function parseWeekLabel(label: string | null | undefined): ParsedWeekLabel {
  const raw = (label ?? '').trim();
  if (!raw) return { year: null, week: null };

  const canonical = CANONICAL_LABEL.exec(raw);
  if (canonical) return { year: Number(canonical[1]), week: Number(canonical[2]) };

  const trailing = TRAILING_WEEK.exec(raw);
  const loose = LOOSE_WEEK.exec(raw);
  const weekText = trailing?.[1] ?? loose?.[1] ?? null;
  const week = weekText ? Number(weekText) : null;
  const yearText = YEAR_ANYWHERE.exec(raw)?.[1] ?? null;
  const year = yearText ? Number(yearText) : null;

  return {
    year: year && year >= 1900 && year <= 2999 ? year : null,
    week: week && week >= 1 ? week : null,
  };
}

/** Canonical label for a parsed week, or null when it can't be normalised. */
function canonicalLabel(parsed: ParsedWeekLabel): string | null {
  if (parsed.week === null) return null;
  if (parsed.year === null) return null;
  return `${parsed.year}-W${String(parsed.week).padStart(2, '0')}`;
}

/** Identity of a week: same week + same year == same bucket. */
function bucketKey(parsed: ParsedWeekLabel, raw: string): string {
  if (parsed.week !== null) return `${parsed.year ?? ''}#${parsed.week}`;
  return `raw:${raw.toLowerCase()}`;
}

function academicYearStartYear(academicYearStart: string | Date | null | undefined): number | null {
  if (!academicYearStart) return null;
  const date = new Date(academicYearStart);
  return Number.isFinite(date.getTime()) ? date.getFullYear() : null;
}

/**
 * Group stored week labels into selectable weeks, most recent first.
 *
 * `academicYearStart` is only used to turn a week number into real dates and to
 * order labels that carry no year; it never changes which bucket a plan is in.
 */
export function buildPlanWeeks(
  rows: PlanWeekCount[] | null | undefined,
  academicYearStart: string | Date | null | undefined
): PlanWeek[] {
  const startYear = academicYearStartYear(academicYearStart);
  const buckets = new Map<string, { labels: Set<string>; planCount: number; parsed: ParsedWeekLabel; raw: string }>();

  for (const row of rows ?? []) {
    const raw = (row?.week_label ?? '').trim();
    if (!raw) continue;
    const parsed = parseWeekLabel(raw);
    const key = bucketKey(parsed, raw);
    const existing = buckets.get(key);
    if (existing) {
      existing.labels.add(raw);
      existing.planCount += Number(row?.plan_count ?? 0) || 0;
      // Prefer a label that carries the year so the display is unambiguous.
      if (existing.parsed.year === null && parsed.year !== null) existing.parsed = parsed;
      continue;
    }
    buckets.set(key, {
      labels: new Set([raw]),
      planCount: Number(row?.plan_count ?? 0) || 0,
      parsed,
      raw,
    });
  }

  const weeks: PlanWeek[] = [];
  for (const [key, bucket] of buckets) {
    const { parsed } = bucket;
    const canonical = canonicalLabel(parsed);
    // Dates are only shown when they are trustworthy: a week number from a
    // different calendar year cannot be placed on the current year's calendar.
    const datesAreTrustworthy =
      !!academicYearStart
      && parsed.week !== null
      && (parsed.year === null || startYear === null || parsed.year === startYear);
    const range = datesAreTrustworthy
      ? weekRangeForNumber(academicYearStart as string | Date, parsed.week as number)
      : null;

    weeks.push({
      key,
      label: canonical ? `Week ${canonical}` : parsed.week !== null ? `Week ${parsed.week}` : bucket.raw,
      rangeLabel: range?.label ?? null,
      weekLabels: [...bucket.labels].sort(),
      planCount: bucket.planCount,
      year: parsed.year,
      week: parsed.week,
    });
  }

  return weeks.sort((a, b) => sortScore(b, startYear) - sortScore(a, startYear) || a.label.localeCompare(b.label));
}

/** Bigger score == more recent. Unparseable labels sink to the bottom. */
function sortScore(week: PlanWeek, startYear: number | null): number {
  if (week.week === null) return -1;
  const year = week.year ?? startYear ?? 0;
  return year * 1000 + week.week;
}

/** True when every plan label in `plans` belongs to this week's bucket. */
export function plansBelongToWeek<T extends { week_label: string }>(
  week: PlanWeek | null | undefined,
  plans: T[] | null | undefined
): boolean {
  if (!week) return false;
  const allowed = new Set(week.weekLabels);
  return (plans ?? []).every((plan) => allowed.has(plan.week_label));
}
