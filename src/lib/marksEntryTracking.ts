/**
 * Pure data-shaping and accountability logic for the admin/supervisor marks
 * monitor. The database RPC is authoritative for assignment, term-roster, and
 * exam matching; this module only normalizes its JSON shape and describes the
 * UI's three statuses.
 */

export const MARKS_EXAM_SCOPES = [
  'monthly',
  'midterm',
  'final',
  'ca',
  'homework',
  'classwork',
  'quiz',
  'attendance',
  'discipline',
] as const;

export type MarksExamScope = (typeof MARKS_EXAM_SCOPES)[number];
export type MarksEntryStatus = 'not_started' | 'in_progress' | 'complete';
export type MarksEntryStatusFilter = 'all' | MarksEntryStatus;
export type MarksEntrySort = 'status' | 'name' | 'latest' | 'percentage';

export interface MissingStudent {
  id: string;
  name: string;
}

/** The stable row the page renders, independent of Supabase's snake_case RPC output. */
export interface MarksEntryRow {
  assignmentId: string;
  teacherId: string;
  teacherName: string;
  className: string;
  subjectId: string;
  subjectName: string;
  academicYearId: string;
  termId: string;
  examScope: MarksExamScope;
  month: string | null;
  expectedStudents: number;
  enteredStudents: number;
  missingStudents: MissingStudent[];
  percentage: number;
  status: MarksEntryStatus;
  lastUpdated: string | null;
  /**
   * Monthly components. Homework is the CA component ("Homework (CA)"); the
   * monitor does not carry a separate CA count. Quiz counts every Quiz record,
   * including bulk-uploaded monthly tests labelled MT.
   */
  homeworkEntered: number;
  classworkEntered: number;
  quizEntered: number;
  attendanceEntered: number;
  courseworkComplete: boolean;
  quizComplete: boolean;
  /** For monthly this is the count of students with both required components. */
  monthlyCompleteStudents: number;
}

export interface MarksEntryFilters {
  status: MarksEntryStatusFilter;
  teacherId: string;
  className: string;
  subjectId: string;
  search: string;
}

export interface MarksEntrySummary {
  totalAssignments: number;
  complete: number;
  inProgress: number;
  notStarted: number;
  expectedStudents: number;
  enteredStudents: number;
  /** Mean row completion, matching the RPC's monthly blended percentage. */
  averagePercentage: number;
  /** Exact student-entry rate for non-monthly scopes; useful as a secondary KPI. */
  studentEntryRate: number;
}

export interface RawMarksEntryRow {
  assignment_id?: unknown;
  assignmentId?: unknown;
  teacher_id?: unknown;
  teacherId?: unknown;
  teacher_name?: unknown;
  teacherName?: unknown;
  class_name?: unknown;
  className?: unknown;
  subject_id?: unknown;
  subjectId?: unknown;
  subject_name?: unknown;
  subjectName?: unknown;
  academic_year_id?: unknown;
  academicYearId?: unknown;
  term_id?: unknown;
  termId?: unknown;
  exam_scope?: unknown;
  examScope?: unknown;
  month?: unknown;
  expected_students?: unknown;
  expectedStudents?: unknown;
  entered_students?: unknown;
  enteredStudents?: unknown;
  missing_students?: unknown;
  missingStudents?: unknown;
  percentage?: unknown;
  completion_status?: unknown;
  status?: unknown;
  last_updated?: unknown;
  lastUpdated?: unknown;
  /**
   * Still returned by the RPC because its monthly completion rule honours
   * legacy CA-type records, but intentionally NOT mapped onto MarksEntryRow:
   * the page treats Homework as the CA component and never shows a separate
   * CA count.
   */
  ca_entered?: unknown;
  caEntered?: unknown;
  homework_entered?: unknown;
  homeworkEntered?: unknown;
  classwork_entered?: unknown;
  classworkEntered?: unknown;
  quiz_entered?: unknown;
  quizEntered?: unknown;
  attendance_entered?: unknown;
  attendanceEntered?: unknown;
  coursework_complete?: unknown;
  courseworkComplete?: unknown;
  quiz_complete?: unknown;
  quizComplete?: unknown;
  monthly_complete_students?: unknown;
  monthlyCompleteStudents?: unknown;
}

const STATUS_ORDER: Record<MarksEntryStatus, number> = {
  not_started: 0,
  in_progress: 1,
  complete: 2,
};

function stringValue(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : value == null ? fallback : String(value);
}

function nullableString(value: unknown): string | null {
  const result = stringValue(value).trim();
  return result === '' ? null : result;
}

function numberValue(value: unknown, fallback = 0): number {
  const result = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(result) ? result : fallback;
}

