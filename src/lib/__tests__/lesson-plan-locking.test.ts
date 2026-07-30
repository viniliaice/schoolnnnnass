import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../supabase', () => ({
  supabase: {
    from: vi.fn(),
    rpc: vi.fn(),
    functions: { invoke: vi.fn() },
  },
}));

import { supabase } from '../supabase';
import {
  savePeriods,
  PlanLockedError,
  expireStuckAiReviews,
  classifyAiError,
  AI_REVIEW_TIMEOUT_MINUTES,
} from '../db/lessonPlans';
import { isPlanEditable, PlanStatus } from '../../types';

const mockFrom = supabase.from as unknown as ReturnType<typeof vi.fn>;
const mockRpc = supabase.rpc as unknown as ReturnType<typeof vi.fn>;

beforeEach(() => {
  mockFrom.mockReset();
  mockRpc.mockReset();
});

/** Stub `.select().eq().single()` returning a plan with the given status. */
function stubPlanStatus(status: string, sink?: { updates: any[] }) {
  mockFrom.mockImplementation(() => ({
    select: () => ({
      eq: () => ({
        single: () => Promise.resolve({ data: { status, id: 'p1', teacher_id: 't1' }, error: null }),
      }),
    }),
    update: (values: any) => ({
      eq: () => ({
        eq: () => {
          sink?.updates.push(values);
          return Promise.resolve({ error: null });
        },
      }),
    }),
    insert: () => Promise.resolve({ error: null }),
  }));
}

describe('isPlanEditable (#1 — locking rule)', () => {
  it('allows editing only drafts and revision_requested plans', () => {
    expect(isPlanEditable('draft')).toBe(true);
    expect(isPlanEditable('revision_requested')).toBe(true);
  });

  it('locks every post-submission status', () => {
    const locked: PlanStatus[] = ['submitted', 'in_review', 'approved', 'rejected', 'ai_failed'];
    for (const status of locked) {
      expect(isPlanEditable(status)).toBe(false);
    }
  });

  it('treats a missing status as not editable', () => {
    expect(isPlanEditable(undefined)).toBe(false);
    expect(isPlanEditable(null)).toBe(false);
  });
});

describe('savePeriods lock enforcement (#1)', () => {
  it('rejects saving a submitted plan', async () => {
    stubPlanStatus('submitted');
    await expect(savePeriods({ plan_id: 'p1', periods: [] } as any)).rejects.toBeInstanceOf(PlanLockedError);
    // The write RPC must never be reached.
    expect(mockRpc).not.toHaveBeenCalled();
  });

  it('rejects saving an approved plan', async () => {
    stubPlanStatus('approved');
    await expect(savePeriods({ plan_id: 'p1', periods: [] } as any)).rejects.toBeInstanceOf(PlanLockedError);
  });

  it('allows saving a draft', async () => {
    stubPlanStatus('draft');
    mockRpc.mockResolvedValue({ data: [], error: null });
    await expect(savePeriods({ plan_id: 'p1', periods: [] } as any)).resolves.toEqual([]);
    expect(mockRpc).toHaveBeenCalledWith('save_lesson_plan_periods', expect.anything());
  });

  it('allows saving once revisions have been requested', async () => {
    stubPlanStatus('revision_requested');
    mockRpc.mockResolvedValue({ data: [], error: null });
    await expect(savePeriods({ plan_id: 'p1', periods: [] } as any)).resolves.toEqual([]);
  });

  it('converts a server-side lock error into PlanLockedError', async () => {
    // Client thinks it is a draft, but the database rejects the write.
    stubPlanStatus('draft');
    mockRpc.mockResolvedValue({ data: null, error: { message: 'Lesson plan p1 is locked (status: submitted).' } });
    await expect(savePeriods({ plan_id: 'p1', periods: [] } as any)).rejects.toBeInstanceOf(PlanLockedError);
  });

  it('carries a message telling the teacher how to unlock the plan', async () => {
    stubPlanStatus('submitted');
    const err = await savePeriods({ plan_id: 'p1', periods: [] } as any).catch((e) => e);
    expect(err.message).toMatch(/request revisions/i);
  });
});

describe('AI review timeout (#4)', () => {
  it('uses the SQL sweep when the RPC is available', async () => {
    mockRpc.mockResolvedValue({ data: [{ id: 'p1' }, { id: 'p2' }], error: null });
    await expect(expireStuckAiReviews()).resolves.toEqual(['p1', 'p2']);
    expect(mockRpc).toHaveBeenCalledWith('expire_stuck_ai_reviews', {
      p_timeout_minutes: AI_REVIEW_TIMEOUT_MINUTES,
    });
  });

  it('falls back to expiring a stuck plan client-side', async () => {
    mockRpc.mockResolvedValue({ data: null, error: { message: 'function missing' } });
    const sink = { updates: [] as any[] };
    stubPlanStatus('submitted', sink);

    const longAgo = new Date(Date.now() - 10 * 60_000).toISOString();
    const expired = await expireStuckAiReviews([
      { id: 'p1', status: 'submitted', ai_started_at: longAgo, updated_at: longAgo, teacher_id: 't1' } as any,
    ]);

    expect(expired).toEqual(['p1']);
    expect(sink.updates[0].status).toBe('ai_failed');
    expect(sink.updates[0].ai_failure_reason).toMatch(/timed out/i);
  });

  it('leaves a plan alone while it is still within the timeout window', async () => {
    mockRpc.mockResolvedValue({ data: null, error: { message: 'function missing' } });
    const justNow = new Date().toISOString();
    const expired = await expireStuckAiReviews([
      { id: 'p1', status: 'submitted', ai_started_at: justNow, updated_at: justNow, teacher_id: 't1' } as any,
    ]);
    expect(expired).toEqual([]);
  });

  it('ignores plans that are not waiting on the AI', async () => {
    mockRpc.mockResolvedValue({ data: null, error: { message: 'function missing' } });
    const longAgo = new Date(Date.now() - 60 * 60_000).toISOString();
    const expired = await expireStuckAiReviews([
      { id: 'p1', status: 'approved', ai_started_at: longAgo, updated_at: longAgo, teacher_id: 't1' } as any,
    ]);
    expect(expired).toEqual([]);
  });

  it('has a timeout well under the 107 minutes observed in the bug report', () => {
    expect(AI_REVIEW_TIMEOUT_MINUTES).toBeLessThanOrEqual(3);
    expect(AI_REVIEW_TIMEOUT_MINUTES).toBeGreaterThan(0);
  });
});

describe('AI failure classification (#4 — error visibility)', () => {
  it('buckets errors into monitorable outcomes', () => {
    expect(classifyAiError('Request timed out')).toBe('timeout');
    expect(classifyAiError('AI review timeout after 70s')).toBe('timeout');
    expect(classifyAiError('429 rate limit exceeded')).toBe('rate_limit');
    expect(classifyAiError('Malformed JSON in response')).toBe('malformed_json');
    expect(classifyAiError('Unit plan could not be matched')).toBe('unit_match_error');
    expect(classifyAiError('Failed to save review')).toBe('save_error');
    expect(classifyAiError('something bizarre')).toBe('unknown');
  });
});
