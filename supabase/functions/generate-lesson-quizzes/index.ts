import { serve } from 'https://deno.land/std@0.224.0/http/server.ts';

const OPENROUTER_CHAT_API_URL = 'https://openrouter.ai/api/v1/chat/completions';
const OPENROUTER_EMBEDDINGS_API_URL = 'https://openrouter.ai/api/v1/embeddings';
const OPENROUTER_GENERATION_MODEL = 'nvidia/nemotron-3-super-120b-a12b:free';
const OPENROUTER_EMBEDDING_MODEL = 'nvidia/nemotron-3-embed-1b:free';
const GEMINI_API_URL = 'https://generativelanguage.googleapis.com/v1beta/interactions';
const GEMINI_36_MODEL = 'gemini-3.6-flash';
const GEMINI_35_LITE_MODEL = 'gemini-3.5-flash-lite';
// Production timings ranged from 18–82 seconds. Forty-five seconds retains the
// normal 18–40 second path while preventing one pathological generation call
// from consuming the worker for the full 82-second outlier.
const AI_ATTEMPT_TIMEOUT_MS = 45_000;
const EMBEDDING_ATTEMPT_TIMEOUT_MS = 5_000;
const WALL_CLOCK_BUDGET_MS = 75_000;
// Embedding preprocessing and OpenRouter generation share the first 45 seconds.
// Gemini 3.6 may then use the remaining time except for the final 15 seconds
// reserved for Gemini 3.5 Flash-Lite.
const GOOGLE_FALLBACK_RESERVED_BUDGET_MS = 30_000;
const FINAL_GOOGLE_ATTEMPT_RESERVED_BUDGET_MS = 15_000;

// The request-global schedule is OpenRouter embedding → OpenRouter generation
// → Gemini 3.6 → Gemini 3.5 Flash-Lite. There are no duplicate transport or
// structural retries.
const MAX_PROVIDER_ATTEMPTS_PER_REQUEST = 4;
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
type ProviderName = 'openrouter-embedding' | 'openrouter' | 'gemini';

export interface EmbeddingBatch {
  inputs: string[];
  periodIndexes: number[];
}

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

/** Build one bounded embedding query plus same-subject period candidates. */
export function buildEmbeddingBatch(payload: GeneratePayload): EmbeddingBatch {
  const plan = payload.plan || {};
  const sourceSubject = boundedText(payload.subject || plan.subject, 160);
  const subject = boundedEducationalLabel(sourceSubject, 160, 'Lesson subject');
  const lessonTitle = boundedText(plan.title || plan.lesson_title, 320);
  const relevantPeriods = (payload.periods || [])
    .map((period, periodIndex) => ({ period, periodIndex }))
    .filter(({ period }) => {
      const periodSubject = boundedText(period?.subject, 160);
      return Boolean(period) && (!periodSubject || periodSubject.toLowerCase() === sourceSubject.toLowerCase());
    })
    .slice(0, 24);

  const queryObjectives: string[] = [];
  const seenObjectives = new Set<string>();
  const addObjective = (value: unknown) => {
    const objective = boundedText(value, 220);
    const key = objective.toLowerCase();
    if (objective && !seenObjectives.has(key) && queryObjectives.length < 12) {
      seenObjectives.add(key);
      queryObjectives.push(objective);
    }
  };
  addObjective(plan.objective || plan.learning_objective);
  relevantPeriods.forEach(({ period }) => addObjective(period.objective || period.learning_objective));

  const query = [
    subject && `Subject: ${subject}`,
    lessonTitle && `Lesson title: ${lessonTitle}`,
    queryObjectives.length > 0 && `Learning objectives: ${queryObjectives.join('; ')}`,
    'Find the lesson periods most useful for balanced, age-appropriate assessment questions.',
  ].filter(Boolean).join(' | ').slice(0, 1_500);

  const inputs = [query];
  const periodIndexes: number[] = [];
  for (const { period, periodIndex } of relevantPeriods) {
    const number = boundedText(period.period_number ?? periodIndex + 1, 12);
    const topic = boundedText(period.topic, 180);
    const objective = boundedText(period.objective || period.learning_objective, 240);
    const activities = boundedText(period.activities, 280);
    const details = Array.isArray(period.details)
      ? period.details
          .slice(0, 4)
          .map((detail: any) => boundedText(detail?.activity, 120))
          .filter(Boolean)
      : [];
    const educationalParts = [
      topic && `Topic: ${topic}`,
      objective && `Objective: ${objective}`,
      activities && `Activities: ${activities}`,
      details.length > 0 && `Key actions: ${details.join('; ')}`,
    ].filter(Boolean);
    if (educationalParts.length === 0) continue;

    const candidate = [`Period ${number}`, ...educationalParts].join(' | ').slice(0, 900);
    inputs.push(candidate);
    periodIndexes.push(periodIndex);
  }

  return { inputs, periodIndexes };
}

