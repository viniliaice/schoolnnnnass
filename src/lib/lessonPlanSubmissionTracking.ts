/**
 * Pure logic for the supervisor's Lesson Plan Submission page.
 *
 * That page answers one question — "who has submitted their lesson plan for
 * the selected week, and who hasn't?" — and its answer must start from the
 * roster of teachers who are EXPECTED to submit, not from the lesson-plan
 * rows. A teacher with no plan for the week must appear as "Not Submitted"
 * instead of disappearing from the page.
 *
 * Nothing in this file touches the database; it merges the two shapes the
 * page fetches (expected submitters + one week's plans) and describes the
 * result. Keeping it pure makes the accountability maths directly testable.
 */

import type { PlanStatus } from '../types/index.js';
import type { PlanWeekCount } from './lessonPlanWeeks.js';
import { buildPlanWeeks } from './lessonPlanWeeks.js';
import { makeWeekLabel, weekNumberForDate, weekRangeForNumber } from '../utils/weekDates.js';

/**
 * A plan counts as a submission in every state where the teacher has handed
 * it in. That is the review page's status set plus `revision_requested` — a
 * plan sent back for revisions was still uploaded for the week; the teacher
 * is not "missing". Only `draft` (never handed in) does not count.
 */
export const SUBMISSION_TRACKING_STATUSES: PlanStatus[] = [
  'submitted',
  'in_review',
  'approved',
  'rejected',
  'ai_failed',
  'revision_requested',
];

/** A teacher the school expects to submit a lesson plan, with their classes. */
export interface ExpectedSubmitter {
  teacherId: string;
  teacherName: string;
  classes: string[];
}

/** The slice of a lesson-plan row the submission page needs. */
export interface SubmissionTrackingPlan {
  id: string;
  teacher_id: string;
  class_name: string;
  week_label: string;
  status: PlanStatus;
  /** Stamped by submit_lesson_plan_for_review when the teacher submits. */
  ai_started_at?: string | null;
  created_at: string;
  updated_at: string;
  teacher_name?: string | null;
}

/** One teacher's submission status for the selected week. */
export interface SubmissionRow {
  teacherId: string;
  teacherName: string;
  /** Classes the teacher is expected to plan for this year. */
  assignedClasses: string[];
  submitted: boolean;
  /** Classes actually covered by this week's plans (empty when missing). */
  submittedClasses: string[];
  /** Latest submission stamp among this week's plans; null when missing. */
  submittedAt: string | null;
  /** Raw plan records for the week (a teacher with 3 records still counts once). */
  planCount: number;
  /** The plan the View button opens — the latest one for the week. */
  latestPlanId: string | null;
  latestPlanStatus: PlanStatus | null;
}

/** A selectable week on the submission page. */
export interface SubmissionWeek {
  /** Stable `<select>` value, same keying as the review page's weeks. */
  key: string;
  /** "Week 2026-W07" */
  label: string;
  /** "12 Sep – 16 Sep 2026", or null when the dates can't be resolved. */
  rangeLabel: string | null;
  /** Every stored `week_label` spelling belonging to this week. */
  weekLabels: string[];
  /** True for the school week that contains "today". */
  isCurrent: boolean;
  /** How many plans are stored under this week (0 for untouched weeks). */
  planCount: number;
  year: number | null;
  week: number | null;
}

export type SubmissionStatusFilter = 'all' | 'submitted' | 'not_submitted';
export type SubmissionSort = 'missing-first' | 'name' | 'latest';

export interface SubmissionFilters {
  status: SubmissionStatusFilter;
  /** null = all classes. */
  className: string | null;
  /** Free-text teacher-name search. */
  search: string;
}

export interface SubmissionSummary {
  total: number;
  submitted: number;
  notSubmitted: number;
  /** 0–100, rounded. 0 when there is nobody to track. */
  rate: number;
}

/** The best-available "when did the teacher submit" stamp for a plan. */
export function submissionStamp(plan: SubmissionTrackingPlan): string {
  return plan.ai_started_at || plan.updated_at || plan.created_at;
}

function daysBetween(a: Date, b: Date): number {
  const aDay = new Date(a); aDay.setHours(0, 0, 0, 0);
  const bDay = new Date(b); bDay.setHours(0, 0, 0, 0);
  return Math.round((bDay.getTime() - aDay.getTime()) / 86400000);
}

