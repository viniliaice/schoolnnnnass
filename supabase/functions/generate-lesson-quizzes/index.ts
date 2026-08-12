import { serve } from 'https://deno.land/std@0.224.0/http/server.ts';

const NVIDIA_API_URL = 'https://integrate.api.nvidia.com/v1/chat/completions';
const NVIDIA_MODEL = 'nvidia/nemotron-3.5-lightning-30b-a3b';
const ZEN_API_URL = 'https://opencode.ai/zen/v1/chat/completions';
const ZEN_MODEL = 'deepseek-v4-flash-free';
// Production timings ranged from 18–82 seconds. Forty-five seconds retains the
// normal 18–40 second path while preventing one pathological provider call from
// consuming the worker for the full 82-second outlier.
const AI_ATTEMPT_TIMEOUT_MS = 45_000;
const RECOVERY_ATTEMPT_TIMEOUT_MS = 30_000;
const WALL_CLOCK_BUDGET_MS = 75_000;

// One retry preserves recovery from genuinely transient gateway failures. Rate
// limits are not retried inside one request, and the global guard keeps the
// full Zen → NVIDIA → validation-recovery path predictable.
const PROVIDER_MAX_RETRIES = 1;
const MAX_PROVIDER_ATTEMPTS_PER_REQUEST = 4;
const BASE_BACKOFF_MS = 800;
export const PROVIDER_MAX_TOKENS = 1800;
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

