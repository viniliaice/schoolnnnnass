import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('https://deno.land/std@0.224.0/http/server.ts', () => ({
  serve: vi.fn(),
}));
vi.mock('../supabase', () => ({
  supabase: {},
}));

import {
  PROVIDER_MAX_TOKENS,
  buildCompactLessonContext,
  buildCompactPrompt,
  handleRequest,
  normalizeQuizResponse,
  parseProviderResponse,
  returnResponse,
  validateQuizResponse,
} from '../../../supabase/functions/generate-lesson-quizzes/index';
import { buildQuizGenerationRequest } from '../db/lessonPlanQuizzes';

function makeValidResponse(includeExtras = false) {
  return {
    quizzes: Array.from({ length: 3 }, (_, quizIndex) => ({
      title: ` Quiz ${quizIndex + 1} `,
      ...(includeExtras ? { providerNote: 'drop this' } : {}),
      questions: Array.from({ length: 4 }, (_, questionIndex) => questionIndex === 3
        ? {
            type: 'direct_answer' as const,
            question: ` Explain concept ${quizIndex + 1}. `,
            rubric: ' Give one point for the concept and one for an example. ',
            ...(includeExtras ? { reasoning: 'drop this too' } : {}),
          }
        : {
            type: 'multiple_choice' as const,
            question: ` Question ${quizIndex + 1}-${questionIndex + 1}? `,
            options: [' First ', ' Second ', ' Third ', ' Fourth '],
            correctIndex: questionIndex,
            explanation: ' A short explanation. ',
            ...(includeExtras ? { confidence: 0.98 } : {}),
          }),
    })),
    ...(includeExtras ? { usage: { tokens: 9999 }, provider: 'unused' } : {}),
  };
}

