import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../supabase', () => ({
  supabase: {
    from: vi.fn(),
  },
}));

vi.mock('../db/students', () => ({
  getStudentById: vi.fn(),
}));

import { supabase } from '../supabase';
import { getStudentById } from '../db/students';
import { getMidtermReportFallback } from '../db/reports';

const mockFrom = supabase.from as unknown as ReturnType<typeof vi.fn>;
const mockGetStudentById = getStudentById as unknown as ReturnType<typeof vi.fn>;

function queryReturning(result: unknown) {
  const query: any = {
    eq: vi.fn(() => query),
    in: vi.fn(() => query),
    returns: vi.fn(() => Promise.resolve({ data: result, error: null })),
  };
  return query;
}

beforeEach(() => {
  mockFrom.mockReset();
  mockGetStudentById.mockReset();
});

describe('getMidtermReportFallback', () => {
  it('calculates subject score, class average, highest score, and rank from fallback queries', async () => {
    mockGetStudentById.mockResolvedValue({ id: 's1', name: 'Asha', className: 'Grade 1-A' });

    const studentExams = [
      { id: 'e1', studentId: 's1', subject: 'Math', score: 45, total: 50 },
    ];
    const classStudents = [{ id: 's1' }, { id: 's2' }, { id: 's3' }];
    const classExams = [
      { id: 'e1', studentId: 's1', subject: 'Math', score: 45, total: 50 },
      { id: 'e2', studentId: 's2', subject: 'Math', score: 40, total: 50 },
      { id: 'e3', studentId: 's3', subject: 'Math', score: 25, total: 50 },
    ];

    let examsCall = 0;
    mockFrom.mockImplementation((table: string) => {
      if (table === 'students') return { select: () => queryReturning(classStudents) };
      if (table === 'exams') {
        examsCall += 1;
        return { select: () => queryReturning(examsCall === 1 ? studentExams : classExams) };
      }
      throw new Error(`Unexpected table ${table}`);
    });

    const report = await getMidtermReportFallback('s1', 'term-1');

    expect(report).toEqual({
      scores: [
        {
          subject: 'Math',
          score: 45,
          total: 50,
          percentage: 90,
          grade: 'A',
          remark: 'Excellent',
          subject_rank: 1,
          class_average: 73,
          highest_in_class: 90,
          examId: 'e1',
        },
      ],
      overall_rank: 1,
      total_students: 3,
    });
  });
});
