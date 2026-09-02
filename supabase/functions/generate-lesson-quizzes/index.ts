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
  repairs: Array<string>;
}

type GenerationStrategy = 'initial' | 'targeted_retry';
type ProviderName = 'gemini';

// Which pipeline stage actually failed. Providers returning HTTP 200 + valid
// JSON must never be reported as provider request failures.
export type FailurePhase =
  | 'PROVIDER_REQUEST_FAILED'
  | 'PROVIDER_RESPONSE_INVALID'
  | 'QUIZ_SCHEMA_INVALID'
  | 'QUIZ_SEMANTIC_INVALID';

export interface QuizShapeDiagnostics {
  quizCount: number | null;
  questionCounts: Array<number | null>;
}

interface GeneratedMultipleChoice {
  type: 'multiple_choice';
  question: string;
  options: string[];
  correctIndex: number;
  explanation?: string;
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

export const QUIZ_VALIDATION_ERROR_CODES = [
  'QUIZ_COUNT',
  'QUIZ_SHAPE',
  'QUESTION_SHAPE',
  'QUESTION_TYPE',
  'OPTION_SHAPE',
  'CORRECT_INDEX',
  'DIRECT_ANSWER_SHAPE',
  'DUPLICATE_QUESTION',
  'DUPLICATE_ANSWER_SET',
  'PLACEHOLDER_OR_TRUNCATION',
  'FORBIDDEN_CONTEXT',
  'NUMERIC_DISTRACTOR',
  'ARITHMETIC_ANSWER',
  'UNKNOWN_VALIDATION',
] as const;

export type QuizValidationErrorCode = typeof QUIZ_VALIDATION_ERROR_CODES[number];
const QUIZ_VALIDATION_ERROR_CODE_SET = new Set<string>(QUIZ_VALIDATION_ERROR_CODES);

/** Semantic (meaning-level) codes as opposed to structural schema codes. */
const SEMANTIC_VALIDATION_CODES = new Set<string>([
  'DUPLICATE_QUESTION',
  'DUPLICATE_ANSWER_SET',
  'PLACEHOLDER_OR_TRUNCATION',
  'FORBIDDEN_CONTEXT',
  'NUMERIC_DISTRACTOR',
  'ARITHMETIC_ANSWER',
]);

class QuizValidationError extends Error {
  readonly validationErrorCode: QuizValidationErrorCode;
  /** Structural location of the failure, e.g. quizzes[1].questions[2].options[3]. */
  readonly validationPath: string;
  /** Short allowlisted rule id (FORBIDDEN_CONTEXT rules only), e.g. artifact-worksheet. */
  readonly validationRule: string | null;