function nonNegativeInt(value: unknown): number {
  return Math.max(0, Math.round(numberValue(value)));
}

function booleanValue(value: unknown): boolean {
  return value === true || value === 'true' || value === 1 || value === '1';
}

function scopeValue(value: unknown): MarksExamScope {
  const scope = stringValue(value, 'monthly').toLowerCase() as MarksExamScope;
  return (MARKS_EXAM_SCOPES as readonly string[]).includes(scope) ? scope : 'monthly';
}

function missingStudentValue(value: unknown): MissingStudent[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((entry) => {
      if (!entry || typeof entry !== 'object') return null;
      const candidate = entry as Record<string, unknown>;
      const id = stringValue(candidate.id ?? candidate.student_id).trim();
      const name = stringValue(candidate.name ?? candidate.student_name, 'Unknown student').trim();
      return id ? { id, name: name || 'Unknown student' } : null;
    })
    .filter((entry): entry is MissingStudent => entry !== null);
}

/** Derive the shared three-status vocabulary from counts, never from a row's label. */
export function marksEntryStatus(
  expectedStudents: number,
  enteredStudents: number,
  percentage: number,
  componentEntries = 0,
  complete = false,
): MarksEntryStatus {
  if (expectedStudents > 0 && complete) return 'complete';
  if (expectedStudents > 0 && enteredStudents >= expectedStudents) return 'complete';
  if (percentage > 0 || componentEntries > 0 || enteredStudents > 0) return 'in_progress';
  return 'not_started';
}

export function normalizeMarksEntryRow(raw: RawMarksEntryRow): MarksEntryRow {
  const expectedStudents = nonNegativeInt(raw.expected_students ?? raw.expectedStudents);
  const enteredStudents = Math.min(
    expectedStudents,
    nonNegativeInt(raw.entered_students ?? raw.enteredStudents),
  );
  const percentage = Math.min(100, Math.max(0, numberValue(raw.percentage)));
  const homeworkEntered = nonNegativeInt(raw.homework_entered ?? raw.homeworkEntered);
  const classworkEntered = nonNegativeInt(raw.classwork_entered ?? raw.classworkEntered);
  const quizEntered = nonNegativeInt(raw.quiz_entered ?? raw.quizEntered);
  const attendanceEntered = nonNegativeInt(raw.attendance_entered ?? raw.attendanceEntered);
  const scope = scopeValue(raw.exam_scope ?? raw.examScope);
  const complete = scope === 'monthly'
    ? booleanValue(raw.coursework_complete ?? raw.courseworkComplete)
      && booleanValue(raw.quiz_complete ?? raw.quizComplete)
    : expectedStudents > 0 && enteredStudents >= expectedStudents;
  // The RPC's percentage and completion flags already apply the monthly
  // coursework rule, so the four displayed components are enough here.
  const status = marksEntryStatus(
    expectedStudents,
    enteredStudents,
    percentage,
    homeworkEntered + classworkEntered + quizEntered + attendanceEntered,
    complete,
  );

  return {
    assignmentId: stringValue(raw.assignment_id ?? raw.assignmentId),
    teacherId: stringValue(raw.teacher_id ?? raw.teacherId),
    teacherName: stringValue(raw.teacher_name ?? raw.teacherName, 'Unknown teacher'),
    className: stringValue(raw.class_name ?? raw.className, 'Unassigned class'),
    subjectId: stringValue(raw.subject_id ?? raw.subjectId),
    subjectName: stringValue(raw.subject_name ?? raw.subjectName, stringValue(raw.subject_id ?? raw.subjectId)),
    academicYearId: stringValue(raw.academic_year_id ?? raw.academicYearId),
    termId: stringValue(raw.term_id ?? raw.termId),
    examScope: scope,
    month: nullableString(raw.month),
    expectedStudents,
    enteredStudents,
    missingStudents: missingStudentValue(raw.missing_students ?? raw.missingStudents),
    percentage,
    status,
    lastUpdated: nullableString(raw.last_updated ?? raw.lastUpdated),
    homeworkEntered,
    classworkEntered,
    quizEntered,
    attendanceEntered,
    courseworkComplete: booleanValue(raw.coursework_complete ?? raw.courseworkComplete),
    quizComplete: booleanValue(raw.quiz_complete ?? raw.quizComplete),
    monthlyCompleteStudents: nonNegativeInt(raw.monthly_complete_students ?? raw.monthlyCompleteStudents ?? enteredStudents),
  };
}

