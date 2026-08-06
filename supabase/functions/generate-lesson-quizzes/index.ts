import { serve } from 'https://deno.land/std@0.224.0/http/server.ts';

const NVIDIA_API_URL = 'https://integrate.api.nvidia.com/v1/chat/completions';
const NVIDIA_MODEL = 'nvidia/nemotron-3-ultra-550b-a55b';
const ZEN_API_URL = 'https://opencode.ai/zen/v1/chat/completions';
const ZEN_MODEL = 'deepseek-v4-flash-free';
const AI_ATTEMPT_TIMEOUT_MS = 60_000;

// Retry / backoff tuning
const PROVIDER_MAX_RETRIES = 2; // retries on 529/429 before falling back
const VALIDATION_MAX_RETRIES = 2; // full-generation retries when structured-output validation fails
const BASE_BACKOFF_MS = 800;
const REPAIR_TIMEOUT_MS = 30_000;
const MAX_RESPONSE_BYTES_WARN = 50_000;

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
  unit_plans?: Array<Record<string, unknown>>;
}

export function errorMessage(err: unknown): string {
  if (err instanceof Error) return `${err.name}: ${err.message}`;
  return String(err);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function strip(value: string | null | undefined): string {
  return (value || '').replace(/\s+/g, ' ').trim();
}

/**
 * Requirement 5 & 9: Streamlined returnResponse with response size guard and memory diagnostics.
 * Serializes data once and measures responseBytes before returning.
 */
export function returnResponse(data: unknown, status = 200, init?: ResponseInit): Response {
  const serialized = typeof data === 'string' ? data : JSON.stringify(data);
  const responseBytes = serialized.length;

  // Requirement 6: Before returning
  console.log({ responseBytes });

  // Requirement 9: Response size guard
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
export function validateGeneratedQuiz(input: any): void {
  if (!input?.title?.trim()) throw new Error('Generated quiz is missing a title');
  if (!Array.isArray(input.questions) || input.questions.length < 3 || input.questions.length > 5) {
    throw new Error('Generated quiz must contain 3–5 questions');
  }
  const seen = new Set<string>();
  let directCount = 0;
  input.questions.forEach((q: any, index: number) => {
    const normalized = strip(q.question).toLowerCase();
    if (!normalized || seen.has(normalized)) throw new Error(`Generated quiz has duplicate/empty question at ${index + 1}`);
    seen.add(normalized);
    if (q.type === 'multiple_choice') {
      if (!Array.isArray(q.options) || q.options.length !== 4) throw new Error(`Question ${index + 1} must have exactly 4 options`);
      if (new Set(q.options.map((o: string) => strip(o).toLowerCase())).size !== 4) throw new Error(`Question ${index + 1} options are not distinct`);
      if (!Number.isInteger(q.correctIndex) || q.correctIndex < 0 || q.correctIndex > 3) throw new Error(`Question ${index + 1} has invalid correctIndex`);
    } else if (q.type === 'direct_answer') {
      directCount += 1;
      if (q.options && q.options.length > 0) throw new Error(`Direct-answer question ${index + 1} must not have options`);
      if (!strip(q.rubric)) throw new Error(`Direct-answer question ${index + 1} must have a rubric`);
    } else {
      throw new Error(`Question ${index + 1} has invalid type`);
    }
  });
  if (directCount < 1) throw new Error('Generated quiz must include at least one direct-answer question');
}

/**
 * Requirement 4: Streamlined validation that checks structure without copying or stringifying large JSON.
 */
export function validate(input: unknown): void {
  const quizzes = (input as any)?.quizzes;
  const expected = 3;
  if (!Array.isArray(quizzes) || quizzes.length !== expected) {
    throw new Error(`LLM must return exactly ${expected} quizzes`);
  }
  quizzes.forEach(validateGeneratedQuiz);
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

/**
 * Requirement 7: Compress lesson context into concise text instead of dumping raw JSON.
 * Requirement 8: Eliminate unnecessary unit_plans data completely.
 */
export function buildCompactLessonContext(payload: GeneratePayload): string {
  const plan = payload.plan || {};
  const className = strip(String(plan.class_name || plan.class || ''));
  const grade = strip(String(plan.grade || '')) || (className.match(/\d+/)?.[0] || className);
  const subject = strip(payload.subject || String(plan.subject || ''));
  const lessonTitle = strip(String(plan.title || plan.lesson_title || ''));

  // Requirement 1 & 8: Only the periods for this subject; omit unit_plans entirely.
  const subjectPeriods = (payload.periods || []).filter((p) => {
    if (!p) return false;
    const pSub = strip(String(p.subject || ''));
    return !pSub || pSub.toLowerCase() === subject.toLowerCase();
  });

  const topics = Array.from(new Set(subjectPeriods.map((p) => strip(String(p.topic || ''))).filter(Boolean)));

  const objectives = Array.from(
    new Set(
      subjectPeriods
        .map((p) => strip(String(p.objective || p.learning_objective || '')))
        .concat(strip(String(plan.objective || plan.learning_objective || '')))
        .filter(Boolean)
    )
  );

  const vocabItems = new Set<string>();
  const addVocab = (val: unknown) => {
    if (!val) return;
    if (Array.isArray(val)) {
      val.forEach((v) => {
        const s = strip(String(v || ''));
        if (s) vocabItems.add(s);
      });
    } else if (typeof val === 'string') {
      val.split(/[,;\n]/).forEach((v) => {
        const s = strip(v);
        if (s) vocabItems.add(s);
      });
    }
  };
  addVocab(plan.vocabulary);
  addVocab(plan.vocab);
  addVocab(plan.keywords);
  subjectPeriods.forEach((p) => {
    addVocab(p.vocabulary);
    addVocab(p.vocab);
    addVocab(p.keywords);
  });

  const activitiesList: string[] = [];
  subjectPeriods.forEach((p, idx) => {
    const periodNumber = p.period_number ?? (idx + 1);
    const parts: string[] = [];
    const topic = strip(String(p.topic || ''));
    if (topic) parts.push(`Topic: ${topic}`);
    const obj = strip(String(p.objective || ''));
    if (obj) parts.push(`Objective: ${obj}`);

    let actStr = strip(String(p.activities || ''));
    if (actStr) {
      if (actStr.length > 200) actStr = actStr.slice(0, 200) + '...';
      parts.push(`Activity: ${actStr}`);
    }
    if (Array.isArray(p.details) && p.details.length > 0) {
      const detailActs = p.details
        .map((d: any) => strip(String(d?.activity || '')))
        .filter(Boolean)
        .slice(0, 4);
      if (detailActs.length > 0) {
        parts.push(`Key actions: ${detailActs.join('; ')}`);
      }
    }
    if (parts.length > 0) {
      activitiesList.push(`[Period ${periodNumber}] ${parts.join(' | ')}`);
    }
  });

  const lines: string[] = [];
  if (className) lines.push(`Class: ${className}`);
  if (grade) lines.push(`Grade: ${grade}`);
  if (subject) lines.push(`Subject: ${subject}`);
  lines.push('');

  if (lessonTitle) {
    lines.push('Lesson:');
    lines.push(lessonTitle);
    lines.push('');
  }
  if (topics.length > 0) {
    lines.push('Topics:');
    topics.forEach((t) => lines.push(`- ${t}`));
    lines.push('');
  }
  if (objectives.length > 0) {
    lines.push('Objectives:');
    objectives.forEach((o) => lines.push(`- ${o}`));
    lines.push('');
  }
  if (vocabItems.size > 0) {
    lines.push('Vocabulary:');
    vocabItems.forEach((v) => lines.push(`- ${v}`));
    lines.push('');
  }
  if (activitiesList.length > 0) {
    lines.push('Activities:');
    activitiesList.forEach((a) => lines.push(a));
    lines.push('');
  }

  let text = lines.join('\n').trim();
  if (text.length > 4500) {
    text = text.slice(0, 4500) + '\n... [truncated for token budget]';
  }
  return text;
}

/**
 * Requirement 1: Build a minimal prompt (< 6000 chars target, hard limit 8000).
 * Requirement 3: Request only fields actually consumed (explanation for MCQ, rubric for direct answer).
 */
export function buildCompactPrompt(payload: GeneratePayload): string {
  const quizCount = payload.quiz_count ?? 3;
  const questionsPerQuiz = payload.questions_per_quiz ?? 4;
  const directAnswerMin = payload.direct_answer_min ?? 1;

  const prompt = `Generate lesson-plan quizzes as strict JSON only.

Required schema:
{
  "quizzes": [
    {
      "title": "string",
      "questions": [
        {
          "type": "multiple_choice",
          "question": "string",
          "options": ["A option", "B option", "C option", "D option"],
          "correctIndex": 0,
          "explanation": "brief explanation"
        },
        {
          "type": "direct_answer",
          "question": "string",
          "rubric": "brief scoring rubric"
        }
      ]
    }
  ]
}

Rules:
- Return exactly ${quizCount} quizzes.
- Each quiz has exactly ${questionsPerQuiz} questions.
- Each quiz must include at least ${directAnswerMin} direct_answer question(s).
- multiple_choice: exactly 4 options, correctIndex 0-3, and an explanation. Do NOT include a rubric field.
- CRITICAL: All 4 multiple_choice options must be pairwise distinct after trimming whitespace and ignoring case (e.g. "24 + 18" and "24+18" or "Berlin" and " berlin " count as duplicates and will be rejected). Each distractor must represent a DIFFERENT plausible misconception.
- direct_answer: provide a non-empty rubric. Do NOT include options, correctIndex, or explanation fields.
- Questions must be specific to the lesson objective/topic/activity and age-appropriate for the grade.
- No repeated question stems inside a quiz.
- Output only valid JSON, no markdown fences.

Example multiple_choice question (4 distinct options):
{
  "type": "multiple_choice",
  "question": "Muna has 24 pencils and gets 18 more. Which sum should she solve?",
  "options": ["24 + 18", "24 - 18", "18 × 2", "24 + 8"],
  "correctIndex": 0,
  "explanation": "We add 24 and 18 to find the total pencils."
}

Lesson Context:
${buildCompactLessonContext(payload)}`;

  // Enforce hard maximum of 8000 characters
  if (prompt.length > 8000) {
    return prompt.slice(0, 8000);
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

function parseJson(content: string) {
  const cleaned = content.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '');
  return JSON.parse(cleaned);
}

function isRetriableStatus(status: number): boolean {
  return status === 429 || status === 529 || status === 502 || status === 503 || status === 504;
}

/**
 * Requirement 2: Reduced token budget (1800 max_tokens).
 * Requirement 6: Measure memory hotspots (promptChars before call, responseChars after response).
 */
async function callProvider(
  prompt: string,
  apiKey: string,
  signal: AbortSignal,
  url = ZEN_API_URL,
  model = ZEN_MODEL,
): Promise<{ parsed: unknown; raw: string }> {
  // Requirement 6: Before provider call
  console.log({ promptChars: prompt.length });
  console.log('[generate-lesson-quizzes] provider request', { provider: url === NVIDIA_API_URL ? 'nvidia' : 'zen', model, promptChars: prompt.length });

  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      model,
      messages: [
        { role: 'system', content: 'You generate rigorous school quiz questions from lesson plans. Output only valid JSON.' },
        { role: 'user', content: prompt },
      ],
      temperature: 0.7,
      top_p: 0.9,
      max_tokens: 1800,
      stream: false,
    }),
    signal,
  });

  if (!response.ok) {
    const body = await response.text();
    console.error('[generate-lesson-quizzes] provider error', { provider: url === NVIDIA_API_URL ? 'nvidia' : 'zen', model, status: response.status, body: body.slice(0, 1000) });
    const err: any = new Error(`${model} API error: ${response.status} ${body.slice(0, 500)}`);
    err.status = response.status;
    err.body = body;
    throw err;
  }

  const body = await response.json();
  const raw: string = body.choices?.[0]?.message?.content;
  if (!raw) throw new Error('Empty LLM response');

  // Requirement 6: After provider response
  console.log({ responseChars: raw.length });

  const parsed = parseJson(raw);
  return { parsed, raw };
}