  constructor(
    validationErrorCode: QuizValidationErrorCode,
    message: string,
    validationPath: string,
    validationRule: string | null = null,
  ) {
    super(message);
    this.name = 'QuizValidationError';
    this.validationErrorCode = validationErrorCode;
    this.validationPath = validationPath;
    this.validationRule = validationRule;
  }
}

function failQuizValidation(
  validationErrorCode: QuizValidationErrorCode,
  message: string,
  validationPath: string,
  validationRule: string | null = null,
): never {
  throw new QuizValidationError(validationErrorCode, message, validationPath, validationRule);
}

/** Return only a fixed allowlisted category; never derive telemetry from model content. */
export function quizValidationErrorCode(error: unknown): QuizValidationErrorCode {
  const value = (error as { validationErrorCode?: unknown })?.validationErrorCode;
  return typeof value === 'string' && QUIZ_VALIDATION_ERROR_CODE_SET.has(value)
    ? value as QuizValidationErrorCode
    : 'UNKNOWN_VALIDATION';
}

/** Structural failure location only (indices + field names); never model content. */
export function quizValidationPath(error: unknown): string | null {
  const value = (error as { validationPath?: unknown })?.validationPath;
  return typeof value === 'string' && /^[a-zA-Z0-9_.[\]]{0,120}$/.test(value) ? value : null;
}

/** Short allowlisted rule id for the failure (FORBIDDEN_CONTEXT rules); never content. */
export function quizValidationRule(error: unknown): string | null {
  const value = (error as { validationRule?: unknown })?.validationRule;
  return typeof value === 'string' && /^[a-z0-9-]{1,40}$/.test(value) ? value : null;
}

/** Classify a quiz validation code into schema vs semantic failure. */
export function failurePhaseForValidationCode(code: QuizValidationErrorCode): FailurePhase {
  return SEMANTIC_VALIDATION_CODES.has(code) ? 'QUIZ_SEMANTIC_INVALID' : 'QUIZ_SCHEMA_INVALID';
}

/** Classify any provider/validation error into the pipeline stage that failed. */
export function failurePhaseForError(err: unknown): FailurePhase {
  const code = (err as { code?: unknown })?.code;
  if (code === 'INVALID_QUIZ_RESPONSE') {
    return failurePhaseForValidationCode(quizValidationErrorCode(err));
  }
  if (
    code === 'INVALID_PROVIDER_ENVELOPE'
    || code === 'EMPTY_PROVIDER_RESPONSE'
    || code === 'INVALID_PROVIDER_JSON'
  ) {
    return 'PROVIDER_RESPONSE_INVALID';
  }
  return 'PROVIDER_REQUEST_FAILED';
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

function validateGeneratedQuizStructure(
  input: any,
  questionsPerQuiz: number,
  directAnswerMin: number,
  quizIndex: number,
): void {
  const quizPath = `quizzes[${quizIndex}]`;
  if (typeof input?.title !== 'string' || !strip(input.title)) {
    failQuizValidation('QUIZ_SHAPE', 'Generated quiz is missing a title', `${quizPath}.title`);
  }
  if (!Array.isArray(input.questions) || input.questions.length !== questionsPerQuiz) {
    failQuizValidation('QUIZ_SHAPE', `Generated quiz must contain exactly ${questionsPerQuiz} questions`, `${quizPath}.questions`);
  }

  const seen = new Set<string>();
  let directCount = 0;
  input.questions.forEach((q: any, index: number) => {
    const questionPath = `${quizPath}.questions[${index}]`;
    if (typeof q?.question !== 'string') {
      failQuizValidation('QUESTION_SHAPE', `Question ${index + 1} is missing question text`, `${questionPath}.question`);
    }
    const normalized = normalizeAssessmentText(q.question);
    if (!normalized || seen.has(normalized)) {
      failQuizValidation('DUPLICATE_QUESTION', `Generated quiz has duplicate/empty question at ${index + 1}`, `${questionPath}.question`);
    }
    seen.add(normalized);

    // Keep application validation aligned with the strict provider schema:
    // three multiple-choice questions followed by one direct-answer question.
    const expectedType = index < questionsPerQuiz - directAnswerMin ? 'multiple_choice' : 'direct_answer';
    if (q.type !== expectedType) {
      failQuizValidation('QUESTION_TYPE', `Question ${index + 1} has invalid type or position`, `${questionPath}.type`);
    }

    if (q.type === 'multiple_choice') {
      if (!Array.isArray(q.options) || q.options.length !== 4 || q.options.some((o: unknown) => typeof o !== 'string' || !strip(o))) {
        failQuizValidation('OPTION_SHAPE', `Question ${index + 1} must have exactly 4 non-empty options`, `${questionPath}.options`);
      }
      if (new Set(q.options.map((o: string) => normalizeAssessmentText(o))).size !== 4) {
        failQuizValidation('OPTION_SHAPE', `Question ${index + 1} options are not distinct`, `${questionPath}.options`);
      }
      if (!Number.isInteger(q.correctIndex) || q.correctIndex < 0 || q.correctIndex > 3) {
        failQuizValidation('CORRECT_INDEX', `Question ${index + 1} has invalid correctIndex`, `${questionPath}.correctIndex`);
      }
    } else if (q.type === 'direct_answer') {
      directCount += 1;
      if (q.options && q.options.length > 0) {
        failQuizValidation('DIRECT_ANSWER_SHAPE', `Direct-answer question ${index + 1} must not have options`, `${questionPath}.options`);
      }
      if (typeof q.rubric !== 'string' || !strip(q.rubric)) {
        failQuizValidation('DIRECT_ANSWER_SHAPE', `Direct-answer question ${index + 1} must have a rubric`, `${questionPath}.rubric`);
      }
    }
  });

  if (directCount !== directAnswerMin) {
    failQuizValidation('DIRECT_ANSWER_SHAPE', `Generated quiz must include exactly ${directAnswerMin} direct-answer question(s)`, `${quizPath}.questions`);
  }
}

interface ForbiddenAssessmentRule {
  /** Short allowlisted rule id recorded in validation metadata (never content). */
  id: string;
  pattern: RegExp;
  /** Closely matching objective language; not a category-wide exemption. */
  objectivePattern: RegExp;
  /**
   * 'agent' rules flag teacher-as-delivery-agent phrasing and are rescued when
   * the question has a narrative/content frame ("the teacher in the story") —
   * the student is then analysing content, not delivery. 'strict' rules cover
   * lesson artifacts and administrative metadata and are never frame-rescued.
   */
  kind: 'agent' | 'strict';
}

// The teacher is the one making a pedagogical choice: "... should the teacher
// use", "what did the teacher plan", "the teacher's strategy", etc. A bare
// mention of a teacher (a story character, a historical role) is NOT delivery.
const TEACHER_DELIVERY_AGENT_PATTERN = /\b(?:(?:should|could|would|must|can|will|shall)\s+(?:the\s+|a\s+|an\s+)?(?:teacher|instructor|educator)|(?:what|which|how|when|where|why)\s+(?:should|could|would|must|can|will|did|does|do)\s+(?:the\s+|a\s+|an\s+)?(?:teacher|instructor|educator)|(?:teacher|instructor|educator)(?:'s|s)?\s+(?:should|could|would|must|will|use|uses|used|do|does|did|plan|plans|planned|prepare|prepares|prepared|choose|chooses|chose|assign|assigns|assigned|teach|teaches|taught|deliver|delivers|delivered|present|presents|presented|demonstrate|demonstrates|demonstrated|manage|manages|managed|assess|assesses|assessed|grade|grades|graded|start|starts|started|begin|begins|began|continue|continues|continued)|(?:teacher|instructor|educator)(?:'s)?\s+(?:strateg(?:y|ies)|method|methods|technique|techniques|approach|resources?|materials?|lesson\s+plans?|planning|objective|delivery))\b/i;

// A teacher (or any mentioned person) inside supplied content the student is
// asked to comprehend: story, passage, history, experiment write-up, etc.
const NARRATIVE_CONTENT_FRAME = /\bin\s+(?:the\s+)?(?:story|passage|text|reading|novel|poem|book|article|play|scene|film|video|history|interview|conversation)\b/i;

const FORBIDDEN_ASSESSMENT_PATTERNS: ForbiddenAssessmentRule[] = [
  { id: 'teacher-delivery-agent', kind: 'agent', pattern: TEACHER_DELIVERY_AGENT_PATTERN, objectivePattern: /\b(?:teacher|instructor|educator)(?:'s|s)?\b/i },
  { id: 'teaching-method', kind: 'strict', pattern: /\b(?:teaching|instructional|classroom)\s+(?:method|strategy|technique)\b/i, objectivePattern: /\b(?:teaching|instructional|classroom)\s+(?:method|strategy|technique)\b/i },
  { id: 'artifact-worksheet', kind: 'strict', pattern: /\bworksheet(?:s)?\b/i, objectivePattern: /\bworksheet(?:s)?\b/i },
  { id: 'artifact-workbook', kind: 'strict', pattern: /\bworkbook(?:s)?\b/i, objectivePattern: /\bworkbook(?:s)?\b/i },
  { id: 'artifact-textbook', kind: 'strict', pattern: /\btextbook(?:s)?\b/i, objectivePattern: /\btextbook(?:s)?\b/i },
  { id: 'artifact-handout', kind: 'strict', pattern: /\bhandout(?:s)?\b/i, objectivePattern: /\bhandout(?:s)?\b/i },
  // "Resource"/"materials" alone are legitimate academic words (natural
  // resources, properties of materials, library-skills questions); only the
  // instructional-delivery collocations are forbidden.
  { id: 'delivery-resource', kind: 'strict', pattern: /\b(?:teaching|learning|classroom|lesson|school)\s+resources?\b|\bresources?\s+(?:for|used?\s+in|during)\s+(?:the\s+)?(?:lesson|class|period|activity|week)\b/i, objectivePattern: /\b(?:teaching|learning|classroom|lesson|school)\s+resources?\b|\bresources?\s+(?:for|used?\s+in|during)\s+(?:the\s+)?(?:lesson|class|period|activity|week)\b/i },
  { id: 'delivery-materials', kind: 'strict', pattern: /\b(?:teaching|classroom|lesson)\s+materials?\b|\bmaterials?\s+(?:for|used?\s+in)\s+(?:the\s+)?(?:lesson|class|activity)\b/i, objectivePattern: /\b(?:teaching|classroom|lesson)\s+materials?\b|\bmaterials?\s+(?:for|used?\s+in)\s+(?:the\s+)?(?:lesson|class|activity)\b/i },
  { id: 'artifact-slide', kind: 'strict', pattern: /\bslide(?:s|\s+number)?\b/i, objectivePattern: /\bslide(?:s|\s+number)?\b/i },
  { id: 'artifact-page', kind: 'strict', pattern: /\bpage(?:\s+\d+)?\b/i, objectivePattern: /\bpage(?:s|\s+\d+)?\b/i },
  { id: 'artifact-chart', kind: 'strict', pattern: /\bchart(?:s)?\b/i, objectivePattern: /\bchart(?:s)?\b/i },
  { id: 'artifact-diagram', kind: 'strict', pattern: /\bdiagram(?:s)?\b/i, objectivePattern: /\bdiagram(?:s)?\b/i },
  { id: 'artifact-table', kind: 'strict', pattern: /\btable(?:s)?\b/i, objectivePattern: /\btable(?:s)?\b/i },
  { id: 'artifact-image', kind: 'strict', pattern: /\bimage(?:s)?\b/i, objectivePattern: /\bimage(?:s)?\b/i },
  // "Passage" is a normal reading-comprehension content word ("main idea of
  // the passage") and is allowed; delivery phrasing is caught by the agent rule.
  { id: 'lesson-plan', kind: 'strict', pattern: /\blesson plan(?:ning)?\b/i, objectivePattern: /\blesson plan(?:ning)?\b/i },
  { id: 'learning-objective', kind: 'strict', pattern: /\blearning objective(?:s)?\b/i, objectivePattern: /\blearning objective(?:s)?\b/i },
  { id: 'assessment-metadata', kind: 'strict', pattern: /\b(?:period number|lesson metadata|database id|identifier|correctindex|quiz generation|json|prompt)\b/i, objectivePattern: /\b(?:period number|lesson metadata|database id|identifier|correctindex|quiz generation|json|prompt)\b/i },
  { id: 'lesson-activity', kind: 'strict', pattern: /\b(?:warm[- ]?up|plenary|lesson|class|period)\s+activit(?:y|ies)\b/i, objectivePattern: /\b(?:warm[- ]?up|plenary|lesson|class|period)\s+activit(?:y|ies)\b/i },
  { id: 'activity-in-lesson', kind: 'strict', pattern: /\bactivit(?:y|ies)\s+(?:in|during|from)\s+(?:the\s+)?(?:lesson|class|period)\b/i, objectivePattern: /\bactivit(?:y|ies)\s+(?:in|during|from)\s+(?:the\s+)?(?:lesson|class|period)\b/i },
  { id: 'method-for-lesson', kind: 'strict', pattern: /\b(?:method|strategy|technique)\s+(?:used|chosen|planned)\s+(?:in|for)\s+(?:the\s+)?(?:lesson|class)\b/i, objectivePattern: /\b(?:method|strategy|technique)\s+(?:used|chosen|planned)\s+(?:in|for)\s+(?:the\s+)?(?:lesson|class)\b/i },
  // Subtle instructional-planning phrasing without the word "teacher".
  { id: 'planning-step', kind: 'strict', pattern: /\bwhat\s+comes\s+next\s+in\s+(?:the\s+)?(?:lesson|plan)\b|\bhow\s+should\s+(?:this|the)\s+lesson\s+be\s+(?:delivered|taught|introduced|presented)\b|\bwhich\s+(?:lesson[- ]?plan|planning)\s+step\b/i, objectivePattern: /\bwhat\s+comes\s+next\s+in\s+(?:the\s+)?(?:lesson|plan)\b|\bhow\s+should\s+(?:this|the)\s+lesson\s+be\s+(?:delivered|taught|introduced|presented)\b|\bwhich\s+(?:lesson[- ]?plan|planning)\s+step\b/i },
  { id: 'admin-metadata', kind: 'strict', pattern: /\b(?:attendance|group size|due date|submission instructions|grading (?:method|policy)|mark allocation|how many minutes)\b/i, objectivePattern: /\b(?:attendance|group size|due date|submission instructions|grading (?:method|policy)|mark allocation|how many minutes)\b/i },
];
const PLACEHOLDER_PATTERN = /(?:\b(?:tbd|todo|lorem ipsum|placeholder|answer here|fill this in)\b|\[(?:insert|replace|add)[^\]]*\]|\b(?:insert|write)\s+(?:question|answer|option|text)\s+here\b|^\s*(?:question|option)\s*[a-d1-9](?:[.?:\-]|\s*$))/i;
const TRUNCATION_PATTERN = /(?:\[(?:context\s+)?truncated\]|(?:\.{3}|…|\betc\.)\s*$)/i;

function objectiveAllows(rule: ForbiddenAssessmentRule, context: QuizQualityContext): boolean {
  return (context.learningObjectives || []).some((objective) => (
    typeof objective === 'string' && rule.objectivePattern.test(objective)
  ));
}

interface NumericOption { value: number; kind: string }

// Short intensifier prefixes that keep an option numeric, e.g. "about 100" or
// "at least 5". Anything longer or free-form stays non-numeric.
const APPROXIMATE_QUANTITY_PREFIX = /^(?:about|approx\.?|approximately|around|roughly|nearly|almost|exactly|circa|at least|at most|up to|over|under|above|below|more than|less than|fewer than|no more than|no less than)\s+/i;
const FRACTION_PATTERN = /^([+-]?\d+(?:\.\d+)?)\s*\/\s*(\d+(?:\.\d+)?)$/;
const MIXED_FRACTION_PATTERN = /^([+-]?\d+)\s+(\d+)\/(\d+)$/;
const CURRENCY_CODE_PATTERN = /^(usd|eur|gbp|sar|aed|egp|kes|sos|etb|ugx|tzs)$/i;
const NUMERIC_OPTION_PATTERN = /^([$£€])?\s*([+-]?(?:(?:\d{1,3}(?:,\d{3})+|\d{1,3}(?: \d{3})+|\d+)(?:\.\d+)?|\.\d+))\s*(%|[$£€])?(?:\s*([\p{L}°]{1,16}))?$/u;

/**
 * Parse an option that is a pure numeric value: 12, 3.5, 0.75, 010, 10.0,
 * 25%, $15, 10$, 15 USD, 2/5, 1 1/2, -3, 1,200, 10 000, 45°, "10 apples",
 * "about 100". Free-form sentences that merely contain a number ("World War II
 * began in 1939") do NOT parse and remain non-numeric.
 */
function parseNumericOption(value: string): NumericOption | null {
  const normalized = strip(value).replace(/[−–—]/g, '-').replace(/^~/, '');
  const withoutPrefix = normalized.replace(APPROXIMATE_QUANTITY_PREFIX, '');

  let numerator: number | null = null;
  let denominator: number | null = null;
  const simple = withoutPrefix.match(FRACTION_PATTERN);
  const mixed = withoutPrefix.match(MIXED_FRACTION_PATTERN);
  if (simple) {
    numerator = Number(simple[1]);
    denominator = Number(simple[2]);
  } else if (mixed) {
    numerator = Number(mixed[1]) * Number(mixed[2]) + Number(mixed[3]);
    denominator = Number(mixed[2]);
  }
  if (numerator !== null && denominator !== null) {
    if (denominator === 0) return null;
    const fractionValue = numerator / denominator;
    return Number.isFinite(fractionValue) ? { value: fractionValue, kind: 'number' } : null;
  }

  const match = withoutPrefix.match(NUMERIC_OPTION_PATTERN);
  if (!match) return null;
  const numericValue = Number(match[2].replace(/[ ,]/g, ''));
  if (!Number.isFinite(numericValue)) return null;

  const prefixSymbol = match[1] || null;
  const suffixMark = match[3] || null;
  const trailingWord = (match[4] || '').trim();
  const currencyCode = trailingWord ? trailingWord.match(CURRENCY_CODE_PATTERN) : null;
  const unitWord = trailingWord && !currencyCode ? trailingWord.toLowerCase() : '';

  if (prefixSymbol && suffixMark && prefixSymbol !== suffixMark) return null;
  if ((prefixSymbol || currencyCode) && suffixMark === '%') return null;
  if (suffixMark && suffixMark !== '%' && unitWord) return null;

  const bareSymbol = prefixSymbol ?? (suffixMark && suffixMark !== '%' ? suffixMark : null);
  if (prefixSymbol && currencyCode) return { value: numericValue, kind: `currency:${currencyCode[1].toLowerCase()}` };
  if (bareSymbol) {
    return { value: numericValue, kind: `currency:${bareSymbol.toLowerCase()}` };
  }
  if (suffixMark === '%' || ['percent', 'percentage', 'pct'].includes(unitWord)) {
    return { value: numericValue, kind: 'percent' };
  }
  if (currencyCode) return { value: numericValue, kind: `currency:${currencyCode[1].toLowerCase()}` };
  if (unitWord) return { value: numericValue, kind: `unit:${unitWord}` };
  return { value: numericValue, kind: 'number' };
}

/**
 * May two parsed numeric kinds share one question's option set? Decimals and
 * fractions are one abstract numeric type; concrete measurement units (days,
 * hours, km, m) are legitimately comparable with each other. Percentages and
 * each currency are their own types and must not be mixed with bare numbers.
 */
function compatibleNumericKinds(left: string, right: string): boolean {
  if (left === right) return true;
  if (left.startsWith('unit:') && right.startsWith('unit:')) return true;
  return false;
}

function parseArithmeticExpression(question: string, questionPath = 'quizzes'): { result: number } | null {
  const normalized = question.replace(/[−–—]/g, '-');
  // "3/4 of 12" or "25% of 80" are multiplicative phrasings, not division: a
  // regex cannot reliably solve them, so skip rather than mis-solve them.
  if (/(?:\d+\s*\/\s*\d+|\d+\s*%)\s+of\s+\d/i.test(normalized)) return null;
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
    if (right === 0) failQuizValidation('ARITHMETIC_ANSWER', 'Arithmetic question divides by zero', questionPath);
    result = left / right;
  }
  if (!Number.isFinite(result)) {
    failQuizValidation('ARITHMETIC_ANSWER', 'Arithmetic question has a non-finite answer', questionPath);
  }
  return { result };
}

function nearlyEqual(left: number, right: number): boolean {
  return Math.abs(left - right) <= 1e-9 * Math.max(1, Math.abs(left), Math.abs(right));
}

function asksForArithmeticResult(question: string): boolean {
  return /\b(?:what is|calculate|compute|solve|evaluate|find (?:the )?(?:answer|value|result|sum|difference|product|quotient)|how (?:do|would|can|should) (?:you|a student)?\s*solve|explain how to solve)\b|(?:equals|equal to)\s*\?*\s*$/i.test(question);
}

/**
 * Semantic numeric-distractor rule.
 *
 * The question type is decided by the CORRECT ANSWER, not by counting digits:
 * - If the correct answer is non-numeric (a conceptual/definition question),
 *   any bare-numeric distractor ("12", "45%") is meaningless → reject.
 * - If the correct answer is numeric (a genuinely numeric/calculation/date/
 *   quantity/price question), numeric distractors are expected and allowed;
 *   the option set must simply stay one comparable numeric type with distinct
 *   values (fractions and decimals are the same type; different measurement
 *   units such as "24 hours" and "365 days" may be compared in one set).
 */
function validateNumericOptions(question: any, label: string, questionPath: string): void {
  if (question.type !== 'multiple_choice' || !Array.isArray(question.options)) return;
  const options: string[] = question.options;
  const correctIndex: unknown = question.correctIndex;
  // CORRECT_INDEX shape is validated structurally; guard standalone callers.
  if (!Number.isInteger(correctIndex) || (correctIndex as number) < 0 || (correctIndex as number) >= options.length) return;

  const parsedOptions = options.map((option) => parseNumericOption(option));
  const numericCount = parsedOptions.filter(Boolean).length;
  if (numericCount === 0) return; // fully non-numeric question: nothing numeric to police

  const correctIsNumeric = parsedOptions[correctIndex as number] !== null;
  if (!correctIsNumeric) {
    const firstNumeric = parsedOptions.findIndex((option) => option !== null);
    failQuizValidation(
      'NUMERIC_DISTRACTOR',
      `${label} uses a numeric distractor on a non-numeric question`,
      `${questionPath}.options[${firstNumeric}]`,
    );
  }

  // Numeric question: every option must be numeric (no word-numbers or prose
  // mixed into an otherwise numeric set — those are malformed distractors).
  if (numericCount !== options.length) {
    const firstNonNumeric = parsedOptions.findIndex((option) => option === null);
    failQuizValidation(
      'NUMERIC_DISTRACTOR',
      `${label} mixes numeric answers with malformed numeric distractors`,
      `${questionPath}.options[${firstNonNumeric}]`,
    );
  }

  const numericOptions = parsedOptions as NumericOption[];
  for (let left = 0; left < numericOptions.length; left += 1) {
    for (let right = left + 1; right < numericOptions.length; right += 1) {
      if (!compatibleNumericKinds(numericOptions[left].kind, numericOptions[right].kind)) {
        failQuizValidation('NUMERIC_DISTRACTOR', `${label} numeric distractors must use the same value type`, `${questionPath}.options`);
      }
      // Only values with the identical kind/unit are directly comparable.
      if (numericOptions[left].kind === numericOptions[right].kind
        && nearlyEqual(numericOptions[left].value, numericOptions[right].value)) {
        failQuizValidation('NUMERIC_DISTRACTOR', `${label} has duplicate numeric answer values`, `${questionPath}.options`);
      }
    }
  }

  const expression = parseArithmeticExpression(question.question, questionPath);
  if (!expression || !asksForArithmeticResult(question.question)) return;
  const matching = numericOptions
    .map((option, index) => nearlyEqual(option.value, expression.result) ? index : -1)
    .filter((index) => index >= 0);
  if (matching.length !== 1) {
    failQuizValidation('ARITHMETIC_ANSWER', `${label} must contain exactly one solved arithmetic answer`, questionPath);
  }
  if (question.correctIndex !== matching[0]) {
    failQuizValidation('ARITHMETIC_ANSWER', `${label} correctIndex does not match the solved arithmetic answer`, `${questionPath}.correctIndex`);
  }
}

function validateDirectArithmetic(question: any, label: string, questionPath: string): void {
  if (question.type !== 'direct_answer' || !question.rubric || !asksForArithmeticResult(question.question)) return;
  const expression = parseArithmeticExpression(question.question, questionPath);
  if (!expression) return;
  const rubricNumbers = question.rubric
    .match(/[+-]?(?:(?:\d{1,3}(?:,\d{3})+)|\d+)(?:\.\d+)?/g)
    ?.map((value: string) => Number(value.replace(/,/g, ''))) || [];
  if (!rubricNumbers.some((value: number) => nearlyEqual(value, expression.result))) {
    failQuizValidation('ARITHMETIC_ANSWER', `${label} rubric does not include the solved arithmetic answer`, `${questionPath}.rubric`);
  }
}

/** High-confidence semantic checks; general subject truth remains the model's job. */
export function validateQuizQuality(input: unknown, context: QuizQualityContext = {}): void {
  const quizzes = (input as any)?.quizzes;
  if (!Array.isArray(quizzes)) {
    failQuizValidation('QUIZ_SHAPE', 'Quiz quality validation requires quizzes', 'quizzes');
  }
  const seenQuestions = new Set<string>();
  const seenAnswerSets = new Set<string>();

  quizzes.forEach((quiz: any, quizIndex: number) => {
    const quizPath = `quizzes[${quizIndex}]`;
    if (PLACEHOLDER_PATTERN.test(quiz.title) || TRUNCATION_PATTERN.test(quiz.title)) {
      failQuizValidation('PLACEHOLDER_OR_TRUNCATION', `Quiz ${quizIndex + 1} title contains placeholder or truncated text`, `${quizPath}.title`);
    }
    quiz.questions.forEach((question: any, questionIndex: number) => {
      const label = `Quiz ${quizIndex + 1} question ${questionIndex + 1}`;
      const questionPath = `${quizPath}.questions[${questionIndex}]`;
      const normalizedQuestion = normalizeAssessmentText(question.question);
      if (seenQuestions.has(normalizedQuestion)) {
        failQuizValidation('DUPLICATE_QUESTION', `${label} duplicates a question from another quiz`, `${questionPath}.question`);
      }
      seenQuestions.add(normalizedQuestion);

      const assessmentText = [question.question, ...(question.options || []), question.rubric || ''].filter(Boolean);
      if (assessmentText.some((value: string) => PLACEHOLDER_PATTERN.test(value) || TRUNCATION_PATTERN.test(value))) {
        failQuizValidation('PLACEHOLDER_OR_TRUNCATION', `${label} contains placeholder or truncated text`, questionPath);
      }
      for (const rule of FORBIDDEN_ASSESSMENT_PATTERNS) {
        if (!assessmentText.some((value: string) => rule.pattern.test(value))) continue;
        if (objectiveAllows(rule, context)) continue;
        // A teacher inside content the student is analysing ("the teacher in
        // the story discovered...") is academic content, not lesson delivery.
        if (rule.kind === 'agent' && NARRATIVE_CONTENT_FRAME.test(question.question)) continue;
        failQuizValidation(
          'FORBIDDEN_CONTEXT',
          `${label} asks about teacher delivery, resources, or lesson planning`,
          questionPath,
          rule.id,
        );
      }

      if (question.type === 'multiple_choice' && question.options) {
        const answerSet = question.options.map(normalizeAssessmentText).sort().join('|');
        if (seenAnswerSets.has(answerSet)) {
          failQuizValidation('DUPLICATE_ANSWER_SET', `${label} repeats an answer set from another question`, `${questionPath}.options`);
        }
        seenAnswerSets.add(answerSet);
      }
      validateNumericOptions(question, label, questionPath);
      validateDirectArithmetic(question, label, questionPath);
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
    failQuizValidation('QUIZ_COUNT', `LLM must return exactly ${quizCount} quizzes`, 'quizzes');
  }
  quizzes.forEach((quiz: unknown, quizIndex: number) => {
    validateGeneratedQuizStructure(quiz, questionsPerQuiz, directAnswerMin, quizIndex);
  });
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

export type QuizRepairKind =
  | 'trim_whitespace'
  | 'numeric_option'
  | 'correct_index'
  | 'drop_empty_options';

export interface QuizRepairResult {
  value: unknown;
  repairs: QuizRepairKind[];
}

const CORRECT_INDEX_STRING_PATTERN = /^\s*(?:([0-3])|([A-Da-d]))[).]?\s*$/;

/**
 * Deterministic, meaning-preserving normalization applied BEFORE validation.
 * It never invents, reorders, or deletes quiz content: it only trims stray
 * whitespace, stringifies numeric JSON options (10 → "10"), maps letter or
 * string indexes ("B" / "1" → 1), and drops empty options arrays from
 * direct-answer questions. A repaired candidate is still fully validated.
 */
export function repairQuizCandidate(input: unknown): QuizRepairResult {
  const repairs = new Set<QuizRepairKind>();
  const quizzes = (input as any)?.quizzes;
  if (!Array.isArray(quizzes)) return { value: input, repairs: [] };

  const cleanString = (value: unknown): string => {
    const cleaned = typeof value === 'string' ? strip(value) : value;
    if (typeof cleaned === 'string' && cleaned !== value) repairs.add('trim_whitespace');
    return cleaned as string;
  };

  quizzes.forEach((quiz: any) => {
    if (!quiz || typeof quiz !== 'object' || !Array.isArray(quiz.questions)) return;
    if (typeof quiz.title === 'string') quiz.title = cleanString(quiz.title);
    quiz.questions.forEach((question: any) => {
      if (!question || typeof question !== 'object') return;
      if (typeof question.question === 'string') question.question = cleanString(question.question);
      if (typeof question.rubric === 'string') question.rubric = cleanString(question.rubric);
      if (typeof question.explanation === 'string') question.explanation = cleanString(question.explanation);

      if (question.type === 'multiple_choice' && Array.isArray(question.options)) {
        question.options = question.options.map((option: unknown) => {
          if (typeof option === 'number' && Number.isFinite(option)) {
            repairs.add('numeric_option');
            return cleanString(String(option));
          }
          return cleanString(option);
        });
        if (typeof question.correctIndex === 'string') {
          const match = question.correctIndex.match(CORRECT_INDEX_STRING_PATTERN);
          if (match) {
            repairs.add('correct_index');
            question.correctIndex = match[1] ? Number(match[1]) : (question.correctIndex.trim().toUpperCase().charCodeAt(0) - 65);
          }
        }
      } else if (question.type === 'direct_answer' && Array.isArray(question.options) && question.options.length === 0) {
        delete question.options;
        repairs.add('drop_empty_options');
      }
    });
  });
  return { value: input, repairs: [...repairs] };
}

/** Drop provider-added metadata and retain only fields consumed by the client. */
export function normalizeQuizResponse(input: unknown): GeneratedQuizResponse {
  const quizzes = (input as any).quizzes.map((quiz: any) => ({
    title: strip(quiz.title),
    questions: quiz.questions.map((question: any) => {
      if (question.type === 'multiple_choice') {
        const normalized: GeneratedMultipleChoice = {
          type: 'multiple_choice',
          question: strip(question.question),
          options: question.options.map((option: string) => strip(option)),
          correctIndex: question.correctIndex,
        };
        if (typeof question.explanation === 'string' && strip(question.explanation)) {
          normalized.explanation = strip(question.explanation);
        }
        return normalized;
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
export function buildCompactPrompt(payload: GeneratePayload, maxPromptChars: number = MAX_PROMPT_CHARS): string {
  // Quiz generation is intentionally fixed to the existing client contract.
  const quizCount = 3;
  const questionsPerQuiz = 4;
  const instructions = `Generate rigorous, age-appropriate quizzes from the lesson context.

OUTPUT CONTRACT — every rule is mandatory:
- Return ONLY one valid JSON object. No markdown, prose, commentary, or code fences.
- Return exactly ${quizCount} quizzes. Do not return 2, 4, or any other number. Do not omit a quiz.
- Each quiz must contain exactly ${questionsPerQuiz} questions. Do not return 3, 5, or any other number.
- In EACH quiz, questions 1–3 must be multiple_choice and question 4 must be direct_answer.
- Use no fields except those shown in the exact object shapes below.

Exact root and object shapes:
{"quizzes":[{"title":"concise title","questions":[{"type":"multiple_choice","question":"concise question","options":["concise option 1","concise option 2","concise option 3","concise option 4"],"correctIndex":0},{"type":"multiple_choice","question":"concise question","options":["concise option 1","concise option 2","concise option 3","concise option 4"],"correctIndex":1},{"type":"multiple_choice","question":"concise question","options":["concise option 1","concise option 2","concise option 3","concise option 4"],"correctIndex":2},{"type":"direct_answer","question":"concise question","rubric":"one short scoring sentence"}]}]}
The example shows one quiz object only to define its fields. The actual "quizzes" array MUST repeat that quiz object shape exactly ${quizCount} times.

Student-assessment rules:
- Assess only what STUDENTS know, understand, apply, or reason about from the supplied student topics and learning objectives.
- NEVER ask about the teacher's job or choices: what a teacher should do, use, prepare, plan, or choose; lesson administration, planning decisions, lesson-plan steps, teaching methods or strategies, classroom resources or materials, worksheets, workbooks, textbook pages, slides, charts/diagrams not supplied here, metadata, IDs, prompts, or quiz construction. A normally forbidden item is allowed only when the student learning objective explicitly asks students to learn that item.
- Questions assess the STUDENT, never the delivery of the lesson. It IS acceptable to mention an experiment, activity, demonstration, example, lesson, passage, or resource when the question tests the underlying academic concept — e.g. "Which activity produces glucose in a plant?" or "What is the main idea of the passage?".
- Match the class/grade. Use concrete, simple recall or application for KG and early primary; do not force abstract higher-order reasoning. Use suitably deeper application or reasoning only for older grades.
- Vary the angle across all 12 questions (knowledge, understanding, application, or reasoning as age-appropriate). Do not repeat or lightly reword a stem or answer set across quizzes.
- Every multiple_choice has exactly 4 meaningful, pairwise-distinct options and correctIndex 0–3.
- Each wrong option must be a plausible same-type answer based on a different likely student mistake or misconception; never use nonsense, malformed values, or differences only in spacing/punctuation.
- Distractor typing (decide from the question): if the question genuinely expects a numeric value (calculation, count, date, measurement, price, percentage), make ALL 4 options numeric values in ONE shared type and format — e.g. "What is 7 + 5?" → 10, 11, 12, 13; "How much did it cost?" → $5, $10, $15, $20. If the question is conceptual (definition, vocabulary, science, history, reading), every option must be a meaningful NON-numeric alternative of the same kind as the correct answer — NEVER a bare number such as 12 or 35.
- For every mathematical question, solve it independently before writing options. Include exactly one correct value, make correctIndex point to it, and re-check the operation. Numeric distractors must be valid, distinct, same-type values caused by plausible errors. For direct arithmetic, state the solved answer in the rubric.
- Every direct_answer has a non-empty rubric and no options, correctIndex, or explanation. It must assess student learning, not lesson delivery.
- Do not include explanations or rationales. Keep all questions, options, titles, and rubrics complete and concise; never use placeholders or truncated text.
- Use only the supplied class/grade, subject, lesson title, student topics, student learning objectives, and vocabulary.

Lesson context:
`;

  const targetContextLimit = Math.max(0, TARGET_PROMPT_CHARS - instructions.length - 1);
  const hardContextLimit = Math.max(0, Math.min(maxPromptChars, MAX_PROMPT_CHARS) - instructions.length);
  const context = buildCompactLessonContext(payload, Math.min(MAX_CONTEXT_CHARS, targetContextLimit, hardContextLimit));
  const prompt = `${instructions}${context}`;

  if (prompt.length > maxPromptChars) {
    // Defensive invariant: context is already bounded, so reaching this means a
    // future instruction change bypassed the budget and must not hit a provider.
    throw new Error(`Prompt exceeds hard maximum of ${maxPromptChars} characters`);
  }
  if (prompt.length >= TARGET_PROMPT_CHARS) {
    console.warn('[generate-lesson-quizzes] prompt reached target ceiling', { promptChars: prompt.length });
  }
  return prompt;
}

/**
 * Validation-error-specific corrections appended to the retry attempt. Retrying
 * with the identical prompt tends to reproduce the same invalid structure, so
 * the second attempt is told exactly which rule it broke.
 */
export const TARGETED_RETRY_CORRECTIONS: Record<QuizValidationErrorCode, string> = {
  NUMERIC_DISTRACTOR: `CORRECTION — your previous quiz response failed validation: a distractor was classified as an invalid numeric distractor (NUMERIC_DISTRACTOR). Regenerate the full quiz set.
- Numeric options are allowed ONLY when the question genuinely expects a numeric or calculation answer (count, date, measurement, price, percentage). For those questions all 4 options must be numeric values of one shared type and format.
- For conceptual, vocabulary, reading, science, history, or definition questions, every distractor must be a semantically plausible NON-numeric alternative of the same kind as the correct answer. Never use a bare number as a conceptual distractor.
- Never repeat the previous response's questions; write a fresh, valid set.
- Satisfy every schema rule and return JSON only.`,
  QUIZ_COUNT: `CORRECTION — your previous response had the wrong quiz count. Return EXACTLY 3 quizzes, each with EXACTLY 4 questions. Return JSON only.`,
  QUIZ_SHAPE: `CORRECTION — your previous response had a malformed quiz object. Every quiz needs a concise non-empty title and exactly 4 questions. Return JSON only.`,
  QUESTION_SHAPE: `CORRECTION — a question in your previous response was missing its question text. Every question needs a complete, concise stem. Return JSON only.`,
  QUESTION_TYPE: `CORRECTION — your previous response broke the question order. In EACH quiz, questions 1-3 must be multiple_choice and question 4 must be direct_answer. Return JSON only.`,
  OPTION_SHAPE: `CORRECTION — a multiple-choice question in your previous response had invalid options. Every multiple_choice question needs EXACTLY 4 non-empty, pairwise-distinct string options. Return JSON only.`,
  CORRECT_INDEX: `CORRECTION — a question in your previous response had an invalid correctIndex. correctIndex must be the integer 0, 1, 2, or 3 pointing at the correct option. Return JSON only.`,
  DIRECT_ANSWER_SHAPE: `CORRECTION — a direct-answer question in your previous response was malformed. Question 4 of each quiz must be direct_answer with a non-empty rubric and NO options. Return JSON only.`,
  DUPLICATE_QUESTION: `CORRECTION — your previous response repeated a question stem across quizzes. Every question stem must be unique across all 3 quizzes. Return JSON only.`,
  DUPLICATE_ANSWER_SET: `CORRECTION — your previous response repeated an entire answer set. Do not reuse the same four options for different questions. Return JSON only.`,
  PLACEHOLDER_OR_TRUNCATION: `CORRECTION — your previous response contained placeholder or truncated text. Write every title, question, option, and rubric complete and concise with no placeholders or trailing ellipses. Return JSON only.`,
  FORBIDDEN_CONTEXT: `CORRECTION — your previous quiz response failed validation because it contained a teacher-facing or instructional-delivery question (FORBIDDEN_CONTEXT). Regenerate the ENTIRE quiz set with fresh questions.
- Every question must test STUDENT learning from the supplied lesson content: what a student knows, understands, applies, or reasons about.
- Do NOT ask about teacher actions, lesson delivery, teaching strategies or methods, classroom resources or materials, classroom management, lesson planning, or what a teacher should do, use, prepare, or choose.
- A question MAY mention an experiment, activity, demonstration, lesson, classroom example, or resource when the student is being tested on the underlying academic concept (e.g. "Which activity produces glucose in a plant?").
- Do not keep or reword the problematic question — write a completely fresh one.
- Return the exact required JSON structure and nothing else.`,
  ARITHMETIC_ANSWER: `CORRECTION — an arithmetic question in your previous response had a wrong or ambiguous answer. Solve each calculation independently, place exactly one correct value among the options, make correctIndex point to it, and state the solved answer in the rubric for direct arithmetic. Return JSON only.`,
  UNKNOWN_VALIDATION: `CORRECTION — your previous response failed quiz validation. Re-read every rule in this prompt, especially the output contract and question shapes, and regenerate a fully valid quiz set. Return JSON only.`,
};

/** The correction block appended to a retry prompt for a specific code. */
export function targetedRetryCorrection(code: QuizValidationErrorCode): string {
  const text = TARGETED_RETRY_CORRECTIONS[code] || TARGETED_RETRY_CORRECTIONS.UNKNOWN_VALIDATION;
  return `\n\nVALIDATION FEEDBACK FOR THIS RETRY ATTEMPT\n${text}`;
}

/** Append a retry correction while respecting the hard prompt budget. */
export function buildRetryPrompt(
  basePrompt: string,
  payload: GeneratePayload,
  correction: string,
): string {
  if (basePrompt.length + correction.length <= MAX_PROMPT_CHARS) {
    return `${basePrompt}${correction}`;
  }
  return `${buildCompactPrompt(payload, MAX_PROMPT_CHARS - correction.length)}${correction}`;
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
  },
  required: ['type', 'question', 'options', 'correctIndex'],
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
            prefixItems: [
              MULTIPLE_CHOICE_SCHEMA,
              MULTIPLE_CHOICE_SCHEMA,
              MULTIPLE_CHOICE_SCHEMA,
              DIRECT_ANSWER_SCHEMA,
            ],
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
    system_instruction: 'Generate rigorous school quizzes and output only the schema-conforming JSON result. Match distractor types to the question: numeric options only when the question expects a numeric answer; plausible non-numeric alternatives for conceptual questions.',
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
      failurePhase: failurePhaseForError(err),
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
    // Deterministic, meaning-preserving normalization runs before validation so
    // cosmetic provider drift (untrimmed strings, numeric JSON options, letter
    // indexes) cannot masquerade as schema/semantic failures.
    const repaired = repairQuizCandidate(value);
    return {
      value: repaired.value,
      responseChars,
      responseBytes,
      attempt: output.attempt,
      latencyMs: output.latencyMs,
      repairs: repaired.repairs,
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
      failurePhase: 'PROVIDER_RESPONSE_INVALID',
      validationErrorCode: 'INVALID_PROVIDER_JSON',
      validationPath: null,
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
      validationErrorCode: null,
      validationPath: null,
      repairs: candidate.repairs,
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
      validationErrorCode: quizValidationErrorCode(validationError),
      validationPath: quizValidationPath(validationError),
      validationRule: quizValidationRule(validationError),
      failurePhase: failurePhaseForValidationCode(quizValidationErrorCode(validationError)),
      repairs: candidate.repairs,
      ...summarizeQuizShape(candidate.value),
      responseChars: candidate.responseChars,
      responseBytes: candidate.responseBytes,
      latencyMs: candidate.latencyMs,
      promptChars,
      executionMs: Date.now() - diagnostics.startedAt,
      totalProviderAttempts: diagnostics.providerAttempts,
    });
    logValidationFailureDiagnostics(candidate.value, validationError);
    throw validationError;
  }
}

/** Opt-in diagnostics flag (QUIZ_DEBUG_DIAGNOSTICS=1|true|yes) for staging. */
function debugDiagnosticsEnabled(): boolean {
  try {
    const flag = (globalThis as any).Deno?.env?.get?.('QUIZ_DEBUG_DIAGNOSTICS');
    const value = typeof flag === 'string' ? flag.trim().toLowerCase() : '';
    return value === '1' || value === 'true' || value === 'yes';
  } catch {
    return false;
  }
}

const VALIDATION_QUESTION_PATH_PATTERN = /^quizzes\[(\d+)\]\.questions\[(\d+)\](?:\.options\[(\d+)\])?$/;

function boundedDiagnosticText(value: unknown, maxChars: number): string | null {
  if (typeof value !== 'string') return null;
  return value.replace(/\s+/g, ' ').trim().slice(0, maxChars);
}

/**
 * Identify the exact offending question/choice behind a validation failure.
 * Disabled by default: opting in logs bounded generated content, so it is for
 * development/staging diagnosis only — production logs stay content-free.
 */
function logValidationFailureDiagnostics(input: unknown, error: unknown): void {
  if (!debugDiagnosticsEnabled()) return;
  const path = quizValidationPath(error);
  const match = path ? path.match(VALIDATION_QUESTION_PATH_PATTERN) : null;
  if (!match) return;
  const question = (input as any)?.quizzes?.[Number(match[1])]?.questions?.[Number(match[2])];
  if (!question || typeof question !== 'object') return;
  const options = Array.isArray(question.options) ? question.options : [];
  console.error('[generate-lesson-quizzes] validation failure diagnostics', {
    validationErrorCode: quizValidationErrorCode(error),
    validationPath: path,
    questionIndex: Number(match[2]),
    choiceIndex: match[3] !== undefined ? Number(match[3]) : null,
    questionType: typeof question.type === 'string' ? question.type : null,
    question: boundedDiagnosticText(question.question, 120),
    correctAnswer: Number.isInteger(question.correctIndex) && options.length > 0
      ? boundedDiagnosticText(options[question.correctIndex], 80)
      : null,
    distractor: match[3] !== undefined ? boundedDiagnosticText(options[Number(match[3])], 80) : null,
    validationError: quizValidationErrorCode(error),
  });
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
  strategy: GenerationStrategy = 'initial',
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
    strategy,
  );

  try {
    return validateCandidateWithTelemetry(
      candidate,
      provider,
      model,
      strategy,
      prompt.length,
      diagnostics,
      qualityContext,
    );
  } catch (validationError) {
    const err: any = new Error('Quiz generation returned invalid structured output');
    err.code = 'INVALID_QUIZ_RESPONSE';
    // Preserve only the allowlisted category (and structural path) across the
    // generic public-facing wrapper. Raw validator messages and generated
    // content are discarded; the public error stays INVALID_QUIZ_RESPONSE.
    err.validationErrorCode = quizValidationErrorCode(validationError);
    err.validationPath = quizValidationPath(validationError);
    err.validationRule = quizValidationRule(validationError);
    err.failurePhase = failurePhaseForValidationCode(err.validationErrorCode);
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
    // Root validation cause of the previous attempt (allowlisted code only).
    // The fallback attempt receives a correction targeting this exact error
    // instead of a byte-identical prompt that reproduces the same defect.
    let lastValidationErrorCode: QuizValidationErrorCode | null = null;

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
        const strategy: GenerationStrategy = lastValidationErrorCode ? 'targeted_retry' : 'initial';
        const attemptPrompt = lastValidationErrorCode
          ? buildRetryPrompt(prompt, payload, targetedRetryCorrection(lastValidationErrorCode))
          : prompt;
        const result = await attemptGenerationWithValidation(
          attemptPrompt,
          route.apiKey,
          route.url,
          route.model,
          route.attemptDeadline,
          diagnostics,
          qualityContext,
          strategy,
        );
        console.log('[generate-lesson-quizzes] success', {
          provider: route.provider,
          model: route.model,
          strategy,
          executionMs: Date.now() - diagnostics.startedAt,
          totalProviderAttempts: diagnostics.providerAttempts,
        });
        return returnResponse(result, 200, undefined, diagnostics);
      } catch (err: any) {
        lastError = err;
        if (err?.code === 'INVALID_QUIZ_RESPONSE') {
          lastValidationErrorCode = typeof err.validationErrorCode === 'string'
            && QUIZ_VALIDATION_ERROR_CODE_SET.has(err.validationErrorCode)
            ? err.validationErrorCode as QuizValidationErrorCode
            : 'UNKNOWN_VALIDATION';
        }
        console.error('[generate-lesson-quizzes] provider failed final', {
          provider: route.provider,
          model: route.model,
          errorCode: diagnosticErrorCode(err),
          failurePhase: failurePhaseForError(err),
          validationErrorCode: typeof err?.validationErrorCode === 'string' ? err.validationErrorCode : null,
          validationPath: typeof err?.validationPath === 'string' ? err.validationPath : null,
          validationRule: typeof err?.validationRule === 'string' ? err.validationRule : null,
          totalProviderAttempts: diagnostics.providerAttempts,
          executionMs: Date.now() - diagnostics.startedAt,
        });
      }
    }

    const detail =
      lastError instanceof Error ? lastError.message.slice(0, 500) : 'No quiz generation provider configured';
    const lastValidationCode = typeof (lastError as any)?.validationErrorCode === 'string'
      && QUIZ_VALIDATION_ERROR_CODE_SET.has((lastError as any).validationErrorCode)
      ? (lastError as any).validationErrorCode as QuizValidationErrorCode
      : null;
    console.error('[generate-lesson-quizzes] failed all providers', {
      provider: 'all',
      errorCode: diagnosticErrorCode(lastError),
      failurePhase: failurePhaseForError(lastError),
      validationErrorCode: lastValidationCode,
      validationRule: quizValidationRule(lastError),
      totalProviderAttempts: diagnostics.providerAttempts,
      executionMs: Date.now() - diagnostics.startedAt,
    });
    return returnResponse(
      {
        error: detail,
        code: 'QUIZ_GENERATION_FAILED',
        provider: 'all',
        // Allowlisted category only (never generated content); lets the client
        // show the real cause instead of a hardcoded guess.
        validationErrorCode: lastValidationCode,
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
