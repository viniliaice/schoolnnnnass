import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../supabase', () => ({
  supabase: {
    from: vi.fn(),
    rpc: vi.fn(),
  },
}));

vi.mock('../db/students', () => ({
  getStudentById: vi.fn(),
}));

import { supabase } from '../supabase';
import { getStudentById } from '../db/students';
import { getMidtermReportFallback, getMonthlyReportFallback } from '../db/reports';

const mockFrom = supabase.from as unknown as ReturnType<typeof vi.fn>;
const mockGetStudentById = getStudentById as unknown as ReturnType<typeof vi.fn>;

function queryReturning(result: unknown) {
  const resolved = Promise.resolve({ data: result, error: null });
  const query: any = {
    eq: vi.fn(() => query),
    in: vi.fn(() => query),
    maybeSingle: vi.fn(() => resolved),
    returns: vi.fn(() => resolved),
    then: (resolve: any, reject: any) => resolved.then(resolve, reject),
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
      { id: 'e1', studentId: 's1', subject: 'Math', score: 45, total: 50, examType: 'Midterm', assessmentLabel: null },
    ];
    const classStudents = [{ id: 's1' }, { id: 's2' }, { id: 's3' }];
    const classExams = [
      { id: 'e1', studentId: 's1', subject: 'Math', score: 45, total: 50, examType: 'Midterm', assessmentLabel: null },
      { id: 'e2', studentId: 's2', subject: 'Math', score: 40, total: 50, examType: 'Midterm', assessmentLabel: null },
      { id: 'e3', studentId: 's3', subject: 'Math', score: 25, total: 50, examType: 'Midterm', assessmentLabel: null },
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

  it('treats bulk-uploaded MT rows stored as Quiz + assessmentLabel=MT as midterms', async () => {
    mockGetStudentById.mockResolvedValue({ id: 's1', name: 'Asha', className: 'Grade 1-A' });

    const studentExams = [
      { id: 'e1', studentId: 's1', subject: 'Math', score: 17.5, total: 20, examType: 'Quiz', assessmentLabel: 'MT' },
      { id: 'e-ignore', studentId: 's1', subject: 'Math', score: 5, total: 5, examType: 'Quiz', assessmentLabel: 'HW1' },
    ];
    const classStudents = [{ id: 's1' }, { id: 's2' }];
    const classExams = [
      { id: 'e1', studentId: 's1', subject: 'Math', score: 17.5, total: 20, examType: 'Quiz', assessmentLabel: 'MT' },
      { id: 'e2', studentId: 's2', subject: 'Math', score: 15.5, total: 20, examType: 'Quiz', assessmentLabel: 'MT' },
      { id: 'e-ignore', studentId: 's2', subject: 'Math', score: 4.5, total: 5, examType: 'Quiz', assessmentLabel: 'HW1' },
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
        expect.objectContaining({
          subject: 'Math',
          score: 17.5,
          total: 20,
          percentage: 88,
          grade: 'B',
          subject_rank: 1,
          class_average: 83,
          highest_in_class: 88,
          examId: 'e1',
        }),
      ],
      overall_rank: 1,
      total_students: 2,
    });
  });
});

describe('getMonthlyReportFallback', () => {
  it('returns CA 40% + Quiz 60% and keeps Quiz visible', async () => {
    const exams = [
      { id: 'e-ca', studentId: 's1', subject: 'Mathematics', score: 70, total: 100, examType: 'CA', assessmentLabel: null, month: 'September', date: '2026-09-01', status: 'approved', entryState: 'scored' },
      { id: 'e-quiz', studentId: 's1', subject: 'Mathematics', score: 80, total: 100, examType: 'Quiz', assessmentLabel: null, month: 'September', date: '2026-09-02', status: 'approved', entryState: 'scored' },
    ];

    mockFrom.mockImplementation((table: string) => {
      if (table === 'exams') return { select: () => queryReturning(exams) };
      if (table === 'terms') return { select: () => queryReturning({ months: ['September'] }) };
      throw new Error(`Unexpected table ${table}`);
    });

    const report = await getMonthlyReportFallback('s1', 'term-1');
    expect(report).toHaveLength(1);
    expect(report[0].subject).toBe('Mathematics');
    expect(report[0].ca_avg).toBe(70);
    expect(report[0].quiz_avg).toBe(80);
    expect(report[0].average).toBe(76);
    expect(report[0].grade).toBe('C');
    expect(report[0].quiz_details).toEqual(expect.arrayContaining([
      expect.objectContaining({ examType: 'Quiz', score: 80, total: 100 }),
    ]));
  });

  it('does not treat a missing Quiz as zero', async () => {
    const exams = [
      { id: 'e-ca', studentId: 's1', subject: 'Mathematics', score: 70, total: 100, examType: 'CA', assessmentLabel: null, month: 'September', date: '2026-09-01', status: 'approved', entryState: 'scored' },
    ];

    mockFrom.mockImplementation((table: string) => {
      if (table === 'exams') return { select: () => queryReturning(exams) };
      if (table === 'terms') {
        const query: any = {
          eq: vi.fn(() => query),
          maybeSingle: vi.fn(() => Promise.resolve({ data: { months: ['September'] }, error: null })),
        };
        return { select: () => query };
      }
      throw new Error(`Unexpected table ${table}`);
    });

    const report = await getMonthlyReportFallback('s1', 'term-1');
    expect(report[0].quiz_avg).toBeNull();
    expect(report[0].average).toBeNull();
  });
});