async function callProviderWithRetry(
  prompt: string,
  apiKey: string,
  url: string,
  model: string,
  timeoutMs: number,
): Promise<{ parsed: unknown; raw: string }> {
  let lastError: unknown;
  for (let attempt = 0; attempt <= PROVIDER_MAX_RETRIES; attempt++) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const result = await callProvider(prompt, apiKey, controller.signal, url, model);
      clearTimeout(timeout);
      if (attempt > 0) console.log('[generate-lesson-quizzes] provider retry succeeded', { provider: url === NVIDIA_API_URL ? 'nvidia' : 'zen', attempt: attempt + 1 });
      return result;
    } catch (err: any) {
      clearTimeout(timeout);
      lastError = err;
      const status: number | undefined = err?.status;
      const isAbort = err?.name === 'AbortError';
      const retriable = !isAbort && status !== undefined && isRetriableStatus(status);
      console.error('[generate-lesson-quizzes] provider attempt failed', {
        provider: url === NVIDIA_API_URL ? 'nvidia' : 'zen',
        attempt: attempt + 1,
        status,
        retriable,
        error: errorMessage(err).slice(0, 1000),
      });
      if (!retriable || attempt === PROVIDER_MAX_RETRIES) break;
      const backoff = BASE_BACKOFF_MS * Math.pow(2, attempt) + Math.random() * 400;
      console.log('[generate-lesson-quizzes] backing off before retry', { ms: Math.round(backoff), nextAttempt: attempt + 2 });
      await sleep(backoff);
    }
  }
  throw lastError;
}

