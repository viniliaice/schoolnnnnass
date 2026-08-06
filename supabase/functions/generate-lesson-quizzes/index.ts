import { serve } from 'https://deno.land/std@0.224.0/http/server.ts';

const NVIDIA_API_URL = 'https://integrate.api.nvidia.com/v1/chat/completions';
const NVIDIA_MODEL = 'nvidia/nemotron-3-ultra-550b-a55b';
// Production logs reported nvidia provider as deepseek-ai/deepseek-v4-flash with 529.
// Keep NVIDIA_MODEL as configured via env if needed, but default above is the current deployment value.
const ZEN_API_URL = 'https://opencode.ai/zen/v1/chat/completions';
const ZEN_MODEL = 'deepseek-v4-flash-free';
const AI_ATTEMPT_TIMEOUT_MS = 120_000;

// Retry / backoff tuning
const PROVIDER_MAX_RETRIES = 2; // retries on 529/429 before falling back
const VALIDATION_MAX_RETRIES = 2; // full-generation retries when structured-output validation fails
const BASE_BACKOFF_MS = 800;
const REPAIR_TIMEOUT_MS = 60_000;

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

function corsResponse(body: unknown, init?: ResponseInit): Response {
  return new Response(JSON.stringify(body), {
    ...init,
    headers: { ...CORS_HEADERS, 'Content-Type': 'application/json', ...init?.headers },
  });
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) return `${err.name}: ${err.message}`;
  return String(err);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function strip(value: string | null | undefined): string {
  return (value || '').replace(/\s+/g, ' ').trim();
}

