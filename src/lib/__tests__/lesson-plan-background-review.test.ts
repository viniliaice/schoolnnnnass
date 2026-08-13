import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const migration = readFileSync(
  new URL('../../../supabase/migrations/20260812_background_lesson_plan_ai_review.sql', import.meta.url),
  'utf8',
);
const edgeFunction = readFileSync(
  new URL('../../../supabase/functions/generate-lesson-review/index.ts', import.meta.url),
  'utf8',
);

function functionBody(sql: string, name: string): string {
  const start = sql.indexOf(`CREATE OR REPLACE FUNCTION ${name}`);
  if (start < 0) throw new Error(`SQL function ${name} was not found`);
  const nextFunction = sql.indexOf('CREATE OR REPLACE FUNCTION ', start + 1);
  return sql.slice(start, nextFunction < 0 ? sql.length : nextFunction);
}

describe('background lesson-plan review database contract', () => {
  it('commits submitted status and attempt timestamp in the queueing RPC', () => {
    const body = functionBody(migration, 'submit_lesson_plan_for_review');
    expect(body).toContain("SET status = 'submitted'");
    expect(body).toContain('ai_started_at = v_started_at');
    expect(body).toContain('RETURN QUERY SELECT * FROM lesson_plans');
    expect(body.indexOf("SET status = 'submitted'")).toBeLessThan(
      body.indexOf('RETURN QUERY SELECT * FROM lesson_plans'),
    );
  });

  it('atomically persists aggregate and per-period output for only the exact pending attempt', () => {
    const body = functionBody(migration, 'persist_lesson_plan_ai_review_attempt');
    expect(body).toContain("v_plan.status <> 'submitted'");
    expect(body).toContain('v_plan.ai_started_at IS DISTINCT FROM p_ai_started_at');
    expect(body).toContain('INSERT INTO ai_reviews');
    expect(body).toContain('INSERT INTO lesson_period_ai_reviews');
    expect(body).toContain("SET status = 'in_review'");
  });

  it('guards dispatch failures by status and exact attempt timestamp', () => {
    const body = functionBody(migration, 'mark_lesson_plan_review_dispatch_failed');
    expect(body).toContain("v_plan.status <> 'submitted'");
    expect(body).toContain('v_plan.ai_started_at IS DISTINCT FROM p_ai_started_at');
    expect(body).toContain("SET status = 'ai_failed'");
  });
});

describe('background Edge Function contract', () => {
  it('rejects AI work before the plan is submitted', () => {
    expect(edgeFunction).toContain("if (plan.status !== 'submitted' || !plan.ai_started_at)");
    expect(edgeFunction).toContain('Plan must be submitted before AI review starts');
  });

  it('acknowledges with 202 and keeps generation alive with EdgeRuntime.waitUntil', () => {
    const waitUntilIndex = edgeFunction.indexOf('edgeRuntime.waitUntil(task)');
    const acceptedIndex = edgeFunction.indexOf("{ status: 202 }");
    expect(waitUntilIndex).toBeGreaterThan(-1);
    expect(acceptedIndex).toBeGreaterThan(waitUntilIndex);
  });

  it('uses native Deno.serve without changing the request handler contract', () => {
    expect(edgeFunction).toContain('Deno.serve(async (req: Request) => {');
    expect(edgeFunction).not.toContain("deno.land/std@0.224.0/http/server.ts");
    expect(edgeFunction).toContain("if (req.method === 'OPTIONS')");
    expect(edgeFunction).toContain("if (req.method !== 'POST')");
  });

  it('uses OpenRouter Lightning, Gemini 3.6, then Gemini 3.5 Lite', () => {
    const routes = edgeFunction.slice(
      edgeFunction.indexOf('export function buildProviderRoutes('),
      edgeFunction.indexOf('interface ProviderError'),
    );
    const lightningIndex = routes.indexOf('model: OPENROUTER_MODEL');
    const gemini36Index = routes.indexOf('model: GEMINI_36_MODEL');
    const gemini35Index = routes.indexOf('model: GEMINI_35_LITE_MODEL');

    expect(edgeFunction).toContain("const OPENROUTER_MODEL = 'nvidia/nemotron-3.5-lightning:free'");
    expect(edgeFunction).toContain("const GEMINI_36_MODEL = 'gemini-3.6-flash'");
    expect(edgeFunction).toContain("const GEMINI_35_LITE_MODEL = 'gemini-3.5-flash-lite'");
    expect(edgeFunction).toContain("Deno.env.get('OPENROUTER_API_KEY')");
    expect(edgeFunction).toContain("Deno.env.get('GEMINI_API_KEY')");
    expect(lightningIndex).toBeGreaterThan(-1);
    expect(gemini36Index).toBeGreaterThan(lightningIndex);
    expect(gemini35Index).toBeGreaterThan(gemini36Index);
    expect(edgeFunction).not.toContain('NVIDIA_API_KEY');
    expect(edgeFunction).not.toContain('ZEN_API_KEY');
  });

  it('retries each provider once with exponential backoff for approved statuses', () => {
    const retryPolicy = edgeFunction.slice(
      edgeFunction.indexOf('export function isRetriableStatus'),
      edgeFunction.indexOf('\n}\n\nfunction sleep', edgeFunction.indexOf('export function isRetriableStatus')) + 2,
    );

    for (const status of [429, 502, 503, 504, 529]) {
      expect(retryPolicy).toContain(`status === ${status}`);
    }
    expect(edgeFunction).toContain('const PROVIDER_MAX_RETRIES = 1');
    expect(edgeFunction).toContain('const retriableHttpStatus = status !== undefined && isRetriableStatus(status)');
    expect(edgeFunction).toContain('if (retriableHttpStatus) {');
    expect(edgeFunction).toContain('BASE_BACKOFF_MS * Math.pow(2, attempt)');
    expect(edgeFunction).toContain('await sleep(backoff)');
    expect(edgeFunction).toContain("const retriableMalformedPrimary = route.provider === 'openrouter'");
    expect(edgeFunction).toContain('callLLMWithRetry(promptText, route');
  });

  it('preserves the complete review prompts and period mapping byte-for-byte', () => {
    const systemPrompt = edgeFunction.slice(
      edgeFunction.indexOf('const SYSTEM_PROMPT ='),
      edgeFunction.indexOf('\n\ninterface CategoryScore'),
    );
    const promptBuilder = edgeFunction.slice(
      edgeFunction.indexOf('function buildPrompt('),
      edgeFunction.indexOf('\n\nexport async function callLLM('),
    );

    expect(createHash('sha256').update(systemPrompt).digest('hex'))
      .toBe('72635d2bbffb10081429ba05630da6c0898267a197903081d0e77596830158c5');
    expect(createHash('sha256').update(promptBuilder).digest('hex'))
      .toBe('8f7a221a5aa96e3d5de9188004a7ff8fa47d76a46915c9f1896f1740c289482e');
  });

  it('uses the atomic persistence RPC for aggregate and period results', () => {
    expect(edgeFunction).toContain("'persist_lesson_plan_ai_review_attempt'");
    expect(edgeFunction).toContain('p_period_reviews: periodRows');
  });
});
