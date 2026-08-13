// @ts-ignore -- this HTTPS module is resolved by the Deno Edge runtime.
import { serve } from 'https://deno.land/std@0.224.0/http/server.ts';

const GEMINI_API_URL = 'https://generativelanguage.googleapis.com/v1beta/interactions';
const GEMINI_36_MODEL = 'gemini-3.6-flash';
const GEMINI_35_LITE_MODEL = 'gemini-3.5-flash-lite';
// Production timings ranged from 18–82 seconds. Forty-five seconds retains the
// normal 18–40 second path while preventing one pathological generation call
// from consuming the worker for the full 82-second outlier.
const AI_ATTEMPT_TIMEOUT_MS = 45_000;
const WALL_CLOCK_BUDGET_MS = 75_000;
// Gemini 3.6 may use the request budget except for the final 15 seconds reserved
// for Gemini 3.5 Flash-Lite.
const FINAL_GOOGLE_ATTEMPT_RESERVED_BUDGET_MS = 15_000;

// The request-global schedule is Gemini 3.6 → Gemini 3.5 Flash-Lite. There are
// no duplicate transport or structural retries.
const MAX_PROVIDER_ATTEMPTS_PER_REQUEST = 2;
export const PROVIDER_MAX_TOKENS = 1800;
const MAX_REQUEST_BYTES = 250_000;
const MAX_RESPONSE_BYTES_WARN = 50_000;
const MAX_CONTEXT_CHARS = 3_700;
const MAX_PROMPT_CHARS = 8_000;
const TARGET_PROMPT_CHARS = 6_000;

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

interface GeneratePayload {
  plan: Record<string, unknown>;
  subject: string;
  quiz_count?: number;
  questions_per_quiz?: number;
  direct_answer_min?: number;
  periods: Array<Record<string, unknown>>;
}

interface RequestDiagnostics {
  startedAt: number;
  providerAttempts: number;
}

interface ProviderOutput {
  raw: string;
  finishReason: string | null;
  attempt: number;
  latencyMs: number;
}

interface ParsedCandidate {
  value: unknown;
  responseChars: number;
  responseBytes: number;
  attempt: number;
  latencyMs: number;
}

type GenerationStrategy = 'initial';
type ProviderName = 'gemini';

export interface QuizShapeDiagnostics {
  quizCount: number | null;
  questionCounts: Array<number | null>;
}

interface GeneratedMultipleChoice {
  type: 'multiple_choice';
  question: string;
  options: string[];
  correctIndex: number;
  explanation: string;
}

interface GeneratedDirectAnswer {
  type: 'direct_answer';
  question: string;
  rubric: string;
}

type GeneratedQuestion = GeneratedMultipleChoice | GeneratedDirectAnswer;
interface GeneratedQuiz { title: string; questions: GeneratedQuestion[] }
export interface GeneratedQuizResponse { quizzes: GeneratedQuiz[] }

export function errorMessage(err: unknown): string {
  if (err instanceof Error) return `${err.name}: ${err.message}`;
  return String(err);
}

function diagnosticErrorCode(err: unknown): string {
  const code = (err as { code?: unknown })?.code;
  if (typeof code === 'string' && code) return code.slice(0, 80);
  return err instanceof Error ? err.name.slice(0, 80) : 'UNKNOWN_ERROR';
}

/** Milliseconds left before the overall request budget expires (never negative). */
function remainingMs(deadline: number): number {
  return Math.max(0, deadline - Date.now());
}

export function strip(value: string | null | undefined): string {
  return (value || '').replace(/\s+/g, ' ').trim();
}

/** Serialize the final body once, then reuse the same string for measurement and response. */
export function returnResponse(
  data: unknown,
  status = 200,
  init?: ResponseInit,
  diagnostics?: RequestDiagnostics,
): Response {
  const serialized = typeof data === 'string' ? data : JSON.stringify(data);
  const responseBytes = new TextEncoder().encode(serialized).byteLength;
  const executionMs = diagnostics ? Date.now() - diagnostics.startedAt : undefined;
  const totalProviderAttempts = diagnostics?.providerAttempts;

  console.log({ responseBytes, executionMs, totalProviderAttempts });
  if (responseBytes > MAX_RESPONSE_BYTES_WARN) {
    console.warn('[generate-lesson-quizzes] warning: unexpectedly large response size', { responseBytes });
  }

  return new Response(serialized, {
    status,
    ...init,
    headers: { ...CORS_HEADERS, 'Content-Type': 'application/json', ...init?.headers },
  });
}

// ── Validation (mirrors src/lib/quizGenerationValidation.ts) ───────────────
export interface QuizQualityContext {
  learningObjectives?: Array<string | null | undefined>;
}