/**
 * The weeks the submission page offers.
 *
 * Unlike the review page (which only lists weeks that HAVE submissions), a
 * submission tracker must also offer weeks where nobody submitted anything —
 * otherwise the very week the school wants accountability for is invisible.
 * So the list is generated from the academic-year calendar (week 1 … the
 * current week) and then merged with the stored submission weeks:
 *
 *   * every generated week is selectable even with zero plans,
 *   * legacy label spellings ("week 7", "Week7") fold into their week so the
 *     fetch still finds those plans,
 *   * stored weeks outside the generated range (future submissions, last
 *     year's weeks) stay selectable at their sorted position.
 *
 * Without an academic year the list degrades to the submitted weeks alone —
 * the same source the review page uses.
 */
export function buildSubmissionWeeks(
  submissionWeekCounts: PlanWeekCount[] | null | undefined,
  academicYear: { startDate: string; endDate?: string | null } | null | undefined,
  today: Date = new Date()
): SubmissionWeek[] {
  const dbWeeks = buildPlanWeeks(submissionWeekCounts, academicYear?.startDate ?? null);

  if (!academicYear?.startDate) {
    return dbWeeks.map((week) => ({ ...week, isCurrent: false }));
  }

  const start = new Date(academicYear.startDate);
  if (!Number.isFinite(start.getTime())) {
    return dbWeeks.map((week) => ({ ...week, isCurrent: false }));
  }
  const startYear = start.getFullYear();
  const currentWeek = weekNumberForDate(start, today);

  // How many teaching weeks the year defines (week 1 .. endDate). A missing
  // or unparseable end date simply means "up to the current week".
  let weeksInYear = Number.POSITIVE_INFINITY;
  if (academicYear.endDate) {
    const end = new Date(academicYear.endDate);
    if (Number.isFinite(end.getTime())) {
      weeksInYear = Math.max(1, Math.ceil((daysBetween(start, end) + 1) / 7));
    }
  }
  const lastSelectableWeek = Math.min(currentWeek, weeksInYear);

  const generated: SubmissionWeek[] = [];
  for (let week = 1; week <= lastSelectableWeek; week++) {
    const label = makeWeekLabel(start, week);
    generated.push({
      key: `${startYear}#${week}`,
      label: `Week ${label}`,
      rangeLabel: weekRangeForNumber(start, week).label,
      weekLabels: [label],
      isCurrent: week === currentWeek,
      planCount: 0,
      year: startYear,
      week,
    });
  }

  // Fold stored submission weeks into the generated calendar where they
  // belong, and keep the rest (future weeks, other years) as extra options.
  const extras: SubmissionWeek[] = [];
  for (const dbWeek of dbWeeks) {
    const week = dbWeek.week;
    if (
      week !== null
      && week >= 1
      && week <= lastSelectableWeek
      && (dbWeek.year === null || dbWeek.year === startYear)
    ) {
      const target = generated[week - 1];
      target.weekLabels = Array.from(new Set([...target.weekLabels, ...dbWeek.weekLabels])).sort();
      target.planCount += dbWeek.planCount;
      continue;
    }
    extras.push({ ...dbWeek, isCurrent: false });
  }

  return [...generated, ...extras].sort(
    (a, b) => weekSortScore(b, startYear) - weekSortScore(a, startYear) || a.label.localeCompare(b.label)
  );
}

function weekSortScore(week: SubmissionWeek, startYear: number): number {
  if (week.week === null) return -1;
  const year = week.year ?? startYear;
  return year * 1000 + week.week;
}

/** The week the page opens on: the current school week when it is selectable. */
export function defaultSubmissionWeek(weeks: SubmissionWeek[]): SubmissionWeek | null {
  return weeks.find((week) => week.isCurrent) ?? weeks[0] ?? null;
}

/**
 * Merge the expected submitters with one week's plans into per-teacher rows.
 *
 * The roster comes first: every expected teacher gets exactly one row, so a
 * teacher with no plan shows up as "Not Submitted". Teachers who submitted
 * but are no longer on the roster (class reassigned mid-year, role changed)
 * are added from the plans so their submissions stay visible — they are
 * genuinely submitted, never "missing". Multiple plan records from the same
 * teacher collapse into ONE submitted teacher.
 */
export function buildSubmissionRows(
  submitters: ExpectedSubmitter[] | null | undefined,
  plans: SubmissionTrackingPlan[] | null | undefined
): SubmissionRow[] {
  const byTeacher = new Map<string, SubmissionTrackingPlan[]>();
  for (const plan of plans ?? []) {
    if (!plan?.teacher_id) continue;
    const list = byTeacher.get(plan.teacher_id);
    if (list) list.push(plan);
    else byTeacher.set(plan.teacher_id, [plan]);
  }

  const rows: SubmissionRow[] = [];
  const seen = new Set<string>();

  for (const submitter of submitters ?? []) {
    if (!submitter?.teacherId || seen.has(submitter.teacherId)) continue;
    seen.add(submitter.teacherId);
    rows.push(rowFor(submitter.teacherId, submitter.teacherName, submitter.classes ?? [], byTeacher));
  }

  // Submitters only — plus plan authors the roster does not cover, so an
  // unexpected submission never vanishes from the week.
  for (const [teacherId, teacherPlans] of byTeacher) {
    if (seen.has(teacherId)) continue;
    seen.add(teacherId);
    const name = teacherPlans.find((plan) => plan.teacher_name)?.teacher_name || 'Unknown teacher';
    rows.push(rowFor(teacherId, name, [], byTeacher));
  }

  return rows;
}

