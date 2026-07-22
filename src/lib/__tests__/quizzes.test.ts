import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../supabase', () => ({
  supabase: {
    from: vi.fn(() => buildChain({ data: [], error: null })),
  },
}));

import { supabase } from '../supabase';
import { createQuestion, getQuestionsByTeacher, createQuiz, getQuizWithQuestions, submitAttempt } from '../db/quizzes';

vi.mock('../db/exams', () => ({
  createExam: vi.fn(),
}));

function buildChain(result: any) {
  const chain: any = {
    select: vi.fn(() => chain),
    insert: vi.fn(() => chain),
    eq: vi.fn(() => chain),
    in: vi.fn(() => chain),
    order: vi.fn(() => chain),
    range: vi.fn(() => chain),
    single: vi.fn(() => chain),
    limit: vi.fn(() => chain),
    maybeSingle: vi.fn(() => Promise.resolve(result)),
    then: undefined,
  };
  chain.select.mockReturnValue(chain);
  chain.insert.mockReturnValue(chain);
  chain.eq.mockReturnValue(chain);
  chain.in.mockReturnValue(chain);
  chain.order.mockReturnValue(chain);
  chain.range.mockReturnValue(chain);
  chain.single.mockReturnValue(Promise.resolve(result));
  chain.then = (resolve: any) => resolve(result);
  return chain;
}

const mockFrom = supabase.from as unknown as ReturnType<typeof vi.fn>;

beforeEach(() => {
  mockFrom.mockClear();
  mockFrom.mockImplementation(() => buildChain({ data: [], error: null }));
});

describe('quiz DB layer', () => {
  it('createQuestion inserts and returns the question', async () => {
    const questionData = { prompt: 'What is 2+2?', type: 'multiple_choice' as const, options: [{ label: 'A', text: '4' }], correctAnswer: 'A', rubric: null, teacherId: 't1' };
    const expected = { id: expect.stringContaining('q-'), ...questionData, createdAt: expect.any(String) };

    mockFrom.mockImplementation(() => {
      const chain = buildChain({ data: expected, error: null });
      chain.insert.mockReturnValue(chain);
      chain.select.mockReturnValue(chain);
      chain.single.mockReturnValue(Promise.resolve({ data: expected, error: null }));
      return chain;
    });

    const result = await createQuestion(questionData);
    expect(result.prompt).toBe('What is 2+2?');
    expect(mockFrom).toHaveBeenCalledWith('questions');
  });

  it('getQuestionsByTeacher returns questions for that teacher', async () => {
    const questions = [{ id: 'q1', prompt: 'Q1', teacherId: 't1' }];
    mockFrom.mockImplementation(() => {
      const chain = buildChain({ data: questions, error: null });
      return chain;
    });

    const result = await getQuestionsByTeacher('t1');
    expect(result).toEqual(questions);
  });

  it('createQuiz inserts quiz and junction rows', async () => {
    const quizMeta = { className: 'Grade 1-A', subject: 'Math', title: 'Quiz 1', description: null, openDate: '2026-01-01', dueDate: '2026-01-07', timeLimit: 10, questionOrder: 'randomized' as const, teacherId: 't1' };

    mockFrom.mockImplementation(() => {
      const chain = buildChain({ data: [{ id: 'q1', prompt: 'Q1', type: 'multiple_choice', options: [{ label: 'A', text: '4' }], correctAnswer: 'A' }], error: null });
      chain.insert.mockReturnValue(Promise.resolve({ error: null }));
      return chain;
    });

    const result = await createQuiz(quizMeta, [{ questionId: 'q1', points: 1 }]);
    expect(result.title).toBe('Quiz 1');
    expect(mockFrom).toHaveBeenCalledWith('questions');
  });

  it('getQuizWithQuestions returns quiz with questions', async () => {
    const quiz = { id: 'quiz1', title: 'Quiz 1' };

    mockFrom.mockImplementation((table: string) => {
      if (table === 'quizzes') {
        const chain = buildChain({ data: quiz, error: null });
        chain.single.mockReturnValue(Promise.resolve({ data: quiz, error: null }));
        return chain;
      }
      return buildChain({ data: [{ id: 'qq1', quizId: 'quiz1' }], error: null });
    });

    const result = await getQuizWithQuestions('quiz1');
    expect(result).not.toBeNull();
    expect(result!.quiz.title).toBe('Quiz 1');
  });

  it('submitAttempt marks as graded', async () => {
    const attempt = {
      id: 'a1', quizId: 'quiz1', studentId: 's1',
      answers: [{ questionId: 'qq1', answer: 'A', pointsEarned: 1, isCorrect: true }],
      totalEarned: 1, totalPossible: 1,
      startedAt: new Date().toISOString(), submittedAt: null,
      status: 'in_progress',
    };

    const gradedAttempt = { ...attempt, submittedAt: expect.any(String), status: 'graded' };

    mockFrom.mockImplementation((table: string) => {
      if (table === 'quiz_attempts') {
        return {
          select: vi.fn(() => ({
            eq: vi.fn(() => ({
              single: vi.fn(() => Promise.resolve({ data: attempt, error: null })),
            })),
          })),
          update: vi.fn(() => ({
            eq: vi.fn(() => ({
              select: vi.fn(() => ({
                single: vi.fn(() => Promise.resolve({ data: gradedAttempt, error: null })),
              })),
            })),
          })),
        };
      }
      return {
        select: vi.fn(() => ({
          eq: vi.fn(() => ({
            single: vi.fn(() => Promise.resolve({ data: { className: 'Grade 1-A', subject: 'Math' }, error: null })),
          })),
        })),
      };
    });

    const result = await submitAttempt('a1');
    expect(result.status).toBe('graded');
    expect(result.totalEarned).toBe(1);
  });
});
