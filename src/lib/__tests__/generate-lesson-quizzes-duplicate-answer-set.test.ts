import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('https://deno.land/std@0.224.0/http/server.ts', () => ({
  serve: vi.fn(),
}));

import {
  buildCompactPrompt,
  buildRetryPrompt,
  duplicateAnswerSetDetail,
  duplicateAnswerSetRetryDetail,
  quizValidationErrorCode,
  quizValidationPath,
  quizValidationRule,
  targetedRetryCorrection,
  validateQuizResponse,
} from '../../../supabase/functions/generate-lesson-quizzes/index';
import type { DuplicateAnswerSetDetail } from '../../../supabase/functions/generate-lesson-quizzes/index';
import {
  quizValidationFailureHint,
  validateGeneratedResponse,
} from '../quizGenerationValidation';

// ── fixtures ────────────────────────────────────────────────────────────────

type McQuestion = { type: 'multiple_choice'; question: string; options: string[]; correctIndex: number };
type DaQuestion = { type: 'direct_answer'; question: string; rubric: string };
type Question = McQuestion | DaQuestion;
type Quiz = { title: string; questions: Question[] };

function fillerQuiz(variant: number): Quiz {
  const words = [
    'Mango', 'River', 'Lantern', 'Harbour', 'Cactus', 'Compass', 'Anvil', 'Pebble',
    'Meadow', 'Signal', 'Orchard', 'Thistle', 'Basalt', 'Lagoon', 'Summit', 'Drizzle',
    'Ember', 'Fjord', 'Grove', 'Hollow', 'Islet', 'Knoll', 'Marsh', 'Nimbus',
  ];
  const pick = (index: number) => words[(variant * 4 + index) % words.length];
  return {
    title: `Learning check ${variant}`,
    questions: [
      { type: 'multiple_choice', question: `Which meaning best fits the word "${pick(0)}" in set ${variant}?`, options: [`A calm ${pick(0)} scene`, `A loud ${pick(1)} scene`, `A wide ${pick(2)} field`, `A tall ${pick(3)} tower`], correctIndex: 0 },
      { type: 'multiple_choice', question: `Which sentence uses "${pick(1)}" correctly in set ${variant}?`, options: [`The ${pick(1)} shone over the bay`, `The ${pick(2)} ate its tail`, `The ${pick(3)} sang a note`, `The ${pick(0)} drove a car`], correctIndex: 0 },
      { type: 'multiple_choice', question: `Which pair belongs with "${pick(2)}" in set ${variant}?`, options: [`${pick(2)} and calm water`, `${pick(3)} and dry sand`, `${pick(0)} and sharp thorns`, `${pick(1)} and cold iron`], correctIndex: 0 },
      { type: 'direct_answer', question: `Explain in one sentence why "${pick(3)}" matters in set ${variant}.`, rubric: 'Award one point for a relevant reason and one for a clear example.' },
    ],
  };
}

function mc(question: string, options: string[], correctIndex = 0): McQuestion {
  return { type: 'multiple_choice', question, options, correctIndex };
}

function da(question: string, rubric: string): DaQuestion {
  return { type: 'direct_answer', question, rubric };
}

/** Quiz 1 carries the gas question whose option set later questions reuse. */
function gasQuizOne(): Quiz {
  return {
    title: 'Learning check 1',
    questions: [
      mc('Which gas do plants absorb to make food?', ['Carbon dioxide', 'Oxygen', 'Nitrogen', 'Helium']),
      mc('Which part of the plant takes in water?', ['Roots', 'Leaves', 'Flowers', 'Stems']),
      mc('What is the main idea of the passage?', ['The coast changes slowly over time', 'Fish live near reefs', 'Boats carry goods', 'Tides follow the moon']),
      da('Explain why sunlight matters to plants.', 'Award one point for energy for food-making and one for a clear example.'),
    ],
  };
}

/**
 * quizzes[1].questions[2] reuses quizzes[0].questions[0]'s option set — the
 * exact production retry failure path (validationPath quizzes[1].questions[2].options).
 */
function duplicateSetResponse(): { quizzes: Quiz[] } {
  const quizTwo: Quiz = {
    title: 'Learning check 2',
    questions: [
      fillerQuiz(2).questions[0] as Question,
      fillerQuiz(2).questions[1] as Question,
      mc('Which gas do people breathe out most?', ['Carbon dioxide', 'Oxygen', 'Nitrogen', 'Helium']),
      da('Explain in one sentence why breathing matters.', 'Award one point for a relevant reason and one for clear wording.'),
    ],
  };
  return { quizzes: [gasQuizOne(), quizTwo, fillerQuiz(7)] };
}