async function attemptGenerationWithValidation(
  prompt: string,
  apiKey: string,
  url: string,
  model: string,
): Promise<{ parsed: unknown; raw: string }> {
  let lastParsed: unknown = null;
  let lastRaw: string | null = null;
  let lastValidationError: unknown = null;

  for (let attempt = 0; attempt <= VALIDATION_MAX_RETRIES; attempt++) {
    let result: { parsed: unknown; raw: string };
    try {
      result = await callProviderWithRetry(prompt, apiKey, url, model, attempt === 0 ? AI_ATTEMPT_TIMEOUT_MS : REPAIR_TIMEOUT_MS);
    } catch (err) {
      throw err; // provider error bubbles to fallback logic
    }
    lastParsed = result.parsed;
    lastRaw = result.raw;

    try {
      validate(result.parsed);
      console.log('[generate-lesson-quizzes] validation passed', { provider: url === NVIDIA_API_URL ? 'nvidia' : 'zen', attempt: attempt + 1 });
      return result;
    } catch (validationErr) {
      lastValidationError = validationErr;
      const offending = findOffendingQuestions(result.parsed);
      console.error('[generate-lesson-quizzes] validation failed', {
        provider: url === NVIDIA_API_URL ? 'nvidia' : 'zen',
        attempt: attempt + 1,
        error: errorMessage(validationErr),
        offending,
        rawExcerpt: result.raw.slice(0, 1500),
      });

      const isDistinctError = /options are not distinct/i.test(errorMessage(validationErr));
      const canRepair = isDistinctError && offending.length > 0 && offending.length <= 2 && attempt < VALIDATION_MAX_RETRIES;

      if (canRepair) {
        console.log('[generate-lesson-quizzes] attempting targeted repair', { offending });
        const repairPrompt = buildRepairPrompt(result.parsed, offending);
        try {
          const repaired = await callProviderWithRetry(repairPrompt, apiKey, url, model, REPAIR_TIMEOUT_MS);
          try {
            validate(repaired.parsed);
            console.log('[generate-lesson-quizzes] repair validation passed', { provider: url === NVIDIA_API_URL ? 'nvidia' : 'zen' });
            return repaired;
          } catch (repairValidationErr) {
            console.error('[generate-lesson-quizzes] repair still invalid', {
              provider: url === NVIDIA_API_URL ? 'nvidia' : 'zen',
              error: errorMessage(repairValidationErr),
              rawExcerpt: repaired.raw.slice(0, 1500),
            });
            lastParsed = repaired.parsed;
            lastRaw = repaired.raw;
            lastValidationError = repairValidationErr;
          }
        } catch (repairErr) {
          console.error('[generate-lesson-quizzes] repair call failed', { error: errorMessage(repairErr) });
        }
      }

      if (attempt === VALIDATION_MAX_RETRIES) {
        console.error('[generate-lesson-quizzes] validation failed final', {
          provider: url === NVIDIA_API_URL ? 'nvidia' : 'zen',
          error: errorMessage(validationErr),
          rawExcerpt: lastRaw?.slice(0, 2000),
        });
        const err: any = new Error(`Quiz generation returned invalid structured output: ${errorMessage(validationErr)}`);
        err.raw = lastRaw;
        err.parsed = lastParsed;
        err.validationError = validationErr;
        throw err;
      }

      const backoff = 500 * (attempt + 1);
      console.log('[generate-lesson-quizzes] full retry after validation failure', { nextAttempt: attempt + 2, backoff });
      await sleep(backoff);
    }
  }

  const err: any = new Error(`Quiz generation returned invalid structured output: ${errorMessage(lastValidationError)}`);
  err.raw = lastRaw;
  err.parsed = lastParsed;
  throw err;
}