function normalizeAssessmentText(value: string): string {
  return strip(value)
    .normalize('NFKC')
    .toLowerCase()
    .replace(/^\s*(?:question|q)\s*\d+[.):\-]?\s*/i, '')
    // Keep arithmetic operators: 12 + 3 and 12 - 3 are not duplicates.
    .replace(/[^\p{L}\p{N}+*×÷/=-]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function validateGeneratedQuizStructure(input: any, questionsPerQuiz: number, directAnswerMin: number): void {
  if (typeof input?.title !== 'string' || !strip(input.title)) {
    throw new Error('Generated quiz is missing a title');
  }
  if (!Array.isArray(input.questions) || input.questions.length !== questionsPerQuiz) {
    throw new Error(`Generated quiz must contain exactly ${questionsPerQuiz} questions`);
  }

  const seen = new Set<string>();
  let directCount = 0;
  input.questions.forEach((q: any, index: number) => {
    if (typeof q?.question !== 'string') throw new Error(`Question ${index + 1} is missing question text`);
    const normalized = normalizeAssessmentText(q.question);
    if (!normalized || seen.has(normalized)) throw new Error(`Generated quiz has duplicate/empty question at ${index + 1}`);
    seen.add(normalized);

    if (q.type === 'multiple_choice') {
      if (!Array.isArray(q.options) || q.options.length !== 4 || q.options.some((o: unknown) => typeof o !== 'string' || !strip(o))) {
        throw new Error(`Question ${index + 1} must have exactly 4 non-empty options`);
      }
      if (new Set(q.options.map((o: string) => normalizeAssessmentText(o))).size !== 4) {
        throw new Error(`Question ${index + 1} options are not distinct`);
      }
      if (!Number.isInteger(q.correctIndex) || q.correctIndex < 0 || q.correctIndex > 3) {
        throw new Error(`Question ${index + 1} has invalid correctIndex`);
      }
      if (typeof q.explanation !== 'string' || !strip(q.explanation)) {
        throw new Error(`Question ${index + 1} must have an explanation`);
      }
    } else if (q.type === 'direct_answer') {
      directCount += 1;
      if (q.options && q.options.length > 0) throw new Error(`Direct-answer question ${index + 1} must not have options`);
      if (typeof q.rubric !== 'string' || !strip(q.rubric)) {
        throw new Error(`Direct-answer question ${index + 1} must have a rubric`);
      }
    } else {
      throw new Error(`Question ${index + 1} has invalid type`);
    }
  });

  if (directCount < directAnswerMin) {
    throw new Error(`Generated quiz must include at least ${directAnswerMin} direct-answer question(s)`);
  }
}

interface ForbiddenAssessmentRule {
  pattern: RegExp;
  /** Closely matching objective language; not a category-wide exemption. */
  objectivePattern: RegExp;
}
const FORBIDDEN_ASSESSMENT_PATTERNS: ForbiddenAssessmentRule[] = [
  { pattern: /\b(?:teacher|instructor|educator)(?:'s|s)?\b/i, objectivePattern: /\b(?:teacher|instructor|educator)(?:'s|s)?\b/i },
  { pattern: /\b(?:teaching|instructional|classroom)\s+(?:method|strategy|technique)\b/i, objectivePattern: /\b(?:teaching|instructional|classroom)\s+(?:method|strategy|technique)\b/i },
  { pattern: /\bworksheet(?:s)?\b/i, objectivePattern: /\bworksheet(?:s)?\b/i },
  { pattern: /\bworkbook(?:s)?\b/i, objectivePattern: /\bworkbook(?:s)?\b/i },
  { pattern: /\btextbook(?:s)?\b/i, objectivePattern: /\btextbook(?:s)?\b/i },
  { pattern: /\bhandout(?:s)?\b/i, objectivePattern: /\bhandout(?:s)?\b/i },
  { pattern: /\bresource(?:s)?\b/i, objectivePattern: /\bresource(?:s)?\b/i },
  { pattern: /\bslide(?:s|\s+number)?\b/i, objectivePattern: /\bslide(?:s|\s+number)?\b/i },
  { pattern: /\bpage(?:\s+\d+)?\b/i, objectivePattern: /\bpage(?:s|\s+\d+)?\b/i },
  { pattern: /\bchart(?:s)?\b/i, objectivePattern: /\bchart(?:s)?\b/i },
  { pattern: /\bdiagram(?:s)?\b/i, objectivePattern: /\bdiagram(?:s)?\b/i },
  { pattern: /\btable(?:s)?\b/i, objectivePattern: /\btable(?:s)?\b/i },
  { pattern: /\bimage(?:s)?\b/i, objectivePattern: /\bimage(?:s)?\b/i },
  { pattern: /\bpassage(?:s)?\b/i, objectivePattern: /\bpassage(?:s)?\b/i },
  { pattern: /\blesson plan(?:ning)?\b/i, objectivePattern: /\blesson plan(?:ning)?\b/i },
  { pattern: /\blearning objective(?:s)?\b/i, objectivePattern: /\blearning objective(?:s)?\b/i },
  { pattern: /\b(?:period number|lesson metadata|database id|identifier|correctindex|quiz generation|json|prompt)\b/i, objectivePattern: /\b(?:period number|lesson metadata|database id|identifier|correctindex|quiz generation|json|prompt)\b/i },
  { pattern: /\b(?:warm[- ]?up|plenary|lesson|class|period)\s+activit(?:y|ies)\b/i, objectivePattern: /\b(?:warm[- ]?up|plenary|lesson|class|period)\s+activit(?:y|ies)\b/i },
  { pattern: /\bactivit(?:y|ies)\s+(?:in|during|from)\s+(?:the\s+)?(?:lesson|class|period)\b/i, objectivePattern: /\bactivit(?:y|ies)\s+(?:in|during|from)\s+(?:the\s+)?(?:lesson|class|period)\b/i },
  { pattern: /\b(?:method|strategy|technique)\s+(?:used|chosen|planned)\s+(?:in|for)\s+(?:the\s+)?(?:lesson|class)\b/i, objectivePattern: /\b(?:method|strategy|technique)\s+(?:used|chosen|planned)\s+(?:in|for)\s+(?:the\s+)?(?:lesson|class)\b/i },
  { pattern: /\b(?:attendance|group size|due date|submission instructions|grading (?:method|policy)|mark allocation|how many minutes)\b/i, objectivePattern: /\b(?:attendance|group size|due date|submission instructions|grading (?:method|policy)|mark allocation|how many minutes)\b/i },
];
const PLACEHOLDER_PATTERN = /(?:\b(?:tbd|todo|lorem ipsum|placeholder|answer here|fill this in)\b|\[(?:insert|replace|add)[^\]]*\]|\b(?:insert|write)\s+(?:question|answer|option|text)\s+here\b|^\s*(?:question|option)\s*[a-d1-9](?:[.?:\-]|\s*$))/i;
const TRUNCATION_PATTERN = /(?:\[(?:context\s+)?truncated\]|(?:\.{3}|…|\betc\.)\s*$)/i;

function objectiveAllows(rule: ForbiddenAssessmentRule, context: QuizQualityContext): boolean {
  return (context.learningObjectives || []).some((objective) => (
    typeof objective === 'string' && rule.objectivePattern.test(objective)
  ));
}

interface NumericOption { value: number; kind: string }

