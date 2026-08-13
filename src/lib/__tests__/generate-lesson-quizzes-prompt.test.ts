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
  parseGeminiResponse,
  parseQuizJson,
  returnResponse,
  summarizeQuizShape,
  validateQuizResponse,
} from '../../../supabase/functions/generate-lesson-quizzes/index';
import { buildQuizGenerationRequest } from '../db/lessonPlanQuizzes';

function makeValidResponse(includeExtras = false) {
  return {
    quizzes: Array.from({ length: 3 }, (_, quizIndex) => ({
      title: ` Plant learning check ${quizIndex + 1} `,
      ...(includeExtras ? { providerNote: 'drop this' } : {}),
      questions: Array.from({ length: 4 }, (_, questionIndex) => questionIndex === 3
        ? {
            type: 'direct_answer' as const,
            question: ` How does plant concept ${quizIndex + 1} support healthy growth? `,
            rubric: ' Give one point for the concept and one for a relevant example. ',
            ...(includeExtras ? { reasoning: 'drop this too' } : {}),
          }
        : {
            type: 'multiple_choice' as const,
            question: ` Which plant process matches idea ${questionIndex + 1} in set ${quizIndex + 1}? `,
            options: ['A', 'B', 'C', 'D'].map((label) => ` Concept ${quizIndex + 1}-${questionIndex + 1}-${label} `),
            correctIndex: questionIndex,
            explanation: ' A short explanation. ',
            ...(includeExtras ? { confidence: 0.98 } : {}),
          }),
    })),
    ...(includeExtras ? { usage: { tokens: 9999 }, provider: 'unused' } : {}),
  };
}

