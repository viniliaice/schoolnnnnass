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

// One retry preserves recovery from transient 429/5xx responses without the old
// nested 30-call worst case. A hard request-level guard prevents future loops.
const PROVIDER_MAX_RETRIES = 1;
const MAX_PROVIDER_ATTEMPTS_PER_REQUEST = 8;
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
  const providerAttempts = diagnostics?.providerAttempts;

  console.log({ responseBytes, executionMs, providerAttempts });
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

function findOffendingQuestions(input: unknown): Array<{ quizIndex: number; questionIndex: number }> {
  const result: Array<{ quizIndex: number; questionIndex: number }> = [];
  const quizzes = (input as any)?.quizzes;
  if (!Array.isArray(quizzes)) return result;
  quizzes.forEach((quiz: any, qi: number) => {
    if (!Array.isArray(quiz.questions)) return;
    quiz.questions.forEach((q: any, qIdx: number) => {
      if (q.type === 'multiple_choice' && Array.isArray(q.options) && q.options.length === 4) {
        if (new Set(q.options.map((o: string) => strip(o).toLowerCase())).size !== 4) {
          result.push({ quizIndex: qi, questionIndex: qIdx });
        }
      }
    });
  });
  return result;
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
  const directAnswerMin = 1;
  const instructions = `Generate rigorous, age-appropriate quizzes from the lesson context. Return JSON only.

Exact schema (no extra fields):
{"quizzes":[{"title":"string","questions":[{"type":"multiple_choice","question":"string","options":["string","string","string","string"],"correctIndex":0,"explanation":"one short sentence"},{"type":"direct_answer","question":"string","rubric":"one short scoring sentence"}]}]}

Quiz settings and rules:
- Exactly ${quizCount} quizzes and exactly ${questionsPerQuiz} questions in each quiz.
- At least ${directAnswerMin} direct_answer question in each quiz; use multiple_choice for the others.
- Every multiple_choice has exactly 4 meaningful, pairwise-distinct options and correctIndex 0-3.
- Distractors must test different plausible misconceptions; do not vary only spacing or punctuation.
- Every direct_answer has a non-empty rubric and no options/correctIndex/explanation.
- Keep explanations and rubrics to one short sentence.
- Use only the supplied lesson title, objectives, topics, vocabulary, activities, class, grade, and subject.
- Do not repeat question stems within a quiz. Do not output markdown.

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

function buildRepairPrompt(original: unknown, offending: Array<{ quizIndex: number; questionIndex: number }>): string {
  const offendersDesc = offending.map(({ quizIndex, questionIndex }) => `quiz ${quizIndex + 1} question ${questionIndex + 1}`).join(', ');
  const origStr = typeof original === 'string' ? original : JSON.stringify(original);
  const truncatedOrig = origStr.length > 3000 ? origStr.slice(0, 3000) + '... [truncated]' : origStr;
  return `You previously generated quizzes but the following questions failed validation because their 4 answer options were not distinct (duplicates after trimming whitespace and ignoring case): ${offendersDesc}.

Fix ONLY those questions. For each offending multiple_choice question, regenerate its "options" array so all 4 strings are pairwise distinct after trimming and lowercasing, and each distractor represents a different plausible misconception. Keep the same question stem, correct answer position (correctIndex), and all other quizzes/questions exactly as they were.

Return the FULL JSON again with the same schema:
{ "quizzes": [...] }

Offending indices: ${JSON.stringify(offending)}

Original JSON you produced:
${truncatedOrig}

Rules for the fix:
- Each fixed question must have exactly 4 distinct options (case-insensitive, whitespace-insensitive).
- Do not create near-duplicates like "24 + 18" vs "24+18".
- Keep correctIndex pointing to the correct answer.
- Output only valid JSON, no markdown fences.`;
}

function parseQuizJson(content: string): unknown {
  let cleaned = content.trim();
  if (cleaned.startsWith('```')) {
    const firstLineEnd = cleaned.indexOf('\n');
    cleaned = firstLineEnd >= 0 ? cleaned.slice(firstLineEnd + 1) : cleaned.slice(3);
    if (cleaned.trimEnd().endsWith('```')) {
      cleaned = cleaned.trimEnd().slice(0, -3).trimEnd();
    }
  }
  return JSON.parse(cleaned);
}

/** Extract only the completion text needed by quiz parsing from the provider envelope. */
export function parseProviderResponse(body: unknown): ProviderOutput {
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
  return status === 429 || status === 529 || status === 502 || status === 503 || status === 504;
}

