import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../supabase', () => ({
  supabase: {
    from: vi.fn(),
    rpc: vi.fn(),
  },
}));

import { supabase } from '../supabase';
import { getClassStudentSubjectProgress } from '../db/progress';

const mockFrom = supabase.from as unknown as ReturnType<typeof vi.fn>;
const mockRpc = supabase.rpc as unknown as ReturnType<typeof vi.fn>;

function terminalEq(result: unknown) {
  return {
    eq: vi.fn(() => Promise.resolve({ data: result, error: null })),
  };
}

function examsQuery(result: unknown) {
  const query: any = {
    in: vi.fn(() => query),
    eq: vi.fn(() => Promise.resolve({ data: result, error: null })),
  };
  return query;
}

beforeEach(() => {
  mockFrom.mockReset();
  mockRpc.mockReset();
});

describe('getClassStudentSubjectProgress', () => {
  it('uses the RPC path and normalizes returned rows', async () => {
    mockRpc.mockResolvedValue({
      data: [
        {
          student_id: 's1',
          student_name: 'Asha',
          class_name: 'Grade 1-A',
          month: 'January',
          subject: 'Mathematics',
          ca_entered: true,
          homework_entered: false,
          classwork_entered: false,
          attendance_entered: false,
          quiz_entered: true,
          total_exam_rows: 2,
          exam_entries: [
            { exam_type: 'CA', score: 8, total: 10 },
            { exam_type: 'Quiz', score: 9, total: 10 },
          ],
        },
      ],
      error: null,
    });

    await expect(getClassStudentSubjectProgress('Grade 1-A', 'January')).resolves.toEqual([
      {
        studentId: 's1',
        studentName: 'Asha',
        className: 'Grade 1-A',
        month: 'January',
        subject: 'Mathematics',
        caEntered: true,
        homeworkEntered: false,
        classworkEntered: false,
        attendanceEntered: false,
        quizEntered: true,
        totalExamRows: 2,
        examEntries: [
          { examType: 'CA', score: 8, total: 10 },
          { examType: 'Quiz', score: 9, total: 10 },
        ],
      },
    ]);

    expect(mockRpc).toHaveBeenCalledWith('get_class_student_subject_progress', {
      p_class_name: 'Grade 1-A',
      p_month: 'January',
    });
    expect(mockFrom).not.toHaveBeenCalled();
  });

  it('falls back to direct queries when the RPC is missing', async () => {
    mockRpc.mockResolvedValue({ data: null, error: { code: 'PGRST202', message: 'function missing' } });

    const students = [
      { id: 's1', name: 'Asha' },
      { id: 's2', name: 'Bilan' },
    ];
    const classSubjects = [
      { subjectId: 'math-id', subjects: { name: 'Mathematics' } },
    ];
    const exams = [
      { studentId: 's1', subject: 'math-id', examType: 'CA', score: 8, total: 10 },
      { studentId: 's1', subject: 'Mathematics', examType: 'Quiz', score: 9, total: 10 },
    ];

    mockFrom.mockImplementation((table: string) => {
      if (table === 'students') return { select: () => terminalEq(students) };
      if (table === 'class_subjects') return { select: () => terminalEq(classSubjects) };
      if (table === 'exams') return { select: () => examsQuery(exams) };
      throw new Error(`Unexpected table ${table}`);
    });

    const result = await getClassStudentSubjectProgress('Grade 1-A', 'January');

    expect(result).toHaveLength(2);
    expect(result[0]).toMatchObject({
      studentId: 's1',
      studentName: 'Asha',
      subject: 'Mathematics',
      caEntered: true,
      quizEntered: true,
      totalExamRows: 2,
    });
    expect(result[0].examEntries).toEqual([
      { examType: 'CA', score: 8, total: 10 },
      { examType: 'Quiz', score: 9, total: 10 },
    ]);
    expect(result[1]).toMatchObject({
      studentId: 's2',
      studentName: 'Bilan',
      subject: 'Mathematics',
      totalExamRows: 0,
      examEntries: [],
    });
  });

  it('returns an empty array when className or month is missing', async () => {
    await expect(getClassStudentSubjectProgress('', 'January')).resolves.toEqual([]);
    await expect(getClassStudentSubjectProgress('Grade 1-A', '')).resolves.toEqual([]);
    expect(mockFrom).not.toHaveBeenCalled();
    expect(mockRpc).not.toHaveBeenCalled();
  });
});
