import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('https://deno.land/std@0.224.0/http/server.ts', () => ({
  serve: vi.fn(),
}));

import {
  buildCompactPrompt,
  buildRetryPrompt,
  quizValidationErrorCode,
  quizValidationPath,
  quizValidationRule,
  targetedRetryCorrection,
  validateQuizResponse,
} from '../../../supabase/functions/generate-lesson-quizzes/index';
import {
  quizValidationFailureHint,
  validateGeneratedResponse,
} from '../quizGenerationValidation';

// ── fixtures ────────────────────────────────────────────────────────────────

type McQuestion = { type: 'multiple_choice'; question: string; options: string[]; correctIndex: number };
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

function responseWithQuizOne(quizOne: { title: string; questions: Question[] }) {
  return { quizzes: [quizOne, fillerQuiz(5), fillerQuiz(6)] };
}

/** Places the given question at quizzes[0].questions[1] — the production path. */
function responseWithSecondQuestion(question: Question) {
  const quizOne = {
    title: 'Learning check 1',
    questions: [fillerQuiz(1).questions[0] as Question, question, fillerQuiz(1).questions[2] as Question, fillerQuiz(1).questions[3] as Question],
  };
  return responseWithQuizOne(quizOne);
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
    periods: [
      { subject: 'Science', topic: 'Photosynthesis', objective: 'Explain how plants make food' },
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

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

// ── semantic classifier ─────────────────────────────────────────────────────

describe('FORBIDDEN_CONTEXT semantic classifier', () => {
  it('rejects real teacher-delivery questions (spec MUST-FAIL set)', () => {
    expect(outcome(responseWithSecondQuestion(mc(
      'Which strategy should the teacher use to teach this concept?',
      ['A think-pair-share discussion', 'A silent test', 'A field trip', 'A film night'],
    )))).toMatch(/^FAIL FORBIDDEN_CONTEXT/);
    expect(outcome(responseWithSecondQuestion(mc(
      'What should the teacher do next in the lesson?',
      ['Check understanding with questions', 'Go home early', 'Mark other books', 'Start a new topic'],
    )))).toMatch(/^FAIL FORBIDDEN_CONTEXT/);
    expect(outcome(responseWithSecondQuestion(mc(
      'Which classroom activity should the teacher prepare?',
      ['A group sorting game', 'A test', 'Nothing', 'A trip'],
    )))).toMatch(/^FAIL FORBIDDEN_CONTEXT/);
  });

  it('rejects real teacher-resource and lesson-artifact questions', () => {
    expect(outcome(responseWithSecondQuestion(mc(
      'Which resource should the teacher use?',
      ['The projector', 'A workbook', 'Chalk', 'Nothing'],
    )))).toMatch(/^FAIL FORBIDDEN_CONTEXT/);
    expect(outcome(responseWithSecondQuestion(mc(
      'Which teaching resource belongs in this lesson?',
      ['The fraction wall', 'A ruler', 'A globe', 'A timer'],
    )))).toMatch(/^FAIL FORBIDDEN_CONTEXT/);
    expect(outcome(responseWithSecondQuestion(mc(
      'Which page of the workbook has the practice questions?',
      ['Page 12', 'Page 3', 'Page 40', 'The cover'],
    )))).toMatch(/^FAIL FORBIDDEN_CONTEXT/);
    expect(outcome(responseWithSecondQuestion(mc(
      'Which worksheet should students complete for homework?',
      ['The fractions sheet', 'The reading log', 'Both', 'Neither'],
    )))).toMatch(/^FAIL FORBIDDEN_CONTEXT/);
  });

  it('rejects subtly worded instructional-planning questions without the word teacher', () => {
    expect(outcome(responseWithSecondQuestion(mc(
      'What comes next in the lesson after the warm-up?',
      ['Guided practice', 'Home time', 'Lunch', 'Assembly'],
    )))).toMatch(/^FAIL FORBIDDEN_CONTEXT/);
    expect(outcome(responseWithSecondQuestion(mc(
      'How should this lesson be delivered?',
      ['In small groups', 'Outdoors', 'Online', 'By a visitor'],
    )))).toMatch(/^FAIL FORBIDDEN_CONTEXT/);
    expect(outcome(responseWithSecondQuestion(mc(
      'Which lesson-plan step follows the introduction?',
      ['Independent practice', 'Dismissal', 'Registration', 'Break duty'],
    )))).toMatch(/^FAIL FORBIDDEN_CONTEXT/);
  });

  it('accepts pure student science and reading questions (spec MUST-PASS set)', () => {
    expect(outcome(responseWithSecondQuestion(mc(
      'Why does photosynthesis require sunlight?',
      ['It powers the making of food', 'It cools the leaves', 'It colours flowers', 'It waters roots'],
    )))).toBe('PASS');
    expect(outcome(responseWithSecondQuestion(mc(
      'Which process allows plants to make food?',
      ['Photosynthesis', 'Respiration', 'Erosion', 'Condensation'],
    )))).toBe('PASS');
    expect(outcome(responseWithSecondQuestion(mc(
      'What happens when water changes from liquid to gas?',
      ['It evaporates', 'It freezes', 'It snows', 'It melts'],
    )))).toBe('PASS');
    expect(outcome(responseWithSecondQuestion(mc(
      'Which example best demonstrates evaporation?',
      ['A puddle drying in the sun', 'Ice forming on a lake', 'Fog rolling in', 'Rain falling'],
    )))).toBe('PASS');
    expect(outcome(responseWithSecondQuestion(mc(
      'Why is chlorophyll important to plants?',
      ['It captures light energy', 'It absorbs sound', 'It stores water', 'It makes roots grow'],
    )))).toBe('PASS');
    expect(outcome(responseWithSecondQuestion(mc(
      'What is the main idea of the passage?',
      ['The coast changes slowly over time', 'Fish live near reefs', 'Boats carry goods', 'Tides follow the moon'],
    )))).toBe('PASS');
    expect(outcome(responseWithSecondQuestion(mc(
      'Which evidence supports the author\'s conclusion?',
      ['Rocks appear smaller each year', 'The beach has ice cream vans', 'Tourists visit in summer', 'The town is very old'],
    )))).toBe('PASS');
  });

  it('accepts student questions that mention experiment, lesson, activity, example, or classroom', () => {
    expect(outcome(responseWithSecondQuestion(mc(
      'What does the experiment demonstrate?',
      ['That warm air rises', 'That water freezes', 'That paper burns', 'That glass bends'],
    )))).toBe('PASS');
    expect(outcome(responseWithSecondQuestion(mc(
      'Which idea from this lesson explains why summer days are longer?',
      ['Earth tilts on its axis', 'The moon moves faster', 'Clouds block the sun', 'Nights are warmer'],
    )))).toBe('PASS');
    expect(outcome(responseWithSecondQuestion(mc(
      'Which activity produces glucose in a plant?',
      ['Photosynthesis', 'Respiration', 'Erosion', 'Condensation'],
    )))).toBe('PASS');
    expect(outcome(responseWithSecondQuestion(mc(
      'Which classroom example best demonstrates Newton\'s third law?',
      ['A rocket pushing gas down to rise', 'A ball rolling downhill', 'A lamp glowing', 'Ice melting in water'],
    )))).toBe('PASS');
  });

  it('accepts a teacher mentioned inside content the student analyses', () => {
    // Story comprehension: the teacher is a character, not the delivery agent.
    expect(outcome(responseWithSecondQuestion(mc(
      'What did the teacher in the story discover about the missing telescope?',
      ['It was hidden in the attic', 'It was never built', 'It belonged to the school', 'It was a gift'],
    )))).toBe('PASS');
    // Speculative science reasoning, not pedagogy.
    expect(outcome(responseWithSecondQuestion(mc(
      'Why might a teacher observe this chemical reaction?',
      ['It produces a striking colour change', 'It costs a lot of money', 'It happens very slowly in nature', 'It needs two people'],
    )))).toBe('PASS');
    // Historical/social-studies content about the role of teachers.
    expect(outcome(responseWithSecondQuestion(mc(
      'In the story, why does the village teacher visit every home?',
      ['To bring news to families', 'To sell books', 'To count the houses', 'To mend the roof'],
    )))).toBe('PASS');
  });

  it('still lets learning objectives allow otherwise-forbidden wording', () => {
    const response = responseWithSecondQuestion(mc(
      'What does a teacher do in our community?',
      ['Helps people learn', 'Fixes cars', 'Sells fruit', 'Drives buses'],
    ));
    expect(outcome(response)).toMatch(/^FAIL FORBIDDEN_CONTEXT/);
    try {
      validateQuizResponse(response, 3, 4, 1, {
        learningObjectives: ['Describe the role of the teacher in our community'],
      });
      expect(true).toBe(true);
    } catch (error) {
      throw new Error(`objective escape no longer works: ${quizValidationErrorCode(error)}`);
    }
  });

  it('classifies the exact production-style failure path with a rule id', () => {
    const input = responseWithSecondQuestion(mc(
      'Which strategy should the teacher use to teach this concept?',
      ['A think-pair-share discussion', 'A silent test', 'A field trip', 'A film night'],
    ));
    try {
      validateQuizResponse(input);
      throw new Error('expected FORBIDDEN_CONTEXT');
    } catch (error) {
      expect(quizValidationErrorCode(error)).toBe('FORBIDDEN_CONTEXT');
      expect(quizValidationPath(error)).toBe('quizzes[0].questions[1]');
      expect(quizValidationRule(error)).toBe('teacher-delivery-agent');
    }
  });

  it('keeps the edge and client validators consistent on the same inputs', () => {
    const cases: Array<[string, Question, 'PASS' | 'FORBIDDEN']> = [
      ['delivery', mc('What should the teacher do next in the lesson?', ['Check understanding', 'Go home', 'Mark books', 'Stop']), 'FORBIDDEN'],
      ['story teacher', mc('What did the teacher in the story discover?', ['It was hidden', 'It broke', 'It was sold', 'It vanished']), 'PASS'],
      ['natural resource', mc('Which natural resource do plants need to make food?', ['Sunlight', 'Plastic', 'Iron', 'Concrete']), 'PASS'],
      ['passage', mc('What is the main idea of the passage?', ['The coast changes over time', 'Fish live near reefs', 'Boats carry goods', 'Tides follow the moon']), 'PASS'],
      ['teaching resource', mc('Which teaching resource fits this lesson?', ['The fraction wall', 'A globe', 'A timer', 'A ruler']), 'FORBIDDEN'],
    ];
    for (const [name, question, expected] of cases) {
      const input = responseWithSecondQuestion(question);
      const edge = outcome(input) === 'PASS' ? 'PASS' : `FAIL ${quizValidationErrorCodeFromOutcome(input)}`;
      let client: string;
      try {
        validateGeneratedResponse(JSON.parse(JSON.stringify(input)));
        client = 'PASS';
      } catch {
        client = 'FAIL FORBIDDEN';
      }
      expect(edge.startsWith(expected === 'PASS' ? 'PASS' : 'FAIL FORBIDDEN'), `${name}: edge=${edge}`).toBe(true);
      expect(client, `${name}: client=${client}`).toBe(expected === 'PASS' ? 'PASS' : 'FAIL FORBIDDEN');
    }
  });

  function quizValidationErrorCodeFromOutcome(input: unknown): string {
    try {
      validateQuizResponse(input);
      return 'NONE';
    } catch (error) {
      return quizValidationErrorCode(error);
    }
  }
});

// ── unrelated protections must remain intact ────────────────────────────────

describe('unrelated validation stays intact', () => {
  it('still enforces duplicate answer sets, numeric distractors, and arithmetic', () => {
    // Duplicate answer set across quizzes.
    const duplicateSet = responseWithQuizOne({
      title: 'Learning check 1',
      questions: [
        fillerQuiz(5).questions[0] as Question,
        mc('Which word means the opposite of ancient?', ['Modern', 'Old', 'Aged', 'Antique']),
        fillerQuiz(1).questions[2] as Question,
        fillerQuiz(1).questions[3] as Question,
      ],
    });
    (duplicateSet.quizzes[0] as any).questions[1] = {
      ...(duplicateSet.quizzes[0] as any).questions[1],
      options: [...((fillerQuiz(5).questions[0] as McQuestion).options)],
    };
    expect(outcome(duplicateSet)).toMatch(/^FAIL DUPLICATE_ANSWER_SET/);

    // Numeric distractor on a conceptual question.
    expect(outcome(responseWithSecondQuestion(mc(
      'What is evaporation?',
      ['The change from liquid to gas', '45', '100', '27'],
    )))).toMatch(/^FAIL NUMERIC_DISTRACTOR/);

    // Arithmetic integrity: solved value present and indexed → passes;
    // correctIndex pointing elsewhere → ARITHMETIC_ANSWER.
    expect(outcome(responseWithSecondQuestion(mc(
      'What is 31 + 12?',
      ['43', '42', '44', '53'],
    )))).toBe('PASS');
    expect(outcome(responseWithSecondQuestion(mc(
      'What is 31 + 12?',
      ['42', '43', '44', '53'],
    )))).toMatch(/^FAIL ARITHMETIC_ANSWER/);
  });
});

// ── prompt + targeted retry ─────────────────────────────────────────────────

describe('FORBIDDEN_CONTEXT prompt and targeted retry', () => {
  it('keeps the prompt contract explicit about student vs teacher actions within budget', () => {
    const prompt = buildCompactPrompt(lessonPayload() as any);
    expect(prompt).toContain('NEVER ask about the teacher');
    expect(prompt).toContain("the teacher's job or choices");
    expect(prompt).toContain('Questions assess the STUDENT, never the delivery of the lesson');
    expect(prompt).toContain('Which activity produces glucose in a plant?');
    expect(prompt).toContain('What is the main idea of the passage?');
    expect(prompt.length).toBeLessThan(6_000);
    expect(prompt.length).toBeLessThanOrEqual(8_000);
  });

  it('builds a changed, explicit retry prompt bounded by the hard limit', () => {
    const correction = targetedRetryCorrection('FORBIDDEN_CONTEXT');
    expect(correction).toContain('teacher-facing or instructional-delivery question');
    expect(correction).toContain('Regenerate the ENTIRE quiz set');
    expect(correction).toContain('Do NOT ask about teacher actions, lesson delivery, teaching strategies or methods');
    expect(correction).toContain('A question MAY mention an experiment, activity, demonstration, lesson, classroom example, or resource');
    expect(correction).toContain('completely fresh one');

    const base = buildCompactPrompt(lessonPayload() as any);
    const retry = buildRetryPrompt(base, lessonPayload() as any, correction);
    expect(retry).not.toBe(base);
    expect(retry).toContain('VALIDATION FEEDBACK FOR THIS RETRY ATTEMPT');
    expect(retry.length).toBeLessThanOrEqual(8_000);
  });
});

// ── user-facing error mapping ───────────────────────────────────────────────

describe('user-facing failure hints', () => {
  it('names the actual cause instead of always blaming duplicate options', () => {
    const forbidden = quizValidationFailureHint(
      'Edge Function returned a non-2xx status code: Quiz generation returned invalid structured output · FORBIDDEN_CONTEXT · QUIZ_GENERATION_FAILED · all',
    );
    expect(forbidden).toContain('teacher or lesson-delivery content');
    expect(forbidden).not.toContain('duplicate');

    const duplicates = quizValidationFailureHint('... · DUPLICATE_ANSWER_SET · QUIZ_GENERATION_FAILED · all');
    expect(duplicates).toContain('reused the same answer options for more than one question');

    const numeric = quizValidationFailureHint('... · NUMERIC_DISTRACTOR · QUIZ_GENERATION_FAILED · all');
    expect(numeric).toContain('numeric');

    expect(quizValidationFailureHint('Function timed out')).toBeNull();
    expect(quizValidationFailureHint(null)).toBeNull();
  });
});

// ── end-to-end retry behaviour ──────────────────────────────────────────────

describe('end-to-end FORBIDDEN_CONTEXT retry', () => {
  it('rejects the first response, retries with a targeted prompt, then succeeds', async () => {
    const { handleRequest } = await import('../../../supabase/functions/generate-lesson-quizzes/index');
    const invalid = responseWithSecondQuestion(mc(
      'Which strategy should the teacher use to teach this concept?',
      ['A think-pair-share discussion', 'A silent test', 'A field trip', 'A film night'],
    ));
    const valid = responseWithSecondQuestion(mc(
      'Why does photosynthesis require sunlight?',
      ['It powers the making of food', 'It cools the leaves', 'It colours flowers', 'It waters roots'],
    ));
    const fetchMock = vi.fn()
      .mockImplementationOnce(async () => okResponse(JSON.stringify(invalid)))
      .mockImplementationOnce(async () => okResponse(JSON.stringify(valid)));
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
    expect(bodies[1].input).toContain('VALIDATION FEEDBACK FOR THIS RETRY ATTEMPT');
    expect(bodies[1].input).toContain('teacher-facing or instructional-delivery question');
    expect(bodies[1].input).toContain('Do NOT ask about teacher actions');
    expect(bodies[1].input.length).toBeLessThanOrEqual(8_000);

    expect(errorSpy).toHaveBeenCalledWith(
      '[generate-lesson-quizzes] validation metadata',
      expect.objectContaining({
        provider: 'gemini',
        model: 'gemini-3.6-flash',
        attempt: 1,
        httpStatus: 200,
        validJson: true,
        validationResult: 'failed',
        validationErrorCode: 'FORBIDDEN_CONTEXT',
        validationPath: 'quizzes[0].questions[1]',
        validationRule: 'teacher-delivery-agent',
        failurePhase: 'QUIZ_SEMANTIC_INVALID',
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
  });

  it('reports a clear FORBIDDEN_CONTEXT diagnostic (never a duplicate-answer claim) when retry also fails', async () => {
    const { handleRequest } = await import('../../../supabase/functions/generate-lesson-quizzes/index');
    const invalid = responseWithSecondQuestion(mc(
      'Which resource should the teacher use?',
      ['The projector', 'A workbook', 'Chalk', 'Nothing'],
    ));
    const fetchMock = vi.fn().mockImplementation(async () => okResponse(JSON.stringify(invalid)));
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
      validationErrorCode: 'FORBIDDEN_CONTEXT',
    }));
    // The user-facing hint derived from this body must not blame duplicates.
    const hint = quizValidationFailureHint(JSON.stringify(body));
    expect(hint).toContain('teacher or lesson-delivery content');
    expect(hint).not.toContain('duplicate');
    expect(errorSpy).toHaveBeenCalledWith(
      '[generate-lesson-quizzes] failed all providers',
      expect.objectContaining({
        errorCode: 'INVALID_QUIZ_RESPONSE',
        failurePhase: 'QUIZ_SEMANTIC_INVALID',
        validationErrorCode: 'FORBIDDEN_CONTEXT',
        validationRule: 'teacher-delivery-agent',
        totalProviderAttempts: 2,
      }),
    );
    // No generated content leaks into logs.
    expect(JSON.stringify(errorSpy.mock.calls)).not.toContain('think-pair-share');
    expect(JSON.stringify(errorSpy.mock.calls)).not.toContain('Which resource should the teacher');
  });
});