/** Same collision, but at quizzes[1].questions[0] — the first production log path. */
function duplicateSetAtFirstQuestionResponse(): { quizzes: Quiz[] } {
  const quizTwo: Quiz = {
    title: 'Learning check 2',
    questions: [
      mc('Which gas makes up most of the air people exhale?', ['Carbon dioxide', 'Oxygen', 'Nitrogen', 'Helium']),
      fillerQuiz(2).questions[1] as Question,
      fillerQuiz(2).questions[2] as Question,
      da('Explain in one sentence why fresh air matters.', 'Award one point for a relevant reason and one for clear wording.'),
    ],
  };
  return { quizzes: [gasQuizOne(), quizTwo, fillerQuiz(7)] };
}

/** Corrected second attempt: the repeating question gets its own option set. */
function fixedSetResponse(): { quizzes: Quiz[] } {
  const quizTwo: Quiz = {
    title: 'Learning check 2',
    questions: [
      fillerQuiz(2).questions[0] as Question,
      fillerQuiz(2).questions[1] as Question,
      mc('Which gas do people breathe out most?', ['Mostly nitrogen', 'Mostly argon', 'Mostly helium', 'Mostly hydrogen']),
      da('Explain in one sentence why breathing matters.', 'Award one point for a relevant reason and one for clear wording.'),
    ],
  };
  return { quizzes: [gasQuizOne(), quizTwo, fillerQuiz(7)] };
}

function outcome(input: unknown) {
  try {
    validateQuizResponse(input);
    return 'PASS';
  } catch (error) {
    return `FAIL ${quizValidationErrorCode(error)} @ ${quizValidationPath(error)}`;
  }
}

