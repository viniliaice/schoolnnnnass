/**
 * Pure logic for the admin/supervisor "Monitor Marks Entries" page.
 *
 * The page answers one question — "which teacher/class/subject mark-entry
 * assignments are complete, in progress, or not started for the selected exam
 * period?" — and its answer starts from the roster of EXPECTED entries, not
 * from the exam rows. An assignment with no marks must appear as "Not Started"
 * instead of vanishing from the page.
 *
 * Nothing in this file touches the database. The DB layer
 * (db/marksUploadMonitoring.ts) fetches the per-assignment rows produced by the
 * get_monitor_marks_entries RPC; this module filters, sorts, and summarises
 * them. Keeping it pure makes the accountability maths directly testable.
 */

import type { ExamType } from '../types';

/** The marks-entry workflow an admin can monitor. */
export const MARKS_MONITOR_EXAM_TYPES: string[] = [
  'Monthly',
  'Midterm',
  'Final',
  'CA',
  'Homework',
  'Classwork',
  'Quiz',
  'Attendance',
];

/** Three-state status used everywhere on the monitoring page. */
export type MonitorMarksStatus = 'not_started' | 'in_progress' | 'complete';

/** A single teacher/class/subject mark-entry assignment for one exam period. */
export interface MonitorMarksRow {
  teacherId: string;
  teacherName: string;
  className: string;
  subjectId: string;
  subjectName: string;
  academicYearId: string | null;
  termId: string | null;
  termName: string | null;
  month: string;
  examType: string;
  /** Students expected to have marks (active roster for the class). */
  expectedStudents: number;
  /** Students who have the required marks for the selected exam type. */
  enteredStudents: number;
  /** Per-exam-type entered student counts (for the detail view). */
  caEntered: number;
  homeworkEntered: number;
  classworkEntered: number;
  quizEntered: number;
  attendanceEntered: number;
  midtermEntered: number;
  finalEntered: number;
  /** 0–100, rounded to 2 dp. 0 when there is nobody expected. */
  completionPercent: number;
  status: MonitorMarksStatus;
  /** Most recent exam createdAt for this assignment, or null. */
  lastUpdate: string | null;
}

export type MonitorMarksStatusFilter = 'all' | MonitorMarksStatus;
export type MonitorMarksSort = 'attention-first' | 'name' | 'completion';

export interface MonitorMarksFilters {
  status: MonitorMarksStatusFilter;
  /** null = all classes. */
  className: string | null;
  /** null = all subjects. */
  subjectName: string | null;
  /** null = all teachers (admin/supervisor only). */
  teacherId: string | null;
  /** Free-text teacher-name search. */
  search: string;
}

export interface MonitorMarksSummary {
  all: number;
  complete: number;
  inProgress: number;
  notStarted: number;
  /** Mean completion across every entry, 0–100 rounded. */
  avgCompletion: number;
}

/** Normalise a raw DB row into a typed MonitorMarksRow (defensive). */
export function normalizeMonitorMarksRow(row: Record<string, unknown>): MonitorMarksRow {
  const num = (value: unknown): number => {
    const n = typeof value === 'number' ? value : Number(value);
    return Number.isFinite(n) ? n : 0;
  };
  const status = row.status as MonitorMarksStatus;
  return {
    teacherId: String(row.teacherId ?? ''),
    teacherName: String(row.teacherName ?? ''),
    className: String(row.className ?? ''),
    subjectId: String(row.subjectId ?? ''),
    subjectName: String(row.subjectName ?? ''),
    academicYearId: row.academicYearId == null ? null : String(row.academicYearId),
    termId: row.termId == null ? null : String(row.termId),
    termName: row.termName == null ? null : String(row.termName),
    month: String(row.month ?? ''),
    examType: String(row.examType ?? 'Monthly'),
    expectedStudents: num(row.expectedStudents),
    enteredStudents: num(row.enteredStudents),
    caEntered: num(row.caEntered),
    homeworkEntered: num(row.homeworkEntered),
    classworkEntered: num(row.classworkEntered),
    quizEntered: num(row.quizEntered),
    attendanceEntered: num(row.attendanceEntered),
    midtermEntered: num(row.midtermEntered),
    finalEntered: num(row.finalEntered),
    completionPercent: num(row.completionPercent),
    status: status === 'complete' || status === 'in_progress' ? status : 'not_started',
    lastUpdate: row.lastUpdate == null ? null : String(row.lastUpdate),
  };
}

/**
 * Apply the page filters together: status AND class AND subject AND teacher
 * AND name search. Each filter is independent so the admin can narrow on
 * several axes at once, exactly like the lesson-plan tracker.
 */
