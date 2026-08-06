import { serve } from 'https://deno.land/std@0.224.0/http/server.ts';

const NVIDIA_API_URL = 'https://integrate.api.nvidia.com/v1/chat/completions';
const NVIDIA_MODEL = 'nvidia/nemotron-3-ultra-550b-a55b';
const ZEN_API_URL = 'https://opencode.ai/zen/v1/chat/completions';
const ZEN_MODEL = 'deepseek-v4-flash-free';
const AI_ATTEMPT_TIMEOUT_MS = 120_000;

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
- multiple_choice: exactly 4 distinct options and correctIndex 0-3.
- direct_answer: omit options or set options null, correctIndex null, and provide a non-empty rubric.
- Questions must be specific to the lesson period objective/topic/activity and grade/class.
- No repeated stems inside a quiz.
- Do not use generic stems like "Which statement best shows understanding of...".
- Do not paste the objective verbatim as the whole question.
- Keep language professional and age-appropriate.

Lesson plan/context JSON:
${JSON.stringify(payload, null, 2)}`;
}

function parseJson(content: string) {
  const cleaned = content.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '');
  return JSON.parse(cleaned);
}

async function callLLM(prompt: string, apiKey: string, signal: AbortSignal, url = NVIDIA_API_URL, model = NVIDIA_MODEL) {
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
    console.error('[generate-lesson-quizzes] provider error', { provider: url === NVIDIA_API_URL ? 'nvidia' : 'zen', model, status: response.status, body });
    throw new Error(`${model} API error: ${response.status} ${body}`);
  }
  const body = await response.json();
  const content = body.choices?.[0]?.message?.content;
  if (!content) throw new Error('Empty LLM response');
  return parseJson(content);
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
    const nvidiaKey = Deno.env.get('NVIDIA_API_KEY');
    const zenKey = Deno.env.get('ZEN_API_KEY');
    let lastError: unknown;

    if (nvidiaKey) {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), AI_ATTEMPT_TIMEOUT_MS);
      try {
        const result = await callLLM(prompt, nvidiaKey, controller.signal);
        clearTimeout(timeout);
        console.log('[generate-lesson-quizzes] success', { provider: 'nvidia', ms: Date.now() - startedAt });
        return corsResponse(result);
      } catch (err) {
        clearTimeout(timeout);
        lastError = err;
        console.error('[generate-lesson-quizzes] nvidia failed', { error: errorMessage(err) });
      }
    } else {
      console.error('[generate-lesson-quizzes] NVIDIA_API_KEY missing');
    }

    if (zenKey) {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), AI_ATTEMPT_TIMEOUT_MS);
      try {
        const result = await callLLM(prompt, zenKey, controller.signal, ZEN_API_URL, ZEN_MODEL);
        clearTimeout(timeout);
        console.log('[generate-lesson-quizzes] success', { provider: 'zen', ms: Date.now() - startedAt });
        return corsResponse(result);
      } catch (err) {
        clearTimeout(timeout);
        lastError = err;
        console.error('[generate-lesson-quizzes] zen failed', { error: errorMessage(err) });
      }
    } else {
      console.error('[generate-lesson-quizzes] ZEN_API_KEY missing');
    }

    const detail = lastError instanceof Error ? lastError.message : 'No quiz generation provider configured';
    console.error('[generate-lesson-quizzes] failed all providers', { error: detail, ms: Date.now() - startedAt });
    return corsResponse({ error: detail, code: 'QUIZ_GENERATION_FAILED' }, { status: 502 });
  } catch (err) {
    console.error('[generate-lesson-quizzes] internal error', { error: errorMessage(err), ms: Date.now() - startedAt });
    return corsResponse({ error: err instanceof Error ? err.message : 'Internal error', code: 'INTERNAL_ERROR' }, { status: 500 });
  }
});