// ── Validation (mirrors src/lib/quizGenerationValidation.ts) ───────────────
// "not distinct" means: after trimming, collapsing internal whitespace to a
// single space, and lowercasing, the 4 option strings are not all unique.
// It is case-insensitive and whitespace-insensitive, but punctuation-sensitive.
// e.g. "24 + 18" vs "24+18" → collapsed to "24 + 18" vs "24+18" → considered
// distinct (different strings). "Berlin" vs " berlin " → both → "berlin" →
// duplicate → validation fails. This catches real duplicates, not false
// positives from trivial whitespace/case differences — those ARE correctly
// flagged as duplicates because a student sees them as the same answer.
function validateGeneratedQuiz(input: any): void {
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

function validateGeneratedResponse(input: unknown): void {
  const quizzes = (input as any)?.quizzes;
  if (!Array.isArray(quizzes) || quizzes.length !== 3) {
    // allow dynamic quiz_count but default is 3
    const expected = 3;
    if (!Array.isArray(quizzes) || quizzes.length !== expected) {
      throw new Error(`LLM must return exactly ${expected} quizzes`);
    }
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

function buildPrompt(payload: GeneratePayload): string {
  return `Generate lesson-plan quizzes as strict JSON only.

Required schema:
{
  "quizzes": [
    {
      "title": "string",
      "questions": [
        {
          "type": "multiple_choice" | "direct_answer",
          "question": "string",
          "options": ["A option", "B option", "C option", "D option"],
          "correctIndex": 0,
          "rubric": "string",
          "explanation": "string"
        }
      ]
    }
  ]
}

Rules:
- Return exactly ${payload.quiz_count ?? 3} quizzes.
- Each quiz has exactly ${payload.questions_per_quiz ?? 4} questions.
- Each quiz must include at least ${payload.direct_answer_min ?? 1} direct_answer question(s).
- multiple_choice: exactly 4 options and correctIndex 0-3.
- CRITICAL: All 4 multiple_choice options must be pairwise distinct after trimming whitespace and ignoring case. Do NOT repeat, paraphrase, or create near-duplicates of the same answer (e.g. "24 + 18" and "24+18" or "Berlin" and " berlin " count as duplicates and will be rejected). Each distractor must represent a DIFFERENT plausible misconception.
- Distractors must be non-overlapping and plausible — avoid options that are substrings of each other or identical after lowercasing/trimming.
- direct_answer: omit options or set options null, correctIndex null, and provide a non-empty rubric.
- Questions must be specific to the lesson period objective/topic/activity and grade/class.
- No repeated stems inside a quiz.
- Do not use generic stems like "Which statement best shows understanding of...".
- Do not paste the objective verbatim as the whole question.
- Keep language professional and age-appropriate.

One-shot example — correct vs incorrect:

CORRECT (4 distinct options):
{
  "type": "multiple_choice",
  "question": "Muna has 24 pencils and gets 18 more. Which sum should she solve?",
  "options": ["24 + 18", "24 - 18", "18 × 2", "24 + 8"],
  "correctIndex": 0
}

INCORRECT (duplicate options — will be rejected):
{
  "type": "multiple_choice",
  "question": "Muna has 24 pencils and gets 18 more. Which sum should she solve?",
  "options": ["24 + 18", "24+18", "24 + 18 ", "24 - 18"],
  "correctIndex": 0
}
The second example fails because options 1, 2, and 3 are identical after trimming/casing.

Lesson plan/context JSON:
${JSON.stringify(payload, null, 2)}`;
}

function buildRepairPrompt(original: unknown, offending: Array<{ quizIndex: number; questionIndex: number }>): string {
  const offendersDesc = offending.map(({ quizIndex, questionIndex }) => `quiz ${quizIndex + 1} question ${questionIndex + 1}`).join(', ');
  return `You previously generated quizzes but the following questions failed validation because their 4 answer options were not distinct (duplicates after trimming whitespace and ignoring case): ${offendersDesc}.

Fix ONLY those questions. For each offending multiple_choice question, regenerate its "options" array so all 4 strings are pairwise distinct after trimming and lowercasing, and each distractor represents a different plausible misconception. Keep the same question stem, correct answer position (correctIndex), and all other quizzes/questions exactly as they were.

Return the FULL JSON again with the same schema:
{ "quizzes": [...] }

Offending indices: ${JSON.stringify(offending)}

Original JSON you produced:
${JSON.stringify(original, null, 2)}

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

async function callLLM(prompt: string, apiKey: string, signal: AbortSignal, url = NVIDIA_API_URL, model = NVIDIA_MODEL): Promise<{ parsed: unknown; raw: string }> {
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
      temperature: 0.8,
      top_p: 0.9,
      max_tokens: 12000,
      reasoning_budget: url === NVIDIA_API_URL ? 4096 : undefined,
      chat_template_kwargs: url === NVIDIA_API_URL ? { enable_thinking: true } : undefined,
      stream: false,
    }),
    signal,
  });
  if (!response.ok) {
    const body = await response.text();
    console.error('[generate-lesson-quizzes] provider error', { provider: url === NVIDIA_API_URL ? 'nvidia' : 'zen', model, status: response.status, body: body.slice(0, 2000) });
    const err: any = new Error(`${model} API error: ${response.status} ${body}`);
    err.status = response.status;
    err.body = body;
    throw err;
  }
  const body = await response.json();
  const content = body.choices?.[0]?.message?.content;
  if (!content) throw new Error('Empty LLM response');
  const parsed = parseJson(content);
  return { parsed, raw: content };
}

async function callLLMWithProviderRetry(
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
      const result = await callLLM(prompt, apiKey, controller.signal, url, model);
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
        error: errorMessage(err).slice(0, 2000),
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
    const currentPrompt = attempt === 0 ? prompt : prompt; // full retry uses same prompt
    let result: { parsed: unknown; raw: string };
    try {
      result = await callLLMWithProviderRetry(currentPrompt, apiKey, url, model, attempt === 0 ? AI_ATTEMPT_TIMEOUT_MS : REPAIR_TIMEOUT_MS);
    } catch (err) {
      throw err; // provider error bubbles to fallback logic
    }
    lastParsed = result.parsed;
    lastRaw = result.raw;

    try {
      validateGeneratedResponse(result.parsed);
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
        rawExcerpt: result.raw.slice(0, 2000),
      });

      // Targeted repair: if exactly one (or few) questions have duplicate options,
      // try a focused repair call before doing a full retry.
      const isDistinctError = /options are not distinct/i.test(errorMessage(validationErr));
      const canRepair = isDistinctError && offending.length > 0 && offending.length <= 2 && attempt < VALIDATION_MAX_RETRIES;

      if (canRepair) {
        console.log('[generate-lesson-quizzes] attempting targeted repair', { offending });
        const repairPrompt = buildRepairPrompt(result.parsed, offending);
        try {
          const repaired = await callLLMWithProviderRetry(repairPrompt, apiKey, url, model, REPAIR_TIMEOUT_MS);
          try {
            validateGeneratedResponse(repaired.parsed);
            console.log('[generate-lesson-quizzes] repair validation passed', { provider: url === NVIDIA_API_URL ? 'nvidia' : 'zen' });
            return repaired;
          } catch (repairValidationErr) {
            console.error('[generate-lesson-quizzes] repair still invalid', {
              provider: url === NVIDIA_API_URL ? 'nvidia' : 'zen',
              error: errorMessage(repairValidationErr),
              rawExcerpt: repaired.raw.slice(0, 2000),
            });
            lastParsed = repaired.parsed;
            lastRaw = repaired.raw;
            lastValidationError = repairValidationErr;
            // fall through to full retry
          }
        } catch (repairErr) {
          console.error('[generate-lesson-quizzes] repair call failed', { error: errorMessage(repairErr) });
          // fall through to full retry
        }
      }

      if (attempt === VALIDATION_MAX_RETRIES) {
        // Exhausted retries — log full raw for diagnostics
        console.error('[generate-lesson-quizzes] validation failed final', {
          provider: url === NVIDIA_API_URL ? 'nvidia' : 'zen',
          error: errorMessage(validationErr),
          rawFull: lastRaw?.slice(0, 8000),
          parsedExcerpt: JSON.stringify(lastParsed)?.slice(0, 4000),
        });
        const err: any = new Error(`Quiz generation returned invalid structured output: ${errorMessage(validationErr)}`);
        err.raw = lastRaw;
        err.parsed = lastParsed;
        err.validationError = validationErr;
        throw err;
      }

      // Backoff before full retry
      const backoff = 600 * (attempt + 1);
      console.log('[generate-lesson-quizzes] full retry after validation failure', { nextAttempt: attempt + 2, backoff });
      await sleep(backoff);
    }
  }
  // Should be unreachable
  const err: any = new Error(`Quiz generation returned invalid structured output: ${errorMessage(lastValidationError)}`);
  err.raw = lastRaw;
  err.parsed = lastParsed;
  throw err;
}

serve(async (req: Request) => {
  const startedAt = Date.now();
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS_HEADERS });
  if (req.method !== 'POST') return corsResponse({ error: 'Method not allowed' }, { status: 405 });

  try {
    const payload: GeneratePayload = await req.json();
    if (!payload.plan || !payload.subject || !Array.isArray(payload.periods)) {
      console.error('[generate-lesson-quizzes] invalid payload', { hasPlan: !!payload.plan, subject: payload.subject, periodsIsArray: Array.isArray(payload.periods) });
      return corsResponse({ error: 'Invalid payload', code: 'INVALID_PAYLOAD' }, { status: 400 });
    }

    const prompt = buildPrompt(payload);
    // Provider order: Zen primary (fastest path under 3-min watchdog, ~21s), NVIDIA Nemotron fallback.
    const zenKey = Deno.env.get('ZEN_API_KEY');
    const nvidiaKey = Deno.env.get('NVIDIA_API_KEY');
    let lastError: unknown;
    let lastRaw: string | null = null;

    if (zenKey) {
      try {
        const result = await attemptGenerationWithValidation(prompt, zenKey, ZEN_API_URL, ZEN_MODEL);
        console.log('[generate-lesson-quizzes] success', { provider: 'zen', ms: Date.now() - startedAt });
        return corsResponse(result.parsed);
      } catch (err: any) {
        lastError = err;
        lastRaw = err?.raw ?? null;
        console.error('[generate-lesson-quizzes] zen failed final', { error: errorMessage(err), ms: Date.now() - startedAt });
        // If it's a validation error we already retried + repaired, don't immediately fall back
        // if the error was retriable provider error we already retried with backoff.
        // Still fall back to nvidia for any failure.
      }
    } else {
      console.error('[generate-lesson-quizzes] ZEN_API_KEY missing');
    }

    if (nvidiaKey) {
      try {
        const result = await attemptGenerationWithValidation(prompt, nvidiaKey, NVIDIA_API_URL, NVIDIA_MODEL);
        console.log('[generate-lesson-quizzes] success', { provider: 'nvidia', ms: Date.now() - startedAt });
        return corsResponse(result.parsed);
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
      rawExcerpt: lastRaw?.slice(0, 4000) ?? null,
      // Log full raw at error level so it appears in production logs for debugging
      rawFull: lastRaw?.slice(0, 8000) ?? null,
    });
    return corsResponse(
      {
        error: detail,
        code: 'QUIZ_GENERATION_FAILED',
        provider: 'all',
        raw_excerpt: lastRaw?.slice(0, 3000) ?? undefined,
      },
      { status: 502 },
    );
  } catch (err) {
    console.error('[generate-lesson-quizzes] internal error', { error: errorMessage(err), ms: Date.now() - startedAt });
    return corsResponse({ error: err instanceof Error ? err.message : 'Internal error', code: 'INTERNAL_ERROR' }, { status: 500 });
  }
});
