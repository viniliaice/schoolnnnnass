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
  buildEmbeddingBatch,
  handleRequest,
  normalizeQuizResponse,
  parseGeminiResponse,
  parseProviderResponse,
  parseQuizJson,
  rankPeriodsByEmbeddings,
  returnResponse,
  summarizeQuizShape,
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

function embeddingEnvelope(payload: any) {
  const batch = buildEmbeddingBatch(payload);
  return {
    data: batch.inputs.map((_, index) => ({
      index,
      embedding: index === 0 ? [1, 0] : [1, index / 100],
    })),
  };
}

function openRouterCompletion(raw: string) {
  return {
    choices: [{
      finish_reason: 'stop',
      message: {
        content: raw,
        reasoning_details: [{ type: 'summary', text: 'must stay private' }],
      },
    }],
  };
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
    expect(context).toContain('Learning objectives:');
    expect(context).toContain('Vocabulary: chlorophyll, glucose, sunlight');
    expect(context).toContain('Period 1: topic Plant leaves');
    expect(context).not.toContain('Fractions');
    expect(context).not.toContain('Huge Unit Plan');
    expect(context).not.toContain('teacher_id');
    expect(context.length).toBeLessThanOrEqual(3_700);
  });

  it('states the exact JSON-only 3×4 contract and forbids omissions and rationales', () => {
    const prompt = buildCompactPrompt(samplePayload as any);
    expect(prompt).toContain('Return ONLY one valid JSON object');
    expect(prompt).toContain('Return exactly 3 quizzes');
    expect(prompt).toContain('Do not return 2, 4, or any other number');
    expect(prompt).toContain('exactly 4 questions');
    expect(prompt).toContain('Do not return 3, 5, or any other number');
    expect(prompt).toContain('Do not include explanations or rationales');
    expect(prompt).toContain('No markdown, prose, commentary, or code fences');
    expect(prompt).toContain('questions 1–3 must be multiple_choice and question 4 must be direct_answer');
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

  it('builds one bounded educational embedding query plus at most 24 candidates', () => {
    const payload = {
      plan: {
        title: `Plant systems ${'title '.repeat(500)}`,
        objective: `Explain transport ${'objective '.repeat(500)}`,
        teacher_id: 'PRIVATE-TEACHER-ID',
      },
      subject: 'Science',
      periods: Array.from({ length: 80 }, (_, index) => ({
        id: `PRIVATE-PERIOD-${index}`,
        subject: index < 60 ? 'Science' : 'Math',
        period_number: index + 1,
        topic: `Topic ${index} ${'topic '.repeat(100)}`,
        objective: `Objective ${index} ${'objective '.repeat(100)}`,
        activities: `Activity ${index} ${'activity '.repeat(200)}`,
        details: [{ activity: `Step ${index} ${'detail '.repeat(100)}`, resource: 'PRIVATE-RESOURCE' }],
      })),
    };

    const batch = buildEmbeddingBatch(payload as any);
    expect(batch.inputs).toHaveLength(25);
    expect(batch.periodIndexes).toHaveLength(24);
    expect(batch.inputs[0].length).toBeLessThanOrEqual(1_500);
    expect(batch.inputs.slice(1).every((input) => input.length <= 900)).toBe(true);
    expect(batch.periodIndexes).toEqual(Array.from({ length: 24 }, (_, index) => index));
    const serialized = JSON.stringify(batch.inputs);
    expect(serialized).not.toContain('PRIVATE-TEACHER-ID');
    expect(serialized).not.toContain('PRIVATE-PERIOD-');
    expect(serialized).not.toContain('PRIVATE-RESOURCE');
    expect(serialized).not.toContain('Math');

    const storedSubjectId = 'd9428888-122b-11e1-b85c-61cd3cbb3210';
    const identifierPayload = {
      plan: { title: 'Fractions' },
      subject: storedSubjectId,
      periods: [{
        subject: storedSubjectId,
        period_number: 1,
        topic: 'Equivalent fractions',
        objective: 'Compare equivalent fractions',
      }],
    };
    expect(buildCompactLessonContext(identifierPayload as any)).not.toContain(storedSubjectId);
    expect(JSON.stringify(buildEmbeddingBatch(identifierPayload as any).inputs)).not.toContain(storedSubjectId);
  });

  it('uses valid embedding similarity only under context pressure and restores chronology', () => {
    const payload = {
      plan: { class_name: 'Grade 7', title: 'Interdependent ecosystems' },
      subject: 'Science',
      periods: Array.from({ length: 12 }, (_, index) => ({
        subject: 'Science',
        period_number: index + 1,
        topic: `Topic ${index} ${'ecosystem '.repeat(20)}`,
        objective: `Objective ${index} ${'relationship '.repeat(20)}`,
        activities: `Activity ${index} ${'investigation '.repeat(24)}`,
        details: [{ activity: `Evidence task ${index} ${'observation '.repeat(10)}` }],
      })),
    };
    expect(buildCompactLessonContext(payload as any)).toContain('[context truncated]');
    const batch = buildEmbeddingBatch(payload as any);
    const data = batch.inputs.map((_, vectorIndex) => {
      if (vectorIndex === 0) return { index: 0, embedding: [1, 0] };
      const periodIndex = batch.periodIndexes[vectorIndex - 1];
      const score = periodIndex === 8 ? 1 : periodIndex === 2 ? 0.99 : 0.1;
      return { index: vectorIndex, embedding: [score, Math.sqrt(1 - score * score)] };
    });

    const ranked = rankPeriodsByEmbeddings(payload as any, batch, data);
    const selectedIndexes = ranked.periods.map((period) => payload.periods.indexOf(period as any));
    expect(ranked).not.toBe(payload);
    expect(ranked.periods.length).toBeLessThan(payload.periods.length);
    expect(selectedIndexes).toContain(8);
    expect(selectedIndexes).toContain(2);
    expect(selectedIndexes).toEqual([...selectedIndexes].sort((left, right) => left - right));
    expect(buildCompactLessonContext(ranked as any)).not.toContain('[context truncated]');

    expect(() => rankPeriodsByEmbeddings(payload as any, batch, data.slice(0, -1)))
      .toThrow(/count does not match/i);
    const malformed = data.map((item) => ({ ...item, embedding: [...item.embedding] }));
    malformed[1].embedding[0] = Number.NaN;
    expect(() => rankPeriodsByEmbeddings(payload as any, batch, malformed))
      .toThrow(/non-finite vector/i);

    const overflowing = data.map((item) => ({ ...item, embedding: [Number.MAX_VALUE, Number.MAX_VALUE] }));
    expect(() => rankPeriodsByEmbeddings(payload as any, batch, overflowing))
      .toThrow(/invalid cosine similarity/i);
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
    expect(Object.keys(request.periods[0]).sort()).toEqual([
      'activities', 'details', 'objective', 'period_number', 'subject', 'topic',
    ]);
    expect(request.periods[0].details).toHaveLength(4);
    expect(request.periods.every((period) => period.subject === 'Science')).toBe(true);
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
    expect(normalized.quizzes[0].questions[0].question).toBe('Question 1-1?');
  });

  it('extracts only completion text from provider envelopes', () => {
    expect(parseProviderResponse({
      id: 'provider-id',
      usage: { total_tokens: 1234 },
      choices: [{
        finish_reason: 'stop',
        message: {
          content: ' {"quizzes":[]} ',
          reasoning_content: 'unused reasoning',
          reasoning_details: [{ text: 'also unused' }],
        },
      }],
    })).toEqual({ raw: '{"quizzes":[]}', finishReason: 'stop' });
    expect(parseProviderResponse({
      choices: [{ finish_reason: 'stop', message: { reasoning_content: '{"quizzes":["private"]}' } }],
    })).toEqual({ raw: '', finishReason: 'stop' });

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

  it('uses bounded embedding preprocessing and JSON-only Lightning generation on success', async () => {
    const providerResult = makeValidResponse(true);
    const raw = JSON.stringify(providerResult);
    const fetchMock = vi.fn()
      .mockImplementationOnce(async () => new Response(JSON.stringify(embeddingEnvelope(samplePayload)), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }))
      .mockImplementationOnce(async () => new Response(JSON.stringify(openRouterCompletion(raw)), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }));
    vi.stubGlobal('fetch', fetchMock);
    vi.stubGlobal('Deno', {
      env: { get: (name: string) => name === 'OPENROUTER_API_KEY' ? 'openrouter-key' : undefined },
    });
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});

    const response = await handleRequest(generationRequest());
    const responseData = await response.json();

    expect(response.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls.map((call) => call[0])).toEqual([
      'https://openrouter.ai/api/v1/embeddings',
      'https://openrouter.ai/api/v1/chat/completions',
    ]);

    const embeddingBody = JSON.parse(String(fetchMock.mock.calls[0][1]?.body));
    expect(embeddingBody).toEqual({
      model: 'nvidia/nemotron-3-embed-1b:free',
      input: buildEmbeddingBatch(samplePayload as any).inputs,
      encoding_format: 'float',
    });
    expect(embeddingBody.input).toHaveLength(2);
    expect(JSON.stringify(embeddingBody)).not.toContain('plan-1');
    expect(JSON.stringify(embeddingBody)).not.toContain('t-12345');
    expect(fetchMock.mock.calls[0][1]?.headers).toEqual({
      'Content-Type': 'application/json',
      Authorization: 'Bearer openrouter-key',
    });

    const providerBody = JSON.parse(String(fetchMock.mock.calls[1][1]?.body));
    expect(providerBody).toEqual(expect.objectContaining({
      model: 'nvidia/nemotron-3.5-lightning:free',
      temperature: 0.7,
      top_p: 0.95,
      max_tokens: PROVIDER_MAX_TOKENS,
      stream: false,
      reasoning: { effort: 'minimal', exclude: true },
    }));
    expect(providerBody.max_tokens).toBe(1_800);
    expect(providerBody.messages[1].content.length).toBeLessThan(6_000);
    expect(providerBody).not.toHaveProperty('provider');
    expect(providerBody).not.toHaveProperty('response_format');
    expect(fetchMock.mock.calls[1][1]?.headers).toEqual({
      'Content-Type': 'application/json',
      Authorization: 'Bearer openrouter-key',
    });

    expect(responseData).toEqual(normalizeQuizResponse(providerResult));
    expect(logSpy).toHaveBeenCalledWith(
      '[generate-lesson-quizzes] validation metadata',
      expect.objectContaining({
        provider: 'openrouter',
        attempt: 2,
        httpStatus: 200,
        validJson: true,
        validationResult: 'passed',
        quizCount: 3,
        questionCounts: [4, 4, 4],
        responseChars: raw.length,
        responseBytes: new TextEncoder().encode(raw).byteLength,
        latencyMs: expect.any(Number),
        promptChars: providerBody.messages[1].content.length,
        executionMs: expect.any(Number),
        totalProviderAttempts: 2,
      }),
    );
    expect(logSpy).toHaveBeenCalledWith(expect.objectContaining({
      responseBytes: expect.any(Number),
      executionMs: expect.any(Number),
      totalProviderAttempts: 2,
    }));
    const diagnostics = JSON.stringify(logSpy.mock.calls);
    expect(diagnostics).not.toContain('Question 1-1?');
    expect(diagnostics).not.toContain('must stay private');
    expect(diagnostics).not.toContain('[1,0]');
  });

  it('falls back to deterministic source order when embedding vectors are malformed', async () => {
    const payload = {
      plan: { class_name: 'Grade 6', title: 'Water systems' },
      subject: 'Science',
      periods: Array.from({ length: 12 }, (_, index) => ({
        subject: 'Science',
        period_number: index + 1,
        topic: `Source topic ${index} ${'cycle '.repeat(24)}`,
        objective: `Source objective ${index} ${'explain '.repeat(28)}`,
        activities: `Source activity ${index} ${'observe '.repeat(36)}`,
      })),
    };
    const raw = JSON.stringify(makeValidResponse());
    const fetchMock = vi.fn()
      .mockImplementationOnce(async () => new Response(JSON.stringify({
        data: [{ index: 0, embedding: [1, 0] }],
      }), { status: 200, headers: { 'Content-Type': 'application/json' } }))
      .mockImplementationOnce(async () => new Response(JSON.stringify(openRouterCompletion(raw)), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }));
    vi.stubGlobal('fetch', fetchMock);
    vi.stubGlobal('Deno', {
      env: { get: (name: string) => name === 'OPENROUTER_API_KEY' ? 'openrouter-key' : undefined },
    });
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const response = await handleRequest(generationRequest(payload));

    expect(response.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const generationBody = JSON.parse(String(fetchMock.mock.calls[1][1]?.body));
    expect(generationBody.messages[1].content).toBe(buildCompactPrompt(payload as any));
    expect(warnSpy).toHaveBeenCalledWith(
      '[generate-lesson-quizzes] embedding fallback applied',
      expect.objectContaining({
        provider: 'openrouter-embedding',
        totalProviderAttempts: 1,
      }),
    );
    expect(errorSpy).toHaveBeenCalledWith(
      '[generate-lesson-quizzes] embedding metadata',
      expect.objectContaining({
        validJson: true,
        validationResult: 'failed',
        totalProviderAttempts: 1,
      }),
    );
    expect(JSON.stringify([...errorSpy.mock.calls, ...warnSpy.mock.calls])).not.toContain('[1,0]');
  });

  it('uses the fixed embedding → OpenRouter → Gemini 3.6 → Gemini 3.5 order', async () => {
    const valid = makeValidResponse();
    const invalidRaw = JSON.stringify({ quizzes: valid.quizzes.slice(0, 2) });
    const validRaw = JSON.stringify(valid);
    const fetchMock = vi.fn()
      .mockImplementationOnce(async () => new Response(JSON.stringify(embeddingEnvelope(samplePayload)), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }))
      .mockImplementationOnce(async () => new Response(JSON.stringify({
        error: { message: 'PRIVATE-QUOTA-DETAIL' },
      }), { status: 429, headers: { 'Content-Type': 'application/json' } }))
      .mockImplementationOnce(async () => new Response(JSON.stringify(geminiInteraction(invalidRaw)), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }))
      .mockImplementationOnce(async () => new Response(JSON.stringify(geminiInteraction(validRaw)), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }));
    vi.stubGlobal('fetch', fetchMock);
    vi.stubGlobal('Deno', { env: { get: () => 'provider-key' } });
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const response = await handleRequest(generationRequest());

    expect(response.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(fetchMock.mock.calls.map((call) => call[0])).toEqual([
      'https://openrouter.ai/api/v1/embeddings',
      'https://openrouter.ai/api/v1/chat/completions',
      'https://generativelanguage.googleapis.com/v1beta/interactions',
      'https://generativelanguage.googleapis.com/v1beta/interactions',
    ]);
    expect(fetchMock.mock.calls.map((call) => JSON.parse(String(call[1]?.body)).model)).toEqual([
      'nvidia/nemotron-3-embed-1b:free',
      'nvidia/nemotron-3.5-lightning:free',
      'gemini-3.6-flash',
      'gemini-3.5-flash-lite',
    ]);
    expect(errorSpy).toHaveBeenCalledWith(
      '[generate-lesson-quizzes] provider attempt failed',
      expect.objectContaining({
        provider: 'openrouter',
        attempt: 2,
        httpStatus: 429,
        rateLimited: true,
        errorCode: 'PROVIDER_HTTP_ERROR',
        totalProviderAttempts: 2,
      }),
    );
    expect(JSON.stringify(errorSpy.mock.calls)).not.toContain('PRIVATE-QUOTA-DETAIL');
  });

  it('falls back safely when a provider envelope is malformed without exposing its content', async () => {
    const privateProviderContent = 'DO_NOT_LOG_PROVIDER_CONTENT';
    const validRaw = JSON.stringify(makeValidResponse());
    const fetchMock = vi.fn()
      .mockImplementationOnce(async () => new Response(JSON.stringify(embeddingEnvelope(samplePayload)), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }))
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
    expect(fetchMock).toHaveBeenCalledTimes(3);
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
                prefixItems: [
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
                    },
                    required: ['type', 'question', 'options', 'correctIndex'],
                  },
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
                    },
                    required: ['type', 'question', 'options', 'correctIndex'],
                  },
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
                    },
                    required: ['type', 'question', 'options', 'correctIndex'],
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
            required: ['title', 'questions'],
          },
        },
      },
      required: ['quizzes'],
    });
  });

  it('rejects invalid output after four calls without logging or returning generated content', async () => {
    const invalidRaw = JSON.stringify({
      quizzes: [{ title: 'DO_NOT_LOG_GENERATED_CONTENT', questions: [] }],
    });
    const fetchMock = vi.fn().mockImplementation(async (url: string) => {
      const envelope = url.endsWith('/embeddings')
        ? embeddingEnvelope(samplePayload)
        : url.includes('generativelanguage.googleapis.com')
          ? geminiInteraction(invalidRaw)
          : openRouterCompletion(invalidRaw);
      return new Response(JSON.stringify(envelope), {
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
    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(fetchMock.mock.calls.map((call) => JSON.parse(String(call[1]?.body)).model)).toEqual([
      'nvidia/nemotron-3-embed-1b:free',
      'nvidia/nemotron-3.5-lightning:free',
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
    const invalidRaw = JSON.stringify({ quizzes: [] });
    const fetchMock = vi.fn().mockImplementation(async (url: string) => new Response(JSON.stringify(
      url.endsWith('/embeddings')
        ? embeddingEnvelope(samplePayload)
        : openRouterCompletion(invalidRaw),
    ), { status: 200, headers: { 'Content-Type': 'application/json' } }));
    vi.stubGlobal('fetch', fetchMock);
    vi.stubGlobal('Deno', {
      env: { get: (name: string) => name === 'GEMINI_API_KEY' ? undefined : 'provider-key' },
    });
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const response = await handleRequest(generationRequest());

    expect(response.status).toBe(502);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls.every((call) => !String(call[0]).includes('googleapis.com'))).toBe(true);
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