function parseNumericOption(value: string): NumericOption | null {
  const normalized = strip(value).replace(/[−–—]/g, '-');
  const match = normalized.match(/^([$£€])?\s*([+-]?(?:(?:\d{1,3}(?:,\d{3})+)|\d+)(?:\.\d+)?)(%)?(?:\s*([\p{L}°]+))?$/u);
  if (!match) return null;
  const numericValue = Number(match[2].replace(/,/g, ''));
  if (!Number.isFinite(numericValue)) return null;
  const unit = (match[4] || '').toLowerCase();
  const kind = match[1] ? `currency:${match[1]}` : match[3] ? 'percent' : unit ? `unit:${unit}` : 'number';
  return { value: numericValue, kind };
}

function parseArithmeticExpression(question: string): { result: number } | null {
  const normalized = question.replace(/[−–—]/g, '-');
  const match = normalized.match(/(?:^|[^\d.])(-?\d+(?:\.\d+)?)\s*([+*×÷/]|\s[xX]\s|-)\s*(-?\d+(?:\.\d+)?)(?!\d|\.\d)/);
  if (!match) return null;
  const left = Number(match[1]);
  const right = Number(match[3]);
  const operator = match[2].trim().toLowerCase();
  let result: number;
  if (operator === '+') result = left + right;
  else if (operator === '-') result = left - right;
  else if (operator === '*' || operator === '×' || operator === 'x') result = left * right;
  else {
    if (right === 0) throw new Error('Arithmetic question divides by zero');
    result = left / right;
  }
  if (!Number.isFinite(result)) throw new Error('Arithmetic question has a non-finite answer');
  return { result };
}

function nearlyEqual(left: number, right: number): boolean {
  return Math.abs(left - right) <= 1e-9 * Math.max(1, Math.abs(left), Math.abs(right));
}

function asksForArithmeticResult(question: string): boolean {
  return /\b(?:what is|calculate|compute|solve|evaluate|find (?:the )?(?:answer|value|result|sum|difference|product|quotient)|how (?:do|would|can|should) (?:you|a student)?\s*solve|explain how to solve)\b|(?:equals|equal to)\s*\?*\s*$/i.test(question);
}

function validateNumericOptions(question: any, label: string): void {
  if (question.type !== 'multiple_choice' || !question.options) return;
  const parsedOptions = question.options.map(parseNumericOption);
  const numericCount = parsedOptions.filter(Boolean).length;
  if (numericCount > 0 && numericCount < question.options.length) {
    throw new Error(`${label} mixes numeric answers with malformed numeric distractors`);
  }
  if (numericCount !== question.options.length) return;

  const numericOptions = parsedOptions as NumericOption[];
  if (new Set(numericOptions.map((option) => option.kind)).size !== 1) {
    throw new Error(`${label} numeric distractors must use the same value type`);
  }
  for (let left = 0; left < numericOptions.length; left += 1) {
    for (let right = left + 1; right < numericOptions.length; right += 1) {
      if (nearlyEqual(numericOptions[left].value, numericOptions[right].value)) {
        throw new Error(`${label} has duplicate numeric answer values`);
      }
    }
  }

  const expression = parseArithmeticExpression(question.question);
  if (!expression || !asksForArithmeticResult(question.question)) return;
  const matching = numericOptions
    .map((option, index) => nearlyEqual(option.value, expression.result) ? index : -1)
    .filter((index) => index >= 0);
  if (matching.length !== 1) throw new Error(`${label} must contain exactly one solved arithmetic answer`);
  if (question.correctIndex !== matching[0]) throw new Error(`${label} correctIndex does not match the solved arithmetic answer`);
}

function validateDirectArithmetic(question: any, label: string): void {
  if (question.type !== 'direct_answer' || !question.rubric || !asksForArithmeticResult(question.question)) return;
  const expression = parseArithmeticExpression(question.question);
  if (!expression) return;
  const rubricNumbers = question.rubric
    .match(/[+-]?(?:(?:\d{1,3}(?:,\d{3})+)|\d+)(?:\.\d+)?/g)
    ?.map((value: string) => Number(value.replace(/,/g, ''))) || [];
  if (!rubricNumbers.some((value: number) => nearlyEqual(value, expression.result))) {
    throw new Error(`${label} rubric does not include the solved arithmetic answer`);
  }
}

/** High-confidence semantic checks; general subject truth remains the model's job. */
export function validateQuizQuality(input: unknown, context: QuizQualityContext = {}): void {
  const quizzes = (input as any)?.quizzes;
  if (!Array.isArray(quizzes)) throw new Error('Quiz quality validation requires quizzes');
  const seenQuestions = new Set<string>();
  const seenAnswerSets = new Set<string>();

  quizzes.forEach((quiz: any, quizIndex: number) => {
    if (PLACEHOLDER_PATTERN.test(quiz.title) || TRUNCATION_PATTERN.test(quiz.title)) {
      throw new Error(`Quiz ${quizIndex + 1} title contains placeholder or truncated text`);
    }
    quiz.questions.forEach((question: any, questionIndex: number) => {
      const label = `Quiz ${quizIndex + 1} question ${questionIndex + 1}`;
      const normalizedQuestion = normalizeAssessmentText(question.question);
      if (seenQuestions.has(normalizedQuestion)) throw new Error(`${label} duplicates a question from another quiz`);
      seenQuestions.add(normalizedQuestion);

      const assessmentText = [
        question.question,
        ...(question.options || []),
        question.explanation || '',
        question.rubric || '',
      ].filter(Boolean);
      if (assessmentText.some((value: string) => PLACEHOLDER_PATTERN.test(value) || TRUNCATION_PATTERN.test(value))) {
        throw new Error(`${label} contains placeholder or truncated text`);
      }
      for (const rule of FORBIDDEN_ASSESSMENT_PATTERNS) {
        if (assessmentText.some((value: string) => rule.pattern.test(value)) && !objectiveAllows(rule, context)) {
          throw new Error(`${label} asks about teacher delivery, resources, or lesson planning`);
        }
      }

      if (question.type === 'multiple_choice' && question.options) {
        const answerSet = question.options.map(normalizeAssessmentText).sort().join('|');
        if (seenAnswerSets.has(answerSet)) throw new Error(`${label} repeats an answer set from another question`);
        seenAnswerSets.add(answerSet);
      }
      validateNumericOptions(question, label);
      validateDirectArithmetic(question, label);
    });
  });
}