type GenerationStrategy = 'initial' | 'strict_recovery';

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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
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
function validateGeneratedQuiz(input: any, questionsPerQuiz: number, directAnswerMin: number): void {
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
    const normalized = strip(q.question).toLowerCase();
    if (!normalized || seen.has(normalized)) throw new Error(`Generated quiz has duplicate/empty question at ${index + 1}`);
    seen.add(normalized);

    if (q.type === 'multiple_choice') {
      if (!Array.isArray(q.options) || q.options.length !== 4 || q.options.some((o: unknown) => typeof o !== 'string' || !strip(o))) {
        throw new Error(`Question ${index + 1} must have exactly 4 non-empty options`);
      }
      if (new Set(q.options.map((o: string) => strip(o).toLowerCase())).size !== 4) {
        throw new Error(`Question ${index + 1} options are not distinct`);
      }
      if (!Number.isInteger(q.correctIndex) || q.correctIndex < 0 || q.correctIndex > 3) {
        throw new Error(`Question ${index + 1} has invalid correctIndex`);
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

export function validateQuizResponse(
  input: unknown,
  quizCount = 3,
  questionsPerQuiz = 4,
  directAnswerMin = 1,
): void {
  const quizzes = (input as any)?.quizzes;
  if (!Array.isArray(quizzes) || quizzes.length !== quizCount) {
    throw new Error(`LLM must return exactly ${quizCount} quizzes`);
  }
  quizzes.forEach((quiz: unknown) => validateGeneratedQuiz(quiz, questionsPerQuiz, directAnswerMin));
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
  const subject = boundedText(payload.subject || plan.subject, 160);
  const lessonTitle = boundedText(plan.title || plan.lesson_title, 320);

  const subjectPeriods = (payload.periods || [])
    .filter((period) => {
      if (!period) return false;
      const periodSubject = boundedText(period.subject, 160);
      return !periodSubject || periodSubject.toLowerCase() === subject.toLowerCase();
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

  const periodSummaries = subjectPeriods.map((period, index) => {
    const number = boundedText(period.period_number ?? index + 1, 12);
    const topic = boundedText(period.topic, 150);
    const objective = boundedText(period.objective || period.learning_objective, 220);
    const activities = boundedText(period.activities, 260);
    const detailActivities = Array.isArray(period.details)
      ? period.details
          .slice(0, 4)
          .map((detail: any) => boundedText(detail?.activity, 120))
          .filter(Boolean)
      : [];
    const parts = [
      topic && `topic ${topic}`,
      objective && `objective ${objective}`,
      activities && `activities ${activities}`,
      detailActivities.length > 0 && `key actions ${detailActivities.join('; ')}`,
    ].filter(Boolean);
    return parts.length > 0 ? `- Period ${number}: ${parts.join(' | ')}` : '';
  }).filter(Boolean);

  const sections: string[] = [
    className && `Class: ${className}`,
    grade && `Grade: ${grade}`,
    subject && `Subject: ${subject}`,
    lessonTitle && `Lesson title: ${lessonTitle}`,
    topics.length > 0 && `Topics:\n${topics.map((topic) => `- ${topic}`).join('\n')}`,
    objectives.length > 0 && `Learning objectives:\n${objectives.map((objective) => `- ${objective}`).join('\n')}`,
    vocabulary.length > 0 && `Vocabulary: ${vocabulary.join(', ')}`,
    periodSummaries.length > 0 && `Relevant periods and summarized activities:\n${periodSummaries.join('\n')}`,
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
- In EACH quiz, questions 1–3 must be multiple_choice and question 4 must be direct_answer.
- Use no fields except those shown in the exact object shapes below.

Exact root and object shapes:
{"quizzes":[{"title":"concise title","questions":[{"type":"multiple_choice","question":"concise question","options":["concise option 1","concise option 2","concise option 3","concise option 4"],"correctIndex":0},{"type":"multiple_choice","question":"concise question","options":["concise option 1","concise option 2","concise option 3","concise option 4"],"correctIndex":1},{"type":"multiple_choice","question":"concise question","options":["concise option 1","concise option 2","concise option 3","concise option 4"],"correctIndex":2},{"type":"direct_answer","question":"concise question","rubric":"one short scoring sentence"}]}]}
The example shows one quiz object only to define its fields. The actual "quizzes" array MUST repeat that quiz object shape exactly ${quizCount} times.

Content rules:
- Every multiple_choice has exactly 4 meaningful, pairwise-distinct options and correctIndex 0–3.
- Distractors test different plausible misconceptions; never vary only spacing or punctuation.
- Every direct_answer has a non-empty rubric and no options, correctIndex, or explanation.
- Do not include explanations or rationales. Keep all questions, options, titles, and rubrics concise.
- Use only the supplied lesson title, objectives, topics, vocabulary, activities, class, grade, and subject.
- Do not repeat question stems within a quiz.

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

function buildStrictRecoveryPrompt(prompt: string, failure: 'invalid_json' | 'validation_failed'): string {
  const recovery = `

STRICT RECOVERY — the previous output was rejected (${failure}). Discard it and generate a new complete result.
- Return ONLY one valid JSON object with the root key "quizzes".
- Return exactly 3 quizzes, never 2, 4, or another count.
- Return exactly 4 questions in EACH quiz, never 3, 5, or another count.
- In each quiz, questions 1–3 are multiple_choice and question 4 is direct_answer.
- Include every required field and exactly 4 distinct options for each multiple_choice.
- Include no explanations, rationales, markdown, prose, or omitted quizzes.
Before responding, silently count the quizzes and every questions array. Output the JSON object only.`;
  const strictPrompt = `${prompt}${recovery}`;
  if (strictPrompt.length > MAX_PROMPT_CHARS) {
    throw new Error(`Strict recovery prompt exceeds hard maximum of ${MAX_PROMPT_CHARS} characters`);
  }
  return strictPrompt;
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

/** Extract only the completion text needed by quiz parsing from the provider envelope. */
export function parseProviderResponse(body: unknown): Pick<ProviderOutput, 'raw' | 'finishReason'> {
  const envelope = body as any;
  const choice = envelope?.choices?.[0];
  const message = choice?.message ?? choice?.delta ?? {};
  const raw = (
    typeof message.content === 'string'
      ? message.content
      : typeof choice?.text === 'string'
        ? choice.text
        : typeof message.reasoning_content === 'string'
          ? message.reasoning_content
          : ''
  ).trim();
  return {
    raw,
    finishReason: typeof choice?.finish_reason === 'string' ? choice.finish_reason : null,
  };
}

function isRetriableStatus(status: number): boolean {
  // A rate limit will not clear within this short request. In particular, Zen's
  // FreeUsageLimitError must immediately route to NVIDIA rather than consume an
  // identical retry. Only transient gateway/service failures are retried.
  return status === 529 || status === 502 || status === 503 || status === 504;
}

async function sendProviderRequest(
  prompt: string,
  apiKey: string,
  signal: AbortSignal,
  url: string,
  model: string,
  strategy: GenerationStrategy,
): Promise<Response> {
  // The provider body is serialized exactly once in this short-lived scope.
  // Nemotron 3.5 documents JSON-object mode (not full json_schema enforcement),
  // so exact 3×4 counts remain application-validated. Thinking is disabled so
  // the output budget is reserved for the client-consumed JSON.
  const isNvidia = url === NVIDIA_API_URL;
  const strictRecovery = strategy === 'strict_recovery';
  const serializedRequest = JSON.stringify({
    model,
    messages: [
      {
        role: 'system',
        content: strictRecovery
          ? 'Act as a strict JSON compiler. Return one complete valid object matching every count and field rule; output no other text.'
          : 'Generate rigorous school quizzes. Return only one valid JSON object.',
      },
      { role: 'user', content: prompt },
    ],
    temperature: strictRecovery ? 0.2 : isNvidia ? 1 : 0.7,
    top_p: strictRecovery ? 0.8 : isNvidia ? 0.95 : 0.9,
    max_tokens: PROVIDER_MAX_TOKENS,
    stream: false,
    ...(isNvidia
      ? {
          response_format: { type: 'json_object' },
          chat_template_kwargs: { enable_thinking: false },
        }
      : {}),
  });
  return fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
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
  url = ZEN_API_URL,
  model = ZEN_MODEL,
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
  const provider = url === NVIDIA_API_URL ? 'nvidia' : 'zen';
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

  const response = await sendProviderRequest(prompt, apiKey, signal, url, model, strategy);
  const latencyMs = Date.now() - startedAt;
  if (!response.ok) {
    // Read only to classify a known Zen error; never expose provider body text.
    const errorBody = await response.text();
    const freeUsageLimit = provider === 'zen'
      && response.status === 429
      && /FreeUsageLimitError/i.test(errorBody.slice(0, 4_000));
    const err: any = new Error(`${model} API error: HTTP ${response.status}`);
    err.status = response.status;
    err.code = freeUsageLimit ? 'ZEN_FREE_USAGE_LIMIT' : 'PROVIDER_HTTP_ERROR';
    err.attempt = attempt;
    err.responseChars = errorBody.length;
    err.responseBytes = new TextEncoder().encode(errorBody).byteLength;
    err.latencyMs = latencyMs;
    throw err;
  }

  const envelope: unknown = await response.json();
  const output = parseProviderResponse(envelope);
  if (!output.raw) {
    const err: any = new Error('Empty LLM response');
    err.status = response.status;
    err.code = 'EMPTY_PROVIDER_RESPONSE';
    err.retriable = true;
    err.attempt = attempt;
    err.responseChars = 0;
    err.responseBytes = 0;
    err.latencyMs = latencyMs;
    throw err;
  }

  return { ...output, attempt, latencyMs };
}

async function callProviderWithRetry(
  prompt: string,
  apiKey: string,
  url: string,
  model: string,
  timeoutMs: number,
  deadline: number,
  diagnostics: RequestDiagnostics,
  strategy: GenerationStrategy,
): Promise<ProviderOutput> {
  let lastError: unknown;
  // A strict recovery is itself the single post-validation retry and is never
  // resent identically. Only the initial strategy may retry a transient fault.
  const maxRetries = strategy === 'initial' ? PROVIDER_MAX_RETRIES : 0;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
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
      const output = await callProvider(prompt, apiKey, controller.signal, diagnostics, url, model, strategy);
      if (attempt > 0) {
        console.log('[generate-lesson-quizzes] provider retry succeeded', {
          provider: url === NVIDIA_API_URL ? 'nvidia' : 'zen',
          strategy,
          transportAttempt: attempt + 1,
          attempt: output.attempt,
          totalProviderAttempts: diagnostics.providerAttempts,
        });
      }
      return output;
    } catch (err: any) {
      lastError = err;
      const status: number | undefined = err?.status;
      const isAbort = err?.name === 'AbortError';
      const isNetworkFailure = err instanceof TypeError && status === undefined;
      const retriable = status !== 429
        && !isAbort
        && err?.code !== 'PROVIDER_ATTEMPT_GUARD'
        && (err?.retriable === true || isNetworkFailure || (status !== undefined && isRetriableStatus(status)));
      console.error('[generate-lesson-quizzes] provider attempt failed', {
        provider: url === NVIDIA_API_URL ? 'nvidia' : 'zen',
        model,
        strategy,
        transportAttempt: attempt + 1,
        attempt: typeof err?.attempt === 'number' ? err.attempt : diagnostics.providerAttempts,
        httpStatus: status ?? null,
        validJson: null,
        validationResult: 'not_run',
        quizCount: null,
        questionCounts: [],
        responseChars: typeof err?.responseChars === 'number' ? err.responseChars : null,
        responseBytes: typeof err?.responseBytes === 'number' ? err.responseBytes : null,
        latencyMs: typeof err?.latencyMs === 'number' ? err.latencyMs : Date.now() - attemptStartedAt,
        promptChars: prompt.length,
        executionMs: Date.now() - diagnostics.startedAt,
        retriable,
        rateLimited: status === 429,
        errorCode: typeof err?.code === 'string' ? err.code : null,
        totalProviderAttempts: diagnostics.providerAttempts,
      });
      if (!retriable || attempt === maxRetries) break;
      const backoff = BASE_BACKOFF_MS * Math.pow(2, attempt) + Math.random() * 300;
      await sleep(backoff);
    } finally {
      clearTimeout(timeout);
    }
  }
  throw lastError;
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
  const provider = url === NVIDIA_API_URL ? 'nvidia' : 'zen';
  const output = await callProviderWithRetry(
    prompt,
    apiKey,
    url,
    model,
    timeoutMs,
    deadline,
    diagnostics,
    strategy,
  );
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
      finishReason: output.finishReason,
      totalProviderAttempts: diagnostics.providerAttempts,
    });
    const err: any = new Error('Provider returned invalid JSON');
    err.code = 'INVALID_PROVIDER_JSON';
    throw err;
  }
}

function validateCandidateWithTelemetry(
  candidate: ParsedCandidate,
  provider: 'zen' | 'nvidia',
  model: string,
  strategy: GenerationStrategy,
  promptChars: number,
  diagnostics: RequestDiagnostics,
): GeneratedQuizResponse {
  try {
    validateQuizResponse(candidate.value);
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

/** Generate once, then allow at most one materially stricter recovery request. */
async function attemptGenerationWithValidation(
  prompt: string,
  apiKey: string,
  url: string,
  model: string,
  deadline: number,
  diagnostics: RequestDiagnostics,
): Promise<GeneratedQuizResponse> {
  const provider = url === NVIDIA_API_URL ? 'nvidia' : 'zen';
  let recoveryReason: 'invalid_json' | 'validation_failed';

  try {
    const initial = await requestParsedCandidate(
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
        initial,
        provider,
        model,
        'initial',
        prompt.length,
        diagnostics,
      );
    } catch {
      recoveryReason = 'validation_failed';
    }
  } catch (err: any) {
    if (err?.code !== 'INVALID_PROVIDER_JSON') throw err;
    recoveryReason = 'invalid_json';
  }

  const recoveryPrompt = buildStrictRecoveryPrompt(prompt, recoveryReason);
  const recovered = await requestParsedCandidate(
    recoveryPrompt,
    apiKey,
    url,
    model,
    RECOVERY_ATTEMPT_TIMEOUT_MS,
    deadline,
    diagnostics,
    'strict_recovery',
  );
  try {
    return validateCandidateWithTelemetry(
      recovered,
      provider,
      model,
      'strict_recovery',
      recoveryPrompt.length,
      diagnostics,
    );
  } catch (recoveryValidationError) {
    const err: any = new Error(
      `Quiz generation returned invalid structured output: ${errorMessage(recoveryValidationError)}`,
    );
    err.code = 'INVALID_QUIZ_RESPONSE';
    throw err;
  }
}

export async function handleRequest(req: Request): Promise<Response> {
  const diagnostics: RequestDiagnostics = { startedAt: Date.now(), providerAttempts: 0 };
  const deadline = diagnostics.startedAt + WALL_CLOCK_BUDGET_MS;

  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS_HEADERS });
  if (req.method !== 'POST') {
    return returnResponse({ error: 'Method not allowed' }, 405, undefined, diagnostics);
  }

  try {
    // Avoid parsing a stale or non-browser caller's legacy multi-megabyte payload.
    const declaredLength = Number(req.headers.get('content-length') || 0);
    if (declaredLength > 250_000) {
      console.warn('[generate-lesson-quizzes] request rejected by size guard', { requestBytes: declaredLength });
      return returnResponse(
        { error: 'Quiz generation request is too large', code: 'REQUEST_TOO_LARGE' },
        413,
        undefined,
        diagnostics,
      );
    }

    const payload: GeneratePayload = await req.json();
    if (!payload.plan || !payload.subject || !Array.isArray(payload.periods)) {
      console.error('[generate-lesson-quizzes] invalid payload', {
        hasPlan: Boolean(payload.plan),
        hasSubject: Boolean(payload.subject),
        periodsIsArray: Array.isArray(payload.periods),
      });
      return returnResponse({ error: 'Invalid payload', code: 'INVALID_PAYLOAD' }, 400, undefined, diagnostics);
    }

    const prompt = buildCompactPrompt(payload);
    const zenKey = Deno.env.get('ZEN_API_KEY');
    const nvidiaKey = Deno.env.get('NVIDIA_API_KEY');
    let lastError: unknown;

    if (zenKey) {
      try {
        const result = await attemptGenerationWithValidation(
          prompt,
          zenKey,
          ZEN_API_URL,
          ZEN_MODEL,
          deadline,
          diagnostics,
        );
        console.log('[generate-lesson-quizzes] success', {
          provider: 'zen',
          executionMs: Date.now() - diagnostics.startedAt,
          totalProviderAttempts: diagnostics.providerAttempts,
        });
        return returnResponse(result, 200, undefined, diagnostics);
      } catch (err: any) {
        lastError = err;
        console.error('[generate-lesson-quizzes] provider failed final', {
          provider: 'zen',
          errorCode: diagnosticErrorCode(err),
          totalProviderAttempts: diagnostics.providerAttempts,
          executionMs: Date.now() - diagnostics.startedAt,
        });
      }
    } else {
      console.error('[generate-lesson-quizzes] ZEN_API_KEY missing');
    }

    if (nvidiaKey && remainingMs(deadline) > 0) {
      try {
        const result = await attemptGenerationWithValidation(
          prompt,
          nvidiaKey,
          NVIDIA_API_URL,
          NVIDIA_MODEL,
          deadline,
          diagnostics,
        );
        console.log('[generate-lesson-quizzes] success', {
          provider: 'nvidia',
          executionMs: Date.now() - diagnostics.startedAt,
          totalProviderAttempts: diagnostics.providerAttempts,
        });
        return returnResponse(result, 200, undefined, diagnostics);
      } catch (err: any) {
        lastError = err;
        console.error('[generate-lesson-quizzes] provider failed final', {
          provider: 'nvidia',
          errorCode: diagnosticErrorCode(err),
          totalProviderAttempts: diagnostics.providerAttempts,
          executionMs: Date.now() - diagnostics.startedAt,
        });
      }
    } else if (!nvidiaKey) {
      console.error('[generate-lesson-quizzes] NVIDIA_API_KEY missing');
    }

    const detail = lastError instanceof Error
      ? lastError.message.slice(0, 500)
      : 'No quiz generation provider configured';
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
      { error: err instanceof Error ? err.message.slice(0, 500) : 'Internal error', code: 'INTERNAL_ERROR' },
      500,
      undefined,
      diagnostics,
    );
  }
}

serve(handleRequest);