function rowFor(
  teacherId: string,
  teacherName: string,
  assignedClasses: string[],
  byTeacher: Map<string, SubmissionTrackingPlan[]>
): SubmissionRow {
  const plans = byTeacher.get(teacherId) ?? [];
  if (plans.length === 0) {
    return {
      teacherId,
      teacherName,
      assignedClasses,
      submitted: false,
      submittedClasses: [],
      submittedAt: null,
      planCount: 0,
      latestPlanId: null,
      latestPlanStatus: null,
    };
  }

  // Newest submission first: the row's stamp and its View target follow the
  // plan the teacher handed in most recently for this week.
  const ordered = [...plans].sort(
    (a, b) => submissionStamp(b).localeCompare(submissionStamp(a)) || b.created_at.localeCompare(a.created_at)
  );
  const latest = ordered[0];
  const submittedClasses: string[] = [];
  for (const plan of ordered) {
    if (plan.class_name && !submittedClasses.includes(plan.class_name)) {
      submittedClasses.push(plan.class_name);
    }
  }

  return {
    teacherId,
    teacherName,
    assignedClasses,
    submitted: true,
    submittedClasses,
    submittedAt: submissionStamp(latest),
    planCount: plans.length,
    latestPlanId: latest.id,
    latestPlanStatus: latest.status,
  };
}

/** Classes to show in the row: what was submitted, else what is expected. */
export function submissionClassLabel(row: SubmissionRow): string {
  const classes = row.submittedClasses.length > 0 ? row.submittedClasses : row.assignedClasses;
  if (classes.length === 0) return '—';
  return classes.join(', ');
}

/** Apply the page filters together: status AND class AND name search. */
export function filterSubmissionRows(
  rows: SubmissionRow[],
  filters: SubmissionFilters
): SubmissionRow[] {
  const search = filters.search.trim().toLowerCase();
  return rows.filter((row) => {
    if (filters.status === 'submitted' && !row.submitted) return false;
    if (filters.status === 'not_submitted' && row.submitted) return false;
    if (
      filters.className
      && !row.assignedClasses.includes(filters.className)
      && !row.submittedClasses.includes(filters.className)
    ) {
      return false;
    }
    if (search && !row.teacherName.toLowerCase().includes(search)) return false;
    return true;
  });
}

/**
 * Default ordering puts the teachers who need attention first: Not Submitted
 * before Submitted. The alternatives keep a plain A–Z or a latest-submission
 * ordering available.
 */
export function sortSubmissionRows(rows: SubmissionRow[], sort: SubmissionSort): SubmissionRow[] {
  const ordered = [...rows];
  if (sort === 'name') {
    return ordered.sort((a, b) => a.teacherName.localeCompare(b.teacherName) || a.teacherId.localeCompare(b.teacherId));
  }
  if (sort === 'latest') {
    return ordered.sort(
      (a, b) => (b.submittedAt ?? '').localeCompare(a.submittedAt ?? '') || a.teacherName.localeCompare(b.teacherName)
    );
  }
  return ordered.sort(
    (a, b) =>
      Number(a.submitted) - Number(b.submitted)
      || a.teacherName.localeCompare(b.teacherName)
      || a.teacherId.localeCompare(b.teacherId)
  );
}

/** Teacher-level summary for the cards and the progress bar. */
export function summarizeSubmissions(rows: SubmissionRow[]): SubmissionSummary {
  const total = rows.length;
  const submitted = rows.filter((row) => row.submitted).length;
  return {
    total,
    submitted,
    notSubmitted: total - submitted,
    rate: total === 0 ? 0 : Math.round((submitted / total) * 100),
  };
}

/** Every class the supervisor can filter by, in display order. */
export function submissionClassOptions(rows: SubmissionRow[]): string[] {
  const classes = new Set<string>();
  for (const row of rows) {
    for (const name of [...row.assignedClasses, ...row.submittedClasses]) {
      if (name) classes.add(name);
    }
  }
  return [...classes].sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
}