function qualityContextFromPayload(payload: GeneratePayload): QuizQualityContext {
  const plan = payload.plan || {};
  return {
    learningObjectives: [
      plan.objective,
      plan.learning_objective,
      ...(payload.periods || []).flatMap((period) => [period.objective, period.learning_objective]),
    ].filter((value): value is string => typeof value === 'string'),
  };
}

export function validateQuizResponse(
  input: unknown,
  quizCount = 3,
  questionsPerQuiz = 4,
  directAnswerMin = 1,
  qualityContext: QuizQualityContext = {},
): void {
  const quizzes = (input as any)?.quizzes;
  if (!Array.isArray(quizzes) || quizzes.length !== quizCount) {
    throw new Error(`LLM must return exactly ${quizCount} quizzes`);
  }
  quizzes.forEach((quiz: unknown) => validateGeneratedQuizStructure(quiz, questionsPerQuiz, directAnswerMin));
  validateQuizQuality(input, qualityContext);
}

// Backward-compatible export used by the existing focused tests.
export function validate(input: unknown): void {
  validateQuizResponse(input);
}

/** Bounded structural metadata for diagnostics; never includes generated content. */
export function summarizeQuizShape(input: unknown): QuizShapeDiagnostics {
  const quizzes = (input as any)?.quizzes;
  if (!Array.isArray(quizzes)) return { quizCount: null, questionCounts: [] };
  return {
    quizCount: quizzes.length,
    questionCounts: quizzes.slice(0, 10).map((quiz: any) => (
      Array.isArray(quiz?.questions) ? quiz.questions.length : null
    )),
  };
}

/** Drop provider-added metadata and retain only fields consumed by the client. */
export function normalizeQuizResponse(input: unknown): GeneratedQuizResponse {
  const quizzes = (input as any).quizzes.map((quiz: any) => ({
    title: strip(quiz.title),
    questions: quiz.questions.map((question: any) => {
      if (question.type === 'multiple_choice') {
        return {
          type: 'multiple_choice' as const,
          question: strip(question.question),
          options: question.options.map((option: string) => strip(option)),
          correctIndex: question.correctIndex,
          explanation: strip(question.explanation),
        };
      }
      return {
        type: 'direct_answer' as const,
        question: strip(question.question),
        rubric: strip(question.rubric),
      };
    }),
  }));
  return { quizzes };
}

function boundedText(value: unknown, maxChars: number): string {
  if (value === null || value === undefined) return '';
  const raw = String(value);
  // Avoid normalizing an unbounded metadata value before truncating it.
  const boundedRaw = raw.length > maxChars * 4 ? raw.slice(0, maxChars * 4) : raw;
  return strip(boundedRaw).slice(0, maxChars).trim();
}

function boundedEducationalLabel(value: unknown, maxChars: number, fallback: string): string {
  const label = boundedText(value, maxChars);
  const uuidPattern = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
  return !label || uuidPattern.test(label) ? fallback : label;
}

function truncateDeterministically(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value;
  const marker = '\n… [context truncated]';
  return `${value.slice(0, Math.max(0, maxChars - marker.length)).trimEnd()}${marker}`;
}

/** Build only the bounded lesson facts the model needs; database metadata is ignored. */
export function buildCompactLessonContext(payload: GeneratePayload, maxChars = MAX_CONTEXT_CHARS): string {
  const plan = payload.plan || {};
  const className = boundedText(plan.class_name || plan.class, 120);
  const grade = boundedText(plan.grade, 60) || boundedText(className.match(/\d+/)?.[0] || className, 60);
  const sourceSubject = boundedText(payload.subject || plan.subject, 160);
  const subject = boundedEducationalLabel(sourceSubject, 160, 'Lesson subject');
  const lessonTitle = boundedText(plan.title || plan.lesson_title, 320);

  const subjectPeriods = (payload.periods || [])
    .filter((period) => {
      if (!period) return false;
      const periodSubject = boundedText(period.subject, 160);
      return !periodSubject || periodSubject.toLowerCase() === sourceSubject.toLowerCase();
    })
    .slice(0, 24);

  const uniqueValues = (values: unknown[], itemLimit: number, charLimit: number): string[] => {
    const unique = new Set<string>();
    for (const value of values) {
      const text = boundedText(value, charLimit);
      if (text) unique.add(text);
      if (unique.size >= itemLimit) break;
    }
    return [...unique];
  };

  const topics = uniqueValues(subjectPeriods.map((period) => period.topic), 12, 180);
  const objectives = uniqueValues(
    [plan.objective, plan.learning_objective, ...subjectPeriods.map((period) => period.objective || period.learning_objective)],
    12,
    260,
  );

  const vocabulary: string[] = [];
  const seenVocabulary = new Set<string>();
  const addVocabulary = (value: unknown) => {
    if (seenVocabulary.size >= 32 || !value) return;
    const candidates = Array.isArray(value)
      ? value.slice(0, 32)
      : String(value).slice(0, 3_000).split(/[,;\n]/).slice(0, 32);
    for (const candidate of candidates) {
      const word = boundedText(candidate, 80);
      const key = word.toLowerCase();
      if (word && !seenVocabulary.has(key)) {
        seenVocabulary.add(key);
        vocabulary.push(word);
      }
      if (seenVocabulary.size >= 32) break;
    }
  };
  addVocabulary(plan.vocabulary);
  addVocabulary(plan.vocab);
  addVocabulary(plan.keywords);
  subjectPeriods.forEach((period) => {
    addVocabulary(period.vocabulary);
    addVocabulary(period.vocab);
    addVocabulary(period.keywords);
  });

  // Delivery activities/details are deliberately omitted. They describe how a
  // teacher runs the lesson and previously crowded out the student-learning
  // facts that questions should assess.
  const sections: string[] = [
    className && `Class: ${className}`,
    grade && `Grade: ${grade}`,
    subject && `Subject: ${subject}`,
    lessonTitle && `Lesson title: ${lessonTitle}`,
    topics.length > 0 && `Student topics:\n${topics.map((topic) => `- ${topic}`).join('\n')}`,
    objectives.length > 0 && `Student learning objectives:\n${objectives.map((objective) => `- ${objective}`).join('\n')}`,
    vocabulary.length > 0 && `Student vocabulary: ${vocabulary.join(', ')}`,
  ].filter((section): section is string => Boolean(section));

  return truncateDeterministically(sections.join('\n\n'), Math.max(0, maxChars));
}

