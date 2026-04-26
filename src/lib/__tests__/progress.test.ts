import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../supabase', () => ({
  supabase: {
    from: vi.fn(),
  },
}));

import { supabase } from '../supabase';

const mockFrom = supabase.from as unknown as ReturnType<typeof vi.fn>;

beforeEach(() => {
  mockFrom.mockReset();
});

const createQuery = (result: any) => {
  const query: any = {
    eq: vi.fn(() => query),
    in: vi.fn(() => query),
    order: vi.fn(() => Promise.resolve({ data: result, error: null })),
  };
  return query;
};

describe('getTeacherExamProgress', () => {
  it('returns rows for all months when month is not provided', async () => {
    const rows = [
      {
        teacherId: 't1',
        teacherName: 'Teacher One',
        className: 'KG-A',
        subjectId: 'english',
        subjectName: 'English',
        month: 'January',
        requiredEntries: 4,
        completedEntries: 1,
        completionStatus: 'incomplete',
        completionPercent: 25,
        caEntered: 1,
        homeworkEntered: 0,
        classworkEntered: 0,
        attendanceEntered: 0,
        quizEntered: 0,
        totalStudents: 20,
        missingExamTypes: ['Homework', 'Classwork', 'Quiz'],
      },
    ];

    mockFrom.mockImplementation(() => ({
      select: () => createQuery(rows),
    }));

    const { getTeacherExamProgress } = await import('../db/progress');
    const result = await getTeacherExamProgress({});

    expect(result).toEqual(rows);
    expect(mockFrom).toHaveBeenCalledWith('teacher_exam_progress');
  });

  it('applies month and classNames filters correctly', async () => {
    const rows = [
      {
        teacherId: 't2',
        teacherName: 'Teacher Two',
        className: 'KG-B',
        subjectId: 'math',
        subjectName: 'Math',
        month: 'February',
        requiredEntries: 4,
        completedEntries: 4,
        completionStatus: 'complete',
        completionPercent: 100,
        caEntered: 1,
        homeworkEntered: 1,
        classworkEntered: 1,
        attendanceEntered: 1,
        quizEntered: 1,
        totalStudents: 18,
        missingExamTypes: [],
      },
    ];

    const query = createQuery(rows);
    mockFrom.mockImplementation(() => ({ select: () => query }));

    const { getTeacherExamProgress } = await import('../db/progress');
    const result = await getTeacherExamProgress({ month: 'February', classNames: ['KG-B'] });

    expect(result).toEqual(rows);
    expect(query.eq).toHaveBeenCalledWith('month', 'February');
    expect(query.in).toHaveBeenCalledWith('className', ['KG-B']);
    expect(query.order).toHaveBeenCalledWith('completionPercent', { ascending: false });
  });
});
