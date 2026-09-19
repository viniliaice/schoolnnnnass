import { describe, expect, it } from 'vitest';
import {
  filterMarksEntryRows,
  marksEntryFilterOptions,
  normalizeMarksEntryRow,
  normalizeMarksEntryRows,
  sortMarksEntryRows,
  summarizeMarksEntryRows,
  type MarksEntryRow,
} from '../marksEntryTracking';

function row(overrides: Partial<MarksEntryRow> = {}): MarksEntryRow {
  return {
    assignmentId: 'assignment-1',
    teacherId: 'teacher-1',
    teacherName: 'Teacher One',
    className: 'Grade 5-A',
    subjectId: 'english',
    subjectName: 'English',
    academicYearId: 'ay-1',
    termId: 'term-1',
    examScope: 'final',
    month: null,
    expectedStudents: 10,
    enteredStudents: 0,
    missingStudents: [],
    percentage: 0,
    status: 'not_started',
    lastUpdated: null,
    caEntered: 0,
    homeworkEntered: 0,
    classworkEntered: 0,
    quizEntered: 0,
    attendanceEntered: 0,
    courseworkComplete: false,
    quizComplete: false,
    monthlyCompleteStudents: 0,
    ...overrides,
  };
}

describe('marks-entry-tracking — derived row semantics', () => {
  it('normalizes the RPC shape and preserves missing student identity', () => {
    const normalized = normalizeMarksEntryRow({
      assignment_id: 'cs-1',
      teacher_id: 't-1',
      teacher_name: 'Hodan',
      class_name: 'Grade 2-A',
      subject_id: 'math',
      subject_name: 'Mathematics',
      academic_year_id: 'ay-1',
      term_id: 'term-1',
      exam_scope: 'final',
      expected_students: 3,
      entered_students: 2,
      missing_students: [{ id: 's-3', name: 'Student Three' }],
      percentage: '66.67',
      completion_status: 'in_progress',
      last_updated: '2026-09-18T12:00:00Z',
    });

    expect(normalized).toMatchObject({
      assignmentId: 'cs-1',
      expectedStudents: 3,
      enteredStudents: 2,
      percentage: 66.67,
      status: 'in_progress',
      missingStudents: [{ id: 's-3', name: 'Student Three' }],
    });
  });

  it('never reports entered students for an empty roster', () => {
    const normalized = normalizeMarksEntryRow({
      assignment_id: 'empty',
      expected_students: 0,
      entered_students: 4,
      percentage: 0,
      completion_status: 'complete',
    });
    expect(normalized.expectedStudents).toBe(0);
    expect(normalized.enteredStudents).toBe(0);
    expect(normalized.status).toBe('not_started');
  });

  it('uses the monthly coursework + quiz status vocabulary without inventing a fourth status', () => {
    const normalized = normalizeMarksEntryRow({
      assignment_id: 'monthly',
      exam_scope: 'monthly',
      expected_students: 4,
      entered_students: 0,
      percentage: 50,
      ca_entered: 4,
      quiz_entered: 0,
      coursework_complete: true,
      quiz_complete: false,
      completion_status: 'in_progress',
    });
    expect(normalized.status).toBe('in_progress');
    expect(normalized.courseworkComplete).toBe(true);
    expect(normalized.quizComplete).toBe(false);
  });

  it('normalizes duplicate RPC records without pretending they are different assignment rows', () => {
    const rows = normalizeMarksEntryRows([
      { assignment_id: 'a', class_name: 'Grade 1-A', subject_name: 'English' },
      { assignment_id: 'a', class_name: 'Grade 1-A', subject_name: 'English' },
      { assignment_id: 'b', class_name: 'Grade 1-B', subject_name: 'English' },
    ]);
    // The database should already be one row per assignment; normalization
    // also protects summary cards if a legacy join ever repeats an assignment.
    expect(rows).toHaveLength(2);
    expect(new Set(rows.map((entry) => entry.assignmentId)).size).toBe(2);
  });
});

describe('marks-entry-tracking — filters, sorting, and summaries', () => {
  const rows = [
    row({ assignmentId: 'a', teacherId: 't-a', teacherName: 'Asha', className: 'Grade 1-A', subjectId: 'math', subjectName: 'Mathematics', status: 'not_started' }),
    row({ assignmentId: 'b', teacherId: 't-b', teacherName: 'Bilal', className: 'Grade 2-A', subjectId: 'english', subjectName: 'English', enteredStudents: 5, percentage: 50, status: 'in_progress', lastUpdated: '2026-09-17T10:00:00Z' }),
    row({ assignmentId: 'c', teacherId: 't-a', teacherName: 'Asha', className: 'Grade 1-A', subjectId: 'science', subjectName: 'Science', enteredStudents: 10, percentage: 100, status: 'complete', lastUpdated: '2026-09-18T10:00:00Z' }),
  ];

  it('filters by status, assignment identity, and a teacher/class/subject search', () => {
    expect(filterMarksEntryRows(rows, { status: 'complete', teacherId: '', className: '', subjectId: '', search: '' }).map((entry) => entry.assignmentId)).toEqual(['c']);
    expect(filterMarksEntryRows(rows, { status: 'all', teacherId: 't-a', className: '', subjectId: '', search: '' })).toHaveLength(2);
    expect(filterMarksEntryRows(rows, { status: 'all', teacherId: '', className: '', subjectId: '', search: 'science' }).map((entry) => entry.assignmentId)).toEqual(['c']);
  });

  it('sorts missing rows first by default and can sort by latest update', () => {
    expect(sortMarksEntryRows(rows, 'status').map((entry) => entry.assignmentId)).toEqual(['a', 'b', 'c']);
    expect(sortMarksEntryRows(rows, 'latest').map((entry) => entry.assignmentId)).toEqual(['c', 'b', 'a']);
  });

  it('summarizes assignments without counting one student or mark row twice', () => {
    expect(summarizeMarksEntryRows(rows)).toMatchObject({
      totalAssignments: 3,
      complete: 1,
      inProgress: 1,
      notStarted: 1,
      expectedStudents: 30,
      enteredStudents: 15,
      averagePercentage: 50,
      studentEntryRate: 50,
    });
  });

  it('builds stable filter options from assignment IDs, not teacher name matches', () => {
    expect(marksEntryFilterOptions(rows)).toEqual({
      teachers: [{ id: 't-a', name: 'Asha' }, { id: 't-b', name: 'Bilal' }],
      classes: ['Grade 1-A', 'Grade 2-A'],
      subjects: [{ id: 'english', name: 'English' }, { id: 'math', name: 'Mathematics' }, { id: 'science', name: 'Science' }],
    });
  });
});
