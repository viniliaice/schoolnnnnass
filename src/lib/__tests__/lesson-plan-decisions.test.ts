import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../supabase', () => ({
  supabase: {
    from: vi.fn(),
    rpc: vi.fn(),
    functions: { invoke: vi.fn() },
  },
}));
vi.mock('../db/lessonPlanQuizzes', () => ({
  generateLessonPlanQuizzes: vi.fn().mockResolvedValue([]),
}));

import { supabase } from '../supabase';
import { approvePlan, rejectPlan, retryAIReview, submitForReview } from '../db/lessonPlans';

const mockFrom = supabase.from as unknown as ReturnType<typeof vi.fn>;
const mockRpc = supabase.rpc as unknown as ReturnType<typeof vi.fn>;
const mockInvoke = supabase.functions.invoke as unknown as ReturnType<typeof vi.fn>;

beforeEach(() => {
  mockFrom.mockReset();
  mockRpc.mockReset();
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

describe('status-first background review dispatch', () => {
  const queuedPlan = {
    id: 'p1',
    status: 'submitted',
    ai_started_at: '2026-08-12T10:00:00.000Z',
  };

  it('confirms submitted status before dispatch and resolves while generation is pending', async () => {
    const events: string[] = [];
    mockRpc.mockImplementation(async (name: string) => {
      events.push(name);
      return { data: [queuedPlan], error: null };
    });
    mockInvoke.mockImplementation(() => {
      events.push('generate-lesson-review');
      // Deliberately never resolve: teacher submission must not await the Edge
      // invocation or the provider generation it starts.
      return new Promise(() => undefined);
    });

    await expect(submitForReview('p1')).resolves.toEqual({
      plan_id: 'p1',
      status: 'submitted',
      ai_started_at: queuedPlan.ai_started_at,
    });

    expect(events).toEqual([
      'submit_lesson_plan_for_review',
      'generate-lesson-review',
    ]);
    expect(mockRpc).toHaveBeenCalledWith('submit_lesson_plan_for_review', { p_plan_id: 'p1' });
    expect(mockInvoke).toHaveBeenCalledWith('generate-lesson-review', { body: { plan_id: 'p1' } });
  });

  it('does not dispatch when the submitted transaction fails', async () => {
    mockRpc.mockResolvedValue({ data: null, error: { message: 'database unavailable' } });

    await expect(submitForReview('p1')).rejects.toMatchObject({ message: 'database unavailable' });
    expect(mockInvoke).not.toHaveBeenCalled();
  });

  it('does not dispatch when the database did not return confirmed submitted status', async () => {
    mockRpc.mockResolvedValue({
      data: [{ ...queuedPlan, status: 'draft' }],
      error: null,
    });

    await expect(submitForReview('p1')).rejects.toThrow(/not confirmed/i);
    expect(mockInvoke).not.toHaveBeenCalled();
  });

  it('marks only the exact queued attempt failed when dispatch is rejected', async () => {
    mockRpc
      .mockResolvedValueOnce({ data: [queuedPlan], error: null })
      .mockResolvedValueOnce({ data: true, error: null });
    mockInvoke.mockResolvedValue({ data: null, error: { message: 'network down' } });

    await expect(submitForReview('p1')).resolves.toMatchObject({ status: 'submitted' });

    await vi.waitFor(() => {
      expect(mockRpc).toHaveBeenCalledWith('mark_lesson_plan_review_dispatch_failed', {
        p_plan_id: 'p1',
        p_ai_started_at: queuedPlan.ai_started_at,
        p_reason: 'network down',
      });
    });
  });

  it('queues a fresh retry attempt before invoking the Edge Function', async () => {
    const retryPlan = { ...queuedPlan, ai_started_at: '2026-08-12T10:05:00.000Z' };
    const events: string[] = [];
    mockRpc.mockImplementation(async (name: string) => {
      events.push(name);
      return { data: [retryPlan], error: null };
    });
    mockInvoke.mockImplementation(async () => {
      events.push('generate-lesson-review');
      return { data: { status: 'accepted' }, error: null };
    });
    await expect(retryAIReview('p1')).resolves.toEqual({
      plan_id: 'p1',
      status: 'submitted',
      ai_started_at: retryPlan.ai_started_at,
    });
    expect(events).toEqual(['retry_lesson_plan_ai_review', 'generate-lesson-review']);
  });
});
