import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockState = vi.hoisted(() => ({
  events: [] as string[],
  invoke: vi.fn(),
}));

vi.mock('../supabase', () => {
  class Query {
    table: string;
    action = 'select';
    rows: any[] = [];

    constructor(table: string) {
      this.table = table;
    }

    select() { return this; }
    insert(rows: any[]) { this.action = 'insert'; this.rows = rows; return this; }
    delete() { this.action = 'delete'; return this; }
    eq() { return this; }

    single() {
      mockState.events.push(`select:${this.table}`);
      return Promise.resolve({
        data: {
          id: 'plan-1',
          teacher_id: 'teacher-1',
          class_name: 'Grade 4',
          week_label: 'Week 1',
          title: 'Plant Growth',
        },
        error: null,
      });
    }

    then(resolve: (value: any) => unknown, reject: (reason: unknown) => unknown) {
      mockState.events.push(`${this.action}:${this.table}`);
      let result: any = { data: null, error: null };
      if (this.action === 'select' && this.table === 'lesson_plan_periods') {
        result = {
          data: [{
            day: 'Monday',
            period_number: 1,
            subject: 'subject-1',
            is_free: false,
            topic: 'Plant needs',
            objective: 'Explain what plants need to grow',
          }],
          error: null,
        };
      } else if (this.action === 'select' && this.table === 'subjects') {
        result = { data: [{ id: 'subject-1', name: 'Science' }], error: null };
      } else if (this.action === 'insert' && this.table === 'questions') {
        result = { data: this.rows, error: null };
      }
      return Promise.resolve(result).then(resolve, reject);
    }
  }

  return {
    supabase: {
      from: (table: string) => new Query(table),
      functions: {
        invoke: (...args: any[]) => {
          mockState.events.push('invoke:generate-lesson-quizzes');
          return mockState.invoke(...args);
        },
      },
    },
  };
});

import { generateLessonPlanQuizzes } from '../db/lessonPlanQuizzes';

function generatedResponse() {
  return {
    quizzes: Array.from({ length: 3 }, (_, quizIndex) => ({
      title: `Plant Check ${quizIndex + 1}`,
      questions: Array.from({ length: 4 }, (_, questionIndex) => questionIndex === 3
        ? {
            type: 'direct_answer',
            question: `Explain how plant need ${quizIndex + 1} supports growth.`,
            rubric: `Credit an accurate explanation of plant need ${quizIndex + 1}.`,
          }
        : {
            type: 'multiple_choice',
            question: `Which statement explains plant need ${quizIndex + 1}-${questionIndex + 1}?`,
            options: ['A', 'B', 'C', 'D'].map((label) => `Plant response ${quizIndex + 1}-${questionIndex + 1}-${label}`),
            correctIndex: questionIndex,
            explanation: `Plant response ${quizIndex + 1}-${questionIndex + 1} is correct.`,
          }),
    })),
  };
}

beforeEach(() => {
  mockState.events.length = 0;
  mockState.invoke.mockReset();
  vi.restoreAllMocks();
});

describe('lesson-plan quiz replacement ordering', () => {
  it('does not delete the current set when provider generation fails', async () => {
    mockState.invoke.mockResolvedValue({ data: null, error: new Error('provider unavailable') });
    vi.spyOn(console, 'error').mockImplementation(() => {});

    await expect(generateLessonPlanQuizzes('plan-1')).rejects.toThrow(/provider unavailable/i);

    expect(mockState.events).toContain('invoke:generate-lesson-quizzes');
    expect(mockState.events.some((event) => event.startsWith('delete:'))).toBe(false);
  });

  it('generates and validates the entire replacement before deleting old rows', async () => {
    mockState.invoke.mockResolvedValue({ data: generatedResponse(), error: null });

    await expect(generateLessonPlanQuizzes('plan-1')).resolves.toHaveLength(3);

    const generatedAt = mockState.events.indexOf('invoke:generate-lesson-quizzes');
    const oldQuizDeleteAt = mockState.events.indexOf('delete:quizzes');
    const replacementInsertAt = mockState.events.indexOf('insert:quizzes');
    expect(generatedAt).toBeGreaterThan(-1);
    expect(oldQuizDeleteAt).toBeGreaterThan(generatedAt);
    expect(replacementInsertAt).toBeGreaterThan(oldQuizDeleteAt);
  });
});
