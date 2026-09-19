// Pure-logic tests for the Monitor Marks Entries accountability maths.
//
// These mirror lesson-plan-submission-tracking.test.ts: every assertion runs
// against marksUploadTracking.ts with no database, so the
// expected/entered/status/summary logic is pinned directly.

import { describe, expect, it } from 'vitest';
import {
  filterMonitorMarksRows,
  missingMonthlyComponents,
  monitorMarksClassOptions,
  monitorMarksSubjectOptions,
  monitorMarksTeacherOptions,
  normalizeMonitorMarksRow,
  sortMonitorMarksRows,
  summarizeMonitorMarks,
  type MonitorMarksRow,
} from '../marksUploadTracking';

function row(overrides: Partial<MonitorMarksRow>): MonitorMarksRow {
  return {
    teacherId: 't1',
    teacherName: 'Fatima Ali',
    className: 'Grade 7-A',
    subjectId: 'sub-math',
    subjectName: 'Mathematics',
    academicYearId: 'ay1',
    termId: 't1',
    termName: 'Term 1',
    month: 'September',
    examType: 'Monthly',
    expectedStudents: 4,
    enteredStudents: 0,
    caEntered: 0,
    homeworkEntered: 0,
    classworkEntered: 0,
    quizEntered: 0,
    attendanceEntered: 0,
    midtermEntered: 0,
    finalEntered: 0,
    completionPercent: 0,
    status: 'not_started',
    lastUpdate: null,
    ...overrides,
  };
}

describe('normalizeMonitorMarksRow — defensive typing', () => {
  it('coerces numeric strings and coerces unknown status to not_started', () => {
    const r = normalizeMonitorMarksRow({
      teacherId: 't1',
      teacherName: 'Fatima',
      className: 'Grade 7-A',
      subjectId: 'sub-math',
      subjectName: 'Mathematics',
      month: 'September',
      examType: 'Monthly',
      expectedStudents: '4',
      enteredStudents: '2',
      caEntered: 1,
      homeworkEntered: 1,
      classworkEntered: 1,
      quizEntered: 1,
      attendanceEntered: 0,
      midtermEntered: 0,
      finalEntered: 0,
      completionPercent: '50',
      status: 'weird', // invalid -> not_started
      lastUpdate: null,
    });
    expect(r.expectedStudents).toBe(4);
    expect(r.enteredStudents).toBe(2);
    expect(r.completionPercent).toBe(50);
    expect(r.status).toBe('not_started');
  });
});

describe('summarizeMonitorMarks — the four summary cards', () => {
  const rows: MonitorMarksRow[] = [
    row({ status: 'complete', enteredStudents: 4, expectedStudents: 4, completionPercent: 100 }),
    row({ teacherId: 't2', status: 'in_progress', enteredStudents: 2, expectedStudents: 4, completionPercent: 50 }),
    row({ teacherId: 't3', status: 'not_started', enteredStudents: 0, expectedStudents: 4, completionPercent: 0 }),
    row({ teacherId: 't4', status: 'complete', enteredStudents: 3, expectedStudents: 3, completionPercent: 100 }),
  ];

  it('counts All / Complete / In Progress / Not Started', () => {
    const s = summarizeMonitorMarks(rows);
    expect(s.all).toBe(4);
    expect(s.complete).toBe(2);
    expect(s.inProgress).toBe(1);
    expect(s.notStarted).toBe(1);
  });

  it('averages completion across every entry (rounded)', () => {
    // (100 + 50 + 0 + 100) / 4 = 62.5 -> 63
    const s = summarizeMonitorMarks(rows);
    expect(s.avgCompletion).toBe(63);
  });

  it('returns zeroed summary for no rows', () => {
    expect(summarizeMonitorMarks([])).toEqual({
      all: 0,
      complete: 0,
      inProgress: 0,
      notStarted: 0,
      avgCompletion: 0,
    });
  });
});

