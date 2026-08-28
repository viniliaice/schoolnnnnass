import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('https://deno.land/std@0.224.0/http/server.ts', () => ({
  serve: vi.fn(),
}));

import {
  PROVIDER_MAX_TOKENS,
  buildCompactPrompt,
  buildRetryPrompt,
  failurePhaseForError,
  handleRequest,
  quizValidationErrorCode,
  quizValidationPath,
  repairQuizCandidate,
  targetedRetryCorrection,
  validateQuizResponse,
} from '../../../supabase/functions/generate-lesson-quizzes/index';

// ── helpers ────────────────────────────────────────────────────────────────

type McQuestion = {
  type: 'multiple_choice';
  question: string;
  options: string[];
  correctIndex: number;
};
type DaQuestion = { type: 'direct_answer'; question: string; rubric: string };
type Question = McQuestion | DaQuestion;

function fillerQuiz(variant: number): { title: string; questions: Question[] } {
  const words = [
    'Mango', 'River', 'Lantern', 'Harbour', 'Cactus', 'Compass', 'Anvil', 'Pebble',
    'Meadow', 'Signal', 'Orchard', 'Thistle', 'Basalt', 'Lagoon', 'Summit', 'Drizzle',
    'Ember', 'Fjord', 'Grove', 'Hollow', 'Islet', 'Knoll', 'Marsh', 'Nimbus',
  ];
  const pick = (index: number) => words[(variant * 4 + index) % words.length];
  return {
    title: `Learning check ${variant}`,
    questions: [
      {
        type: 'multiple_choice',
        question: `Which meaning best fits the word "${pick(0)}" in set ${variant}?`,
        options: [`A calm ${pick(0)} scene`, `A loud ${pick(1)} scene`, `A wide ${pick(2)} field`, `A tall ${pick(3)} tower`],
        correctIndex: 0,
      },
      {
        type: 'multiple_choice',
        question: `Which sentence uses "${pick(1)}" correctly in set ${variant}?`,
        options: [`The ${pick(1)} shone over the bay`, `The ${pick(2)} ate its tail`, `The ${pick(3)} sang a note`, `The ${pick(0)} drove a car`],
        correctIndex: 0,
      },
      {
        type: 'multiple_choice',
        question: `Which pair belongs with "${pick(2)}" in set ${variant}?`,
        options: [`${pick(2)} and calm water`, `${pick(3)} and dry sand`, `${pick(0)} and sharp thorns`, `${pick(1)} and cold iron`],
        correctIndex: 0,
      },
      {
        type: 'direct_answer',
        question: `Explain in one sentence why "${pick(3)}" matters in set ${variant}.`,
        rubric: 'Award one point for a relevant reason and one for a clear example.',
      },
    ],
  };
}

/** A full 3-quiz response with the caller's questions placed into quiz 1. */
function makeResponse(questions: Question[]) {
  if (questions.length !== 4) throw new Error('quiz 1 needs exactly 4 questions');
  return { quizzes: [{ title: 'Learning check 1', questions }, fillerQuiz(5), fillerQuiz(6)] };
}

function outcome(input: unknown) {
  try {
    validateQuizResponse(input);
    return 'PASS';
  } catch (error) {
    return `FAIL ${quizValidationErrorCode(error)} @ ${quizValidationPath(error)}`;
  }
}

function geminiInteraction(raw: string) {
  return {
    id: 'interaction-test',
    status: 'completed',
    steps: [{ type: 'model_output', content: [{ type: 'text', text: raw }] }],
  };
}