serve(async (req: Request) => {
  const startedAt = Date.now();
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS_HEADERS });
  if (req.method !== 'POST') return returnResponse({ error: 'Method not allowed' }, 405);

  try {
    const payload: GeneratePayload = await req.json();
    if (!payload.plan || !payload.subject || !Array.isArray(payload.periods)) {
      console.error('[generate-lesson-quizzes] invalid payload', { hasPlan: !!payload.plan, subject: payload.subject, periodsIsArray: Array.isArray(payload.periods) });
      return returnResponse({ error: 'Invalid payload', code: 'INVALID_PAYLOAD' }, 400);
    }

    // Requirement 1: Build minimal prompt (< 6000 chars target, hard limit 8000)
    const prompt = buildCompactPrompt(payload);

    // Provider order: Zen primary (fastest path under 3-min watchdog, ~21s), NVIDIA Nemotron fallback.
    const zenKey = Deno.env.get('ZEN_API_KEY');
    const nvidiaKey = Deno.env.get('NVIDIA_API_KEY');
    let lastError: unknown;
    let lastRaw: string | null = null;

    if (zenKey) {
      try {
        const result = await attemptGenerationWithValidation(prompt, zenKey, ZEN_API_URL, ZEN_MODEL);
        console.log('[generate-lesson-quizzes] success', { provider: 'zen', ms: Date.now() - startedAt });
        return returnResponse(result.parsed);
      } catch (err: any) {
        lastError = err;
        lastRaw = err?.raw ?? null;
        console.error('[generate-lesson-quizzes] zen failed final', { error: errorMessage(err), ms: Date.now() - startedAt });
      }
    } else {
      console.error('[generate-lesson-quizzes] ZEN_API_KEY missing');
    }

    if (nvidiaKey) {
      try {
        const result = await attemptGenerationWithValidation(prompt, nvidiaKey, NVIDIA_API_URL, NVIDIA_MODEL);
        console.log('[generate-lesson-quizzes] success', { provider: 'nvidia', ms: Date.now() - startedAt });
        return returnResponse(result.parsed);
      } catch (err: any) {
        lastError = err;
        lastRaw = err?.raw ?? lastRaw;
        console.error('[generate-lesson-quizzes] nvidia failed final', { error: errorMessage(err), ms: Date.now() - startedAt });
      }
    } else {
      console.error('[generate-lesson-quizzes] NVIDIA_API_KEY missing');
    }

    const detail = lastError instanceof Error ? lastError.message : 'No quiz generation provider configured';
    console.error('[generate-lesson-quizzes] failed all providers', {
      error: detail,
      ms: Date.now() - startedAt,
      rawExcerpt: lastRaw?.slice(0, 2000) ?? null,
    });
    return returnResponse(
      {
        error: detail,
        code: 'QUIZ_GENERATION_FAILED',
        provider: 'all',
        raw_excerpt: lastRaw?.slice(0, 1500) ?? undefined,
      },
      502,
    );
  } catch (err) {
    console.error('[generate-lesson-quizzes] internal error', { error: errorMessage(err), ms: Date.now() - startedAt });
    return returnResponse({ error: err instanceof Error ? err.message : 'Internal error', code: 'INTERNAL_ERROR' }, 500);
  }
});