function embeddingVector(value: unknown, expectedLength?: number): number[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > 8_192) {
    throw new Error('Embedding response contains an invalid vector length');
  }
  if (expectedLength !== undefined && value.length !== expectedLength) {
    throw new Error('Embedding response contains inconsistent vector dimensions');
  }
  const vector = value as number[];
  if (vector.some((entry) => typeof entry !== 'number' || !Number.isFinite(entry))) {
    throw new Error('Embedding response contains a non-finite vector value');
  }
  return vector;
}

function cosineSimilarity(left: number[], right: number[]): number {
  let dot = 0;
  let leftMagnitude = 0;
  let rightMagnitude = 0;
  for (let index = 0; index < left.length; index += 1) {
    dot += left[index] * right[index];
    leftMagnitude += left[index] * left[index];
    rightMagnitude += right[index] * right[index];
  }
  if (leftMagnitude === 0 || rightMagnitude === 0) {
    throw new Error('Embedding response contains a zero-magnitude vector');
  }
  if (!Number.isFinite(dot) || !Number.isFinite(leftMagnitude) || !Number.isFinite(rightMagnitude)) {
    throw new Error('Embedding response produces an invalid cosine similarity');
  }
  const denominator = Math.sqrt(leftMagnitude) * Math.sqrt(rightMagnitude);
  const similarity = dot / denominator;
  if (!Number.isFinite(denominator) || !Number.isFinite(similarity)) {
    throw new Error('Embedding response produces an invalid cosine similarity');
  }
  return similarity;
}

/**
 * Select relevant periods only when the deterministic context would truncate.
 * Selected periods are restored to their original order so lesson chronology is
 * preserved. Invalid embeddings throw and the caller retains the original order.
 */
export function rankPeriodsByEmbeddings(
  payload: GeneratePayload,
  batch: EmbeddingBatch,
  data: unknown,
): GeneratePayload {
  const items = Array.isArray(data) ? data : [];
  if (items.length !== batch.inputs.length || batch.periodIndexes.length !== batch.inputs.length - 1) {
    throw new Error('Embedding response count does not match request inputs');
  }

  const byIndex = new Map<number, unknown>();
  for (const item of items) {
    const index = (item as any)?.index;
    if (!Number.isInteger(index) || index < 0 || index >= batch.inputs.length || byIndex.has(index)) {
      throw new Error('Embedding response contains an invalid index');
    }
    byIndex.set(index, (item as any)?.embedding);
  }

  const queryVector = embeddingVector(byIndex.get(0));
  const scores = batch.periodIndexes.map((periodIndex, candidateIndex) => ({
    periodIndex,
    sourceOrder: candidateIndex,
    score: cosineSimilarity(
      queryVector,
      embeddingVector(byIndex.get(candidateIndex + 1), queryVector.length),
    ),
  }));

  if (!buildCompactLessonContext(payload).includes('[context truncated]')) return payload;

  scores.sort((left, right) => right.score - left.score || left.sourceOrder - right.sourceOrder);
  const selected = new Set<number>();
  for (const candidate of scores) {
    const proposed = new Set(selected).add(candidate.periodIndex);
    const proposedPayload: GeneratePayload = {
      ...payload,
      periods: [...proposed]
        .sort((left, right) => left - right)
        .map((periodIndex) => payload.periods[periodIndex])
        .filter(Boolean),
    };
    if (!buildCompactLessonContext(proposedPayload).includes('[context truncated]')) {
      selected.add(candidate.periodIndex);
    }
  }

  if (selected.size === 0) return payload;
  return {
    ...payload,
    periods: [...selected]
      .sort((left, right) => left - right)
      .map((periodIndex) => payload.periods[periodIndex])
      .filter(Boolean),
  };
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
  // Reasoning fields are deliberately ignored: only final answer content may
  // enter JSON parsing and application validation.
  const raw = (
    typeof message.content === 'string'
      ? message.content
      : typeof choice?.text === 'string'
        ? choice.text
        : ''
  ).trim();
  return {
    raw,
    finishReason: typeof choice?.finish_reason === 'string' ? choice.finish_reason : null,
  };
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
  if (url === OPENROUTER_EMBEDDINGS_API_URL) return 'openrouter-embedding';
  if (url === GEMINI_API_URL) return 'gemini';
  return 'openrouter';
}