/** Build a strict prompt whose normal path is below 6,000 chars and can never exceed 8,000. */
export function buildCompactPrompt(payload: GeneratePayload): string {
  // Quiz generation is intentionally fixed to the existing client contract.
  const quizCount = 3;
  const questionsPerQuiz = 4;
  const instructions = `Generate rigorous, age-appropriate quizzes from the lesson context.

OUTPUT CONTRACT — every rule is mandatory:
- Return ONLY one valid JSON object. No markdown, prose, commentary, or code fences.
- Return exactly ${quizCount} quizzes. Do not return 2, 4, or any other number. Do not omit a quiz.
- Each quiz must contain exactly ${questionsPerQuiz} questions. Do not return 3, 5, or any other number.
- EACH quiz must contain at least 1 direct_answer question; the other questions may use either supported type as appropriate.
- Use no fields except those shown in the exact object shapes below.

Exact root shape:
{"quizzes":[{"title":"concise title","questions":[QUESTION_OBJECT,QUESTION_OBJECT,QUESTION_OBJECT,QUESTION_OBJECT]}]}
Exact multiple_choice shape:
{"type":"multiple_choice","question":"concise question","options":["concise option 1","concise option 2","concise option 3","concise option 4"],"correctIndex":0,"explanation":"one short explanation"}
Exact direct_answer shape:
{"type":"direct_answer","question":"concise question","rubric":"one short scoring sentence"}
The root example shows one quiz object only. The actual "quizzes" array MUST contain exactly ${quizCount} quiz objects.

Student-assessment rules:
- Assess only what STUDENTS know, understand, apply, or reason about from the supplied student topics and learning objectives.
- NEVER ask about the teacher, lesson administration, planning decisions, activities, teaching methods, resources, worksheets, workbooks, textbook pages, slides, charts/diagrams not supplied here, metadata, IDs, prompts, or quiz construction. A normally forbidden item is allowed only when the student learning objective explicitly asks students to learn that item.
- Match the class/grade. Use concrete, simple recall or application for KG and early primary; do not force abstract higher-order reasoning. Use suitably deeper application or reasoning only for older grades.
- Vary the angle across all 12 questions (knowledge, understanding, application, or reasoning as age-appropriate). Do not repeat or lightly reword a stem or answer set across quizzes.
- Every multiple_choice has exactly 4 meaningful, pairwise-distinct options, correctIndex 0–3, and one brief explanation of the correct answer.
- Each wrong option must be a plausible same-type answer based on a different likely student mistake or misconception; never use nonsense, malformed values, or differences only in spacing/punctuation.
- For every mathematical question, solve it independently before writing options. Include exactly one correct value, make correctIndex point to it, and re-check the operation. Numeric distractors must be valid, distinct, same-type values caused by plausible errors. For direct arithmetic, state the solved answer in the rubric.
- Every direct_answer has a non-empty rubric and no options, correctIndex, or explanation. It must assess student learning, not lesson delivery.
- Keep every explanation and rubric to one short sentence. Keep all questions, options, titles, explanations, and rubrics complete and concise; never use placeholders or truncated text.
- Use only the supplied class/grade, subject, lesson title, student topics, student learning objectives, and vocabulary.

Lesson context:
`;

  const targetContextLimit = Math.max(0, TARGET_PROMPT_CHARS - instructions.length - 1);
  const hardContextLimit = Math.max(0, MAX_PROMPT_CHARS - instructions.length);
  const context = buildCompactLessonContext(payload, Math.min(MAX_CONTEXT_CHARS, targetContextLimit, hardContextLimit));
  const prompt = `${instructions}${context}`;

  if (prompt.length > MAX_PROMPT_CHARS) {
    // Defensive invariant: context is already bounded, so reaching this means a
    // future instruction change bypassed the budget and must not hit a provider.
    throw new Error(`Prompt exceeds hard maximum of ${MAX_PROMPT_CHARS} characters`);
  }
  if (prompt.length >= TARGET_PROMPT_CHARS) {
    console.warn('[generate-lesson-quizzes] prompt reached target ceiling', { promptChars: prompt.length });
  }
  return prompt;
}

/** Parse exact JSON or a harmless markdown/prose wrapper around one balanced object. */
export function parseQuizJson(content: string): unknown {
  const cleaned = content.replace(/^\uFEFF/, '').trim();
  try {
    return JSON.parse(cleaned);
  } catch {
    // Providers occasionally wrap an otherwise valid object. Scan balanced
    // object boundaries while respecting quoted braces and escapes; never
    // synthesize, duplicate, truncate, or otherwise repair generated content.
    let firstCandidate: unknown;
    let hasCandidate = false;
    for (let start = 0; start < cleaned.length; start += 1) {
      if (cleaned[start] !== '{') continue;
      let depth = 0;
      let inString = false;
      let escaped = false;
      for (let index = start; index < cleaned.length; index += 1) {
        const char = cleaned[index];
        if (inString) {
          if (escaped) escaped = false;
          else if (char === '\\') escaped = true;
          else if (char === '"') inString = false;
          continue;
        }
        if (char === '"') {
          inString = true;
        } else if (char === '{') {
          depth += 1;
        } else if (char === '}') {
          depth -= 1;
          if (depth === 0) {
            try {
              const parsed = JSON.parse(cleaned.slice(start, index + 1));
              if (parsed && typeof parsed === 'object' && Object.prototype.hasOwnProperty.call(parsed, 'quizzes')) {
                return parsed;
              }
              if (!hasCandidate) {
                firstCandidate = parsed;
                hasCandidate = true;
              }
            } catch {
              // This balanced span was not JSON; continue at the next opening brace.
            }
            break;
          }
        }
      }
    }
    if (hasCandidate) return firstCandidate;
  }
  throw new SyntaxError('No complete valid JSON object found in provider response');
}