function okResponse(raw: string) {
  return new Response(JSON.stringify(geminiInteraction(raw)), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

function lessonPayload(overrides: Record<string, unknown> = {}) {
  return {
    plan: {
      class_name: 'Grade 6B',
      grade: '6',
      title: 'Representative lesson title',
      objective: 'Understand the core idea and apply it to examples',
      vocabulary: ['concept', 'example'],
      ...((overrides.plan as Record<string, unknown>) || {}),
    },
    subject: (overrides.subject as string) || 'Science',
    periods: overrides.periods || [
      { subject: 'Science', topic: 'Core topic', objective: 'Explain the core idea' },
    ],
    quiz_count: 3,
    questions_per_quiz: 4,
    direct_answer_min: 1,
  };
}

function generationRequest(payload: unknown) {
  return new Request('https://example.test/generate-lesson-quizzes', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
}

function stubEnv(debugDiagnostics?: string) {
  return {
    env: {
      get: (name: string) => {
        if (name === 'GEMINI_API_KEY') return 'gemini-key';
        if (name === 'QUIZ_DEBUG_DIAGNOSTICS') return debugDiagnostics;
        return undefined;
      },
    },
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

// ── Step 11: validator semantics ───────────────────────────────────────────

describe('NUMERIC_DISTRACTOR validator semantics', () => {
  it('accepts valid numeric questions with plausible numeric distractors', () => {
    expect(outcome(makeResponse([
      { type: 'multiple_choice', question: 'What is 8 × 7?', options: ['54', '56', '58', '64'], correctIndex: 1 },
      { type: 'multiple_choice', question: 'What is 45 + 38?', options: ['73', '83', '87', '93'], correctIndex: 1 },
      { type: 'multiple_choice', question: 'Which number is 6 more than 27?', options: ['21', '31', '33', '34'], correctIndex: 2 },
      { type: 'direct_answer', question: 'Calculate 12 × 8.', rubric: 'Award one mark for the product 96 and one for the method.' },
    ]))).toBe('PASS');

    expect(outcome(makeResponse([
      { type: 'multiple_choice', question: 'How much did the item cost?', options: ['$5', '$10', '$15', '$20'], correctIndex: 0 },
      { type: 'multiple_choice', question: 'What is the price of two notebooks?', options: ['8 USD', '12 USD', '16 USD', '20 USD'], correctIndex: 2 },
      { type: 'multiple_choice', question: 'Which amount is greatest?', options: ['$40', '$14', '$25', '$31'], correctIndex: 0 },
      { type: 'direct_answer', question: 'Explain how to check a price total.', rubric: 'Award one point for re-adding the amounts and one for a clear example.' },
    ]))).toBe('PASS');

    expect(outcome(makeResponse([
      { type: 'multiple_choice', question: 'What is 25% of 80?', options: ['10%', '20%', '25%', '30%'], correctIndex: 1 },
      { type: 'multiple_choice', question: 'Which percentage is the largest?', options: ['45%', '5%', '0.5%', '95%'], correctIndex: 3 },
      { type: 'multiple_choice', question: 'Which decimal equals 50 percent?', options: ['0.5', '0.05', '0.25', '0.75'], correctIndex: 0 },
      { type: 'direct_answer', question: 'Explain what a percentage shows.', rubric: 'Award one point for parts per hundred and one for an example.' },
    ]))).toBe('PASS');
  });

  it('accepts valid conceptual questions with semantic distractors', () => {
    expect(outcome(makeResponse([
      { type: 'multiple_choice', question: 'What is evaporation?', options: ['The change from liquid to gas', 'The change from gas to solid', 'The change from solid to liquid', 'The movement of rocks'], correctIndex: 0 },
      { type: 'multiple_choice', question: 'What is the main purpose of photosynthesis?', options: ['Producing food for the plant', 'Absorbing sound', 'Creating gravity', 'Cooling the soil'], correctIndex: 0 },
      { type: 'multiple_choice', question: 'Which word is a verb?', options: ['jump', 'quick', 'silver', 'warm'], correctIndex: 0 },
      { type: 'direct_answer', question: 'Explain why roots matter to a plant.', rubric: 'Award one point for water uptake and one for anchoring.' },
    ]))).toBe('PASS');
  });

  it('rejects random numeric distractors on a conceptual question', () => {
    const result = outcome(makeResponse([
      { type: 'multiple_choice', question: 'What is evaporation?', options: ['The change from liquid to gas', '45', '100', '27'], correctIndex: 0 },
      fillerQuiz(2).questions[0] as McQuestion,
      fillerQuiz(2).questions[1] as McQuestion,
      fillerQuiz(2).questions[3] as DaQuestion,
    ]));
    expect(result).toBe('FAIL NUMERIC_DISTRACTOR @ quizzes[0].questions[0].options[1]');
  });

  it('rejects numeric distractors regardless of which option is correct', () => {
    const quizOne = makeResponse([
      { type: 'multiple_choice', question: 'What does a thermometer measure?', options: ['12', '35', 'Temperature', '100'], correctIndex: 2 },
      fillerQuiz(2).questions[0] as McQuestion,
      fillerQuiz(2).questions[1] as McQuestion,
      fillerQuiz(2).questions[3] as DaQuestion,
    ]);
    expect(outcome(quizOne)).toMatch(/^FAIL NUMERIC_DISTRACTOR/);
  });

  it('accepts numeric answers embedded inside full sentences and year options', () => {
    expect(outcome(makeResponse([
      { type: 'multiple_choice', question: 'Which statement about 1939 is correct?', options: ['World War II began in 1939', 'The first human walked on the moon in 1939', 'The Titanic sank in 1939', 'The Berlin Wall fell in 1939'], correctIndex: 0 },
      { type: 'multiple_choice', question: 'When did World War II end?', options: ['1945', '1939', '1918', '1950'], correctIndex: 0 },
      { type: 'multiple_choice', question: 'In which year did the Titanic sink?', options: ['1912', '1905', '1920', '1898'], correctIndex: 0 },
      { type: 'direct_answer', question: 'Explain why dates help us study the past.', rubric: 'Award one point for ordering events and one for an example.' },
    ]))).toBe('PASS');
  });

  it('accepts fractions, decimals, approximate quantities, and mixed measurement units', () => {
    expect(outcome(makeResponse([
      { type: 'multiple_choice', question: 'Which fraction equals 0.75?', options: ['3/4', '2/3', '1/2', '4/5'], correctIndex: 0 },
      { type: 'multiple_choice', question: 'What fraction of the shape is shaded?', options: ['2/5', '1/5', '3/5', '4/5'], correctIndex: 0 },
      { type: 'multiple_choice', question: 'How long does Earth take to orbit the Sun?', options: ['365 days', '30 days', '24 hours', '1 year'], correctIndex: 0 },
      { type: 'direct_answer', question: 'Explain how to compare two fractions.', rubric: 'Award one point for a common method and one for an example.' },
    ]))).toBe('PASS');

    expect(outcome(makeResponse([
      { type: 'multiple_choice', question: 'About how many millilitres are in one litre?', options: ['about 100', 'about 500', 'about 1000', 'about 1500'], correctIndex: 2 },
      { type: 'multiple_choice', question: 'Which measurement is the longest?', options: ['1 km', '100 m', '10 cm', '1 m'], correctIndex: 0 },
      { type: 'multiple_choice', question: 'Which mass is the greatest?', options: ['5 kg', '500 g', '50 g', '2 kg'], correctIndex: 0 },
      { type: 'direct_answer', question: 'Explain why units matter when measuring.', rubric: 'Award one point for a clear reason and one for an example.' },
    ]))).toBe('PASS');
  });

  it('still rejects broken numeric option sets', () => {
    // Word-number distractor inside an otherwise numeric set.
    expect(outcome(makeResponse([
      { type: 'multiple_choice', question: 'What is 8 + 5?', options: ['13', '12', 'fourteen', '15'], correctIndex: 0 },
      fillerQuiz(2).questions[0] as McQuestion,
      fillerQuiz(2).questions[1] as McQuestion,
      fillerQuiz(2).questions[3] as DaQuestion,
    ]))).toMatch(/^FAIL NUMERIC_DISTRACTOR/);

    // Percent mixed with bare numbers on one question.
    expect(outcome(makeResponse([
      { type: 'multiple_choice', question: 'Which value is the answer?', options: ['13%', '12%', '14', '15%'], correctIndex: 0 },
      fillerQuiz(2).questions[0] as McQuestion,
      fillerQuiz(2).questions[1] as McQuestion,
      fillerQuiz(2).questions[3] as DaQuestion,
    ]))).toMatch(/^FAIL NUMERIC_DISTRACTOR/);

    // Two options with the same numeric value.
    expect(outcome(makeResponse([
      { type: 'multiple_choice', question: 'Which value is greatest?', options: ['13', '13.0', '14', '15'], correctIndex: 3 },
      fillerQuiz(2).questions[0] as McQuestion,
      fillerQuiz(2).questions[1] as McQuestion,
      fillerQuiz(2).questions[3] as DaQuestion,
    ]))).toMatch(/^FAIL NUMERIC_DISTRACTOR/);

    // Decimal and its fraction twin are the same value.
    expect(outcome(makeResponse([
      { type: 'multiple_choice', question: 'Which value is greatest?', options: ['0.5', '1/2', '2/3', '3/4'], correctIndex: 3 },
      fillerQuiz(2).questions[0] as McQuestion,
      fillerQuiz(2).questions[1] as McQuestion,
      fillerQuiz(2).questions[3] as DaQuestion,
    ]))).toMatch(/^FAIL NUMERIC_DISTRACTOR/);
  });

  it('keeps the arithmetic answer integrity checks', () => {
    const wrongIndex = makeResponse([
      { type: 'multiple_choice', question: 'What is 31 + 12?', options: ['42', '43', '44', '53'], correctIndex: 0 },
      fillerQuiz(2).questions[0] as McQuestion,
      fillerQuiz(2).questions[1] as McQuestion,
      fillerQuiz(2).questions[3] as DaQuestion,
    ]);
    expect(outcome(wrongIndex)).toBe('FAIL ARITHMETIC_ANSWER @ quizzes[0].questions[0].correctIndex');

    // "3/4 of 12" is multiplication phrasing, not division; must not mis-solve.
    const fractionOf = makeResponse([
      { type: 'multiple_choice', question: 'What is 3/4 of 12?', options: ['9', '6', '3', '12'], correctIndex: 0 },
      fillerQuiz(2).questions[0] as McQuestion,
      fillerQuiz(2).questions[1] as McQuestion,
      fillerQuiz(2).questions[3] as DaQuestion,
    ]);
    expect(outcome(fractionOf)).toBe('PASS');
  });

  it('reports structural paths for non-numeric failures', () => {
    const broken = { quizzes: [fillerQuiz(5), fillerQuiz(6)] };
    expect(outcome(broken)).toBe('FAIL QUIZ_COUNT @ quizzes');
  });
});

// ── Step 4 + 13: generation contract and prompt budget ────────────────────

describe('generation prompt contract', () => {
  it('teaches the numeric-vs-conceptual distractor rule compactly', () => {
    const prompt = buildCompactPrompt(lessonPayload() as any);
    expect(prompt).toContain('Distractor typing (decide from the question)');
    expect(prompt).toContain('ALL 4 options numeric values in ONE shared type');
    expect(prompt).toContain('What is 7 + 5?');
    expect(prompt).toContain('NEVER a bare number such as 12 or 35');
    expect(prompt.length).toBeLessThan(6_000);
    expect(prompt.length).toBeLessThanOrEqual(8_000);
  });

  it('bounds the targeted retry prompt inside the hard budget', () => {
    const payload = lessonPayload({
      plan: {
        title: 'Very long lesson title '.repeat(200),
        objective: 'Detailed objective '.repeat(120),
      },
    }) as any;
    const base = buildCompactPrompt(payload);
    const correction = targetedRetryCorrection('NUMERIC_DISTRACTOR');
    const retry = buildRetryPrompt(base, payload, correction);
    expect(retry.length).toBeLessThanOrEqual(8_000);
    expect(retry).toContain('VALIDATION FEEDBACK FOR THIS RETRY ATTEMPT');
    expect(retry).toContain('invalid numeric distractor (NUMERIC_DISTRACTOR)');
    expect(retry).toContain('return JSON only');
    // Correction is error-specific, not a generic resend.
    const other = targetedRetryCorrection('FORBIDDEN_CONTEXT');
    expect(other).not.toContain('NUMERIC_DISTRACTOR');
  });
});

// ── Step 7: deterministic repair layer ─────────────────────────────────────

describe('deterministic repair layer', () => {
  it('repairs cosmetic drift without changing educational meaning', () => {
    const candidate = {
      quizzes: [
        {
          title: '  Learning   check 1 ',
          questions: [
            // Numeric JSON options + letter index + stray whitespace.
            { type: 'multiple_choice', question: '  What is 8 × 7? ', options: [54, 56, 58, 64], correctIndex: 'B' },
            { type: 'multiple_choice', question: 'Which unit fits a ruler?', options: ['centimetres', 'litres', 'grams', 'hours'], correctIndex: '1' },
            { type: 'multiple_choice', question: 'Which season follows summer?', options: ['autumn', 'winter', 'spring', 'morning'], correctIndex: 0 },
            { type: 'direct_answer', question: 'Explain your choice.', rubric: ' One point for reasoning. ', options: [] },
          ],
        },
        fillerQuiz(2),
        fillerQuiz(3),
      ],
    };
    const { value, repairs } = repairQuizCandidate(candidate);
    expect(repairs).toEqual(expect.arrayContaining(['trim_whitespace', 'numeric_option', 'correct_index', 'drop_empty_options']));
    const quizOne = (value as any).quizzes[0];
    expect(quizOne.title).toBe('Learning check 1');
    expect(quizOne.questions[0].options).toEqual(['54', '56', '58', '64']);
    expect(quizOne.questions[0].correctIndex).toBe(1);
    expect(quizOne.questions[1].correctIndex).toBe(1);
    expect(quizOne.questions[3]).not.toHaveProperty('options');
    // The repaired candidate must now pass full validation.
    expect(outcome(value)).toBe('PASS');
  });

  it('never invents content for unrecoverable candidates', () => {
    const broken = { quizzes: [{ title: 'Only three', questions: [] }] };
    const { value, repairs } = repairQuizCandidate(broken);
    expect(repairs).toEqual([]);
    expect(value).toBe(broken);
    expect(outcome(broken)).toMatch(/^FAIL/);
  });
});

// ── Step 8 + 9 + 10 + 14: retry, boundary semantics, observability ─────────

describe('provider retry and failure semantics', () => {
  it('retries with a validation-specific correction after NUMERIC_DISTRACTOR', async () => {
    const invalid = makeResponse([
      { type: 'multiple_choice', question: 'What is the main purpose of photosynthesis?', options: ['Producing food for the plant', '12', '35', '100'], correctIndex: 0 },
      fillerQuiz(2).questions[0] as McQuestion,
      fillerQuiz(2).questions[1] as McQuestion,
      fillerQuiz(2).questions[3] as DaQuestion,
    ]);
    const valid = makeResponse([
      { type: 'multiple_choice', question: 'What is the main purpose of photosynthesis?', options: ['Producing food for the plant', 'Absorbing sound', 'Creating gravity', 'Cooling the soil'], correctIndex: 0 },
      fillerQuiz(2).questions[0] as McQuestion,
      fillerQuiz(2).questions[1] as McQuestion,
      fillerQuiz(2).questions[3] as DaQuestion,
    ]);
    const fetchMock = vi.fn()
      .mockImplementationOnce(async () => okResponse(JSON.stringify(invalid)))
      .mockImplementationOnce(async () => okResponse(JSON.stringify(valid)));
    vi.stubGlobal('fetch', fetchMock);
    vi.stubGlobal('Deno', stubEnv());
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const response = await handleRequest(generationRequest(lessonPayload()));

    expect(response.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const bodies = fetchMock.mock.calls.map((call) => JSON.parse(String(call[1]?.body)));
    expect(bodies.map((body) => body.model)).toEqual(['gemini-3.6-flash', 'gemini-3.5-flash-lite']);
    // Attempt 2 is NOT a byte-identical resend: it carries the correction.
    expect(bodies[0].input).not.toContain('VALIDATION FEEDBACK');
    expect(bodies[1].input).toContain('VALIDATION FEEDBACK FOR THIS RETRY ATTEMPT');
    expect(bodies[1].input).toContain('NUMERIC_DISTRACTOR');
    expect(bodies[1].input.length).toBeLessThanOrEqual(8_000);
    expect(bodies[1].generation_config.max_output_tokens).toBe(PROVIDER_MAX_TOKENS);

    // Root cause is preserved in logs with the failing option's path.
    expect(errorSpy).toHaveBeenCalledWith(
      '[generate-lesson-quizzes] validation metadata',
      expect.objectContaining({
        model: 'gemini-3.6-flash',
        strategy: 'initial',
        attempt: 1,
        httpStatus: 200,
        validJson: true,
        validationResult: 'failed',
        validationErrorCode: 'NUMERIC_DISTRACTOR',
        validationPath: 'quizzes[0].questions[0].options[1]',
        failurePhase: 'QUIZ_SEMANTIC_INVALID',
        quizCount: 3,
        questionCounts: [4, 4, 4],
      }),
    );
    expect(errorSpy).toHaveBeenCalledWith(
      '[generate-lesson-quizzes] provider failed final',
      expect.objectContaining({
        model: 'gemini-3.6-flash',
        errorCode: 'INVALID_QUIZ_RESPONSE',
        failurePhase: 'QUIZ_SEMANTIC_INVALID',
        validationErrorCode: 'NUMERIC_DISTRACTOR',
        validationPath: 'quizzes[0].questions[0].options[1]',
      }),
    );
    expect(logSpy).toHaveBeenCalledWith(
      '[generate-lesson-quizzes] validation metadata',
      expect.objectContaining({
        model: 'gemini-3.5-flash-lite',
        strategy: 'targeted_retry',
        attempt: 2,
        validationResult: 'passed',
        validationErrorCode: null,
      }),
    );
  });

  it('keeps the retry prompt identical for transport failures', async () => {
    const valid = JSON.stringify(makeResponse([
      { type: 'multiple_choice', question: 'Which gas do plants absorb?', options: ['Carbon dioxide', 'Oxygen', 'Nitrogen', 'Helium'], correctIndex: 0 },
      fillerQuiz(2).questions[0] as McQuestion,
      fillerQuiz(2).questions[1] as McQuestion,
      fillerQuiz(2).questions[3] as DaQuestion,
    ]));
    const fetchMock = vi.fn()
      .mockImplementationOnce(async () => new Response(JSON.stringify({ error: { message: 'quota' } }), { status: 429 }))
      .mockImplementationOnce(async () => okResponse(valid));
    vi.stubGlobal('fetch', fetchMock);
    vi.stubGlobal('Deno', stubEnv());
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const response = await handleRequest(generationRequest(lessonPayload()));

    expect(response.status).toBe(200);
    const bodies = fetchMock.mock.calls.map((call) => JSON.parse(String(call[1]?.body)));
    expect(bodies[1].input).toBe(bodies[0].input);
    expect(errorSpy).toHaveBeenCalledWith(
      '[generate-lesson-quizzes] provider attempt failed',
      expect.objectContaining({
        errorCode: 'PROVIDER_HTTP_ERROR',
        httpStatus: 429,
        failurePhase: 'PROVIDER_REQUEST_FAILED',
      }),
    );
  });

  it('distinguishes malformed provider output from provider request failure', async () => {
    const valid = JSON.stringify(makeResponse([
      { type: 'multiple_choice', question: 'Which gas do plants absorb?', options: ['Carbon dioxide', 'Oxygen', 'Nitrogen', 'Helium'], correctIndex: 0 },
      fillerQuiz(2).questions[0] as McQuestion,
      fillerQuiz(2).questions[1] as McQuestion,
      fillerQuiz(2).questions[3] as DaQuestion,
    ]));
    const fetchMock = vi.fn()
      .mockImplementationOnce(async () => new Response('{"error": not-json', { status: 200 }))
      .mockImplementationOnce(async () => okResponse(valid));
    vi.stubGlobal('fetch', fetchMock);
    vi.stubGlobal('Deno', stubEnv());
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const response = await handleRequest(generationRequest(lessonPayload()));

    expect(response.status).toBe(200);
    expect(errorSpy).toHaveBeenCalledWith(
      '[generate-lesson-quizzes] provider attempt failed',
      expect.objectContaining({
        errorCode: 'INVALID_PROVIDER_ENVELOPE',
        httpStatus: 200,
        failurePhase: 'PROVIDER_RESPONSE_INVALID',
      }),
    );
  });

  it('labels schema vs semantic validation failures separately', async () => {
    const schemaInvalid = { quizzes: [fillerQuiz(5), fillerQuiz(6)] };
    const valid = makeResponse([
      { type: 'multiple_choice', question: 'Which gas do plants absorb?', options: ['Carbon dioxide', 'Oxygen', 'Nitrogen', 'Helium'], correctIndex: 0 },
      fillerQuiz(2).questions[0] as McQuestion,
      fillerQuiz(2).questions[1] as McQuestion,
      fillerQuiz(2).questions[3] as DaQuestion,
    ]);
    const fetchMock = vi.fn()
      .mockImplementationOnce(async () => okResponse(JSON.stringify(schemaInvalid)))
      .mockImplementationOnce(async () => okResponse(JSON.stringify(valid)));
    vi.stubGlobal('fetch', fetchMock);
    vi.stubGlobal('Deno', stubEnv());
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const response = await handleRequest(generationRequest(lessonPayload()));

    expect(response.status).toBe(200);
    expect(errorSpy).toHaveBeenCalledWith(
      '[generate-lesson-quizzes] validation metadata',
      expect.objectContaining({
        validationErrorCode: 'QUIZ_COUNT',
        failurePhase: 'QUIZ_SCHEMA_INVALID',
      }),
    );
    expect(failurePhaseForError({ code: 'PROVIDER_HTTP_ERROR' })).toBe('PROVIDER_REQUEST_FAILED');
    expect(failurePhaseForError({ code: 'INVALID_PROVIDER_JSON' })).toBe('PROVIDER_RESPONSE_INVALID');
  });

  it('returns INVALID_QUIZ_RESPONSE via 502 when every attempt fails validation', async () => {
    const invalid = makeResponse([
      { type: 'multiple_choice', question: 'What is the main purpose of photosynthesis?', options: ['Producing food for the plant', '12', '35', '100'], correctIndex: 0 },
      fillerQuiz(2).questions[0] as McQuestion,
      fillerQuiz(2).questions[1] as McQuestion,
      fillerQuiz(2).questions[3] as DaQuestion,
    ]);
    const fetchMock = vi.fn().mockImplementation(async () => okResponse(JSON.stringify(invalid)));
    vi.stubGlobal('fetch', fetchMock);
    vi.stubGlobal('Deno', stubEnv());
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const response = await handleRequest(generationRequest(lessonPayload()));
    const body = await response.json();

    expect(response.status).toBe(502);
    expect(body).toEqual(expect.objectContaining({
      error: 'Quiz generation returned invalid structured output',
      code: 'QUIZ_GENERATION_FAILED',
      provider: 'all',
    }));
    expect(body).not.toHaveProperty('validationErrorCode');
    expect(errorSpy).toHaveBeenCalledWith(
      '[generate-lesson-quizzes] failed all providers',
      expect.objectContaining({
        errorCode: 'INVALID_QUIZ_RESPONSE',
        failurePhase: 'QUIZ_SEMANTIC_INVALID',
        validationErrorCode: 'NUMERIC_DISTRACTOR',
      }),
    );
    // Retry received the targeted correction, not a duplicate prompt.
    const bodies = fetchMock.mock.calls.map((call) => JSON.parse(String(call[1]?.body)));
    expect(bodies[1].input).toContain('NUMERIC_DISTRACTOR');
  });

  it('logs the offending question and choice only when diagnostics are enabled', async () => {
    const invalid = makeResponse([
      { type: 'multiple_choice', question: 'What is evaporation?', options: ['The change from liquid to gas', '45', '100', '27'], correctIndex: 0 },
      fillerQuiz(2).questions[0] as McQuestion,
      fillerQuiz(2).questions[1] as McQuestion,
      fillerQuiz(2).questions[3] as DaQuestion,
    ]);
    const valid = makeResponse([
      { type: 'multiple_choice', question: 'What is evaporation?', options: ['The change from liquid to gas', 'The change from gas to solid', 'The change from solid to liquid', 'The movement of rocks'], correctIndex: 0 },
      fillerQuiz(2).questions[0] as McQuestion,
      fillerQuiz(2).questions[1] as McQuestion,
      fillerQuiz(2).questions[3] as DaQuestion,
    ]);
    const fetchMock = vi.fn()
      .mockImplementationOnce(async () => okResponse(JSON.stringify(invalid)))
      .mockImplementationOnce(async () => okResponse(JSON.stringify(valid)));
    vi.stubGlobal('fetch', fetchMock);
    vi.stubGlobal('Deno', stubEnv('true'));
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const response = await handleRequest(generationRequest(lessonPayload()));

    expect(response.status).toBe(200);
    expect(errorSpy).toHaveBeenCalledWith(
      '[generate-lesson-quizzes] validation failure diagnostics',
      expect.objectContaining({
        validationErrorCode: 'NUMERIC_DISTRACTOR',
        validationPath: 'quizzes[0].questions[0].options[1]',
        questionIndex: 0,
        choiceIndex: 1,
        questionType: 'multiple_choice',
        question: 'What is evaporation?',
        correctAnswer: 'The change from liquid to gas',
        distractor: '45',
      }),
    );

    // Same failure with diagnostics OFF logs no generated content.
    const fetchMockTwo = vi.fn()
      .mockImplementationOnce(async () => okResponse(JSON.stringify(invalid)))
      .mockImplementationOnce(async () => okResponse(JSON.stringify(valid)));
    vi.stubGlobal('fetch', fetchMockTwo);
    vi.stubGlobal('Deno', stubEnv());
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const errorSpyTwo = vi.spyOn(console, 'error').mockImplementation(() => {});
    // console.error is already spied from the first run; drop its history so
    // only the diagnostics-off run is inspected below.
    errorSpyTwo.mockClear();
    const responseTwo = await handleRequest(generationRequest(lessonPayload()));
    expect(responseTwo.status).toBe(200);
    expect(JSON.stringify(errorSpyTwo.mock.calls)).not.toContain('validation failure diagnostics');
    expect(JSON.stringify(errorSpyTwo.mock.calls)).not.toContain('What is evaporation?');
  });

  it('accepts a repairable provider response end to end', async () => {
    const repairable = {
      quizzes: [
        {
          title: ' Learning check 1 ',
          questions: [
            { type: 'multiple_choice', question: ' What is 7 + 5? ', options: [10, 11, 12, 13], correctIndex: 'C' },
            fillerQuiz(2).questions[0] as McQuestion,
            fillerQuiz(2).questions[1] as McQuestion,
            fillerQuiz(2).questions[3] as DaQuestion,
          ],
        },
        fillerQuiz(5),
        fillerQuiz(6),
      ],
    };
    const fetchMock = vi.fn().mockImplementationOnce(async () => okResponse(JSON.stringify(repairable)));
    vi.stubGlobal('fetch', fetchMock);
    vi.stubGlobal('Deno', stubEnv());
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});

    const response = await handleRequest(generationRequest(lessonPayload()));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.quizzes[0].questions[0].options).toEqual(['10', '11', '12', '13']);
    expect(body.quizzes[0].questions[0].correctIndex).toBe(2);
    expect(logSpy).toHaveBeenCalledWith(
      '[generate-lesson-quizzes] validation metadata',
      expect.objectContaining({
        validationResult: 'passed',
        repairs: expect.arrayContaining(['numeric_option', 'correct_index', 'trim_whitespace']),
      }),
    );
  });
});

// ── Step 12: integration across representative lessons ─────────────────────

describe('generate-lesson-quizzes integration across lesson types', () => {
  const scenarios: Array<{ name: string; payload: Record<string, unknown>; questions: Question[] }> = [
    {
      name: 'mathematics with calculations',
      payload: { subject: 'Mathematics', plan: { title: 'Multiplying and adding whole numbers', objective: 'Multiply and add whole numbers accurately' } },
      questions: [
        { type: 'multiple_choice', question: 'What is 8 × 7?', options: ['54', '56', '58', '64'], correctIndex: 1 },
        { type: 'multiple_choice', question: 'What is 45 + 38?', options: ['73', '83', '87', '93'], correctIndex: 1 },
        { type: 'multiple_choice', question: 'Which number is 6 more than 27?', options: ['21', '31', '33', '34'], correctIndex: 2 },
        { type: 'direct_answer', question: 'Calculate 12 × 8.', rubric: 'Award one mark for the product 96 and one for the method.' },
      ],
    },
    {
      name: 'english vocabulary',
      payload: { subject: 'English', plan: { title: 'Word meanings and tenses', objective: 'Use new vocabulary and past tense correctly' } },
      questions: [
        { type: 'multiple_choice', question: 'Which word means the opposite of ancient?', options: ['Modern', 'Old', 'Aged', 'Antique'], correctIndex: 0 },
        { type: 'multiple_choice', question: 'Which sentence uses the past tense?', options: ['She walked home', 'She walks home', 'She will walk home', 'She walking home'], correctIndex: 0 },
        { type: 'multiple_choice', question: 'Which word is a noun?', options: ['harbour', 'quickly', 'bright', 'gently'], correctIndex: 0 },
        { type: 'direct_answer', question: 'Write one sentence using the word ancient.', rubric: 'Award one point for correct meaning and one for a complete sentence.' },
      ],
    },
    {
      name: 'science with mixed units',
      payload: { subject: 'Science', plan: { title: 'Photosynthesis and the water cycle', objective: 'Explain photosynthesis and the water cycle' } },
      questions: [
        { type: 'multiple_choice', question: 'What is the main purpose of photosynthesis?', options: ['Producing food for the plant', 'Absorbing sound', 'Creating gravity', 'Cooling the soil'], correctIndex: 0 },
        { type: 'multiple_choice', question: 'How long does Earth take to orbit the Sun?', options: ['365 days', '30 days', '24 hours', '1 year'], correctIndex: 0 },
        { type: 'multiple_choice', question: 'At what temperature does water boil at sea level?', options: ['100°C', '90°C', '80°C', '50°C'], correctIndex: 0 },
        { type: 'direct_answer', question: 'Explain evaporation in your own words.', rubric: 'Award one point for liquid to gas and one for an example.' },
      ],
    },
    {
      name: 'history with dates',
      payload: { subject: 'Social Studies', plan: { title: 'World War II overview', objective: 'Sequence key events of World War II' } },
      questions: [
        { type: 'multiple_choice', question: 'When did World War II end?', options: ['1945', '1939', '1918', '1950'], correctIndex: 0 },
        { type: 'multiple_choice', question: 'Which statement about 1939 is correct?', options: ['World War II began in 1939', 'The moon landing happened in 1939', 'The Titanic sank in 1939', 'The Berlin Wall fell in 1939'], correctIndex: 0 },
        { type: 'multiple_choice', question: 'Who led Britain during most of World War II?', options: ['Winston Churchill', 'Napoleon', 'Julius Caesar', 'Nelson Mandela'], correctIndex: 0 },
        { type: 'direct_answer', question: 'Explain why dates help us study the past.', rubric: 'Award one point for ordering events and one for an example.' },
      ],
    },
    {
      name: 'fractions and decimals',
      payload: { subject: 'Mathematics', plan: { title: 'Fractions and decimals', objective: 'Compare fractions and decimals' } },
      questions: [
        { type: 'multiple_choice', question: 'Which fraction equals 0.75?', options: ['3/4', '2/3', '1/2', '4/5'], correctIndex: 0 },
        { type: 'multiple_choice', question: 'What fraction of the shape is shaded?', options: ['2/5', '1/5', '3/5', '4/5'], correctIndex: 0 },
        { type: 'multiple_choice', question: 'Which decimal is the greatest?', options: ['0.9', '0.09', '0.19', '0.099'], correctIndex: 0 },
        { type: 'direct_answer', question: 'Explain how to compare two fractions.', rubric: 'Award one point for a common method and one for an example.' },
      ],
    },
    {
      name: 'percentages',
      payload: { subject: 'Mathematics', plan: { title: 'Understanding percentages', objective: 'Calculate percentages of quantities' } },
      questions: [
        { type: 'multiple_choice', question: 'What is 25% of 80?', options: ['10%', '20%', '25%', '30%'], correctIndex: 1 },
        { type: 'multiple_choice', question: 'Which percentage is the largest?', options: ['45%', '5%', '0.5%', '95%'], correctIndex: 3 },
        { type: 'multiple_choice', question: 'Which decimal equals 50 percent?', options: ['0.5', '0.05', '0.25', '0.75'], correctIndex: 0 },
        { type: 'direct_answer', question: 'Explain what a percentage shows.', rubric: 'Award one point for parts per hundred and one for an example.' },
      ],
    },
    {
      name: 'monetary values',
      payload: { subject: 'Mathematics', plan: { title: 'Money and change', objective: 'Add money amounts and give change' } },
      questions: [
        { type: 'multiple_choice', question: 'How much did the item cost?', options: ['$5', '$10', '$15', '$20'], correctIndex: 0 },
        { type: 'multiple_choice', question: 'What is the price of two notebooks?', options: ['8 USD', '12 USD', '16 USD', '20 USD'], correctIndex: 2 },
        { type: 'multiple_choice', question: 'Which amount is greatest?', options: ['$40', '$14', '$25', '$31'], correctIndex: 0 },
        { type: 'direct_answer', question: 'Explain how to check change after buying two items.', rubric: 'Award one point for adding first and one for subtracting from the amount paid.' },
      ],
    },
    {
      name: 'measurement with approximations',
      payload: { subject: 'Science', plan: { title: 'Measuring matter', objective: 'Use metric units to measure volume and mass' } },
      questions: [
        { type: 'multiple_choice', question: 'About how many millilitres are in one litre?', options: ['about 100', 'about 500', 'about 1000', 'about 1500'], correctIndex: 2 },
        { type: 'multiple_choice', question: 'Which measurement is the longest?', options: ['1 km', '100 m', '10 cm', '1 m'], correctIndex: 0 },
        { type: 'multiple_choice', question: 'Which mass is the greatest?', options: ['5 kg', '500 g', '50 g', '2 kg'], correctIndex: 0 },
        { type: 'direct_answer', question: 'Explain why units matter when measuring.', rubric: 'Award one point for a clear reason and one for an example.' },
      ],
    },
  ];

  for (const scenario of scenarios) {
    it(`accepts a valid Gemini response for a ${scenario.name} lesson`, async () => {
      const response = makeResponse(scenario.questions);
      const fetchMock = vi.fn().mockImplementationOnce(async () => okResponse(JSON.stringify(response)));
      vi.stubGlobal('fetch', fetchMock);
      vi.stubGlobal('Deno', stubEnv());
      const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
      vi.spyOn(console, 'error').mockImplementation(() => {});

      const result = await handleRequest(generationRequest(lessonPayload(scenario.payload)));
      const body = await result.json();

      expect(result.status).toBe(200);
      expect(body.quizzes).toHaveLength(3);
      expect(body.quizzes.every((quiz: any) => quiz.questions.length === 4)).toBe(true);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      const providerBody = JSON.parse(String(fetchMock.mock.calls[0][1]?.body));
      expect(providerBody.generation_config.max_output_tokens).toBe(1_800);
      expect(providerBody.input.length).toBeLessThan(6_000);
      expect(logSpy).toHaveBeenCalledWith(
        '[generate-lesson-quizzes] validation metadata',
        expect.objectContaining({
          provider: 'gemini',
          model: 'gemini-3.6-flash',
          attempt: 1,
          httpStatus: 200,
          validJson: true,
          validationResult: 'passed',
          validationErrorCode: null,
          quizCount: 3,
          questionCounts: [4, 4, 4],
          promptChars: providerBody.input.length,
        }),
      );
    });
  }
});