async function sendProviderRequest(
  prompt: string,
  apiKey: string,
  signal: AbortSignal,
  url: string,
  model: string,
): Promise<Response> {
  // The provider body is serialized exactly once in this short-lived scope.
  // Nemotron 3.5's published sampling values are used for the NVIDIA fallback,
  // but thinking is disabled so its bounded output budget is reserved for the
  // client-consumed quiz JSON rather than an unused reasoning trace.
  const isNvidia = url === NVIDIA_API_URL;
  const serializedRequest = JSON.stringify({
    model,
    messages: [
      { role: 'system', content: 'Generate rigorous school quizzes. Return only valid JSON.' },
      { role: 'user', content: prompt },
    ],
    temperature: isNvidia ? 1 : 0.7,
    top_p: isNvidia ? 0.95 : 0.9,
    max_tokens: PROVIDER_MAX_TOKENS,
    stream: false,
    ...(isNvidia ? { chat_template_kwargs: { enable_thinking: false } } : {}),
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
  const provider = url === NVIDIA_API_URL ? 'nvidia' : 'zen';
  console.log({ promptChars: prompt.length });
  console.log('[generate-lesson-quizzes] provider request', {
    provider,
    model,
    attempt: diagnostics.providerAttempts,
    maxTokens: PROVIDER_MAX_TOKENS,
  });

  const response = await sendProviderRequest(prompt, apiKey, signal, url, model);
  if (!response.ok) {
    const bodyExcerpt = (await response.text()).slice(0, 500);
    console.error('[generate-lesson-quizzes] provider error', {
      provider,
      model,
      status: response.status,
      bodyExcerpt,
    });
    const err: any = new Error(`${model} API error: ${response.status} ${bodyExcerpt}`);
    err.status = response.status;
    throw err;
  }

  const envelope: unknown = await response.json();
  const output = parseProviderResponse(envelope);
  if (!output.raw) {
    console.error('[generate-lesson-quizzes] provider returned empty content', {
      provider,
      model,
      status: response.status,
      finishReason: output.finishReason,
      bodyKeys: envelope && typeof envelope === 'object' ? Object.keys(envelope) : [],
    });
    const err: any = new Error('Empty LLM response');
    err.status = response.status;
    err.retriable = true;
    throw err;
  }

  console.log({ responseChars: output.raw.length });
  return output;
}

async function callProviderWithRetry(
  prompt: string,
  apiKey: string,
  url: string,
  model: string,
  timeoutMs: number,
  deadline: number,
  diagnostics: RequestDiagnostics,
): Promise<ProviderOutput> {
  let lastError: unknown;
  for (let attempt = 0; attempt <= PROVIDER_MAX_RETRIES; attempt++) {
    const remaining = remainingMs(deadline);
    if (remaining <= 0) {
      const budgetError: any = new Error('Quiz generation wall-clock budget exceeded');
      budgetError.code = 'WALL_CLOCK_BUDGET_EXCEEDED';
      throw budgetError;
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), Math.min(timeoutMs, remaining));
    try {
      const output = await callProvider(prompt, apiKey, controller.signal, diagnostics, url, model);
      if (attempt > 0) {
        console.log('[generate-lesson-quizzes] provider retry succeeded', {
          provider: url === NVIDIA_API_URL ? 'nvidia' : 'zen',
          attempt: attempt + 1,
        });
      }
      return output;
    } catch (err: any) {
      lastError = err;
      const status: number | undefined = err?.status;
      const isAbort = err?.name === 'AbortError';
      const retriable = !isAbort && (err?.retriable === true || (status !== undefined && isRetriableStatus(status)));
      console.error('[generate-lesson-quizzes] provider attempt failed', {
        provider: url === NVIDIA_API_URL ? 'nvidia' : 'zen',
        attempt: attempt + 1,
        status,
        retriable,
        error: errorMessage(err).slice(0, 500),
      });
      if (!retriable || attempt === PROVIDER_MAX_RETRIES) break;
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
): Promise<unknown> {
  const output = await callProviderWithRetry(prompt, apiKey, url, model, timeoutMs, deadline, diagnostics);
  try {
    return parseQuizJson(output.raw);
  } catch (parseError) {
    console.error('[generate-lesson-quizzes] provider returned invalid JSON', {
      provider: url === NVIDIA_API_URL ? 'nvidia' : 'zen',
      model,
      finishReason: output.finishReason,
      rawExcerpt: output.raw.slice(0, 800),
    });
    const err: any = new Error(`Provider returned invalid JSON: ${errorMessage(parseError)}`);
    err.code = 'INVALID_PROVIDER_JSON';
    err.rawExcerpt = output.raw.slice(0, 800);
    throw err;
  }
}

/** Validate one generation and allow at most one bounded quality-recovery call. */
async function attemptGenerationWithValidation(
  prompt: string,
  apiKey: string,
  url: string,
  model: string,
  deadline: number,
  diagnostics: RequestDiagnostics,
): Promise<GeneratedQuizResponse> {
  let candidate: unknown;
  let recoveryUsed = false;
  try {
    candidate = await requestParsedCandidate(
      prompt,
      apiKey,
      url,
      model,
      AI_ATTEMPT_TIMEOUT_MS,
      deadline,
      diagnostics,
    );
  } catch (err: any) {
    if (err?.code !== 'INVALID_PROVIDER_JSON') throw err;
    recoveryUsed = true;
    const recoveryPrompt = `${prompt}\n\nYour previous output was not valid JSON. Return the exact schema only, with no markdown or commentary.`;
    candidate = await requestParsedCandidate(
      recoveryPrompt,
      apiKey,
      url,
      model,
      RECOVERY_ATTEMPT_TIMEOUT_MS,
      deadline,
      diagnostics,
    );
  }

  try {
    validateQuizResponse(candidate);
    console.log('[generate-lesson-quizzes] validation passed', {
      provider: url === NVIDIA_API_URL ? 'nvidia' : 'zen',
    });
    return normalizeQuizResponse(candidate);
  } catch (validationError) {
    if (recoveryUsed) {
      const err: any = new Error(`Quiz generation returned invalid structured output: ${errorMessage(validationError)}`);
      err.code = 'INVALID_QUIZ_RESPONSE';
      throw err;
    }

    const offending = findOffendingQuestions(candidate);
    const duplicateOptions = /options are not distinct/i.test(errorMessage(validationError));
    console.error('[generate-lesson-quizzes] validation failed', {
      provider: url === NVIDIA_API_URL ? 'nvidia' : 'zen',
      error: errorMessage(validationError).slice(0, 500),
      offending,
    });

    const recoveryPrompt = duplicateOptions && offending.length > 0 && offending.length <= 2
      ? buildRepairPrompt(candidate, offending)
      : `${prompt}\n\nThe previous response failed validation: ${errorMessage(validationError).slice(0, 240)}. Regenerate the exact schema only.`;
    const recovered = await requestParsedCandidate(
      recoveryPrompt,
      apiKey,
      url,
      model,
      RECOVERY_ATTEMPT_TIMEOUT_MS,
      deadline,
      diagnostics,
    );

    try {
      validateQuizResponse(recovered);
      console.log('[generate-lesson-quizzes] recovery validation passed', {
        provider: url === NVIDIA_API_URL ? 'nvidia' : 'zen',
      });
      return normalizeQuizResponse(recovered);
    } catch (recoveryValidationError) {
      console.error('[generate-lesson-quizzes] recovery validation failed', {
        provider: url === NVIDIA_API_URL ? 'nvidia' : 'zen',
        error: errorMessage(recoveryValidationError).slice(0, 500),
      });
      const err: any = new Error(`Quiz generation returned invalid structured output: ${errorMessage(recoveryValidationError)}`);
      err.code = 'INVALID_QUIZ_RESPONSE';
      throw err;
    }
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
    let lastRawExcerpt: string | undefined;

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
          providerAttempts: diagnostics.providerAttempts,
        });
        return returnResponse(result, 200, undefined, diagnostics);
      } catch (err: any) {
        lastError = err;
        lastRawExcerpt = typeof err?.rawExcerpt === 'string' ? err.rawExcerpt.slice(0, 800) : undefined;
        console.error('[generate-lesson-quizzes] zen failed final', {
          error: errorMessage(err).slice(0, 500),
          providerAttempts: diagnostics.providerAttempts,
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
          providerAttempts: diagnostics.providerAttempts,
        });
        return returnResponse(result, 200, undefined, diagnostics);
      } catch (err: any) {
        lastError = err;
        lastRawExcerpt = typeof err?.rawExcerpt === 'string' ? err.rawExcerpt.slice(0, 800) : lastRawExcerpt;
        console.error('[generate-lesson-quizzes] nvidia failed final', {
          error: errorMessage(err).slice(0, 500),
          providerAttempts: diagnostics.providerAttempts,
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
      error: detail,
      providerAttempts: diagnostics.providerAttempts,
      executionMs: Date.now() - diagnostics.startedAt,
    });
    return returnResponse(
      {
        error: detail,
        code: 'QUIZ_GENERATION_FAILED',
        provider: 'all',
        raw_excerpt: lastRawExcerpt,
      },
      502,
      undefined,
      diagnostics,
    );
  } catch (err) {
    console.error('[generate-lesson-quizzes] internal error', {
      error: errorMessage(err).slice(0, 500),
      providerAttempts: diagnostics.providerAttempts,
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