/** Extract text output only from Gemini Interactions model-output steps. */
export function parseGeminiResponse(body: unknown): Pick<ProviderOutput, 'raw' | 'finishReason'> {
  const interaction = body as any;
  let raw = '';
  if (Array.isArray(interaction?.steps)) {
    for (const step of interaction.steps) {
      if (step?.type !== 'model_output' || !Array.isArray(step.content)) continue;
      for (const block of step.content) {
        if (block?.type === 'text' && typeof block.text === 'string') raw += block.text;
      }
    }
  }
  return {
    raw: raw.trim(),
    finishReason: typeof interaction?.status === 'string' ? interaction.status : null,
  };
}

function providerForUrl(url: string): ProviderName {
  if (url === GEMINI_API_URL) return 'gemini';
  throw new Error('Unsupported quiz provider URL');
}

// Both Gemini models receive the same exact 3×4 JSON Schema. Application
// validation still checks semantic constraints such as non-empty/distinct
// options before returning.
const MULTIPLE_CHOICE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    type: { type: 'string', enum: ['multiple_choice'] },
    question: { type: 'string' },
    options: {
      type: 'array',
      minItems: 4,
      maxItems: 4,
      items: { type: 'string' },
    },
    correctIndex: { type: 'integer', enum: [0, 1, 2, 3] },
    explanation: { type: 'string' },
  },
  required: ['type', 'question', 'options', 'correctIndex', 'explanation'],
};

const DIRECT_ANSWER_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    type: { type: 'string', enum: ['direct_answer'] },
    question: { type: 'string' },
    rubric: { type: 'string' },
  },
  required: ['type', 'question', 'rubric'],
};

const QUIZ_RESPONSE_SCHEMA = {
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
              anyOf: [MULTIPLE_CHOICE_SCHEMA, DIRECT_ANSWER_SCHEMA],
            },
          },
        },
        required: ['title', 'questions'],
      },
    },
  },
  required: ['quizzes'],
};

async function sendProviderRequest(
  prompt: string,
  apiKey: string,
  signal: AbortSignal,
  url: string,
  model: string,
): Promise<Response> {
  // The provider body is serialized exactly once in this short-lived scope.
  const serializedRequest = JSON.stringify({
    model,
    input: prompt,
    system_instruction: 'Generate rigorous school quizzes and output only the schema-conforming JSON result.',
    response_format: {
      type: 'text',
      mime_type: 'application/json',
      schema: QUIZ_RESPONSE_SCHEMA,
    },
    generation_config: {
      max_output_tokens: PROVIDER_MAX_TOKENS,
      thinking_level: 'minimal',
    },
  });
  return fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
    body: serializedRequest,
    signal,
  });
}

/** Make one provider HTTP call and retain only its completion text. */
async function callProvider(
  prompt: string,
  apiKey: string,
  signal: AbortSignal,
  diagnostics: RequestDiagnostics,
  url: string,
  model: string,
  strategy: GenerationStrategy = 'initial',
): Promise<ProviderOutput> {
  if (prompt.length > MAX_PROMPT_CHARS) {
    throw new Error(`Prompt exceeds hard maximum of ${MAX_PROMPT_CHARS} characters`);
  }
  if (diagnostics.providerAttempts >= MAX_PROVIDER_ATTEMPTS_PER_REQUEST) {
    const guardError: any = new Error('Provider attempt guard reached');
    guardError.code = 'PROVIDER_ATTEMPT_GUARD';
    throw guardError;
  }

  diagnostics.providerAttempts += 1;
  const attempt = diagnostics.providerAttempts;
  const provider = providerForUrl(url);
  const startedAt = Date.now();
  console.log('[generate-lesson-quizzes] provider request', {
    provider,
    model,
    strategy,
    attempt,
    promptChars: prompt.length,
    maxTokens: PROVIDER_MAX_TOKENS,
    totalProviderAttempts: diagnostics.providerAttempts,
  });

  const response = await sendProviderRequest(prompt, apiKey, signal, url, model);
  let responseText = await response.text();
  const responseChars = responseText.length;
  const responseBytes = new TextEncoder().encode(responseText).byteLength;
  const latencyMs = Date.now() - startedAt;
  if (!response.ok) {
    // Provider text is measured but never logged or returned.
    const err: any = new Error(`${model} API error: HTTP ${response.status}`);
    err.status = response.status;
    err.code = 'PROVIDER_HTTP_ERROR';
    err.attempt = attempt;
    err.responseChars = responseChars;
    err.responseBytes = responseBytes;
    err.latencyMs = latencyMs;
    throw err;
  }

  let envelope: unknown;
  try {
    envelope = JSON.parse(responseText);
    responseText = '';
  } catch {
    const err: any = new Error('Provider returned an invalid JSON envelope');
    err.status = response.status;
    err.code = 'INVALID_PROVIDER_ENVELOPE';
    err.attempt = attempt;
    err.validJson = false;
    err.responseChars = responseChars;
    err.responseBytes = responseBytes;
    err.latencyMs = latencyMs;
    throw err;
  }

  const output = parseGeminiResponse(envelope);
  if (!output.raw) {
    const err: any = new Error('Empty LLM response');
    err.status = response.status;
    err.code = 'EMPTY_PROVIDER_RESPONSE';
    err.attempt = attempt;
    err.validJson = true;
    err.responseChars = responseChars;
    err.responseBytes = responseBytes;
    err.latencyMs = latencyMs;
    throw err;
  }

  return { ...output, attempt, latencyMs };
}