describe('filterMonitorMarksRows — combined filters', () => {
  const rows: MonitorMarksRow[] = [
    row({ teacherId: 't1', teacherName: 'Fatima Ali', className: 'Grade 7-A', subjectName: 'Mathematics', status: 'complete' }),
    row({ teacherId: 't2', teacherName: 'Omar Hassan', className: 'Grade 7-A', subjectName: 'English', status: 'not_started' }),
    row({ teacherId: 't3', teacherName: 'Ahmed Warsame', className: 'Grade 8-A', subjectName: 'Mathematics', status: 'in_progress' }),
    row({ teacherId: 't4', teacherName: 'Ayan Dahir', className: 'Grade 8-A', subjectName: 'English', status: 'complete' }),
  ];

  it('filters by status', () => {
    const out = filterMonitorMarksRows(rows, {
      status: 'complete',
      className: null,
      subjectName: null,
      teacherId: null,
      search: '',
    });
    expect(out.map((r) => r.teacherId).sort()).toEqual(['t1', 't4']);
  });

  it('filters by class AND subject together', () => {
    const out = filterMonitorMarksRows(rows, {
      status: 'all',
      className: 'Grade 7-A',
      subjectName: 'English',
      teacherId: null,
      search: '',
    });
    expect(out.map((r) => r.teacherId)).toEqual(['t2']);
  });

  it('filters by teacher id', () => {
    const out = filterMonitorMarksRows(rows, {
      status: 'all',
      className: null,
      subjectName: null,
      teacherId: 't3',
      search: '',
    });
    expect(out.map((r) => r.teacherId)).toEqual(['t3']);
  });

  it('filters by name search (case-insensitive)', () => {
    const out = filterMonitorMarksRows(rows, {
      status: 'all',
      className: null,
      subjectName: null,
      teacherId: null,
      search: 'fatima',
    });
    expect(out.map((r) => r.teacherId)).toEqual(['t1']);
  });
});

describe('sortMonitorMarksRows', () => {
  const rows: MonitorMarksRow[] = [
    row({ teacherId: 't1', teacherName: 'Fatima', status: 'complete', completionPercent: 100, className: 'A', subjectName: 'M' }),
    row({ teacherId: 't2', teacherName: 'Omar', status: 'not_started', completionPercent: 0, className: 'A', subjectName: 'E' }),
    row({ teacherId: 't3', teacherName: 'Ahmed', status: 'in_progress', completionPercent: 40, className: 'B', subjectName: 'M' }),
  ];

  it('attention-first: not_started, then in_progress, then complete; lowest completion within a bucket', () => {
    const out = sortMonitorMarksRows(rows, 'attention-first');
    expect(out.map((r) => r.teacherId)).toEqual(['t2', 't3', 't1']);
  });

  it('name: A–Z by teacher name', () => {
    const out = sortMonitorMarksRows(rows, 'name');
    expect(out.map((r) => r.teacherId)).toEqual(['t3', 't1', 't2']);
  });

  it('completion: lowest completion first', () => {
    const out = sortMonitorMarksRows(rows, 'completion');
    expect(out.map((r) => r.completionPercent)).toEqual([0, 40, 100]);
  });
});

describe('option helpers', () => {
  const rows: MonitorMarksRow[] = [
    row({ teacherId: 't1', teacherName: 'Fatima', className: 'Grade 7-A', subjectName: 'Mathematics' }),
    row({ teacherId: 't2', teacherName: 'Omar', className: 'Grade 7-A', subjectName: 'English' }),
    row({ teacherId: 't1', teacherName: 'Fatima', className: 'Grade 8-A', subjectName: 'Mathematics' }),
  ];

  it('class options are unique and sorted', () => {
    expect(monitorMarksClassOptions(rows)).toEqual(['Grade 7-A', 'Grade 8-A']);
  });

  it('subject options are unique and sorted', () => {
    expect(monitorMarksSubjectOptions(rows)).toEqual(['English', 'Mathematics']);
  });

  it('teacher options dedupe by id and sort by name', () => {
    expect(monitorMarksTeacherOptions(rows)).toEqual([
      { id: 't1', name: 'Fatima' },
      { id: 't2', name: 'Omar' },
    ]);
  });
});

describe('missingMonthlyComponents', () => {
  it('flags coursework and quiz when short of the full roster', () => {
    const r = row({
      expectedStudents: 4,
      caEntered: 0,
      homeworkEntered: 1,
      classworkEntered: 1,
      quizEntered: 1,
    });
    expect(missingMonthlyComponents(r)).toEqual(['Coursework (CA or Homework + Classwork)', 'Quiz']);
  });

  it('returns nothing when coursework + quiz are complete for the roster', () => {
    const r = row({
      expectedStudents: 4,
      caEntered: 4,
      homeworkEntered: 4,
      classworkEntered: 4,
      quizEntered: 4,
    });
    expect(missingMonthlyComponents(r)).toEqual([]);
  });
});
