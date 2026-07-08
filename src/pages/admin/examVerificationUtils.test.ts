import { describe, expect, it } from 'vitest';
import type { Exam, Student } from '../../types';
import { clampPage, getTotalPages, getVisibleRange, sortExamsByStudentName } from './examVerificationUtils';

const baseExam: Exam = {
  id: 'e',
  studentId: 's',
  subject: 'Math',
  score: 10,
  total: 10,
  examType: 'CA',
  month: 'January',
  status: 'pending',
  parentId: null,
  date: '2026-01-01',
  createdAt: '2026-01-01',
  teacherId: 't1',
};

const baseStudent: Student = {
  id: 's',
  name: 'Student',
  className: 'Grade 1-A',
  parentId: null,
  createdAt: '2026-01-01',
};

describe('ExamVerification utilities', () => {
  it('sorts exams by student name without mutating the input array', () => {
    const exams: Exam[] = [
      { ...baseExam, id: 'e1', studentId: 's2' },
      { ...baseExam, id: 'e2', studentId: 's1' },
    ];
    const students: Student[] = [
      { ...baseStudent, id: 's1', name: 'Asha' },
      { ...baseStudent, id: 's2', name: 'Bilan' },
    ];

    expect(sortExamsByStudentName(exams, students, 'asc').map(exam => exam.id)).toEqual(['e2', 'e1']);
    expect(sortExamsByStudentName(exams, students, 'desc').map(exam => exam.id)).toEqual(['e1', 'e2']);
    expect(exams.map(exam => exam.id)).toEqual(['e1', 'e2']);
  });

  it('keeps original order when sorting is disabled', () => {
    const exams = [
      { ...baseExam, id: 'e1', studentId: 's2' },
      { ...baseExam, id: 'e2', studentId: 's1' },
    ];

    expect(sortExamsByStudentName(exams, [], 'none').map(exam => exam.id)).toEqual(['e1', 'e2']);
  });

  it('calculates pagination boundaries safely', () => {
    expect(getTotalPages(0, 25)).toBe(1);
    expect(getTotalPages(101, 25)).toBe(5);
    expect(clampPage(99, 101, 25)).toBe(5);
    expect(clampPage(-2, 101, 25)).toBe(1);
    expect(getVisibleRange(2, 25, 60)).toEqual({ from: 26, to: 50 });
    expect(getVisibleRange(5, 25, 60)).toEqual({ from: 51, to: 60 });
    expect(getVisibleRange(1, 25, 0)).toEqual({ from: 0, to: 0 });
  });
});