// Both OpenRouter structured outputs and Gemini Interactions receive the same
// exact 3×4 JSON Schema. Application validation still checks semantic
// constraints such as non-empty/distinct options before returning.
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

/**
 * Make the one advisory embedding call. Any transport, JSON, or vector error is
 * allowed to escape so the handler can retain deterministic period order and
 * continue to generation without a retry.
 */
async function preprocessPeriodsWithEmbeddings(
  payload: GeneratePayload,
  apiKey: string,
  deadline: number,
  diagnostics: RequestDiagnostics,
): Promise<GeneratePayload> {
  const batch = buildEmbeddingBatch(payload);
  if (batch.periodIndexes.length === 0) {
    console.log('[generate-lesson-quizzes] embedding preprocessing skipped', {
      provider: 'openrouter-embedding',
      model: OPENROUTER_EMBEDDING_MODEL,
      reason: 'no_candidates',
      totalProviderAttempts: diagnostics.providerAttempts,
      executionMs: Date.now() - diagnostics.startedAt,
    });
    return payload;
  }
  if (diagnostics.providerAttempts >= MAX_PROVIDER_ATTEMPTS_PER_REQUEST) {
    const guardError: any = new Error('Provider attempt guard reached');
    guardError.code = 'PROVIDER_ATTEMPT_GUARD';
    throw guardError;
  }

  const remaining = remainingMs(deadline);
  if (remaining <= 0) {
    const budgetError: any = new Error('Embedding preprocessing budget exceeded');
    budgetError.code = 'EMBEDDING_BUDGET_EXCEEDED';
    throw budgetError;
  }

  diagnostics.providerAttempts += 1;
  const attempt = diagnostics.providerAttempts;
  const inputChars = batch.inputs.reduce((total, input) => total + input.length, 0);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), Math.min(EMBEDDING_ATTEMPT_TIMEOUT_MS, remaining));
  const startedAt = Date.now();
  let httpStatus: number | null = null;
  let responseChars: number | null = null;
  let responseBytes: number | null = null;
  let validJson: boolean | null = null;
  let validationResult: 'not_run' | 'passed' | 'failed' = 'not_run';

  console.log('[generate-lesson-quizzes] provider request', {
    provider: 'openrouter-embedding',
    model: OPENROUTER_EMBEDDING_MODEL,
    strategy: 'preprocessing',
    attempt,
    inputCount: batch.inputs.length,
    candidateCount: batch.periodIndexes.length,
    inputChars,
    totalProviderAttempts: diagnostics.providerAttempts,
  });

  try {
    const response = await fetch(OPENROUTER_EMBEDDINGS_API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: OPENROUTER_EMBEDDING_MODEL,
        input: batch.inputs,
        encoding_format: 'float',
      }),
      signal: controller.signal,
    });
    httpStatus = response.status;
    let responseText = await response.text();
    responseChars = responseText.length;
    responseBytes = new TextEncoder().encode(responseText).byteLength;
    if (!response.ok) {
      const err: any = new Error(`Embedding API error: HTTP ${response.status}`);
      err.status = response.status;
      err.code = 'PROVIDER_HTTP_ERROR';
      throw err;
    }

    let envelope: any;
    try {
      envelope = JSON.parse(responseText);
      responseText = '';
      validJson = true;
    } catch {
      validJson = false;
      const err: any = new Error('Embedding provider returned invalid JSON');
      err.code = 'INVALID_EMBEDDING_JSON';
      throw err;
    }

    let rankedPayload: GeneratePayload;
    try {
      rankedPayload = rankPeriodsByEmbeddings(payload, batch, envelope?.data);
      validationResult = 'passed';
    } catch (err) {
      validationResult = 'failed';
      throw err;
    }

    console.log('[generate-lesson-quizzes] embedding metadata', {
      provider: 'openrouter-embedding',
      model: OPENROUTER_EMBEDDING_MODEL,
      strategy: 'preprocessing',
      attempt,
      httpStatus,
      validJson,
      validationResult,
      quizCount: null,
      questionCounts: [],
      responseChars,
      responseBytes,
      latencyMs: Date.now() - startedAt,
      inputChars,
      inputCount: batch.inputs.length,
      candidateCount: batch.periodIndexes.length,
      rankingApplied: rankedPayload !== payload,
      selectedPeriodCount: rankedPayload.periods.length,
      executionMs: Date.now() - diagnostics.startedAt,
      totalProviderAttempts: diagnostics.providerAttempts,
    });
    return rankedPayload;
  } catch (err: any) {
    console.error('[generate-lesson-quizzes] embedding metadata', {
      provider: 'openrouter-embedding',
      model: OPENROUTER_EMBEDDING_MODEL,
      strategy: 'preprocessing',
      attempt,
      httpStatus,
      validJson,
      validationResult,
      quizCount: null,
      questionCounts: [],
      responseChars,
      responseBytes,
      latencyMs: Date.now() - startedAt,
      inputChars,
      inputCount: batch.inputs.length,
      candidateCount: batch.periodIndexes.length,
      executionMs: Date.now() - diagnostics.startedAt,
      rateLimited: httpStatus === 429,
      errorCode: typeof err?.code === 'string' ? err.code : diagnosticErrorCode(err),
      totalProviderAttempts: diagnostics.providerAttempts,
    });
    throw err;
  } finally {
    clearTimeout(timeout);
  }
}

