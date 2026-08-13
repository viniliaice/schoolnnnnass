import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const migrationPath = 'supabase/migrations/20260812_background_lesson_plan_ai_review.sql';
const lockingMigrationPath = 'supabase/migrations/20260731_lesson_plan_locking_and_ai_logs.sql';
const lessonPlanSchemaPath = 'supabase/migrations/20260727_lesson_plans.sql';
const edgePath = 'supabase/functions/generate-lesson-review/index.ts';
const clientPath = 'src/lib/db/lessonPlans.ts';

const migration = readFileSync(migrationPath, 'utf8');
const allLifecycleSql = [
  readFileSync(lessonPlanSchemaPath, 'utf8'),
  readFileSync(lockingMigrationPath, 'utf8'),
  migration,
].join('\n');
const edgeSource = readFileSync(edgePath, 'utf8');
const clientSource = readFileSync(clientPath, 'utf8');

function functionBody(sql: string, signatureStart: string): string {
  const start = sql.indexOf(signatureStart);
  expect(start, `missing SQL function ${signatureStart}`).toBeGreaterThanOrEqual(0);
  const next = sql.indexOf('CREATE OR REPLACE FUNCTION ', start + signatureStart.length);
  return sql.slice(start, next === -1 ? sql.length : next);
}

function functionBodyFromSource(source: string, signatureStart: string, nextMarker: string): string {
  const start = source.indexOf(signatureStart);
  expect(start, `missing source function ${signatureStart}`).toBeGreaterThanOrEqual(0);
  const next = source.indexOf(nextMarker, start + signatureStart.length);
  expect(next, `missing next marker ${nextMarker}`).toBeGreaterThan(start);
  return source.slice(start, next);
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

describe('background lesson-plan AI review contracts', () => {
  it('defines the submit, retry, dispatch-failure, persist, provider-failure, expiry, and decision RPCs', () => {
    expect(migration).toContain('CREATE OR REPLACE FUNCTION submit_lesson_plan_for_review(p_plan_id TEXT)');
    expect(migration).toContain('CREATE OR REPLACE FUNCTION retry_lesson_plan_ai_review(p_plan_id TEXT)');
    expect(migration).toContain('CREATE OR REPLACE FUNCTION mark_lesson_plan_review_dispatch_failed(');
    expect(migration).toContain('CREATE OR REPLACE FUNCTION persist_lesson_plan_ai_review_attempt(');
    expect(migration).toContain('CREATE OR REPLACE FUNCTION mark_lesson_plan_ai_review_attempt_failed(');
    expect(migration).toContain('CREATE OR REPLACE FUNCTION expire_stuck_ai_reviews(p_timeout_minutes INTEGER DEFAULT 3)');
    expect(migration).toContain('CREATE OR REPLACE FUNCTION decide_lesson_plan_review(');
  });

  it('records background execution markers on lesson plans', () => {
    expect(allLifecycleSql).toContain('ADD COLUMN IF NOT EXISTS ai_started_at TIMESTAMPTZ');
    expect(allLifecycleSql).toContain('ADD COLUMN IF NOT EXISTS ai_failure_reason TEXT');
  });

  it('keeps submitted plans server-locked while allowing owner and supervisor reads', () => {
    expect(allLifecycleSql).toContain("SELECT p_status IN ('draft', 'revision_requested')");
    expect(allLifecycleSql).toContain('CREATE TRIGGER trg_lesson_plan_periods_lock');
    expect(allLifecycleSql).toContain('CREATE POLICY "teacher_manage_own_plans"');
    expect(allLifecycleSql).toContain('CREATE POLICY "supervisor_select_all_plans"');
  });

  it('makes initial submit an owner-only row-locked transition with a fresh attempt timestamp', () => {
    const body = functionBody(migration, 'CREATE OR REPLACE FUNCTION submit_lesson_plan_for_review(p_plan_id TEXT)');
    expect(body).toContain('SECURITY DEFINER');
    expect(body).toContain('FOR UPDATE');
    expect(body).toContain('v_plan.teacher_id IS DISTINCT FROM v_profile_id');
    expect(body).toContain("v_plan.status NOT IN ('draft', 'revision_requested')");
    expect(body).toContain('ai_started_at = v_started_at');
    expect(body).toContain("status = 'submitted'");
    expect(body).toContain('DELETE FROM ai_reviews WHERE plan_id = p_plan_id');
    expect(body).toContain('TO authenticated');
  });

  it('lets an owner retry only ai_failed while retaining broader supervisor control', () => {
    const body = functionBody(migration, 'CREATE OR REPLACE FUNCTION retry_lesson_plan_ai_review(p_plan_id TEXT)');
    expect(body).toContain('SECURITY DEFINER');
    expect(body).toContain('FOR UPDATE');
    expect(body).toContain("v_plan.status NOT IN ('submitted', 'ai_failed', 'in_review')");
    expect(body).toContain("COALESCE(v_role, '') NOT IN ('supervisor', 'admin')");
    expect(body).toContain("IF v_plan.status <> 'ai_failed'");
    expect(body).toContain('Only a supervisor or administrator may retry an active lesson-plan review.');
    expect(body).toContain('v_started_at TIMESTAMPTZ := clock_timestamp()');
    expect(body).toContain('ai_started_at = v_started_at');
    expect(body).toContain('DELETE FROM ai_reviews WHERE plan_id = p_plan_id');
  });

  it('makes browser dispatch failure attempt-scoped and retryable', () => {
    const body = functionBody(migration, 'CREATE OR REPLACE FUNCTION mark_lesson_plan_review_dispatch_failed(');
    expect(body).toContain('SECURITY DEFINER');
    expect(body).toContain('FOR UPDATE');
    expect(body).toContain("v_plan.status <> 'submitted'");
    expect(body).toContain('v_plan.ai_started_at IS DISTINCT FROM p_ai_started_at');
    expect(body).toContain("status = 'ai_failed'");
    expect(body).toContain("'DISPATCH_FAILED'");
    expect(body).toContain('TO authenticated');
  });

  it('persists aggregate + period rows + in_review status atomically for only the exact attempt', () => {
    const body = functionBody(migration, 'CREATE OR REPLACE FUNCTION persist_lesson_plan_ai_review_attempt(');
    expect(body).toContain('SECURITY DEFINER');
    expect(body).toContain('FOR UPDATE');
    expect(body).toContain("v_plan.status <> 'submitted'");
    expect(body).toContain('v_plan.ai_started_at IS DISTINCT FROM p_ai_started_at');
    expect(body).toContain('DELETE FROM lesson_period_ai_reviews WHERE plan_id = p_plan_id');
    expect(body).toContain('DELETE FROM ai_reviews WHERE plan_id = p_plan_id');
    expect(body).toContain('INSERT INTO ai_reviews');
    expect(body).toContain('INSERT INTO lesson_period_ai_reviews');
    expect(body).toContain("SET status = 'in_review'");
    expect(body).toContain('RETURN TRUE');
    expect(body).toContain('TO service_role');
    expect(body).not.toContain('TO authenticated');
  });

  it('persists background provider failure atomically for only the matching pending attempt', () => {
    const body = functionBody(migration, 'CREATE OR REPLACE FUNCTION mark_lesson_plan_ai_review_attempt_failed(');
    expect(body).toContain('SECURITY DEFINER');
    expect(body).toContain('FOR UPDATE');
    expect(body).toContain("v_plan.status <> 'submitted'");
    expect(body).toContain('v_plan.ai_started_at IS DISTINCT FROM p_ai_started_at');
    expect(body).toContain("SET status = 'ai_failed'");
    expect(body).toContain('INSERT INTO ai_review_logs');
    expect(body).toContain('GREATEST(0, p_latency_ms)');
    expect(body).toContain('TO service_role');
    expect(body).not.toContain('TO authenticated');
  });

  it('authorizes timeout expiry by role/ownership and leaves current or completed attempts alone', () => {
    const body = functionBody(migration, 'CREATE OR REPLACE FUNCTION expire_stuck_ai_reviews(p_timeout_minutes INTEGER DEFAULT 3)');
    expect(body).toContain('SECURITY DEFINER');
    expect(body).toContain('WHERE auth_id = auth.uid()');
    expect(body).toContain("COALESCE(v_role, '') IN ('supervisor', 'admin')");
    expect(body).toContain('lp.teacher_id = v_profile_id');
    expect(body).toContain("WHERE lp.status = 'submitted'");
    expect(body).toContain('lp.ai_started_at IS NOT NULL');
    expect(body).toContain('lp.ai_started_at < v_cutoff');
    expect(body).toContain('NOT EXISTS (SELECT 1 FROM ai_reviews r WHERE r.plan_id = lp.id)');
    expect(body).toContain("SET status = 'ai_failed'");
    expect(body).toContain("'TIMEOUT'");
    expect(body).toContain('TO authenticated');
  });

  it('serializes supervisor decisions with AI persistence and commits feedback + status together', () => {
    const body = functionBody(migration, 'CREATE OR REPLACE FUNCTION decide_lesson_plan_review(');
    expect(body).toContain('SECURITY DEFINER');
    expect(body).toContain("COALESCE(v_role, '') NOT IN ('supervisor', 'admin')");
    expect(body).toContain("p_status NOT IN ('approved', 'rejected')");
    expect(body).toContain('FOR UPDATE');
    expect(body).toContain("v_plan.status NOT IN ('submitted', 'in_review', 'ai_failed', 'approved', 'rejected')");
    expect(body).toContain('UPDATE ai_reviews');
    expect(body).toContain("SET status = 'reviewed'");
    expect(body).toContain('supervisor_comment = v_comment');
    expect(body).toContain("ELSIF BTRIM(v_comment) <> '' THEN");
    expect(body).toContain('INSERT INTO ai_reviews');
    expect(body).toContain('UPDATE lesson_plans');
    expect(body).toContain('SET status = p_status');
    expect(body).toContain('TO authenticated');
  });

  it('authorizes and row-locks revision requests so a pending AI attempt becomes stale', () => {
    const body = functionBody(migration, 'CREATE OR REPLACE FUNCTION request_lesson_plan_revision(');
    expect(body).toContain("COALESCE(v_role, '') NOT IN ('supervisor', 'admin')");
    expect(body).toContain('FOR UPDATE');
    expect(body).toContain("SET status = 'revision_requested'");
    expect(body).toContain('TO authenticated');
  });

  it('encodes the stale-attempt race invariant for retry B and supervisor decisions', () => {
    const retryBody = functionBody(migration, 'CREATE OR REPLACE FUNCTION retry_lesson_plan_ai_review(p_plan_id TEXT)');
    const persistBody = functionBody(migration, 'CREATE OR REPLACE FUNCTION persist_lesson_plan_ai_review_attempt(');
    const failBody = functionBody(migration, 'CREATE OR REPLACE FUNCTION mark_lesson_plan_ai_review_attempt_failed(');
    const decideBody = functionBody(migration, 'CREATE OR REPLACE FUNCTION decide_lesson_plan_review(');

    // Retry B replaces A's timestamp while holding the same plan-row lock.
    expect(retryBody).toContain('FOR UPDATE');
    expect(retryBody).toContain('ai_started_at = v_started_at');
    // Either late success or failure from A must match both submitted status and A's timestamp.
    for (const workerBody of [persistBody, failBody]) {
      expect(workerBody).toContain('FOR UPDATE');
      expect(workerBody).toContain("v_plan.status <> 'submitted'");
      expect(workerBody).toContain('v_plan.ai_started_at IS DISTINCT FROM p_ai_started_at');
      expect(workerBody).toContain('RETURN FALSE');
    }
    // A supervisor decision takes that lock and changes to a final status.
    expect(decideBody).toContain('FOR UPDATE');
    expect(decideBody).toContain('SET status = p_status');
  });

  it('dispatches only after submit confirmation and keeps quiz/review work independent', () => {
    const submitBody = functionBodyFromSource(
      clientSource,
      'export async function submitForReview(',
      'export async function fetchReviewByPlanId(',
    );
    const statusCheck = submitBody.indexOf("submittedPlan.status !== 'submitted'");
    const quizDispatch = submitBody.indexOf('void generateLessonPlanQuizzes(planId).catch');
    const reviewDispatch = submitBody.indexOf('void dispatchLessonPlanReview(planId, submittedPlan.ai_started_at).catch');
    expect(statusCheck).toBeGreaterThanOrEqual(0);
    expect(quizDispatch).toBeGreaterThan(statusCheck);
    expect(reviewDispatch).toBeGreaterThan(statusCheck);
    expect(submitBody).not.toContain('await generateLessonPlanQuizzes');
    expect(submitBody).not.toContain('await dispatchLessonPlanReview');

    const retryBody = functionBodyFromSource(
      clientSource,
      'export async function retryAIReview(',
      '/**\n * Persist the supervisor comment',
    );
    expect(retryBody).toContain('retry_lesson_plan_ai_review');
    expect(retryBody).toContain('await dispatchLessonPlanReview');
    expect(retryBody).not.toContain('generateLessonPlanQuizzes');
  });

  it('uses the authoritative timeout and supervisor-decision RPCs without client write fallbacks', () => {
    const timeoutBody = functionBodyFromSource(
      clientSource,
      'export async function expireStuckAiReviews(',
      '/**\n * Dispatch review generation',
    );
    expect(timeoutBody).toContain("supabase.rpc('expire_stuck_ai_reviews'");
    expect(timeoutBody).not.toContain(".from('lesson_plans')");
    expect(timeoutBody).not.toContain('.update(');

    const decisionBody = functionBodyFromSource(
      clientSource,
      'async function decidePlan(',
      'export async function approvePlan(',
    );
    expect(decisionBody).toContain("supabase.rpc('decide_lesson_plan_review'");
    expect(decisionBody).not.toContain(".from('ai_reviews')");
    expect(decisionBody).not.toContain(".from('lesson_plans')");
    expect(decisionBody).not.toContain('.update(');
  });

  it('runs generation in EdgeRuntime.waitUntil and uses attempt-scoped RPCs for success/failure', () => {
    expect(edgeSource).toContain('const task = generateAndPersistReview({');
    expect(edgeSource).toContain('edgeRuntime.waitUntil(task)');
    expect(edgeSource).toContain("'persist_lesson_plan_ai_review_attempt'");
    expect(edgeSource).toContain("'mark_lesson_plan_ai_review_attempt_failed'");
    expect(edgeSource).toContain('p_ai_started_at: attemptStartedAt');
    expect(edgeSource).not.toContain(".from('lesson_plans')\n        .update({\n          status: 'ai_failed'");
    expect(edgeSource).toContain("status: 'accepted'");
    expect(edgeSource).toContain('{ status: 202 }');
  });

  it('logs bounded diagnostics without full prompts, responses, or lesson payloads', () => {
    const logCalls = [...edgeSource.matchAll(/console\.(?:log|info|error)\([^;]+\);/gs)].map((match) => match[0]);
    expect(logCalls.length).toBeGreaterThan(10);
    for (const call of logCalls) {
      expect(call).not.toContain('promptText,');
      expect(call).not.toContain('result,');
      expect(call).not.toContain('responseText,');
      expect(call).not.toContain('payload,');
      expect(call).not.toContain('periods,');
      expect(call).not.toContain('unitContexts,');
      expect(call).not.toContain('apiKey,');
    }
    expect(edgeSource).toContain("console.log('[generate-lesson-review] provider request'");
    expect(edgeSource).toContain("console.log('[generate-lesson-review] provider response metadata'");
    expect(edgeSource).toContain("console.log('[generate-lesson-review] validation metadata'");
    expect(edgeSource).toContain("console.log('[generate-lesson-review] provider attempt succeeded'");
    expect(edgeSource).toContain("console.error('[generate-lesson-review] provider attempt failed'");
    expect(edgeSource).toContain('promptChars: prompt.length');
    expect(edgeSource).toContain('inputTokens: usage.input_tokens');
    expect(edgeSource).toContain('outputTokens: usage.output_tokens');
    expect(edgeSource).toContain('totalProviderAttempts: diagnostics.providerAttempts');
    expect(edgeSource).toContain('errorCode: diagnosticErrorCode(error)');
    expect(edgeSource).toContain('executionMs: Date.now() - diagnostics.startedAt');
  });

  it('emits the requested bounded lifecycle phases', () => {
    for (const phase of [
      'received',
      'background-started',
      'provider-started',
      'provider-finished',
      'validation',
      'persistence-started',
      'persistence-succeeded',
      'failure',
    ]) {
      expect(edgeSource).toContain(`logLifecycle('${phase}'`);
    }
    const lifecycleBody = functionBodyFromSource(edgeSource, 'function logLifecycle(', 'function buildPrompt(');
    expect(lifecycleBody).toContain("console.log('[generate-lesson-review] lifecycle'");
    expect(lifecycleBody).not.toContain('prompt');
    expect(lifecycleBody).not.toContain('response');
    expect(lifecycleBody).not.toContain('payload');
    expect(lifecycleBody).not.toContain('apiKey');
  });

  it('bounds provider work and output under Edge runtime limits', () => {
    expect(edgeSource).toContain('const AI_ATTEMPT_TIMEOUT_MS = 50_000');
    expect(edgeSource).toContain('const MAX_PROVIDER_ATTEMPTS_PER_REQUEST = 4');
    expect(edgeSource).toContain('const PROVIDER_MAX_RETRIES = 1');
    for (const status of [429, 502, 503, 504, 529]) {
      expect(edgeSource).toContain(`status === ${status}`);
    }
    expect(edgeSource).toContain('for (let attempt = 0; attempt <= PROVIDER_MAX_RETRIES; attempt++)');
    expect(edgeSource).toContain('const retriableHttpStatus = status !== undefined && isRetriableStatus(status)');
    expect(edgeSource).toContain('BASE_BACKOFF_MS * Math.pow(2, attempt)');
    expect(edgeSource).toContain('await sleep(backoff)');
    expect(edgeSource).toContain('max_output_tokens: PROVIDER_MAX_OUTPUT_TOKENS');
    expect(edgeSource).not.toContain('retryMalformedOutput');
  });

  it('uses only Gemini 3.6 then Gemini 3.5 Lite for AI review', () => {
    expect(edgeSource).toContain("const GEMINI_36_MODEL = 'gemini-3.6-flash'");
    expect(edgeSource).toContain("const GEMINI_35_LITE_MODEL = 'gemini-3.5-flash-lite'");
    expect(edgeSource).toContain('https://generativelanguage.googleapis.com/v1beta/interactions');
    expect(edgeSource).toContain("'x-goog-api-key': route.apiKey!");
    expect(edgeSource).toContain("const runtimeEnv = (globalThis as any).Deno.env");
    expect(edgeSource).toContain("const geminiApiKey = runtimeEnv.get('GEMINI_API_KEY')");
    expect(edgeSource).toContain('const routes = buildProviderRoutes(geminiApiKey)');
    expect(edgeSource).not.toMatch(/openrouter/i);
    expect(edgeSource).not.toMatch(/nemotron/i);
    expect(edgeSource).not.toContain("model = 'gemini-2.5-flash'");
    expect(edgeSource).not.toContain('generateContent');
  });

  it('keeps the exact review prompt wording and period order stable', () => {
    const systemPrompt = edgeSource.match(/const SYSTEM_PROMPT = `([\s\S]*?)`;/)?.[1];
    const buildPromptSource = edgeSource.match(/function buildPrompt\(payload: ReviewPayload\): string \{[\s\S]*?\n\}/)?.[0];
    expect(systemPrompt).toBeDefined();
    expect(buildPromptSource).toBeDefined();
    expect(sha256(systemPrompt!)).toBe('807575b78a41ae2242f1f58b8f65cd04c2f194cda91716338c140cb5a869ab19');
    expect(sha256(buildPromptSource!)).toBe('8f7a221a5aa96e3d5de9188004a7ff8fa47d76a46915c9f1896f1740c289482e');
    expect(buildPromptSource).toContain('const periodsText = payload.periods');
    expect(buildPromptSource).toContain('.map((period) => {');
  });

  it('does not embed full lesson payloads into review rows', () => {
    const backgroundBody = functionBodyFromSource(
      edgeSource,
      'async function generateAndPersistReview(',
      "console.log('[generate-lesson-review] module initialized')",
    );
    expect(backgroundBody).not.toContain('lesson_payload');
    expect(backgroundBody).not.toContain('prompt: promptText');
    expect(backgroundBody).not.toContain('raw_response');
  });

  it('client dispatches through Supabase invoke and preserves the accepted response contract', () => {
    expect(clientSource).toContain("supabase.functions.invoke('generate-lesson-review'");
    expect(clientSource).toContain('body: { plan_id: planId }');
    expect(clientSource).toContain('plan_id: planId');
    expect(clientSource).toContain("status: 'submitted'");
    expect(clientSource).toContain('ai_started_at: submittedPlan.ai_started_at');
  });
});
