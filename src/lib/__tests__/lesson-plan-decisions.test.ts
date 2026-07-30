import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../supabase', () => ({
  supabase: {
    from: vi.fn(),
    functions: { invoke: vi.fn() },
  },
}));

import { supabase } from '../supabase';
import { approvePlan, rejectPlan, submitForReview, SubmissionAiError } from '../db/lessonPlans';

const mockFrom = supabase.from as unknown as ReturnType<typeof vi.fn>;
const mockInvoke = supabase.functions.invoke as unknown as ReturnType<typeof vi.fn>;

beforeEach(() => {
  mockFrom.mockReset();
  mockInvoke.mockReset();
});

/** Build a chainable stub for `.update().eq()` and `.upsert()`. */
function planTableStub(record: { updates: any[]; upserts: any[] }) {
  return {
    update: (values: any) => ({
      eq: (_col: string, _val: string) => {
        record.updates.push(values);
        return Promise.resolve({ error: null });
      },
    }),
    upsert: (values: any, _opts: any) => {
      record.upserts.push(values);
      return Promise.resolve({ error: null });
    },
  };
}

describe('supervisor decisions without an AI review', () => {
  it('approvePlan sets status to approved', async () => {
    const rec = { updates: [] as any[], upserts: [] as any[] };
    mockFrom.mockImplementation(() => planTableStub(rec));

    await approvePlan('plan-1');

    expect(rec.updates).toEqual([{ status: 'approved' }]);
    expect(rec.upserts).toHaveLength(0);
  });

  it('rejectPlan sets status to rejected', async () => {
    const rec = { updates: [] as any[], upserts: [] as any[] };
    mockFrom.mockImplementation(() => planTableStub(rec));

    await rejectPlan('plan-1');

    expect(rec.updates).toEqual([{ status: 'rejected' }]);
  });

  it('stores a manual review row when the supervisor decides without an AI score', async () => {
    const rec = { updates: [] as any[], upserts: [] as any[] };
    mockFrom.mockImplementation(() => planTableStub(rec));

    await approvePlan('plan-1', 'Looks good, approving manually.');

    expect(rec.upserts).toHaveLength(1);
    const saved = rec.upserts[0];
    expect(saved.plan_id).toBe('plan-1');
    expect(saved.status).toBe('reviewed');
    expect(saved.supervisor_comment).toBe('Looks good, approving manually.');
    expect(saved.performance_level).toBe('Manual review');
    expect(rec.updates).toEqual([{ status: 'approved' }]);
  });

  it('ignores an empty manual comment', async () => {
    const rec = { updates: [] as any[], upserts: [] as any[] };
    mockFrom.mockImplementation(() => planTableStub(rec));

    await rejectPlan('plan-1', '   ');

    expect(rec.upserts).toHaveLength(0);
    expect(rec.updates).toEqual([{ status: 'rejected' }]);
  });
});

describe('submitForReview failure signalling', () => {
  function statusSequence(statuses: string[]) {
    let call = 0;
    const updates: any[] = [];
    mockFrom.mockImplementation(() => ({
      select: () => ({
        eq: () => ({
          single: () => Promise.resolve({ data: { id: 'p1', teacher_id: 't1', status: statuses[Math.min(call++, statuses.length - 1)] }, error: null }),
        }),
      }),
      update: (values: any) => ({
        eq: () => {
          updates.push(values);
          return Promise.resolve({ error: null });
        },
      }),
      // submitForReview now also writes an ai_review_logs row.
      insert: () => Promise.resolve({ error: null }),
    }));
    return updates;
  }

  it('throws SubmissionAiError when the plan reached the supervisor but the AI failed', async () => {
    // 1st read: pre-submit status 'draft'. 2nd read (after error): 'ai_failed'.
    const updates = statusSequence(['draft', 'ai_failed']);
    mockInvoke.mockResolvedValue({ data: null, error: { message: 'AI review generation failed' } });

    await expect(submitForReview('p1', [])).rejects.toBeInstanceOf(SubmissionAiError);
    // Plan must NOT be rolled back to draft — the supervisor can still see it.
    expect(updates.some((u) => u.status === 'draft')).toBe(false);
  });

  it('rolls the plan back to draft when the submission itself never landed', async () => {
    const updates = statusSequence(['draft', 'draft']);
    mockInvoke.mockResolvedValue({ data: null, error: { message: 'network down' } });

    const err = await submitForReview('p1', []).catch((e) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(SubmissionAiError);
    expect(updates.some((u) => u.status === 'draft')).toBe(true);
  });

  it('does not downgrade in_review back to submitted on success', async () => {
    const updates = statusSequence(['draft', 'in_review']);
    mockInvoke.mockResolvedValue({ data: { plan_id: 'p1' }, error: null });

    await submitForReview('p1', []);

    expect(updates.some((u) => u.status === 'submitted')).toBe(false);
  });
});