async function sendProviderRequest(
  prompt: string,
  apiKey: string,
  signal: AbortSignal,
  url: string,
  model: string,
): Promise<Response> {
  // The provider body is serialized exactly once in this short-lived scope.
  if (url === GEMINI_API_URL) {
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

  const serializedRequest = JSON.stringify({
    model,
    messages: [
      {
        role: 'system',
        content: 'Generate rigorous school quizzes and return only the schema-conforming JSON result.',
      },
      { role: 'user', content: prompt },
    ],
    temperature: 0.7,
    top_p: 0.95,
    max_tokens: PROVIDER_MAX_TOKENS,
    stream: false,
    reasoning: {
      effort: 'minimal',
      exclude: true,
    },
    provider: {
      require_parameters: true,
    },
    response_format: {
      type: 'json_schema',
      json_schema: {
        name: 'lesson_quizzes',
        strict: true,
        schema: QUIZ_RESPONSE_SCHEMA,
      },
    },
  });
  return fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
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

  const output = provider === 'gemini' ? parseGeminiResponse(envelope) : parseProviderResponse(envelope);
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

/** Make one provider call and validate its complete structured result. */
async function attemptGenerationWithValidation(
  prompt: string,
  apiKey: string,
  url: string,
  model: string,
  deadline: number,
  diagnostics: RequestDiagnostics,
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
    return validateCandidateWithTelemetry(candidate, provider, model, 'initial', prompt.length, diagnostics);
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

    const edgeEnv = Deno.env;
    const openRouterKey = edgeEnv.get('OPENROUTER_API_KEY');
    const geminiKey = edgeEnv.get('GEMINI_API_KEY');
    const openRouterGenerationDeadline = deadline - GOOGLE_FALLBACK_RESERVED_BUDGET_MS;
    const gemini36Deadline = deadline - FINAL_GOOGLE_ATTEMPT_RESERVED_BUDGET_MS;
    const embeddingDeadline = Math.min(
      deadline,
      diagnostics.startedAt + EMBEDDING_ATTEMPT_TIMEOUT_MS,
    );
    const reportedMissingSecrets = new Set<string>();
    let generationPayload = payload;
    let lastError: unknown;

    if (openRouterKey) {
      try {
        generationPayload = await preprocessPeriodsWithEmbeddings(
          payload,
          openRouterKey,
          embeddingDeadline,
          diagnostics,
        );
      } catch (err) {
        // Embeddings are advisory. Preserve the original deterministic source
        // order, count the failed call, and continue to OpenRouter generation.
        console.warn('[generate-lesson-quizzes] embedding fallback applied', {
          provider: 'openrouter-embedding',
          model: OPENROUTER_EMBEDDING_MODEL,
          errorCode: diagnosticErrorCode(err),
          executionMs: Date.now() - diagnostics.startedAt,
          totalProviderAttempts: diagnostics.providerAttempts,
        });
      }
    } else {
      console.error('[generate-lesson-quizzes] OPENROUTER_API_KEY missing');
      reportedMissingSecrets.add('OPENROUTER_API_KEY');
    }

    const prompt = buildCompactPrompt(generationPayload);
    const routes: Array<{
      provider: ProviderName;
      model: string;
      url: string;
      apiKey: string | undefined;
      secretName: string;
      attemptDeadline: number;
    }> = [
      {
        provider: 'openrouter',
        model: OPENROUTER_GENERATION_MODEL,
        url: OPENROUTER_CHAT_API_URL,
        apiKey: openRouterKey,
        secretName: 'OPENROUTER_API_KEY',
        attemptDeadline: openRouterGenerationDeadline,
      },
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
