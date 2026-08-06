import { describe, it, expect, vi } from 'vitest';

vi.mock('https://deno.land/std@0.224.0/http/server.ts', () => ({
  serve: vi.fn(),
}));

import { buildCompactLessonContext, buildCompactPrompt, validate, returnResponse } from '../../../supabase/functions/generate-lesson-quizzes/index';


describe('generate-lesson-quizzes resource optimization', () => {
  const samplePayload = {
    plan: {
      id: 'plan-1',
      teacher_id: 't-12345',
      class_name: 'Grade 5A',
      title: 'Plants make food using sunlight',
      objective: 'Explain photosynthesis and identify chlorophyll',
      vocabulary: ['chlorophyll', 'glucose', 'sunlight'],
      created_at: '2026-08-01T00:00:00Z',
      updated_at: '2026-08-01T00:00:00Z',
    },
    subject: 'Science',
    periods: [
      {
        id: 'p-1',
        plan_id: 'plan-1',
        period_number: 1,
        subject: 'Science',
        topic: 'Plant leaves',
        objective: 'Identify chlorophyll in leaves',
        activities: 'Teacher demonstration of leaves in alcohol, followed by student worksheet and group discussion.',
        details: [
          { activity: 'Warm up question', time: '5m', resource: 'Board', place: 'Class' },
          { activity: 'Alcohol leaf demo', time: '15m', resource: 'Beaker', place: 'Lab' },
        ],
      },
      {
        id: 'p-2',
        plan_id: 'plan-1',
        period_number: 2,
        subject: 'Math', // different subject should be ignored
        topic: 'Fractions',
        objective: 'Add fractions',
        activities: 'Worksheet on fractions',
      },
    ],
    unit_plans: [
      {
        id: 'u-1',
        name: 'Huge Unit Plan with 50 pages of standards and text',
        objectives: 'A '.repeat(5000),
      },
    ],
  };

  it('buildCompactLessonContext formats concise context and omits unit_plans and other subjects', () => {
    const context = buildCompactLessonContext(samplePayload as any);
    expect(context).toContain('Class: Grade 5A');
    expect(context).toContain('Grade: 5');
    expect(context).toContain('Subject: Science');
    expect(context).toContain('Lesson:\nPlants make food using sunlight');
    expect(context).toContain('Objectives:\n- Identify chlorophyll in leaves\n- Explain photosynthesis and identify chlorophyll');
    expect(context).toContain('Vocabulary:\n- chlorophyll\n- glucose\n- sunlight');
    expect(context).toContain('[Period 1] Topic: Plant leaves');
    // Ensure Math period and Unit plans are excluded
    expect(context).not.toContain('Fractions');
    expect(context).not.toContain('Huge Unit Plan');
    expect(context.length).toBeLessThan(4500);
  });

  it('buildCompactPrompt keeps total prompt chars under 6000 target', () => {
    const prompt = buildCompactPrompt(samplePayload as any);
    expect(prompt.length).toBeLessThan(6000);
    expect(prompt).toContain('Generate lesson-plan quizzes as strict JSON only');
    expect(prompt).not.toContain('JSON.stringify');
    expect(prompt).not.toContain('Huge Unit Plan');
  });

  it('validate passes valid 3-quiz array and throws on invalid structure without copying large JSON', () => {
    const validResponse = {
      quizzes: [
        {
          title: 'Quiz 1',
          questions: [
            { type: 'multiple_choice', question: 'Q1?', options: ['A', 'B', 'C', 'D'], correctIndex: 0, explanation: 'Exp 1' },
            { type: 'multiple_choice', question: 'Q2?', options: ['E', 'F', 'G', 'H'], correctIndex: 1, explanation: 'Exp 2' },
            { type: 'direct_answer', question: 'Q3?', rubric: 'Rubric 3' },
          ],
        },
        {
          title: 'Quiz 2',
          questions: [
            { type: 'multiple_choice', question: 'Q4?', options: ['A2', 'B2', 'C2', 'D2'], correctIndex: 0, explanation: 'Exp 4' },
            { type: 'multiple_choice', question: 'Q5?', options: ['E2', 'F2', 'G2', 'H2'], correctIndex: 1, explanation: 'Exp 5' },
            { type: 'direct_answer', question: 'Q6?', rubric: 'Rubric 6' },
          ],
        },
        {
          title: 'Quiz 3',
          questions: [
            { type: 'multiple_choice', question: 'Q7?', options: ['A3', 'B3', 'C3', 'D3'], correctIndex: 0, explanation: 'Exp 7' },
            { type: 'multiple_choice', question: 'Q8?', options: ['E3', 'F3', 'G3', 'H3'], correctIndex: 1, explanation: 'Exp 8' },
            { type: 'direct_answer', question: 'Q9?', rubric: 'Rubric 9' },
          ],
        },
      ],
    };

    expect(() => validate(validResponse)).not.toThrow();

    expect(() => validate({ quizzes: [] })).toThrow(/exactly 3 quizzes/i);
  });

  it('returnResponse logs responseBytes and triggers size guard warning if over 50000 bytes', () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const normalData = { test: 'small' };
    const resNormal = returnResponse(normalData);
    expect(resNormal.status).toBe(200);
    expect(logSpy).toHaveBeenCalledWith(expect.objectContaining({ responseBytes: expect.any(Number) }));
    expect(warnSpy).not.toHaveBeenCalled();

    const hugeData = { test: 'x'.repeat(60000) };
    const resHuge = returnResponse(hugeData);
    expect(resHuge.status).toBe(200);
    expect(warnSpy).toHaveBeenCalledWith(
      '[generate-lesson-quizzes] warning: unexpectedly large response size',
      expect.objectContaining({ responseBytes: expect.any(Number) })
    );

    logSpy.mockRestore();
    warnSpy.mockRestore();
  });
});