async function callProviderWithTimeout(
  prompt: string,
  apiKey: string,
  url: string,
  model: string,
  timeoutMs: number,
  deadline: number,
  diagnostics: RequestDiagnostics,
  strategy: GenerationStrategy,
): Promise<ProviderOutput> {
  const remaining = remainingMs(deadline);
  if (remaining <= 0) {
    const budgetError: any = new Error('Quiz generation wall-clock budget exceeded');
    budgetError.code = 'WALL_CLOCK_BUDGET_EXCEEDED';
    throw budgetError;
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), Math.min(timeoutMs, remaining));
  const attemptStartedAt = Date.now();
  try {
    return await callProvider(prompt, apiKey, controller.signal, diagnostics, url, model, strategy);
  } catch (err: any) {
    const status: number | undefined = err?.status;
    console.error('[generate-lesson-quizzes] provider attempt failed', {
      provider: providerForUrl(url),
      model,
      strategy,
      attempt: typeof err?.attempt === 'number' ? err.attempt : diagnostics.providerAttempts,
      httpStatus: status ?? null,
      validJson: typeof err?.validJson === 'boolean' ? err.validJson : null,
      validationResult: 'not_run',
      quizCount: null,
      questionCounts: [],
      responseChars: typeof err?.responseChars === 'number' ? err.responseChars : null,
      responseBytes: typeof err?.responseBytes === 'number' ? err.responseBytes : null,
      latencyMs: typeof err?.latencyMs === 'number' ? err.latencyMs : Date.now() - attemptStartedAt,
      promptChars: prompt.length,
      executionMs: Date.now() - diagnostics.startedAt,
      rateLimited: status === 429,
      errorCode: typeof err?.code === 'string' ? err.code : diagnosticErrorCode(err),
      totalProviderAttempts: diagnostics.providerAttempts,
    });
    throw err;
  } finally {
    clearTimeout(timeout);
  }
}

/** Call the provider, parse its completion, and release the raw string on return. */
async function requestParsedCandidate(
  prompt: string,
  apiKey: string,
  url: string,
  model: string,
  timeoutMs: number,
  deadline: number,
  diagnostics: RequestDiagnostics,
  strategy: GenerationStrategy,
): Promise<ParsedCandidate> {
  const provider = providerForUrl(url);
  const output = await callProviderWithTimeout(prompt, apiKey, url, model, timeoutMs, deadline, diagnostics, strategy);
  const responseChars = output.raw.length;
  const responseBytes = new TextEncoder().encode(output.raw).byteLength;
  try {
    const value = parseQuizJson(output.raw);
    return {
      value,
      responseChars,
      responseBytes,
      attempt: output.attempt,
      latencyMs: output.latencyMs,
    };
  } catch {
    console.error('[generate-lesson-quizzes] provider output metadata', {
      provider,
      model,
      strategy,
      attempt: output.attempt,
      httpStatus: 200,
      validJson: false,
      validationResult: 'not_run',
      quizCount: null,
      questionCounts: [],
      responseChars,
      responseBytes,
      latencyMs: output.latencyMs,
      promptChars: prompt.length,
      executionMs: Date.now() - diagnostics.startedAt,
      totalProviderAttempts: diagnostics.providerAttempts,
    });
    const err: any = new Error('Provider returned invalid JSON');
    err.code = 'INVALID_PROVIDER_JSON';
    throw err;
  }
}

function validateCandidateWithTelemetry(
  candidate: ParsedCandidate,
  provider: ProviderName,
  model: string,
  strategy: GenerationStrategy,
  promptChars: number,
  diagnostics: RequestDiagnostics,
  qualityContext: QuizQualityContext,
): GeneratedQuizResponse {
  try {
    // Structural/schema checks run first; deterministic quality checks then run
    // inside validateQuizResponse before this candidate can be accepted.
    validateQuizResponse(candidate.value, 3, 4, 1, qualityContext);
    console.log('[generate-lesson-quizzes] validation metadata', {
      provider,
      model,
      strategy,
      attempt: candidate.attempt,
      httpStatus: 200,
      validJson: true,
      validationResult: 'passed',
      ...summarizeQuizShape(candidate.value),
      responseChars: candidate.responseChars,
      responseBytes: candidate.responseBytes,
      latencyMs: candidate.latencyMs,
      promptChars,
      executionMs: Date.now() - diagnostics.startedAt,
      totalProviderAttempts: diagnostics.providerAttempts,
    });
    return normalizeQuizResponse(candidate.value);
  } catch (validationError) {
    console.error('[generate-lesson-quizzes] validation metadata', {
      provider,
      model,
      strategy,
      attempt: candidate.attempt,
      httpStatus: 200,
      validJson: true,
      validationResult: 'failed',
      ...summarizeQuizShape(candidate.value),
      responseChars: candidate.responseChars,
      responseBytes: candidate.responseBytes,
      latencyMs: candidate.latencyMs,
      promptChars,
      executionMs: Date.now() - diagnostics.startedAt,
      totalProviderAttempts: diagnostics.providerAttempts,
    });
    throw validationError;
  }
}

/** Make one provider call and validate its complete structured result. */
async function attemptGenerationWithValidation(
  prompt: string,
  apiKey: string,
  url: string,
  model: string,
  deadline: number,
  diagnostics: RequestDiagnostics,
  qualityContext: QuizQualityContext,
): Promise<GeneratedQuizResponse> {
  const provider = providerForUrl(url);
  const candidate = await requestParsedCandidate(
    prompt,
    apiKey,
    url,
    model,
    AI_ATTEMPT_TIMEOUT_MS,
    deadline,
    diagnostics,
    'initial',
  );

  try {
    return validateCandidateWithTelemetry(
      candidate,
      provider,
      model,
      'initial',
      prompt.length,
      diagnostics,
      qualityContext,
    );
  } catch {
    const err: any = new Error('Quiz generation returned invalid structured output');
    err.code = 'INVALID_QUIZ_RESPONSE';
    throw err;
  }
}

