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
const browserLifecycle = readFileSync(
  new URL('../db/lessonPlans.ts', import.meta.url),
  'utf8',
);

function functionBody(sql: string, name: string): string {
  const start = sql.indexOf(`CREATE OR REPLACE FUNCTION ${name}`);
  if (start < 0) throw new Error(`SQL function ${name} was not found`);
  const nextFunction = sql.indexOf('CREATE OR REPLACE FUNCTION ', start + 1);
  return sql.slice(start, nextFunction < 0 ? sql.length : nextFunction);
}

describe('background lesson-plan review database contract', () => {
  it('commits submitted status and attempt timestamp in the owner-checked queueing RPC', () => {
    const body = functionBody(migration, 'submit_lesson_plan_for_review');
    expect(body).toContain('WHERE auth_id = auth.uid()');
    expect(body).toContain('v_plan.teacher_id IS DISTINCT FROM v_profile_id');
    expect(body).toContain('FOR UPDATE');
    expect(body).toContain("SET status = 'submitted'");
    expect(body).toContain('ai_started_at = v_started_at');
    expect(body).toContain('RETURN QUERY SELECT * FROM lesson_plans');
    expect(body.indexOf("SET status = 'submitted'")).toBeLessThan(
      body.indexOf('RETURN QUERY SELECT * FROM lesson_plans'),
    );
  });

  it('creates a fresh retry token without letting an owner erase an active supervisor review', () => {
    const body = functionBody(migration, 'retry_lesson_plan_ai_review');
    expect(body).toContain('FOR UPDATE');
    expect(body).toContain("COALESCE(v_role, '') NOT IN ('supervisor', 'admin')");
    expect(body).toContain("IF v_plan.status <> 'ai_failed'");
    expect(body).toContain('Only a supervisor or administrator may retry an active lesson-plan review.');
    expect(body).toContain('DELETE FROM lesson_period_ai_reviews');
    expect(body).toContain('DELETE FROM ai_reviews');
    expect(body).toContain("SET status = 'submitted'");
    expect(body).toContain('ai_started_at = v_started_at');
    expect(body.indexOf("IF v_plan.status <> 'ai_failed'")).toBeLessThan(
      body.indexOf('DELETE FROM ai_reviews'),
    );
  });

  it('atomically persists aggregate and per-period output for only the exact pending attempt', () => {
    const body = functionBody(migration, 'persist_lesson_plan_ai_review_attempt');
    expect(body).toContain('FOR UPDATE');
    expect(body).toContain("v_plan.status <> 'submitted'");
    expect(body).toContain('v_plan.ai_started_at IS DISTINCT FROM p_ai_started_at');
    expect(body).toContain('INSERT INTO ai_reviews');
    expect(body).toContain('INSERT INTO lesson_period_ai_reviews');
    expect(body).toContain("SET status = 'in_review'");
    expect(body.indexOf("v_plan.status <> 'submitted'")).toBeLessThan(body.indexOf('DELETE FROM ai_reviews'));
  });

  it('guards browser dispatch failures by status, ownership, and exact attempt timestamp', () => {
    const body = functionBody(migration, 'mark_lesson_plan_review_dispatch_failed');
    expect(body).toContain('FOR UPDATE');
    expect(body).toContain("COALESCE(v_role, '') NOT IN ('supervisor', 'admin')");
    expect(body).toContain("v_plan.status <> 'submitted'");
    expect(body).toContain('v_plan.ai_started_at IS DISTINCT FROM p_ai_started_at');
    expect(body).toContain("SET status = 'ai_failed'");
  });

  it('persists background failures and their log atomically for only the matching attempt', () => {
    const body = functionBody(migration, 'mark_lesson_plan_ai_review_attempt_failed');
    expect(body).toContain('FOR UPDATE');
    expect(body).toContain("v_plan.status <> 'submitted'");
    expect(body).toContain('v_plan.ai_started_at IS DISTINCT FROM p_ai_started_at');
    expect(body).toContain("SET status = 'ai_failed'");
    expect(body).toContain('INSERT INTO ai_review_logs');
    expect(body.indexOf("v_plan.status <> 'submitted'")).toBeLessThan(body.indexOf("SET status = 'ai_failed'"));
    expect(migration).toContain(
      'GRANT EXECUTE ON FUNCTION mark_lesson_plan_ai_review_attempt_failed(TEXT, TIMESTAMPTZ, TEXT, TEXT, TEXT, INTEGER) TO service_role',
    );
  });

  it('scopes timeout expiry to the owner or supervisor and leaves races to a conditional update', () => {
    const body = functionBody(migration, 'expire_stuck_ai_reviews');
    expect(body).toContain('WHERE auth_id = auth.uid()');
    expect(body).toContain("lp.status = 'submitted'");
    expect(body).toContain('lp.ai_started_at < v_cutoff');
    expect(body).toContain('lp.teacher_id = v_profile_id');
    expect(body).toContain("COALESCE(v_role, '') IN ('supervisor', 'admin')");
    expect(body).toContain('INSERT INTO ai_review_logs');
    expect(migration).toContain('REVOKE ALL ON FUNCTION expire_stuck_ai_reviews(INTEGER) FROM PUBLIC');
    expect(browserLifecycle).not.toContain('Fallback path');
    expect(browserLifecycle).not.toMatch(/expireStuckAiReviews[\s\S]*?\.from\('lesson_plans'\)\s*\.update/);
  });

  it('serializes supervisor decisions on the same row before comments and final status commit', () => {
    const decision = functionBody(migration, 'decide_lesson_plan_review');
    const persistence = functionBody(migration, 'persist_lesson_plan_ai_review_attempt');
    expect(decision).toContain("COALESCE(v_role, '') NOT IN ('supervisor', 'admin')");
    expect(decision).toContain('FOR UPDATE');
    expect(decision).toContain("SET status = 'reviewed'");
    expect(decision).toContain('supervisor_comment = v_comment');
    expect(decision).toContain('SET status = p_status');
    expect(decision.indexOf('FOR UPDATE')).toBeLessThan(decision.indexOf('UPDATE ai_reviews'));
    expect(decision.indexOf('FOR UPDATE')).toBeLessThan(decision.indexOf('INSERT INTO ai_reviews'));
    expect(decision.indexOf('FOR UPDATE')).toBeLessThan(decision.indexOf('SET status = p_status'));
    expect(persistence).toContain('FOR UPDATE');
    expect(persistence).toContain("v_plan.status <> 'submitted'");
  });

  it('authorizes and row-locks revision requests so pending attempts become stale', () => {
    const body = functionBody(migration, 'request_lesson_plan_revision');
    expect(body).toContain("COALESCE(v_role, '') NOT IN ('supervisor', 'admin')");
    expect(body).toContain('FOR UPDATE');
    expect(body).toContain("SET status = 'revision_requested'");
    expect(migration).toContain('REVOKE ALL ON FUNCTION request_lesson_plan_revision(TEXT, TEXT) FROM PUBLIC');
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

  it('uses OpenRouter Nemotron, then Gemini 3.6, then Gemini 3.5 Lite', () => {
    const routes = edgeFunction.slice(
      edgeFunction.indexOf('export function buildProviderRoutes('),
      edgeFunction.indexOf('interface ProviderAttemptError'),
    );
    const nemotronIndex = routes.indexOf('model: NEMOTRON_MODEL');
    const gemini36Index = routes.indexOf('model: GEMINI_36_MODEL');
    const gemini35Index = routes.indexOf('model: GEMINI_35_LITE_MODEL');

    expect(edgeFunction).toContain("const NEMOTRON_MODEL = 'nvidia/nemotron-3.5-lightning:free'");
    expect(edgeFunction).toContain("const GEMINI_36_MODEL = 'gemini-3.6-flash'");
    expect(edgeFunction).toContain("const GEMINI_35_LITE_MODEL = 'gemini-3.5-flash-lite'");
    expect(edgeFunction).toContain("const runtimeEnv = (globalThis as any).Deno.env");
    expect(edgeFunction).toContain("runtimeEnv.get('OPENROUTER_API_KEY')");
    expect(edgeFunction).toContain("runtimeEnv.get('GEMINI_API_KEY')");
    expect(nemotronIndex).toBeGreaterThan(-1);
    expect(gemini36Index).toBeGreaterThan(nemotronIndex);
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
    expect(edgeFunction).toContain('const MAX_PROVIDER_ATTEMPTS_PER_REQUEST = 6');
    expect(edgeFunction).toContain('const retriableHttpStatus = status !== undefined && isRetriableStatus(status)');
    expect(edgeFunction).toContain('if (retriableHttpStatus) {');
    expect(edgeFunction).toContain('BASE_BACKOFF_MS * Math.pow(2, attempt)');
    expect(edgeFunction).toContain('await sleep(backoff)');
    expect(edgeFunction).toContain('callLLMWithRetry(');
  });

  it('logs bounded received, background, provider, validation, persistence, success, and failure phases', () => {
    const moduleIndex = edgeFunction.indexOf("'[generate-lesson-review] module initialized'");
    const serveIndex = edgeFunction.indexOf('Deno.serve(async (req: Request) => {');
    const receivedIndex = edgeFunction.indexOf("'[generate-lesson-review] request received'");
    const methodCheckIndex = edgeFunction.indexOf("if (req.method === 'OPTIONS')");

    expect(moduleIndex).toBeGreaterThan(-1);
    expect(moduleIndex).toBeLessThan(serveIndex);
    expect(edgeFunction.slice(0, moduleIndex)).not.toContain('Deno.env.get');
    expect(receivedIndex).toBeGreaterThan(serveIndex);
    expect(receivedIndex).toBeLessThan(methodCheckIndex);
    expect(edgeFunction).toContain("'[generate-lesson-review] background started'");
    expect(edgeFunction).toContain("'[generate-lesson-review] provider started'");
    expect(edgeFunction).toContain("'[generate-lesson-review] provider finished'");
    expect(edgeFunction).toContain("'[generate-lesson-review] validation metadata'");
    expect(edgeFunction).toContain("'[generate-lesson-review] persistence started'");
    expect(edgeFunction).toContain("'[generate-lesson-review] persistence succeeded'");
    expect(edgeFunction).toContain("'[generate-lesson-review] background job failed'");
    expect(edgeFunction).toContain("'[generate-lesson-review] success'");
    expect(edgeFunction).not.toMatch(/console\.(?:log|info|error)\([^\n]*(?:promptText|payload|reviewResult|content|body)/);
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

  it('uses authoritative RPCs for successful and failed background completion', () => {
    expect(edgeFunction).toContain("'persist_lesson_plan_ai_review_attempt'");
    expect(edgeFunction).toContain('p_period_reviews: periodRows');
    expect(edgeFunction).toContain("'mark_lesson_plan_ai_review_attempt_failed'");
    expect(edgeFunction).not.toMatch(/\.from\('lesson_plans'\)\s*\.update\(/);
  });
});