const samplePayload = {
  plan: {
    id: 'plan-1',
    teacher_id: 't-12345',
    class_name: 'Grade 5A',
    title: 'Plants make food using sunlight',
    objective: 'Explain photosynthesis and identify chlorophyll',
    vocabulary: ['chlorophyll', 'glucose', 'sunlight'],
    created_at: '2026-08-01T00:00:00Z',
  },
  subject: 'Science',
  periods: [
    {
      id: 'p-1',
      period_number: 1,
      subject: 'Science',
      topic: 'Plant leaves',
      objective: 'Identify chlorophyll in leaves',
      activities: 'Teacher demonstration followed by a worksheet and group discussion.',
      details: [{ activity: 'Warm up question' }, { activity: 'Alcohol leaf demo' }],
    },
    {
      id: 'p-2',
      period_number: 2,
      subject: 'Math',
      topic: 'Fractions',
      objective: 'Add fractions',
      activities: 'Worksheet on fractions',
    },
  ],
  unit_plans: [{ id: 'u-1', name: 'Huge Unit Plan', objectives: 'A '.repeat(5_000) }],
  quiz_count: 3,
  questions_per_quiz: 4,
  direct_answer_min: 1,
};

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('generate-lesson-quizzes resource optimization', () => {
  it('builds concise lesson context from only relevant educational fields', () => {
    const context = buildCompactLessonContext(samplePayload as any);
    expect(context).toContain('Class: Grade 5A');
    expect(context).toContain('Grade: 5');
    expect(context).toContain('Subject: Science');
    expect(context).toContain('Lesson title: Plants make food using sunlight');
    expect(context).toContain('Learning objectives:');
    expect(context).toContain('Vocabulary: chlorophyll, glucose, sunlight');
    expect(context).toContain('Period 1: topic Plant leaves');
    expect(context).not.toContain('Fractions');
    expect(context).not.toContain('Huge Unit Plan');
    expect(context).not.toContain('teacher_id');
    expect(context.length).toBeLessThanOrEqual(3_700);
  });

  it('keeps oversized metadata, vocabulary, activities, periods, and unit plans below prompt limits', () => {
    const metadata = {
      id: 'oversized-id-'.repeat(2_000),
      teacher_id: 'oversized-teacher-'.repeat(2_000),
      created_at: '2026-08-01T00:00:00Z'.repeat(1_000),
      audit_history: 'SECRET-METADATA '.repeat(4_000),
    };
    const oversized = {
      plan: {
        ...metadata,
        class_name: 'Grade 8A',
        grade: '8',
        title: 'Plant nutrition '.repeat(1_000),
        objective: 'Explain photosynthesis '.repeat(1_000),
        vocabulary: Array.from({ length: 500 }, (_, index) => `word-${index}-${'x'.repeat(100)}`),
      },
      subject: 'Science',
      periods: Array.from({ length: 100 }, (_, index) => ({
        ...metadata,
        period_number: index + 1,
        subject: index % 2 === 0 ? 'Science' : 'Irrelevant Mathematics',
        topic: `Topic ${index} ${'large topic '.repeat(300)}`,
        objective: `Objective ${index} ${'large objective '.repeat(300)}`,
        activities: `Activity ${index} ${'large activity '.repeat(600)}`,
        details: Array.from({ length: 50 }, (_, detail) => ({
          activity: `Step ${detail} ${'large detail '.repeat(300)}`,
          resource: 'UNUSED-RESOURCE '.repeat(500),
          time: '50 minutes',
        })),
      })),
      unit_plans: Array.from({ length: 20 }, (_, index) => ({
        ...metadata,
        title: `UNIT-PLAN-${index}`,
        objectives: 'unused unit objective '.repeat(5_000),
      })),
      quiz_count: 3,
      questions_per_quiz: 4,
      direct_answer_min: 1,
    };

    const context = buildCompactLessonContext(oversized as any);
    const prompt = buildCompactPrompt(oversized as any);
    expect(buildCompactPrompt(oversized as any)).toBe(prompt);
    expect(context.length).toBeLessThanOrEqual(3_700);
    expect(prompt.length).toBeLessThan(6_000);
    expect(prompt.length).toBeLessThanOrEqual(8_000);
    expect(prompt).not.toContain('SECRET-METADATA');
    expect(prompt).not.toContain('Irrelevant Mathematics');
    expect(prompt).not.toContain('UNIT-PLAN-');
    expect(prompt).not.toContain('UNUSED-RESOURCE');
  });

  it('builds a bounded browser request without unit plans or database metadata', () => {
    const plan = {
      id: 'plan-id',
      teacher_id: 'teacher-id',
      class_name: `Grade 8A ${'class '.repeat(100)}`,
      week_label: 'Week 3',
      title: `Photosynthesis ${'title '.repeat(1_000)}`,
      created_at: 'unused',
    };
    const periods = Array.from({ length: 100 }, (_, index) => ({
      id: `period-${index}`,
      plan_id: 'plan-id',
      day: 'Monday',
      period_number: index + 1,
      subject: index % 2 === 0 ? 'Science' : 'Math',
      is_free: false,
      topic: `Topic ${index} ${'topic '.repeat(500)}`,
      objective: `Objective ${index} ${'objective '.repeat(500)}`,
      activities: `Activity ${index} ${'activity '.repeat(1_000)}`,
      details: Array.from({ length: 40 }, (_, detail) => ({
        activity: `Step ${detail} ${'detail '.repeat(500)}`,
        time: '10m', resource: 'unused', place: 'unused',
      })),
      created_at: 'unused', updated_at: 'unused', sort_order: index,
    }));

    const request = buildQuizGenerationRequest(plan as any, 'Science', periods as any);
    const serialized = JSON.stringify(request);
    expect(request.periods).toHaveLength(24);
    expect(Object.keys(request.plan).sort()).toEqual(['class_name', 'title']);
    expect(Object.keys(request.periods[0]).sort()).toEqual([
      'activities', 'details', 'objective', 'period_number', 'subject', 'topic',
    ]);
    expect(request.periods[0].details).toHaveLength(4);
    expect(serialized.length).toBeLessThan(40_000);
    expect(serialized).not.toContain('teacher-id');
    expect(serialized).not.toContain('period-0');
    expect(serialized).not.toContain('created_at');
    expect(serialized).not.toContain('unit_plans');
    expect(serialized).not.toContain('"Math"');
  });

  it('validates exactly 3 quizzes with 4 questions and normalizes to consumed fields', () => {
    const providerResult = makeValidResponse(true);
    expect(() => validateQuizResponse(providerResult)).not.toThrow();
    expect(() => validateQuizResponse({ quizzes: [] })).toThrow(/exactly 3 quizzes/i);
    expect(() => validateQuizResponse({ quizzes: providerResult.quizzes.map((quiz) => ({
      ...quiz,
      questions: quiz.questions.slice(0, 3),
    })) })).toThrow(/exactly 4 questions/i);

    const normalized = normalizeQuizResponse(providerResult);
    expect(normalized.quizzes).toHaveLength(3);
    expect(normalized.quizzes[0].questions).toHaveLength(4);
    expect(normalized).not.toHaveProperty('usage');
    expect(normalized.quizzes[0]).not.toHaveProperty('providerNote');
    expect(normalized.quizzes[0].questions[0]).not.toHaveProperty('confidence');
    expect(normalized.quizzes[0].questions[0].question).toBe('Question 1-1?');
  });

  it('extracts only completion text from a provider envelope', () => {
    expect(parseProviderResponse({
      id: 'provider-id',
      usage: { total_tokens: 1234 },
      choices: [{ finish_reason: 'stop', message: { content: ' {"quizzes":[]} ', reasoning_content: 'unused reasoning' } }],
    })).toEqual({ raw: '{"quizzes":[]}', finishReason: 'stop' });
  });

  it('uses 1800 tokens, one provider call on success, and returns the existing normalized schema', async () => {
    const providerResult = makeValidResponse(true);
    const raw = JSON.stringify(providerResult);
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      choices: [{ finish_reason: 'stop', message: { content: raw, reasoning_content: 'unused reasoning' } }],
      usage: { total_tokens: 1_700 },
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
    vi.stubGlobal('fetch', fetchMock);
    vi.stubGlobal('Deno', { env: { get: (name: string) => name === 'ZEN_API_KEY' ? 'zen-key' : 'nvidia-key' } });
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    const response = await handleRequest(new Request('https://example.test/generate-lesson-quizzes', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(samplePayload),
    }));
    const responseData = await response.json();

    expect(response.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const providerBody = JSON.parse(String(fetchMock.mock.calls[0][1]?.body));
    expect(providerBody.max_tokens).toBe(PROVIDER_MAX_TOKENS);
    expect(providerBody.max_tokens).toBe(1_800);
    expect(providerBody.messages[1].content.length).toBeLessThan(6_000);
    expect(responseData).toEqual(normalizeQuizResponse(providerResult));
    expect(logSpy).toHaveBeenCalledWith({ promptChars: providerBody.messages[1].content.length });
    expect(logSpy).toHaveBeenCalledWith({ responseChars: raw.length });
    expect(logSpy).toHaveBeenCalledWith(expect.objectContaining({
      responseBytes: expect.any(Number),
      executionMs: expect.any(Number),
      providerAttempts: 1,
    }));
  });

  it('allows one quality recovery per provider and prevents accidental retry loops', async () => {
    const invalidRaw = JSON.stringify({ quizzes: [] });
    const fetchMock = vi.fn().mockImplementation(async () => new Response(JSON.stringify({
      choices: [{ finish_reason: 'stop', message: { content: invalidRaw } }],
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
    vi.stubGlobal('fetch', fetchMock);
    vi.stubGlobal('Deno', { env: { get: () => 'provider-key' } });
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});

    const response = await handleRequest(new Request('https://example.test/generate-lesson-quizzes', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(samplePayload),
    }));

    expect(response.status).toBe(502);
    // Initial + one validation recovery for Zen, then the same bounded fallback for NVIDIA.
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it('rejects declared legacy-sized requests before parsing or calling a provider', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const response = await handleRequest(new Request('https://example.test/generate-lesson-quizzes', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': '300000' },
      body: '{}',
    }));
    expect(response.status).toBe(413);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('serializes responses once and warns when a response is unexpectedly large', () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    expect(returnResponse({ test: 'small' }).status).toBe(200);
    expect(logSpy).toHaveBeenCalledWith(expect.objectContaining({ responseBytes: expect.any(Number) }));
    expect(warnSpy).not.toHaveBeenCalled();

    const unicodeBody = JSON.stringify({ test: 'Soomaali: barasho fiican — 你好' });
    returnResponse(unicodeBody);
    expect(logSpy).toHaveBeenCalledWith(expect.objectContaining({
      responseBytes: new TextEncoder().encode(unicodeBody).byteLength,
    }));

    expect(returnResponse({ test: 'x'.repeat(60_000) }).status).toBe(200);
    expect(warnSpy).toHaveBeenCalledWith(
      '[generate-lesson-quizzes] warning: unexpectedly large response size',
      expect.objectContaining({ responseBytes: expect.any(Number) }),
    );
  });
});