export function filterMonitorMarksRows(
  rows: MonitorMarksRow[],
  filters: MonitorMarksFilters
): MonitorMarksRow[] {
  const search = filters.search.trim().toLowerCase();
  return rows.filter((row) => {
    if (filters.status !== 'all' && row.status !== filters.status) return false;
    if (filters.className && row.className !== filters.className) return false;
    if (filters.subjectName && row.subjectName !== filters.subjectName) return false;
    if (filters.teacherId && row.teacherId !== filters.teacherId) return false;
    if (search && !row.teacherName.toLowerCase().includes(search)) return false;
    return true;
  });
}

/**
 * Default ordering puts the assignments needing attention first: Not Started
 * before In Progress before Complete — and within a bucket, lowest completion
 * first. The alternatives keep a plain A–Z or a completion ordering available.
 */
export function sortMonitorMarksRows(rows: MonitorMarksRow[], sort: MonitorMarksSort): MonitorMarksRow[] {
  const ordered = [...rows];
  if (sort === 'name') {
    return ordered.sort(
      (a, b) =>
        a.teacherName.localeCompare(b.teacherName) ||
        a.className.localeCompare(b.className) ||
        a.subjectName.localeCompare(b.subjectName)
    );
  }
  if (sort === 'completion') {
    return ordered.sort(
      (a, b) =>
        a.completionPercent - b.completionPercent ||
        a.teacherName.localeCompare(b.teacherName)
    );
  }
  const rank = (status: MonitorMarksStatus): number =>
    status === 'not_started' ? 0 : status === 'in_progress' ? 1 : 2;
  return ordered.sort(
    (a, b) =>
      rank(a.status) - rank(b.status) ||
      a.completionPercent - b.completionPercent ||
      a.className.localeCompare(b.className) ||
      a.subjectName.localeCompare(b.subjectName) ||
      a.teacherName.localeCompare(b.teacherName)
  );
}

/** Entry-level summary for the cards and the progress bar. */
export function summarizeMonitorMarks(rows: MonitorMarksRow[]): MonitorMarksSummary {
  const all = rows.length;
  const complete = rows.filter((row) => row.status === 'complete').length;
  const inProgress = rows.filter((row) => row.status === 'in_progress').length;
  const notStarted = rows.filter((row) => row.status === 'not_started').length;
  const totalCompletion = rows.reduce((sum, row) => sum + row.completionPercent, 0);
  return {
    all,
    complete,
    inProgress,
    notStarted,
    avgCompletion: all === 0 ? 0 : Math.round(totalCompletion / all),
  };
}

/** Every class the admin can filter by, in display order. */
export function monitorMarksClassOptions(rows: MonitorMarksRow[]): string[] {
  const classes = new Set<string>();
  for (const row of rows) {
    if (row.className) classes.add(row.className);
  }
  return [...classes].sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
}

/** Every subject the admin can filter by, in display order. */
export function monitorMarksSubjectOptions(rows: MonitorMarksRow[]): string[] {
  const subjects = new Set<string>();
  for (const row of rows) {
    if (row.subjectName) subjects.add(row.subjectName);
  }
  return [...subjects].sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
}

/** Every teacher the admin can filter by, in display order. */
export function monitorMarksTeacherOptions(rows: MonitorMarksRow[]): { id: string; name: string }[] {
  const byId = new Map<string, string>();
  for (const row of rows) {
    if (row.teacherId && !byId.has(row.teacherId)) byId.set(row.teacherId, row.teacherName);
  }
  return [...byId.entries()]
    .map(([id, name]) => ({ id, name }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** Exam-type-specific entered count for the detail view. */
export function enteredForExamType(row: MonitorMarksRow, examType: ExamType | 'Monthly'): number {
  switch (examType) {
    case 'Monthly':
      return row.enteredStudents;
    case 'CA':
      return row.caEntered;
    case 'Homework':
      return row.homeworkEntered;
    case 'Classwork':
      return row.classworkEntered;
    case 'Quiz':
      return row.quizEntered;
    case 'Attendance':
      return row.attendanceEntered;
    case 'Midterm':
      return row.midtermEntered;
    case 'Final':
      return row.finalEntered;
    default:
      return 0;
  }
}

/** Which of the required components are still missing for a Monthly entry. */
export function missingMonthlyComponents(row: MonitorMarksRow): string[] {
  const missing: string[] = [];
  const courseworkDone =
    row.caEntered >= row.expectedStudents ||
    (row.homeworkEntered >= row.expectedStudents && row.classworkEntered >= row.expectedStudents);
  if (!courseworkDone) missing.push('Coursework (CA or Homework + Classwork)');
  if (row.quizEntered < row.expectedStudents) missing.push('Quiz');
  return missing;
}