export function normalizeMarksEntryRows(value: unknown): MarksEntryRow[] {
  if (!Array.isArray(value)) return [];
  const byAssignment = new Map<string, MarksEntryRow>();
  for (const raw of value) {
    if (!raw || typeof raw !== 'object') continue;
    const row = normalizeMarksEntryRow(raw as RawMarksEntryRow);
    if (row.assignmentId && !byAssignment.has(row.assignmentId)) byAssignment.set(row.assignmentId, row);
  }
  return [...byAssignment.values()].sort((a, b) => a.className.localeCompare(b.className, undefined, { numeric: true })
    || a.subjectName.localeCompare(b.subjectName)
    || a.teacherName.localeCompare(b.teacherName)
    || a.assignmentId.localeCompare(b.assignmentId));
}

export function filterMarksEntryRows(rows: MarksEntryRow[], filters: MarksEntryFilters): MarksEntryRow[] {
  const query = filters.search.trim().toLocaleLowerCase();
  return rows.filter((row) => {
    if (filters.status !== 'all' && row.status !== filters.status) return false;
    if (filters.teacherId && row.teacherId !== filters.teacherId) return false;
    if (filters.className && row.className !== filters.className) return false;
    if (filters.subjectId && row.subjectId !== filters.subjectId) return false;
    if (query) {
      const haystack = [row.teacherName, row.className, row.subjectName].join(' ').toLocaleLowerCase();
      if (!haystack.includes(query)) return false;
    }
    return true;
  });
}

export function sortMarksEntryRows(rows: MarksEntryRow[], sort: MarksEntrySort): MarksEntryRow[] {
  return rows.slice().sort((a, b) => {
    if (sort === 'name') {
      return a.teacherName.localeCompare(b.teacherName)
        || a.className.localeCompare(b.className, undefined, { numeric: true })
        || a.subjectName.localeCompare(b.subjectName);
    }
    if (sort === 'latest') {
      return (b.lastUpdated ? Date.parse(b.lastUpdated) : 0) - (a.lastUpdated ? Date.parse(a.lastUpdated) : 0)
        || a.className.localeCompare(b.className, undefined, { numeric: true });
    }
    if (sort === 'percentage') {
      return b.percentage - a.percentage
        || a.className.localeCompare(b.className, undefined, { numeric: true });
    }
    return STATUS_ORDER[a.status] - STATUS_ORDER[b.status]
      || a.percentage - b.percentage
      || a.className.localeCompare(b.className, undefined, { numeric: true })
      || a.subjectName.localeCompare(b.subjectName);
  });
}

export function summarizeMarksEntryRows(rows: MarksEntryRow[]): MarksEntrySummary {
  const totalAssignments = rows.length;
  const complete = rows.filter((row) => row.status === 'complete').length;
  const inProgress = rows.filter((row) => row.status === 'in_progress').length;
  const notStarted = rows.filter((row) => row.status === 'not_started').length;
  const expectedStudents = rows.reduce((sum, row) => sum + row.expectedStudents, 0);
  const enteredStudents = rows.reduce((sum, row) => sum + row.enteredStudents, 0);
  return {
    totalAssignments,
    complete,
    inProgress,
    notStarted,
    expectedStudents,
    enteredStudents,
    averagePercentage: totalAssignments === 0
      ? 0
      : Math.round((rows.reduce((sum, row) => sum + row.percentage, 0) / totalAssignments) * 10) / 10,
    studentEntryRate: expectedStudents === 0
      ? 0
      : Math.round((Math.min(enteredStudents, expectedStudents) / expectedStudents) * 100),
  };
}

export function marksEntryFilterOptions(rows: MarksEntryRow[]) {
  return {
    teachers: [...new Map(rows.map((row) => [row.teacherId, row.teacherName])).entries()]
      .filter(([id]) => id)
      .map(([id, name]) => ({ id, name }))
      .sort((a, b) => a.name.localeCompare(b.name)),
    classes: [...new Set(rows.map((row) => row.className).filter(Boolean))]
      .sort((a, b) => a.localeCompare(b, undefined, { numeric: true })),
    subjects: [...new Map(rows.map((row) => [row.subjectId, row.subjectName])).entries()]
      .filter(([id]) => id)
      .map(([id, name]) => ({ id, name }))
      .sort((a, b) => a.name.localeCompare(b.name)),
  };
}

export function marksScopeLabel(scope: MarksExamScope): string {
  const labels: Record<MarksExamScope, string> = {
    monthly: 'Monthly coursework + quiz',
    midterm: 'Midterm',
    final: 'Final',
    ca: 'CA',
    homework: 'Homework',
    classwork: 'Classwork',
    quiz: 'Quiz',
    attendance: 'Attendance',
    discipline: 'Akhlaaq / Discipline',
  };
  return labels[scope];
}

export function statusLabel(status: MarksEntryStatus): string {
  return status === 'complete' ? 'Complete' : status === 'in_progress' ? 'In Progress' : 'Not Started';
}
