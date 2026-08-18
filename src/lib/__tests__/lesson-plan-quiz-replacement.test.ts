import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockState = vi.hoisted(() => ({
  events: [] as string[],
  invoke: vi.fn(),
  rpc: vi.fn(),
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
      rpc: (name: string, args: unknown) => {
        mockState.events.push(`rpc:${name}`);
        return mockState.rpc(name, args);
      },
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
          }),
    })),
  };
}

beforeEach(() => {
  mockState.events.length = 0;
  mockState.invoke.mockReset();
  mockState.rpc.mockReset();
  mockState.rpc.mockResolvedValue({ data: { quiz_count: 3, question_count: 12 }, error: null });
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

  it('generates and validates the entire replacement before one atomic RPC', async () => {
    mockState.invoke.mockResolvedValue({ data: generatedResponse(), error: null });

    await expect(generateLessonPlanQuizzes('plan-1')).resolves.toHaveLength(3);

    const generatedAt = mockState.events.indexOf('invoke:generate-lesson-quizzes');
    const replacementAt = mockState.events.indexOf('rpc:replace_generated_lesson_plan_quizzes');
    expect(generatedAt).toBeGreaterThan(-1);
    expect(replacementAt).toBeGreaterThan(generatedAt);
    expect(mockState.events.some((event) => event.startsWith('delete:'))).toBe(false);
    expect(mockState.events.some((event) => event.startsWith('insert:'))).toBe(false);

    expect(mockState.rpc).toHaveBeenCalledTimes(1);
    const [rpcName, payload] = mockState.rpc.mock.calls[0];
    expect(rpcName).toBe('replace_generated_lesson_plan_quizzes');
    expect(payload).toMatchObject({ p_plan_id: 'plan-1' });
    expect(payload.p_quizzes).toHaveLength(3);
    expect(payload.p_questions).toHaveLength(12);
    expect(payload.p_quiz_questions).toHaveLength(12);
  });

  it('does not issue a client cleanup when atomic replacement persistence fails', async () => {
    mockState.invoke.mockResolvedValue({ data: generatedResponse(), error: null });
    mockState.rpc.mockResolvedValue({ data: null, error: { message: 'junction constraint failed' } });
    vi.spyOn(console, 'error').mockImplementation(() => {});

    await expect(generateLessonPlanQuizzes('plan-1')).rejects.toThrow(/junction constraint failed/i);

    expect(mockState.events).toContain('rpc:replace_generated_lesson_plan_quizzes');
    expect(mockState.events.some((event) => event.startsWith('delete:'))).toBe(false);
  });

  it('leaves the already-applied owner-scoped migration intact', () => {
    const migration = readFileSync(
      new URL('../../../supabase/migrations/20260813_atomic_lesson_plan_quiz_replacement.sql', import.meta.url),
      'utf8',
    );

    expect(migration).toContain('CREATE OR REPLACE FUNCTION replace_generated_lesson_plan_quizzes');
    expect(migration).toContain('v_plan_teacher_id IS DISTINCT FROM v_profile_id');
  });

  it('replaces the RPC in a later migration with supervisor/admin actor authorization', () => {
    const migration = readFileSync(
      new URL('../../../supabase/migrations/20260818_supervisor_atomic_lesson_plan_quiz_replacement.sql', import.meta.url),
      'utf8',
    );

    expect(migration).toContain('CREATE OR REPLACE FUNCTION replace_generated_lesson_plan_quizzes');
    expect(migration).toContain('SECURITY DEFINER');
    expect(migration).toContain('SELECT id, role INTO v_actor_profile_id, v_actor_role');
    expect(migration).toContain("COALESCE(v_actor_role, '') NOT IN ('supervisor', 'admin')");
    expect(migration).toContain('Only a supervisor or administrator may replace generated lesson-plan quizzes.');
    expect(migration).not.toContain('v_plan_teacher_id IS DISTINCT FROM v_actor_profile_id');
  });

  it('locks the plan and requires every replacement quiz and question to belong to its teacher', () => {
    const migration = readFileSync(
      new URL('../../../supabase/migrations/20260818_supervisor_atomic_lesson_plan_quiz_replacement.sql', import.meta.url),
      'utf8',
    );

    expect(migration).toContain('FOR UPDATE');
    expect(migration).toContain("quiz.value ->> 'teacherId' IS DISTINCT FROM v_plan_teacher_id");
    expect(migration).toContain("question.value ->> 'teacherId' IS DISTINCT FROM v_plan_teacher_id");
    expect(migration).toContain("quiz.value ->> 'lesson_plan_id' IS DISTINCT FROM p_plan_id");
    expect(migration).toContain("question.value ->> 'source_lesson_plan_id' IS DISTINCT FROM p_plan_id");
  });

  it('preserves validation and all delete/insert work inside one PostgreSQL function transaction', () => {
    const migration = readFileSync(
      new URL('../../../supabase/migrations/20260818_supervisor_atomic_lesson_plan_quiz_replacement.sql', import.meta.url),
      'utf8',
    );

    expect(migration).toContain("jsonb_typeof(p_quizzes) IS DISTINCT FROM 'array'");
    expect(migration).toContain('v_question_count <> v_quiz_count * 4');
    expect(migration).toContain('DELETE FROM quizzes');
    expect(migration).toContain('DELETE FROM questions');
    expect(migration).toContain('INSERT INTO quizzes');
    expect(migration).toContain('INSERT INTO questions');
    expect(migration).toContain('INSERT INTO quiz_questions');
    expect(migration).not.toMatch(/\b(COMMIT|ROLLBACK)\b/);
    expect(migration).toContain('GRANT EXECUTE ON FUNCTION replace_generated_lesson_plan_quizzes');
  });
});