export async function handleRequest(req: Request): Promise<Response> {
  const diagnostics: RequestDiagnostics = {
    startedAt: Date.now(),
    providerAttempts: 0,
  };
  const deadline = diagnostics.startedAt + WALL_CLOCK_BUDGET_MS;

  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS_HEADERS });
  if (req.method !== 'POST') {
    return returnResponse({ error: 'Method not allowed' }, 405, undefined, diagnostics);
  }

  try {
    // Avoid parsing a stale or non-browser caller's legacy multi-megabyte payload.
    const declaredLength = Number(req.headers.get('content-length') || 0);
    if (declaredLength > MAX_REQUEST_BYTES) {
      console.warn('[generate-lesson-quizzes] request rejected by size guard', {
        requestBytes: declaredLength,
      });
      return returnResponse(
        {
          error: 'Quiz generation request is too large',
          code: 'REQUEST_TOO_LARGE',
        },
        413,
        undefined,
        diagnostics,
      );
    }

    let requestText: string;
    try {
      requestText = await req.text();
    } catch (err) {
      console.error('[generate-lesson-quizzes] request body read failed', {
        errorCode: diagnosticErrorCode(err),
      });
      return returnResponse({ error: 'Invalid payload', code: 'INVALID_PAYLOAD' }, 400, undefined, diagnostics);
    }
    const requestBytes = new TextEncoder().encode(requestText).byteLength;
    if (requestBytes > MAX_REQUEST_BYTES) {
      console.warn('[generate-lesson-quizzes] request rejected by size guard', { requestBytes });
      return returnResponse(
        { error: 'Quiz generation request is too large', code: 'REQUEST_TOO_LARGE' },
        413,
        undefined,
        diagnostics,
      );
    }

    let payload: GeneratePayload;
    try {
      payload = JSON.parse(requestText);
      requestText = '';
    } catch (err) {
      console.error('[generate-lesson-quizzes] invalid request JSON', {
        errorCode: diagnosticErrorCode(err),
      });
      return returnResponse({ error: 'Invalid payload', code: 'INVALID_PAYLOAD' }, 400, undefined, diagnostics);
    }
    const hasPlan = Boolean(payload?.plan && typeof payload.plan === 'object' && !Array.isArray(payload.plan));
    const hasSubject = typeof payload?.subject === 'string' && Boolean(payload.subject.trim());
    const periodsIsArray = Array.isArray(payload?.periods);
    if (!payload || typeof payload !== 'object' || !hasPlan || !hasSubject || !periodsIsArray) {
      console.error('[generate-lesson-quizzes] invalid payload', {
        hasPlan,
        hasSubject,
        periodsIsArray,
      });
      return returnResponse({ error: 'Invalid payload', code: 'INVALID_PAYLOAD' }, 400, undefined, diagnostics);
    }

    const edgeEnv = (globalThis as any).Deno.env;
    const geminiKey = edgeEnv.get('GEMINI_API_KEY');
    const gemini36Deadline = deadline - FINAL_GOOGLE_ATTEMPT_RESERVED_BUDGET_MS;
    const reportedMissingSecrets = new Set<string>();
    let lastError: unknown;

    const prompt = buildCompactPrompt(payload);
    const qualityContext = qualityContextFromPayload(payload);
    const routes: Array<{
      provider: ProviderName;
      model: string;
      url: string;
      apiKey: string | undefined;
      secretName: string;
      attemptDeadline: number;
    }> = [
      {
        provider: 'gemini',
        model: GEMINI_36_MODEL,
        url: GEMINI_API_URL,
        apiKey: geminiKey,
        secretName: 'GEMINI_API_KEY',
        attemptDeadline: gemini36Deadline,
      },
      {
        provider: 'gemini',
        model: GEMINI_35_LITE_MODEL,
        url: GEMINI_API_URL,
        apiKey: geminiKey,
        secretName: 'GEMINI_API_KEY',
        attemptDeadline: deadline,
      },
    ];

    for (const route of routes) {
      if (!route.apiKey) {
        if (!reportedMissingSecrets.has(route.secretName)) {
          console.error(`[generate-lesson-quizzes] ${route.secretName} missing`);
          reportedMissingSecrets.add(route.secretName);
        }
        continue;
      }
      if (remainingMs(route.attemptDeadline) <= 0) {
        console.warn('[generate-lesson-quizzes] provider skipped to preserve fallback budget', {
          provider: route.provider,
          model: route.model,
          executionMs: Date.now() - diagnostics.startedAt,
          totalProviderAttempts: diagnostics.providerAttempts,
        });
        continue;
      }

      try {
        const result = await attemptGenerationWithValidation(
          prompt,
          route.apiKey,
          route.url,
          route.model,
          route.attemptDeadline,
          diagnostics,
          qualityContext,
        );
        console.log('[generate-lesson-quizzes] success', {
          provider: route.provider,
          model: route.model,
          executionMs: Date.now() - diagnostics.startedAt,
          totalProviderAttempts: diagnostics.providerAttempts,
        });
        return returnResponse(result, 200, undefined, diagnostics);
      } catch (err: any) {
        lastError = err;
        console.error('[generate-lesson-quizzes] provider failed final', {
          provider: route.provider,
          model: route.model,
          errorCode: diagnosticErrorCode(err),
          totalProviderAttempts: diagnostics.providerAttempts,
          executionMs: Date.now() - diagnostics.startedAt,
        });
      }
    }

    const detail =
      lastError instanceof Error ? lastError.message.slice(0, 500) : 'No quiz generation provider configured';
    console.error('[generate-lesson-quizzes] failed all providers', {
      provider: 'all',
      errorCode: diagnosticErrorCode(lastError),
      totalProviderAttempts: diagnostics.providerAttempts,
      executionMs: Date.now() - diagnostics.startedAt,
    });
    return returnResponse(
      {
        error: detail,
        code: 'QUIZ_GENERATION_FAILED',
        provider: 'all',
      },
      502,
      undefined,
      diagnostics,
    );
  } catch (err) {
    console.error('[generate-lesson-quizzes] internal error', {
      errorCode: diagnosticErrorCode(err),
      totalProviderAttempts: diagnostics.providerAttempts,
      executionMs: Date.now() - diagnostics.startedAt,
    });
    return returnResponse(
      {
        error: err instanceof Error ? err.message.slice(0, 500) : 'Internal error',
        code: 'INTERNAL_ERROR',
      },
      500,
      undefined,
      diagnostics,
    );
  }
}

serve(handleRequest);