function lessonPayload() {
  return {
    plan: {
      class_name: 'Grade 6B',
      grade: '6',
      title: 'Photosynthesis and reading skills',
      objective: 'Explain photosynthesis and identify the main idea of a text',
      vocabulary: ['photosynthesis', 'main idea'],
    },
    subject: 'Science',
    periods: [{ subject: 'Science', topic: 'Photosynthesis', objective: 'Explain photosynthesis' }],
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

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

// ── validator semantics ─────────────────────────────────────────────────────

describe('DUPLICATE_ANSWER_SET semantics', () => {
  it('rejects two questions that reuse the same exact option set (production path quizzes[1].questions[2])', () => {
    expect(outcome(duplicateSetResponse())).toBe('FAIL DUPLICATE_ANSWER_SET @ quizzes[1].questions[2].options');
  });

  it('rejects the same collision at quizzes[1].questions[0] (first production log path)', () => {
    expect(outcome(duplicateSetAtFirstQuestionResponse())).toBe('FAIL DUPLICATE_ANSWER_SET @ quizzes[1].questions[0].options');
  });

  it('passes once the repeating question has its own option set', () => {
    expect(outcome(fixedSetResponse())).toBe('PASS');
  });

  it('rejects duplicate options inside ONE question as OPTION_SHAPE, not DUPLICATE_ANSWER_SET', () => {
    // Spec case: A="Paris" B="London" C="Paris" D="Rome" inside a single question.
    const quizOne: Quiz = {
      title: 'Learning check 1',
      questions: [
        mc('What is the capital of France?', ['Paris', 'London', 'Paris', 'Rome']),
        fillerQuiz(1).questions[1] as Question,
        fillerQuiz(1).questions[2] as Question,
        fillerQuiz(1).questions[3] as Question,
      ],
    };
    expect(outcome({ quizzes: [quizOne, fillerQuiz(5), fillerQuiz(6)] })).toBe('FAIL OPTION_SHAPE @ quizzes[0].questions[0].options');
  });

  it('rejects option sets that only differ by case, whitespace, or punctuation', () => {
    // " paris " / "LONDON" / "Rome." / "Madrid" normalize to the same set as
    // Paris/London/Rome/Madrid used by an earlier question.
    const quizOne: Quiz = {
      title: 'Learning check 1',
      questions: [
        mc('What is the capital of France?', ['Paris', 'London', 'Rome', 'Madrid']),
        fillerQuiz(1).questions[1] as Question,
        fillerQuiz(1).questions[2] as Question,
        fillerQuiz(1).questions[3] as Question,
      ],
    };
    const quizTwo: Quiz = {
      title: 'Learning check 2',
      questions: [
        fillerQuiz(3).questions[0] as Question,
        fillerQuiz(3).questions[1] as Question,
        mc('Which city stands on the River Seine?', [' paris ', 'LONDON', 'Rome.', 'Madrid']),
        fillerQuiz(3).questions[3] as Question,
      ],
    };
    expect(outcome({ quizzes: [quizOne, quizTwo, fillerQuiz(6)] })).toBe('FAIL DUPLICATE_ANSWER_SET @ quizzes[1].questions[2].options');
  });

  it('treats "$1" and "1" as the same normalized option value across questions', () => {
    // normalizeAssessmentText strips "$", so ["$1","$2","$3","$4"] and
    // ["1","2","3","4"] collapse to the same set — following the existing
    // validator's normalization, not new semantics.
    const quizOne: Quiz = {
      title: 'Learning check 1',
      questions: [
        mc('How much did the eraser cost at the school shop?', ['$1', '$2', '$3', '$4']),
        fillerQuiz(1).questions[1] as Question,
        fillerQuiz(1).questions[2] as Question,
        fillerQuiz(1).questions[3] as Question,
      ],
    };
    const quizTwo: Quiz = {
      title: 'Learning check 2',
      questions: [
        fillerQuiz(4).questions[0] as Question,
        fillerQuiz(4).questions[1] as Question,
        mc('How many rulers did Amal buy?', ['1', '2', '3', '4'], 1),
        fillerQuiz(4).questions[3] as Question,
      ],
    };
    expect(outcome({ quizzes: [quizOne, quizTwo, fillerQuiz(6)] })).toBe('FAIL DUPLICATE_ANSWER_SET @ quizzes[1].questions[2].options');
  });

  it('does NOT treat "1.0 kg" and "1 kg" as the same option set (existing normalization)', () => {
    // "1.0" normalizes to "1 0" (the dot is dropped), which differs from "1";
    // the numeric-duplicate case inside one question is covered separately by
    // NUMERIC_DISTRACTOR. Documents existing semantics; no invented rules.
    const quizOne: Quiz = {
      title: 'Learning check 1',
      questions: [
        mc('Which mass is the greatest?', ['5 kg', '500 g', '50 g', '2 kg']),
        fillerQuiz(1).questions[1] as Question,
        fillerQuiz(1).questions[2] as Question,
        fillerQuiz(1).questions[3] as Question,
      ],
    };
    const quizTwo: Quiz = {
      title: 'Learning check 2',
      questions: [
        fillerQuiz(4).questions[0] as Question,
        fillerQuiz(4).questions[1] as Question,
        mc('Which mass is the smallest?', ['1.0 kg', '2 kg', '3 kg', '4 kg']),
        fillerQuiz(4).questions[3] as Question,
      ],
    };
    expect(outcome({ quizzes: [quizOne, quizTwo, fillerQuiz(6)] })).toBe('PASS');
  });

  it('keeps the historical error contract (code, message, path) unchanged', () => {
    let caught: unknown;
    try {
      validateQuizResponse(duplicateSetResponse());
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toBe('Quiz 2 question 3 repeats an answer set from another question');
    expect(quizValidationErrorCode(caught)).toBe('DUPLICATE_ANSWER_SET');
    expect(quizValidationPath(caught)).toBe('quizzes[1].questions[2].options');
    expect(quizValidationRule(caught)).toBeNull();
  });
});

// ── collision detail capture ────────────────────────────────────────────────

describe('DUPLICATE_ANSWER_SET detail capture', () => {
  function caughtDetail(input: unknown): DuplicateAnswerSetDetail | null {
    try {
      validateQuizResponse(input);
    } catch (error) {
      return duplicateAnswerSetDetail(error);
    }
    return null;
  }

  it('captures both colliding questions (repeat + original) with bounded content', () => {
    const detail = caughtDetail(duplicateSetResponse());
    expect(detail).not.toBeNull();
    expect(detail).toEqual({
      repeatPath: 'quizzes[1].questions[2]',
      repeatQuestion: 'Which gas do people breathe out most?',
      repeatOptions: ['Carbon dioxide', 'Oxygen', 'Nitrogen', 'Helium'],
      originalPath: 'quizzes[0].questions[0]',
      originalQuestion: 'Which gas do plants absorb to make food?',
      originalOptions: ['Carbon dioxide', 'Oxygen', 'Nitrogen', 'Helium'],
    });
  });

  it('returns null for malformed or missing detail (shape-guarded accessor)', () => {
    expect(duplicateAnswerSetDetail(new Error('plain'))).toBeNull();
    expect(duplicateAnswerSetDetail({ duplicateAnswerSet: { repeatPath: 7 } })).toBeNull();
    expect(duplicateAnswerSetDetail({ duplicateAnswerSet: {
      repeatPath: 'quizzes[1].questions[2]',
      repeatQuestion: 'q',
      repeatOptions: ['a'],
      originalPath: 'quizzes[0].questions[0]',
      originalQuestion: 'q2',
      originalOptions: ['a', 'b', 'c', 'd', 'e'], // 5 options -> invalid
    } })).toBeNull();
    expect(duplicateAnswerSetDetail({ duplicateAnswerSet: {
      repeatPath: 'quizzes[1].questions[2]',
      repeatQuestion: 'q',
      repeatOptions: ['a', 'b', 'c', 'ok'],
      originalPath: 'quizzes[0].questions[0]',
      originalQuestion: 'q2',
      originalOptions: ['a', 'b', 'c', 42], // non-string option -> invalid
    } })).toBeNull();
  });

  it('bounds oversized content so the retry prompt budget cannot be blown', () => {
    const long = 'x'.repeat(5_000);
    const detail = duplicateAnswerSetDetail({ duplicateAnswerSet: {
      repeatPath: `quizzes[1].questions[2]${long}`,
      repeatQuestion: long,
      // Options are captured bounded at 200 chars; the accessor treats any
      // oversized option as invalid, so nothing oversized can reach the prompt.
      repeatOptions: ['ok', 'ok two', 'ok three', 'ok four'],
      originalPath: 'quizzes[0].questions[0]',
      originalQuestion: 'original',
      originalOptions: ['a', 'b', 'c', 'd'],
    } });
    expect(detail).not.toBeNull();
    expect(detail!.repeatPath.length).toBeLessThanOrEqual(120);
    expect(detail!.repeatQuestion.length).toBeLessThanOrEqual(300);
    expect(detail!.repeatOptions.every((option) => option.length <= 200)).toBe(true);

    // Oversized options are rejected outright (null), never truncated into the prompt.
    expect(duplicateAnswerSetDetail({ duplicateAnswerSet: {
      repeatPath: 'quizzes[1].questions[2]',
      repeatQuestion: 'q',
      repeatOptions: [long, 'a', 'b', 'c'],
      originalPath: 'quizzes[0].questions[0]',
      originalQuestion: 'q2',
      originalOptions: ['a', 'b', 'c', 'd'],
    } })).toBeNull();
  });
});

// ── targeted retry correction ───────────────────────────────────────────────

describe('targeted retry correction', () => {
  const detail: DuplicateAnswerSetDetail = {
    repeatPath: 'quizzes[1].questions[2]',
    repeatQuestion: 'Which gas do people breathe out most?',
    repeatOptions: ['Carbon dioxide', 'Oxygen', 'Nitrogen', 'Helium'],
    originalPath: 'quizzes[0].questions[0]',
    originalQuestion: 'Which gas do plants absorb to make food?',
    originalOptions: ['Carbon dioxide', 'Oxygen', 'Nitrogen', 'Helium'],
  };

  it('names the exact invalid question, its options, and the required correction', () => {
    const correction = targetedRetryCorrection('DUPLICATE_ANSWER_SET', detail);
    expect(correction).toContain('VALIDATION FEEDBACK FOR THIS RETRY ATTEMPT');
    expect(correction).toContain('TARGETED REPAIR');
    expect(correction).toContain('quizzes[1].questions[2]');
    expect(correction).toContain('quizzes[0].questions[0]');
    expect(correction).toContain('Which gas do people breathe out most?');
    expect(correction).toContain('A. Carbon dioxide');
    expect(correction).toContain('D. Helium');
    expect(correction).toContain('Required correction');
    expect(correction).toContain("Preserve the question's topic and the correct answer's meaning");
    expect(correction).toContain('Do not change unrelated questions');
    expect(correction).toContain('Do not repeat normalized option text');
  });

  it('still gives the strengthened general correction when no detail is available', () => {
    const correction = targetedRetryCorrection('DUPLICATE_ANSWER_SET', null);
    expect(correction).toContain('DUPLICATE_ANSWER_SET');
    expect(correction).toContain('every multiple-choice question has its OWN option set');
    expect(correction).not.toContain('TARGETED REPAIR');
  });

  it('leaves other error codes\u2019 corrections untouched', () => {
    const correction = targetedRetryCorrection('NUMERIC_DISTRACTOR', detail);
    expect(correction).toContain('NUMERIC_DISTRACTOR');
    expect(correction).not.toContain('TARGETED REPAIR');
    expect(correction).not.toContain('Carbon dioxide');
  });

  it('renders options A–D and both question paths in the repair block', () => {
    const block = duplicateAnswerSetRetryDetail(detail);
    expect(block).toContain('A. Carbon dioxide\nB. Oxygen\nC. Nitrogen\nD. Helium');
    expect(block).toContain('Repeating question at quizzes[1].questions[2]');
    expect(block).toContain('exact option set of the earlier question at quizzes[0].questions[0]');
    expect(block).toContain('Return the complete corrected quiz set as JSON only.');
  });

  it('stays within the hard retry prompt budget', () => {
    const basePrompt = buildCompactPrompt(lessonPayload());
    const retryPrompt = buildRetryPrompt(
      basePrompt,
      lessonPayload(),
      targetedRetryCorrection('DUPLICATE_ANSWER_SET', detail),
    );
    expect(retryPrompt).toContain('TARGETED REPAIR');
    expect(retryPrompt.length).toBeLessThanOrEqual(8_000);
  });

  it('stays within budget even when the base prompt is at the hard ceiling', () => {
    // Force the compact-fallback path: pretend the base prompt nearly hits 8,000.
    const hugePayload = lessonPayload();
    hugePayload.plan.objective = 'Explain photosynthesis and the water cycle in detail '.repeat(80).trim();
    hugePayload.periods = Array.from({ length: 12 }, (_, index) => ({
      subject: 'Science',
      topic: `Topic ${index} ${'plant biology photosynthesis chlorophyll glucose sunlight '.repeat(8)}`.trim(),
      objective: `Objective ${index}`,
    }));
    const basePrompt = buildCompactPrompt(hugePayload);
    expect(basePrompt.length).toBeLessThanOrEqual(8_000);
    const retryPrompt = buildRetryPrompt(
      basePrompt,
      hugePayload,
      targetedRetryCorrection('DUPLICATE_ANSWER_SET', detail),
    );
    expect(retryPrompt.length).toBeLessThanOrEqual(8_000);
    expect(retryPrompt).toContain('TARGETED REPAIR');
  });
});

// ── proactive prompt rule ───────────────────────────────────────────────────

describe('generation prompt duplicate-set rule', () => {
  it('instructs the model up front that option sets must be unique', () => {
    const prompt = buildCompactPrompt(lessonPayload());
    expect(prompt).toContain('Give every question its OWN four options');
    expect(prompt).toContain('no two questions may share the same set of four options');
    // Prompt stays under the 6,000-char target.
    expect(prompt.length).toBeLessThan(6_000);
  });
});

// ── edge/client consistency ─────────────────────────────────────────────────

describe('edge and client validators agree', () => {
  it('client mirror rejects the same collision with the same meaning', () => {
    expect(() => validateGeneratedResponse(duplicateSetResponse())).toThrow(
      'Quiz 2 question 3 repeats an answer set from another question',
    );
    expect(() => validateGeneratedResponse(fixedSetResponse())).not.toThrow();
  });
});

// ── end-to-end targeted repair ──────────────────────────────────────────────

describe('end-to-end DUPLICATE_ANSWER_SET targeted repair', () => {
  it('rejects the duplicate set, retries with the exact colliding questions, then succeeds', async () => {
    const { handleRequest } = await import('../../../supabase/functions/generate-lesson-quizzes/index');
    const fetchMock = vi.fn()
      .mockImplementationOnce(async () => okResponse(JSON.stringify(duplicateSetResponse())))
      .mockImplementationOnce(async () => okResponse(JSON.stringify(fixedSetResponse())));
    vi.stubGlobal('fetch', fetchMock);
    vi.stubGlobal('Deno', { env: { get: (name: string) => name === 'GEMINI_API_KEY' ? 'gemini-key' : undefined } });
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const response = await handleRequest(generationRequest(lessonPayload()));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const bodies = fetchMock.mock.calls.map((call) => JSON.parse(String(call[1]?.body)));
    expect(bodies.map((b) => b.model)).toEqual(['gemini-3.6-flash', 'gemini-3.5-flash-lite']);
    expect(bodies[0].input).not.toContain('VALIDATION FEEDBACK');
    // The retry is genuinely targeted: it names the exact invalid question and
    // options, and what the model must do about them.
    expect(bodies[1].input).toContain('VALIDATION FEEDBACK FOR THIS RETRY ATTEMPT');
    expect(bodies[1].input).toContain('TARGETED REPAIR');
    expect(bodies[1].input).toContain('DUPLICATE_ANSWER_SET');
    expect(bodies[1].input).toContain('quizzes[1].questions[2]');
    expect(bodies[1].input).toContain('quizzes[0].questions[0]');
    expect(bodies[1].input).toContain('Which gas do people breathe out most?');
    expect(bodies[1].input).toContain('A. Carbon dioxide');
    expect(bodies[1].input).toContain('Do not change unrelated questions');
    expect(bodies[1].input.length).toBeLessThanOrEqual(8_000);

    // Attempt 1 fails with the exact production diagnostic shape.
    expect(errorSpy).toHaveBeenCalledWith(
      '[generate-lesson-quizzes] validation metadata',
      expect.objectContaining({
        provider: 'gemini',
        model: 'gemini-3.6-flash',
        strategy: 'initial',
        attempt: 1,
        httpStatus: 200,
        validJson: true,
        validationResult: 'failed',
        validationErrorCode: 'DUPLICATE_ANSWER_SET',
        validationPath: 'quizzes[1].questions[2].options',
        quizCount: 3,
        questionCounts: [4, 4, 4],
      }),
    );
    expect(logSpy).toHaveBeenCalledWith(
      '[generate-lesson-quizzes] validation metadata',
      expect.objectContaining({
        model: 'gemini-3.5-flash-lite',
        strategy: 'targeted_retry',
        attempt: 2,
        validationResult: 'passed',
      }),
    );
    expect(body.quizzes).toHaveLength(3);

    // The colliding-question excerpt goes to the provider only — never to logs.
    const allLogOutput = JSON.stringify([...errorSpy.mock.calls, ...logSpy.mock.calls]);
    expect(allLogOutput).not.toContain('Carbon dioxide');
    expect(allLogOutput).not.toContain('Which gas do people breathe out most?');
    expect(allLogOutput).not.toContain('TARGETED REPAIR');
  });

  it('returns INVALID_QUIZ_RESPONSE and never the invalid quiz when retry also duplicates', async () => {
    const { handleRequest } = await import('../../../supabase/functions/generate-lesson-quizzes/index');
    const fetchMock = vi.fn().mockImplementation(async () => okResponse(JSON.stringify(duplicateSetResponse())));
    vi.stubGlobal('fetch', fetchMock);
    vi.stubGlobal('Deno', { env: { get: (name: string) => name === 'GEMINI_API_KEY' ? 'gemini-key' : undefined } });
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const response = await handleRequest(generationRequest(lessonPayload()));
    const body = await response.json();

    expect(response.status).toBe(502);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(body).toEqual(expect.objectContaining({
      code: 'QUIZ_GENERATION_FAILED',
      provider: 'all',
      validationErrorCode: 'DUPLICATE_ANSWER_SET',
    }));
    expect(body.quizzes).toBeUndefined();
    // Both attempts failed the same way, and the second prompt was targeted too.
    const bodies = fetchMock.mock.calls.map((call) => JSON.parse(String(call[1]?.body)));
    expect(bodies[1].input).toContain('TARGETED REPAIR');
    expect(errorSpy).toHaveBeenCalledWith(
      '[generate-lesson-quizzes] failed all providers',
      expect.objectContaining({
        errorCode: 'INVALID_QUIZ_RESPONSE',
        failurePhase: 'QUIZ_SEMANTIC_INVALID',
        validationErrorCode: 'DUPLICATE_ANSWER_SET',
        totalProviderAttempts: 2,
      }),
    );
    // No generated content leaks into logs or the error body.
    const allOutput = JSON.stringify([...errorSpy.mock.calls, body]);
    expect(allOutput).not.toContain('Carbon dioxide');
    expect(allOutput).not.toContain('Which gas do people breathe out most?');

    // The user-facing hint derived from the body explains the real cause.
    const hint = quizValidationFailureHint(JSON.stringify(body));
    expect(hint).toContain('reused the same answer options for more than one question');
  });
});
