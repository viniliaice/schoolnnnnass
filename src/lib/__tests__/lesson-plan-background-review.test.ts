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

  it('uses the atomic persistence RPC for aggregate and period results', () => {
    expect(edgeFunction).toContain("'persist_lesson_plan_ai_review_attempt'");
    expect(edgeFunction).toContain('p_period_reviews: periodRows');
  });
});
