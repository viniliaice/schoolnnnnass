/**
 * Database access for the admin/supervisor "Monitor Marks Entries" page.
 *
 * The real work is the get_monitor_marks_entries SQL function
 * (20260918_monitor_marks_entries.sql), which returns one row per EXPECTED
 * teacher/class/subject for the selected exam period. We call it through RPC
 * and, if the function is unavailable (older deploy), fall back to the same
 * maths computed client-side — the same RPC-then-fallback shape the lesson
 * plan tracker and progress.ts use.
 *
 * Nothing here duplicates marks data: it reads class_subjects (who is
 * responsible), students (the roster), and exams (the marks) — the existing
 * application source of truth.
 */

import { supabase } from '../supabase';
import {
  MARKS_MONITOR_EXAM_TYPES,
  normalizeMonitorMarksRow,
  type MonitorMarksRow,
} from '../marksUploadTracking';
import type { ExamType } from '../../types';

export interface MonitorMarksParams {
  termId?: string | null;
  month?: string | null;
  examType?: string;
  teacherId?: string | null;
  className?: string | null;
  subjectId?: string | null;
  status?: string | null;
}

const MONITOR_COLUMNS = `
  "teacherId", "teacherName", "className", "subjectId", "subjectName",
  "academicYearId", "termId", "termName", "month", "examType",
  "expectedStudents", "enteredStudents",
  "caEntered", "homeworkEntered", "classworkEntered", "quizEntered",
  "attendanceEntered", "midtermEntered", "finalEntered",
  "completionPercent", "status", "lastUpdate"
`;

function isMonitorRow(row: Record<string, unknown>): boolean {
  return (
    row &&
    typeof row.teacherId === 'string' &&
    typeof row.className === 'string' &&
    typeof row.subjectId === 'string' &&
    (typeof row.expectedStudents === 'number' || typeof row.expectedStudents === 'string') &&
    (typeof row.completionPercent === 'number' || typeof row.completionPercent === 'string')
  );
}

export async function fetchMonitorMarksEntries(params: MonitorMarksParams): Promise<MonitorMarksRow[]> {
  const examType = params.examType && MARKS_MONITOR_EXAM_TYPES.includes(params.examType)
    ? params.examType
    : 'Monthly';

  try {
    const { data, error } = await supabase.rpc('get_monitor_marks_entries', {
      p_term_id: params.termId ?? null,
      p_month: params.month ?? null,
      p_exam_type: examType,
      p_teacher_id: params.teacherId ?? null,
      p_class_name: params.className ?? null,
      p_subject_id: params.subjectId ?? null,
      p_status: params.status ?? null,
    });
    if (!error && Array.isArray(data) && data.every(isMonitorRow)) {
      return (data as Record<string, unknown>[]).map(normalizeMonitorMarksRow);
    }
    if (error) {
      // A missing-function error (PGRST202 / 42883) means an older deploy
      // without the RPC — fall through to the client fallback.
      const code = (error as { code?: string }).code;
      if (code !== 'PGRST202' && code !== '42883') {
        // For any other error, still try the fallback rather than throwing a
        // blank page; the fallback reads the same base tables.
      }
    }
  } catch {
    // RPC unavailable — fall through to the client fallback.
  }
  return fetchMonitorMarksEntriesFallback({ ...params, examType });
}

/**
 * Client-side equivalent of the RPC. Used when the function is unavailable.
 * Reads class_subjects + students + exams and reproduces the same
 * expected/entered/status maths.
 */