function geminiInteraction(raw: string) {
  return {
    id: 'interaction-test',
    status: 'completed',
    steps: [
      { type: 'thought', content: [{ type: 'text', text: 'must not be parsed' }] },
      { type: 'model_output', content: [{ type: 'text', text: raw }] },
    ],
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

function generationRequest(payload: unknown = samplePayload): Request {
  return new Request('https://example.test/generate-lesson-quizzes', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
}

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
    expect(context).toContain('Student learning objectives:');
    expect(context).toContain('Student vocabulary: chlorophyll, glucose, sunlight');
    expect(context).toContain('Student topics:\n- Plant leaves');
    expect(context).not.toContain('Teacher demonstration');
    expect(context).not.toContain('worksheet');
    expect(context).not.toContain('Warm up question');
    expect(context).not.toContain('Period 1');
    expect(context).not.toContain('Fractions');
    expect(context).not.toContain('Huge Unit Plan');
    expect(context).not.toContain('teacher_id');
    expect(context.length).toBeLessThanOrEqual(3_700);
  });

  it('states the exact JSON-only 3×4 contract and preserves both question shapes', () => {
    const prompt = buildCompactPrompt(samplePayload as any);
    expect(prompt).toContain('Return ONLY one valid JSON object');
    expect(prompt).toContain('Return exactly 3 quizzes');
    expect(prompt).toContain('Do not return 2, 4, or any other number');
    expect(prompt).toContain('exactly 4 questions');
    expect(prompt).toContain('Do not return 3, 5, or any other number');
    expect(prompt).toContain('one brief explanation of the correct answer');
    expect(prompt).toContain('No markdown, prose, commentary, or code fences');
    expect(prompt).toContain('at least 1 direct_answer question');
    expect(prompt).toContain('Assess only what STUDENTS know, understand, apply, or reason about');
    expect(prompt).toContain('NEVER ask about the teacher');
    expect(prompt).toContain('Match the class/grade');
    expect(prompt).toContain('KG and early primary');
    expect(prompt).toContain('plausible same-type answer based on a different likely student mistake');
    expect(prompt).toContain('solve it independently');
    expect(prompt).toContain('exactly one correct value');
    expect(prompt.length).toBeLessThan(6_000);
    expect(prompt.length).toBeLessThanOrEqual(8_000);
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
    const storedSubjectId = 'd9428888-122b-11e1-b85c-61cd3cbb3210';
    const periods = Array.from({ length: 100 }, (_, index) => ({
      id: `period-${index}`,
      plan_id: 'plan-id',
      day: 'Monday',
      period_number: index + 1,
      subject: storedSubjectId,
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
    expect(Object.keys(request.periods[0]).sort()).toEqual(['objective', 'subject', 'topic']);
    expect(request.periods.every((period) => period.subject === 'Science')).toBe(true);
    expect(serialized).not.toContain('Activity 0');
    expect(serialized).not.toContain('Step 0');
    expect(serialized.length).toBeLessThan(40_000);
    expect(serialized).not.toContain('teacher-id');
    expect(serialized).not.toContain('period-0');
    expect(serialized).not.toContain('created_at');
    expect(serialized).not.toContain('unit_plans');
    expect(serialized).not.toContain(storedSubjectId);
  });

  it('validates exactly 3 quizzes with exactly 4 questions and rejects missing fields', () => {
    const providerResult = makeValidResponse(true);
    expect(() => validateQuizResponse(providerResult)).not.toThrow();

    expect(() => validateQuizResponse({ quizzes: providerResult.quizzes.slice(0, 2) }))
      .toThrow(/exactly 3 quizzes/i);
    expect(() => validateQuizResponse({ quizzes: [...providerResult.quizzes, providerResult.quizzes[0]] }))
      .toThrow(/exactly 3 quizzes/i);

    const counts434 = makeValidResponse();
    counts434.quizzes[1].questions = counts434.quizzes[1].questions.slice(0, 3);
    expect(summarizeQuizShape(counts434)).toEqual({ quizCount: 3, questionCounts: [4, 3, 4] });
    expect(() => validateQuizResponse(counts434)).toThrow(/exactly 4 questions/i);

    const counts454 = makeValidResponse();
    counts454.quizzes[1].questions.push(counts454.quizzes[1].questions[0]);
    expect(summarizeQuizShape(counts454)).toEqual({ quizCount: 3, questionCounts: [4, 5, 4] });
    expect(() => validateQuizResponse(counts454)).toThrow(/exactly 4 questions/i);

    const missingRubric = makeValidResponse() as any;
    delete missingRubric.quizzes[2].questions[3].rubric;
    expect(() => validateQuizResponse(missingRubric)).toThrow(/must have a rubric/i);

    const normalized = normalizeQuizResponse(providerResult);
    expect(normalized.quizzes).toHaveLength(3);
    expect(normalized.quizzes[0].questions).toHaveLength(4);
    expect(normalized).not.toHaveProperty('usage');
    expect(normalized.quizzes[0]).not.toHaveProperty('providerNote');
    expect(normalized.quizzes[0].questions[0]).not.toHaveProperty('confidence');
    expect(normalized.quizzes[0].questions[0].question).toBe('Which plant process matches idea 1 in set 1?');
  });

  it('mirrors semantic quality rejection and exact objective exceptions at the Edge boundary', () => {
    const teacherQuestion = makeValidResponse() as any;
    teacherQuestion.quizzes[0].questions[0].question = 'Which worksheet page should the teacher assign?';
    expect(() => validateQuizResponse(teacherQuestion)).toThrow(/teacher delivery, resources, or lesson planning/i);

    const chartQuestion = makeValidResponse() as any;
    chartQuestion.quizzes[0].questions[0].question = 'Which chart correctly represents the plant data?';
    expect(() => validateQuizResponse(chartQuestion, 3, 4, 1, {
      learningObjectives: ['Interpret plant data shown in a chart'],
    })).not.toThrow();
    expect(() => validateQuizResponse(chartQuestion, 3, 4, 1, {
      learningObjectives: ['Complete the plant worksheet'],
    })).toThrow(/teacher delivery, resources, or lesson planning/i);

    const arithmetic = makeValidResponse() as any;
    arithmetic.quizzes[0].questions[0] = {
      type: 'multiple_choice',
      question: 'What is 31 + 12?',
      options: ['42', '43', '44', '53'],
      correctIndex: 0,
      explanation: 'Adding 31 and 12 gives 43.',
    };
    expect(() => validateQuizResponse(arithmetic)).toThrow(/correctIndex does not match/i);
    arithmetic.quizzes[0].questions[0].correctIndex = 1;
    expect(() => validateQuizResponse(arithmetic)).not.toThrow();
  });

  it('extracts only model-output text from Gemini envelopes', () => {
    expect(parseGeminiResponse(geminiInteraction(' {"quizzes":[]} '))).toEqual({
      raw: '{"quizzes":[]}',
      finishReason: 'completed',
    });
    expect(parseGeminiResponse({
      status: 'completed',
      steps: [{ type: 'tool_output', content: [{ type: 'text', text: '{"quizzes":["wrong"]}' }] }],
    })).toEqual({ raw: '', finishReason: 'completed' });
  });

  it('safely parses markdown/prose wrappers without repairing incomplete content', () => {
    const valid = makeValidResponse();
    const raw = JSON.stringify(valid);
    expect(parseQuizJson(`\`\`\`json\n${raw}\n\`\`\``)).toEqual(valid);
    expect(parseQuizJson(`Here is the requested object:\n${raw}\nDone.`)).toEqual(valid);
    expect(parseQuizJson(`prefix {"note":"brace } in string"} then ${raw}`)).toEqual(valid);
    expect(() => parseQuizJson('```json\n{"quizzes":[')).toThrow(/No complete valid JSON object/i);

    const wrappedIncomplete = parseQuizJson(`Result: ${JSON.stringify({ quizzes: valid.quizzes.slice(0, 2) })}`);
    expect(() => validateQuizResponse(wrappedIncomplete)).toThrow(/exactly 3 quizzes/i);
  });

  it('uses Gemini 3.6 JSON-schema generation on success', async () => {
    const providerResult = makeValidResponse(true);
    const raw = JSON.stringify(providerResult);
    const fetchMock = vi.fn().mockImplementationOnce(async () => new Response(
      JSON.stringify(geminiInteraction(raw)),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    ));
    vi.stubGlobal('fetch', fetchMock);
    const envGet = vi.fn((name: string) => name === 'GEMINI_API_KEY' ? 'gemini-key' : undefined);
    vi.stubGlobal('Deno', { env: { get: envGet } });
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});

    const response = await handleRequest(generationRequest());
    const responseData = await response.json();

    expect(response.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe(
      'https://generativelanguage.googleapis.com/v1beta/interactions',
    );
    expect(envGet.mock.calls).toEqual([['GEMINI_API_KEY']]);

    const providerBody = JSON.parse(String(fetchMock.mock.calls[0][1]?.body));
    expect(providerBody).toEqual(expect.objectContaining({
      model: 'gemini-3.6-flash',
      system_instruction: expect.stringContaining('schema-conforming JSON'),
      response_format: expect.objectContaining({
        type: 'text',
        mime_type: 'application/json',
        schema: expect.any(Object),
      }),
      generation_config: {
        max_output_tokens: PROVIDER_MAX_TOKENS,
        thinking_level: 'minimal',
      },
    }));
    expect(providerBody.generation_config.max_output_tokens).toBe(1_800);
    expect(providerBody.input.length).toBeLessThan(6_000);
    expect(fetchMock.mock.calls[0][1]?.headers).toEqual({
      'Content-Type': 'application/json',
      'x-goog-api-key': 'gemini-key',
    });

    expect(responseData).toEqual(normalizeQuizResponse(providerResult));
    expect(logSpy).toHaveBeenCalledWith(
      '[generate-lesson-quizzes] validation metadata',
      expect.objectContaining({
        provider: 'gemini',
        model: 'gemini-3.6-flash',
        attempt: 1,
        httpStatus: 200,
        validJson: true,
        validationResult: 'passed',
        quizCount: 3,
        questionCounts: [4, 4, 4],
        responseChars: raw.length,
        responseBytes: new TextEncoder().encode(raw).byteLength,
        latencyMs: expect.any(Number),
        promptChars: providerBody.input.length,
        executionMs: expect.any(Number),
        totalProviderAttempts: 1,
      }),
    );
    expect(logSpy).toHaveBeenCalledWith(expect.objectContaining({
      responseBytes: expect.any(Number),
      executionMs: expect.any(Number),
      totalProviderAttempts: 1,
    }));
    const diagnostics = JSON.stringify(logSpy.mock.calls);
    expect(diagnostics).not.toContain('Which plant process matches idea 1 in set 1?');
    expect(diagnostics).not.toContain('must not be parsed');
  });

  it('falls back to Gemini Flash-Lite when the first candidate is structurally valid but low quality', async () => {
    const lowQuality = makeValidResponse() as any;
    lowQuality.quizzes[0].questions[0].question = 'Which page should the teacher assign from the workbook?';
    const fetchMock = vi.fn()
      .mockImplementationOnce(async () => new Response(JSON.stringify(geminiInteraction(JSON.stringify(lowQuality))), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }))
      .mockImplementationOnce(async () => new Response(JSON.stringify(geminiInteraction(JSON.stringify(makeValidResponse()))), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }));
    vi.stubGlobal('fetch', fetchMock);
    vi.stubGlobal('Deno', { env: { get: () => 'gemini-key' } });
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const response = await handleRequest(generationRequest());

    expect(response.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls.map((call) => JSON.parse(String(call[1]?.body)).model)).toEqual([
      'gemini-3.6-flash',
      'gemini-3.5-flash-lite',
    ]);
    expect(errorSpy).toHaveBeenCalledWith(
      '[generate-lesson-quizzes] validation metadata',
      expect.objectContaining({
        provider: 'gemini',
        model: 'gemini-3.6-flash',
        validationResult: 'failed',
        validJson: true,
      }),
    );
    expect(JSON.stringify(errorSpy.mock.calls)).not.toContain('Which page should the teacher');
  });

  it('uses the fixed Gemini 3.6 → Gemini 3.5 Flash-Lite order', async () => {
    const validRaw = JSON.stringify(makeValidResponse());
    const fetchMock = vi.fn()
      .mockImplementationOnce(async () => new Response(JSON.stringify({
        error: { message: 'PRIVATE-QUOTA-DETAIL' },
      }), { status: 429, headers: { 'Content-Type': 'application/json' } }))
      .mockImplementationOnce(async () => new Response(JSON.stringify(geminiInteraction(validRaw)), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }));
    vi.stubGlobal('fetch', fetchMock);
    vi.stubGlobal('Deno', { env: { get: () => 'gemini-key' } });
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const response = await handleRequest(generationRequest());

    expect(response.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls.map((call) => call[0])).toEqual([
      'https://generativelanguage.googleapis.com/v1beta/interactions',
      'https://generativelanguage.googleapis.com/v1beta/interactions',
    ]);
    expect(fetchMock.mock.calls.map((call) => JSON.parse(String(call[1]?.body)).model)).toEqual([
      'gemini-3.6-flash',
      'gemini-3.5-flash-lite',
    ]);
    expect(errorSpy).toHaveBeenCalledWith(
      '[generate-lesson-quizzes] provider attempt failed',
      expect.objectContaining({
        provider: 'gemini',
        model: 'gemini-3.6-flash',
        attempt: 1,
        httpStatus: 429,
        rateLimited: true,
        errorCode: 'PROVIDER_HTTP_ERROR',
        totalProviderAttempts: 1,
      }),
    );
    expect(JSON.stringify(errorSpy.mock.calls)).not.toContain('PRIVATE-QUOTA-DETAIL');
  });

  it('falls back safely when a provider envelope is malformed without exposing its content', async () => {
    const privateProviderContent = 'DO_NOT_LOG_PROVIDER_CONTENT';
    const validRaw = JSON.stringify(makeValidResponse());
    const fetchMock = vi.fn()
      .mockImplementationOnce(async () => new Response(`{"error":"${privateProviderContent}`, {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }))
      .mockImplementationOnce(async () => new Response(JSON.stringify(geminiInteraction(validRaw)), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }));
    vi.stubGlobal('fetch', fetchMock);
    vi.stubGlobal('Deno', { env: { get: () => 'provider-key' } });
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const response = await handleRequest(generationRequest());
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.quizzes).toHaveLength(3);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const diagnostics = JSON.stringify([...logSpy.mock.calls, ...errorSpy.mock.calls]);
    expect(diagnostics).not.toContain(privateProviderContent);
    expect(diagnostics).toContain('INVALID_PROVIDER_ENVELOPE');
  });

  it('uses identical exact 3×4 schemas and bounded generation settings for both Gemini calls', async () => {
    const invalidRaw = JSON.stringify({ quizzes: makeValidResponse().quizzes.slice(0, 2) });
    const validRaw = JSON.stringify(makeValidResponse());
    const fetchMock = vi.fn()
      .mockImplementationOnce(async () => new Response(JSON.stringify(geminiInteraction(invalidRaw)), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }))
      .mockImplementationOnce(async () => new Response(JSON.stringify(geminiInteraction(validRaw)), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }));
    vi.stubGlobal('fetch', fetchMock);
    vi.stubGlobal('Deno', {
      env: { get: (name: string) => name === 'GEMINI_API_KEY' ? 'gemini-key' : undefined },
    });
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});

    const response = await handleRequest(generationRequest());

    expect(response.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const bodies = fetchMock.mock.calls.map((call) => JSON.parse(String(call[1]?.body)));
    expect(bodies.map((body) => body.model)).toEqual(['gemini-3.6-flash', 'gemini-3.5-flash-lite']);
    expect(bodies[0].response_format.schema).toEqual(bodies[1].response_format.schema);
    for (const [index, body] of bodies.entries()) {
      expect(body.input).toContain('Return exactly 3 quizzes');
      expect(body.system_instruction).toContain('schema-conforming JSON');
      expect(body.response_format.type).toBe('text');
      expect(body.response_format.mime_type).toBe('application/json');
      expect(body.generation_config).toEqual({
        max_output_tokens: 1_800,
        thinking_level: 'minimal',
      });
      expect(fetchMock.mock.calls[index][1]?.headers).toEqual({
        'Content-Type': 'application/json',
        'x-goog-api-key': 'gemini-key',
      });
    }

    const schema = bodies[0].response_format.schema;
    expect(schema).toEqual({
      type: 'object',
      additionalProperties: false,
      properties: {
        quizzes: {
          type: 'array',
          minItems: 3,
          maxItems: 3,
          items: {
            type: 'object',
            additionalProperties: false,
            properties: {
              title: { type: 'string' },
              questions: {
                type: 'array',
                minItems: 4,
                maxItems: 4,
                items: {
                  anyOf: [
                    {
                      type: 'object',
                      additionalProperties: false,
                      properties: {
                        type: { type: 'string', enum: ['multiple_choice'] },
                        question: { type: 'string' },
                        options: {
                          type: 'array', minItems: 4, maxItems: 4, items: { type: 'string' },
                        },
                        correctIndex: { type: 'integer', enum: [0, 1, 2, 3] },
                        explanation: { type: 'string' },
                      },
                      required: ['type', 'question', 'options', 'correctIndex', 'explanation'],
                    },
                    {
                      type: 'object',
                      additionalProperties: false,
                      properties: {
                        type: { type: 'string', enum: ['direct_answer'] },
                        question: { type: 'string' },
                        rubric: { type: 'string' },
                      },
                      required: ['type', 'question', 'rubric'],
                    },
                  ],
                },
              },
            },
            required: ['title', 'questions'],
          },
        },
      },
      required: ['quizzes'],
    });
  });

  it('rejects invalid output after both Gemini calls without logging or returning generated content', async () => {
    const invalidRaw = JSON.stringify({
      quizzes: [{ title: 'DO_NOT_LOG_GENERATED_CONTENT', questions: [] }],
    });
    const fetchMock = vi.fn().mockImplementation(async () => {
      return new Response(JSON.stringify(geminiInteraction(invalidRaw)), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    });
    vi.stubGlobal('fetch', fetchMock);
    vi.stubGlobal('Deno', { env: { get: () => 'provider-key' } });
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const response = await handleRequest(generationRequest());
    const body = await response.json();

    expect(response.status).toBe(502);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls.map((call) => JSON.parse(String(call[1]?.body)).model)).toEqual([
      'gemini-3.6-flash',
      'gemini-3.5-flash-lite',
    ]);
    expect(body).toEqual(expect.objectContaining({
      error: 'Quiz generation returned invalid structured output',
      code: 'QUIZ_GENERATION_FAILED',
      provider: 'all',
    }));
    expect(body).not.toHaveProperty('raw_excerpt');
    const diagnostics = JSON.stringify([...logSpy.mock.calls, ...errorSpy.mock.calls]);
    expect(diagnostics).not.toContain('DO_NOT_LOG_GENERATED_CONTENT');
    expect(diagnostics).not.toContain(invalidRaw);
  });

  it('does not call Gemini when GEMINI_API_KEY is missing and reports the secret once', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    vi.stubGlobal('Deno', { env: { get: () => undefined } });
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const response = await handleRequest(generationRequest());

    expect(response.status).toBe(502);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(errorSpy.mock.calls.filter((call) => call[0] === '[generate-lesson-quizzes] GEMINI_API_KEY missing'))
      .toHaveLength(1);
  });

  it('rejects malformed request JSON without exposing request content', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const privateContent = 'DO_NOT_LOG_LESSON_CONTENT';

    const response = await handleRequest(new Request('https://example.test/generate-lesson-quizzes', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: `{"plan":{"title":"${privateContent}`,
    }));
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body).toEqual({ error: 'Invalid payload', code: 'INVALID_PAYLOAD' });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(JSON.stringify(errorSpy.mock.calls)).not.toContain(privateContent);
  });

  it('rejects declared or measured legacy-sized requests before calling a provider', async () => {
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

    const measuredResponse = await handleRequest(new Request('https://example.test/generate-lesson-quizzes', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ padding: 'x'.repeat(250_000) }),
    }));
    expect(measuredResponse.status).toBe(413);
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
