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
import { generateLessonPlanQuizzes } from '../db/lessonPlanQuizzes';
import { approvePlan, rejectPlan, retryAIReview, submitForReview } from '../db/lessonPlans';

const mockFrom = supabase.from as unknown as ReturnType<typeof vi.fn>;
const mockRpc = supabase.rpc as unknown as ReturnType<typeof vi.fn>;
const mockInvoke = supabase.functions.invoke as unknown as ReturnType<typeof vi.fn>;
const mockGenerateQuizzes = generateLessonPlanQuizzes as unknown as ReturnType<typeof vi.fn>;

beforeEach(() => {
  mockFrom.mockReset();
  mockRpc.mockReset();
  mockInvoke.mockReset();
  mockGenerateQuizzes.mockReset();
  mockGenerateQuizzes.mockResolvedValue([]);
});

describe('atomic supervisor decisions', () => {
  it('approves through the row-locked decision RPC', async () => {
    mockRpc.mockResolvedValue({ data: [{ id: 'plan-1', status: 'approved' }], error: null });

    await approvePlan('plan-1');

    expect(mockRpc).toHaveBeenCalledWith('decide_lesson_plan_review', {
      p_plan_id: 'plan-1',
      p_status: 'approved',
      p_supervisor_comment: null,
    });
    expect(mockFrom).not.toHaveBeenCalled();
  });

  it('rejects through the same row-locked decision RPC', async () => {
    mockRpc.mockResolvedValue({ data: [{ id: 'plan-1', status: 'rejected' }], error: null });

    await rejectPlan('plan-1', 'Please revise the assessment.');

    expect(mockRpc).toHaveBeenCalledWith('decide_lesson_plan_review', {
      p_plan_id: 'plan-1',
      p_status: 'rejected',
      p_supervisor_comment: 'Please revise the assessment.',
    });
    expect(mockFrom).not.toHaveBeenCalled();
  });

  it('passes a manual comment into the transaction instead of writing a review first', async () => {
    mockRpc.mockResolvedValue({ data: [{ id: 'plan-1', status: 'approved' }], error: null });

    await approvePlan('plan-1', 'Looks good, approving manually.');

    expect(mockRpc).toHaveBeenCalledOnce();
    expect(mockRpc).toHaveBeenCalledWith('decide_lesson_plan_review', {
      p_plan_id: 'plan-1',
      p_status: 'approved',
      p_supervisor_comment: 'Looks good, approving manually.',
    });
    expect(mockFrom).not.toHaveBeenCalled();
  });

  it('surfaces decision-RPC failures without a direct-table fallback', async () => {
    mockRpc.mockResolvedValue({ data: null, error: { message: 'not authorized' } });

    await expect(rejectPlan('plan-1', 'Comment')).rejects.toMatchObject({ message: 'not authorized' });
    expect(mockFrom).not.toHaveBeenCalled();
  });
});

describe('status-first background review dispatch', () => {
  const queuedPlan = {
    id: 'p1',
    status: 'submitted',
    ai_started_at: '2026-08-12T10:00:00.000Z',
  };

  it('confirms submitted status before dispatch and resolves while review generation is pending', async () => {
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
    mockGenerateQuizzes.mockImplementation(async () => {
      events.push('generate-lesson-quizzes');
      return [];
    });

    await expect(submitForReview('p1')).resolves.toEqual({
      plan_id: 'p1',
      status: 'submitted',
      ai_started_at: queuedPlan.ai_started_at,
    });

    expect(events).toEqual([
      'submit_lesson_plan_for_review',
      'generate-lesson-review',
      'generate-lesson-quizzes',
    ]);
    expect(mockRpc).toHaveBeenCalledWith('submit_lesson_plan_for_review', { p_plan_id: 'p1' });
    expect(mockInvoke).toHaveBeenCalledWith('generate-lesson-review', { body: { plan_id: 'p1' } });
  });

  it('does not dispatch or generate quizzes when the submitted transaction fails', async () => {
    mockRpc.mockResolvedValue({ data: null, error: { message: 'database unavailable' } });

    await expect(submitForReview('p1')).rejects.toMatchObject({ message: 'database unavailable' });
    expect(mockInvoke).not.toHaveBeenCalled();
    expect(mockGenerateQuizzes).not.toHaveBeenCalled();
  });

  it('does not dispatch when the database did not return confirmed submitted status', async () => {
    mockRpc.mockResolvedValue({
      data: [{ ...queuedPlan, status: 'draft' }],
      error: null,
    });

    await expect(submitForReview('p1')).rejects.toThrow(/not confirmed/i);
    expect(mockInvoke).not.toHaveBeenCalled();
    expect(mockGenerateQuizzes).not.toHaveBeenCalled();
  });

  it('marks only the exact queued attempt failed when review dispatch is rejected', async () => {
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
    expect(mockGenerateQuizzes).toHaveBeenCalledWith('p1');
  });

  it('keeps quiz generation independent when review invocation fails', async () => {
    mockRpc
      .mockResolvedValueOnce({ data: [queuedPlan], error: null })
      .mockResolvedValueOnce({ data: true, error: null });
    mockInvoke.mockRejectedValue(new Error('review transport failed'));

    await expect(submitForReview('p1')).resolves.toMatchObject({ status: 'submitted' });

    expect(mockGenerateQuizzes).toHaveBeenCalledOnce();
    await vi.waitFor(() => {
      expect(mockRpc).toHaveBeenCalledWith('mark_lesson_plan_review_dispatch_failed', expect.objectContaining({
        p_plan_id: 'p1',
        p_ai_started_at: queuedPlan.ai_started_at,
      }));
    });
  });

  it('queues a fresh retry attempt before invoking the Edge Function without replacing quizzes', async () => {
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
    expect(mockGenerateQuizzes).not.toHaveBeenCalled();
  });
});