export async function fetchMonitorMarksEntriesFallback(params: MonitorMarksParams): Promise<MonitorMarksRow[]> {
  const examType = params.examType && MARKS_MONITOR_EXAM_TYPES.includes(params.examType)
    ? params.examType
    : 'Monthly';
  const month = params.month ?? null;

  // Resolve the month scope: an explicit month, or (when a term is chosen
  // without a month) every month in that term.
  let monthScope: string[] | null = month ? [month] : null;
  if (!monthScope && params.termId) {
    const { data: term } = await supabase
      .from('terms')
      .select('months')
      .eq('id', params.termId)
      .maybeSingle();
    if (term && Array.isArray((term as { months?: unknown }).months)) {
      monthScope = ((term as { months: unknown[] }).months as unknown[]).filter(
        (m): m is string => typeof m === 'string'
      );
    }
  }

  // Expected assignments.
  let csQuery: any = supabase.from('class_subjects').select('id, "className", "subjectId", "teacherId", subjects(name)');
  if (params.teacherId) csQuery = csQuery.eq('teacherId', params.teacherId);
  if (params.className) csQuery = csQuery.eq('className', params.className);
  if (params.subjectId) csQuery = csQuery.eq('subjectId', params.subjectId);
  const { data: csData, error: csError } = await csQuery;
  if (csError) throw csError;
  const assignments = (csData || []) as Array<{
    id: string;
    className: string;
    subjectId: string;
    teacherId: string;
    subjects?: { name: string } | null;
  }>;
  if (assignments.length === 0) return [];

  const classList = Array.from(new Set(assignments.map((a) => a.className)));

  // Roster (exclude withdrawn/left students).
  let studentQuery: any = supabase.from('students').select('id, name, "className", transport').in('className', classList);
  const { data: students, error: studentError } = await studentQuery;
  if (studentError) throw studentError;
  const roster = (students || []).filter((s: any) => s.transport !== 'LEFT') as Array<{
    id: string;
    name: string;
    className: string;
  }>;
  const studentIds = roster.map((s) => s.id);
  if (studentIds.length === 0) return [];

  // Scope exams.
  let examQuery: any = supabase.from('exams').select(
    'studentId, subject, subjectId, examType, month, termId, teacherId, createdAt'
  );
  if (studentIds.length) examQuery = examQuery.in('studentId', studentIds);
  if (params.termId) examQuery = examQuery.eq('termId', params.termId);
  if (monthScope && monthScope.length) examQuery = examQuery.in('month', monthScope);
  if (examType !== 'Monthly') examQuery = examQuery.eq('examType', examType);
  const { data: exams, error: examError } = await examQuery;
  if (examError) throw examError;
  const examRows = (exams || []) as Array<{
    studentId: string;
    subject: string;
    subjectId: string | null;
    examType: ExamType;
    month: string;
    termId: string | null;
    teacherId: string;
    createdAt: string;
  }>;

  const teacherIds = Array.from(new Set(assignments.map((a) => a.teacherId)));
  const { data: teachers } = await supabase.from('profiles').select('id, name').in('id', teacherIds);
  const teacherName = new Map((teachers || []).map((t: any) => [t.id, t.name] as [string, string]));

  const rosterByClass = new Map<string, string[]>();
  for (const s of roster) {
    const list = rosterByClass.get(s.className) ?? [];
    list.push(s.id);
    rosterByClass.set(s.className, list);
  }

  const groups = new Map<string, MonitorMarksRow>();
  for (const a of assignments) {
    const subjectName = (a.subjects as any)?.name || a.subjectId;
    const expected = rosterByClass.get(a.className) ?? [];
    const expectedStudents = expected.length;

    const relevant = examRows.filter(
      (e) =>
        e.teacherId === a.teacherId &&
        (e.subjectId === a.subjectId || e.subject === subjectName) &&
        expected.includes(e.studentId)
    );
    const has = (type: ExamType) =>
      new Set(relevant.filter((e) => e.examType === type).map((e) => e.studentId)).size;
    const caEntered = has('CA');
    const homeworkEntered = has('Homework');
    const classworkEntered = has('Classwork');
    const quizEntered = has('Quiz');
    const attendanceEntered = has('Attendance');
    const midtermEntered = has('Midterm');
    const finalEntered = has('Final');

    const entered =
      examType === 'Monthly'
        ? ((caEntered >= expectedStudents ||
            (homeworkEntered >= expectedStudents && classworkEntered >= expectedStudents)) &&
            quizEntered >= expectedStudents)
        : examType === 'Midterm'
          ? midtermEntered >= expectedStudents
          : examType === 'Final'
            ? finalEntered >= expectedStudents
            : examType === 'Attendance'
              ? attendanceEntered >= expectedStudents
              : examType === 'CA'
                ? caEntered >= expectedStudents
                : examType === 'Homework'
                  ? homeworkEntered >= expectedStudents
                  : examType === 'Classwork'
                    ? classworkEntered >= expectedStudents
                    : quizEntered >= expectedStudents;

    const enteredStudents = expected.filter((sid) => {
      const studentExams = relevant.filter((e) => e.studentId === sid);
      const sCa = studentExams.some((e) => e.examType === 'CA');
      const sHw = studentExams.some((e) => e.examType === 'Homework');
      const sCw = studentExams.some((e) => e.examType === 'Classwork');
      const sQuiz = studentExams.some((e) => e.examType === 'Quiz');
      switch (examType) {
        case 'Monthly':
          return (sCa || (sHw && sCw)) && sQuiz;
        case 'Midterm':
          return studentExams.some((e) => e.examType === 'Midterm');
        case 'Final':
          return studentExams.some((e) => e.examType === 'Final');
        case 'Attendance':
          return studentExams.some((e) => e.examType === 'Attendance');
        case 'CA':
          return sCa;
        case 'Homework':
          return sHw;
        case 'Classwork':
          return sCw;
        case 'Quiz':
          return sQuiz;
        default:
          return sCa || sHw || sCw || sQuiz;
      }
    }).length;

    const lastUpdate = relevant.length
      ? relevant
          .map((e) => e.createdAt)
          .sort()
          .slice(-1)[0]
      : null;

    const status: MonitorMarksRow['status'] =
      expectedStudents === 0
        ? 'not_started'
        : enteredStudents >= expectedStudents
          ? 'complete'
          : enteredStudents > 0
            ? 'in_progress'
            : 'not_started';

    const completionPercent =
      expectedStudents > 0 ? Math.round((enteredStudents / expectedStudents) * 1000) / 10 : 0;

    groups.set(`${a.teacherId}:${a.className}:${a.subjectId}`, {
      teacherId: a.teacherId,
      teacherName: teacherName.get(a.teacherId) || '',
      className: a.className,
      subjectId: a.subjectId,
      subjectName,
      academicYearId: null,
      termId: params.termId ?? null,
      termName: null,
      month: month ?? '',
      examType,
      expectedStudents,
      enteredStudents,
      caEntered,
      homeworkEntered,
      classworkEntered,
      quizEntered,
      attendanceEntered,
      midtermEntered,
      finalEntered,
      completionPercent,
      status,
      lastUpdate,
    });
  }

  let rows = [...groups.values()];
  if (params.status) {
    rows = rows.filter((r) => r.status === params.status);
  }
  return rows.sort((a, b) =>
    a.className.localeCompare(b.className) ||
    a.subjectName.localeCompare(b.subjectName) ||
    a.teacherName.localeCompare(b.teacherName)
  );
}
