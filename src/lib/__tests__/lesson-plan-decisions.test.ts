import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mockRpc, mockInvoke, mockGenerateLessonPlanQuizzes } = vi.hoisted(() => ({
  mockRpc: vi.fn(),
  mockInvoke: vi.fn(),
  mockGenerateLessonPlanQuizzes: vi.fn(),
}));

vi.mock('../supabase', () => ({
  supabase: {
    rpc: mockRpc,
    functions: { invoke: mockInvoke },
  },
}));

vi.mock('../db/lessonPlanQuizzes', () => ({
  generateLessonPlanQuizzes: mockGenerateLessonPlanQuizzes,
}));

import {
  approvePlan,
  rejectPlan,
  retryAIReview,
  submitForReview,
} from '../db/lessonPlans';

describe('lesson-plan decision and dispatch invariants', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGenerateLessonPlanQuizzes.mockResolvedValue([]);
  });

  it('does not dispatch review or quiz generation when submit RPC fails', async () => {
    mockRpc.mockResolvedValueOnce({ data: null, error: new Error('not owner') });

    await expect(submitForReview('plan-1')).rejects.toThrow('not owner');
    expect(mockInvoke).not.toHaveBeenCalled();
    expect(mockGenerateLessonPlanQuizzes).not.toHaveBeenCalled();
  });

  it('does not dispatch review or quiz generation when submit is not confirmed', async () => {
    mockRpc.mockResolvedValueOnce({
      data: [{ id: 'plan-1', status: 'draft', ai_started_at: null }],
      error: null,
    });

    await expect(submitForReview('plan-1')).rejects.toThrow('Submission was not confirmed');
    expect(mockInvoke).not.toHaveBeenCalled();
    expect(mockGenerateLessonPlanQuizzes).not.toHaveBeenCalled();
  });

  it('starts review and quiz dispatch independently only after confirmed submission', async () => {
    const events: string[] = [];
    mockRpc.mockImplementation(async (name: string) => {
      if (name === 'submit_lesson_plan_for_review') {
        events.push('submitted');
        return {
          data: [{ id: 'plan-1', status: 'submitted', ai_started_at: '2026-08-12T10:00:00Z' }],
          error: null,
        };
      }
      return { data: null, error: null };
    });
    mockGenerateLessonPlanQuizzes.mockImplementation(async () => {
      events.push('quiz-dispatched');
      return [];
    });
    mockInvoke.mockImplementation(async () => {
      events.push('review-dispatched');
      return { data: { status: 'accepted' }, error: null };
    });

    await expect(submitForReview('plan-1')).resolves.toEqual({
      plan_id: 'plan-1',
      status: 'submitted',
      ai_started_at: '2026-08-12T10:00:00Z',
    });
    await vi.waitFor(() => expect(events).toContain('review-dispatched'));

    expect(events[0]).toBe('submitted');
    expect(events).toEqual(expect.arrayContaining(['quiz-dispatched', 'review-dispatched']));
    expect(mockGenerateLessonPlanQuizzes).toHaveBeenCalledWith('plan-1');
    expect(mockInvoke).toHaveBeenCalledWith('generate-lesson-review', {
      body: { plan_id: 'plan-1' },
    });
  });

  it('dispatches quiz even when review invocation fails and marks only that review attempt failed', async () => {
    mockRpc
      .mockResolvedValueOnce({
        data: [{ id: 'plan-1', status: 'submitted', ai_started_at: 'attempt-a' }],
        error: null,
      })
      .mockResolvedValueOnce({ data: true, error: null });
    mockInvoke.mockResolvedValueOnce({
      data: null,
      error: { message: 'network down', context: { message: 'dispatch unavailable' } },
    });

    await expect(submitForReview('plan-1')).resolves.toEqual(expect.objectContaining({
      status: 'submitted',
      ai_started_at: 'attempt-a',
    }));
    await vi.waitFor(() => expect(mockRpc).toHaveBeenCalledTimes(2));

    expect(mockGenerateLessonPlanQuizzes).toHaveBeenCalledWith('plan-1');
    expect(mockRpc).toHaveBeenNthCalledWith(2, 'mark_lesson_plan_review_dispatch_failed', {
      p_plan_id: 'plan-1',
      p_ai_started_at: 'attempt-a',
      p_reason: 'dispatch unavailable',
    });
  });

  it('returns confirmed retry dispatch details and does not regenerate quizzes', async () => {
    mockRpc.mockResolvedValueOnce({
      data: [{ id: 'plan-1', status: 'submitted', ai_started_at: 'attempt-b' }],
      error: null,
    });
    mockInvoke.mockResolvedValueOnce({ data: { status: 'accepted' }, error: null });

    await expect(retryAIReview('plan-1')).resolves.toEqual({
      plan_id: 'plan-1',
      status: 'submitted',
      ai_started_at: 'attempt-b',
    });
    expect(mockGenerateLessonPlanQuizzes).not.toHaveBeenCalled();
    expect(mockInvoke).toHaveBeenCalledWith('generate-lesson-review', {
      body: { plan_id: 'plan-1' },
    });
  });

  it('marks an immediate retry dispatch failure against only the fresh attempt', async () => {
    mockRpc
      .mockResolvedValueOnce({
        data: [{ id: 'plan-1', status: 'submitted', ai_started_at: 'attempt-b' }],
        error: null,
      })
      .mockResolvedValueOnce({ data: true, error: null });
    mockInvoke.mockResolvedValueOnce({
      data: null,
      error: { message: 'network down', context: { message: 'dispatch unavailable' } },
    });

    await expect(retryAIReview('plan-1')).rejects.toThrow('Review retry could not be dispatched');
    expect(mockRpc).toHaveBeenNthCalledWith(2, 'mark_lesson_plan_review_dispatch_failed', {
      p_plan_id: 'plan-1',
      p_ai_started_at: 'attempt-b',
      p_reason: 'dispatch unavailable',
    });
    expect(mockGenerateLessonPlanQuizzes).not.toHaveBeenCalled();
  });

  it('approves through one atomic supervisor-decision RPC', async () => {
    mockRpc.mockResolvedValueOnce({
      data: { id: 'plan-1', status: 'approved' },
      error: null,
    });

    await approvePlan('plan-1');

    expect(mockRpc).toHaveBeenCalledOnce();
    expect(mockRpc).toHaveBeenCalledWith('decide_lesson_plan_review', {
      p_plan_id: 'plan-1',
      p_status: 'approved',
      p_supervisor_comment: null,
    });
  });

  it('rejects with feedback through the same atomic supervisor-decision RPC', async () => {
    mockRpc.mockResolvedValueOnce({
      data: [{ id: 'plan-1', status: 'rejected' }],
      error: null,
    });

    await rejectPlan('plan-1', 'Please improve differentiation.');

    expect(mockRpc).toHaveBeenCalledOnce();
    expect(mockRpc).toHaveBeenCalledWith('decide_lesson_plan_review', {
      p_plan_id: 'plan-1',
      p_status: 'rejected',
      p_supervisor_comment: 'Please improve differentiation.',
    });
  });

  it('propagates decision RPC errors without a second client-side write path', async () => {
    mockRpc.mockResolvedValueOnce({ data: null, error: new Error('not authorized') });

    await expect(approvePlan('plan-1', 'Looks good')).rejects.toThrow('not authorized');
    expect(mockRpc).toHaveBeenCalledOnce();
  });

});
