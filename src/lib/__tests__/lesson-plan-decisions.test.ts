import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../supabase', () => ({
  supabase: {
    from: vi.fn(),
    functions: { invoke: vi.fn() },
  },
}));

// The background chain calls these after submission; mock them so the unit
// tests can assert they were invoked (or not) without DB plumbing.
vi.mock('../db/lessonPeriodAiReviews', () => ({
  regeneratePeriodAiReviews: vi.fn().mockResolvedValue([]),
}));
vi.mock('../db/lessonPlanQuizzes', () => ({
  generateLessonPlanQuizzes: vi.fn().mockResolvedValue([]),
}));

import { supabase } from '../supabase';
import { approvePlan, rejectPlan, submitForReview, runAiReviewInBackground } from '../db/lessonPlans';
import { regeneratePeriodAiReviews } from '../db/lessonPeriodAiReviews';
import { generateLessonPlanQuizzes } from '../db/lessonPlanQuizzes';
import type { DayOfWeek } from '../../types';

const mockFrom = supabase.from as unknown as ReturnType<typeof vi.fn>;
const mockInvoke = supabase.functions.invoke as unknown as ReturnType<typeof vi.fn>;

beforeEach(() => {
  mockFrom.mockReset();
  mockInvoke.mockReset();
  (regeneratePeriodAiReviews as unknown as ReturnType<typeof vi.fn>).mockClear();
  (generateLessonPlanQuizzes as unknown as ReturnType<typeof vi.fn>).mockClear();
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

describe('submitForReview — fast, non-blocking submission', () => {
  function stubPlan(initialStatus: string) {
    const updates: any[] = [];
    mockFrom.mockImplementation(() => ({
      select: () => ({
        eq: () => ({
          single: () => Promise.resolve({ data: { id: 'p1', teacher_id: 't1', status: initialStatus }, error: null }),
        }),
      }),
      update: (values: any) => ({
        eq: () => {
          updates.push(values);
          return Promise.resolve({ error: null });
        },
      }),
      insert: () => Promise.resolve({ error: null }),
    }));
    return updates;
  }

  it('writes status=submitted and returns immediately — never awaits the AI review', async () => {
    const updates = stubPlan('draft');

    const result = await submitForReview('p1', []);

    expect(result).toEqual({ plan_id: 'p1', status: 'submitted' });
    // The submission itself is only a status write...
    expect(updates.some((u) => u.status === 'submitted')).toBe(true);
    // ...and the AI edge function is NOT called inside the awaited submit.
    expect(mockInvoke).not.toHaveBeenCalled();
  });

  it('stamps ai_started_at so the timeout watchdog can time out a stuck background review', async () => {
    const updates = stubPlan('draft');

    await submitForReview('p1', []);

    const submitUpdate = updates.find((u) => u.status === 'submitted');
    expect(submitUpdate?.ai_started_at).toBeTruthy();
    expect(submitUpdate?.ai_failure_reason).toBeNull();
  });

  it('rejects when the plan is already submitted, in review, or approved', async () => {
    for (const status of ['submitted', 'in_review', 'approved']) {
      stubPlan(status);
      await expect(submitForReview('p1', [])).rejects.toThrow(/already/i);
    }
  });
});

describe('runAiReviewInBackground — fire-and-forget chain', () => {
  it('invokes the review edge function, then regenerates period reviews and quizzes on success', async () => {
    const logs: any[] = [];
    mockFrom.mockImplementation(() => ({
      insert: (values: any) => {
        logs.push(values);
        return Promise.resolve({ error: null });
      },
    }));
    mockInvoke.mockResolvedValue({ data: { plan_id: 'p1' }, error: null });
    const periods = [{ day: 'Monday' as DayOfWeek, period_number: 1, topic: 'T', activities: 'A' }];

    await runAiReviewInBackground('p1', periods, { name: 'Unit 1', objectives: 'Add, subtract' });

    expect(mockInvoke).toHaveBeenCalledWith('generate-lesson-review', {
      body: { plan_id: 'p1', periods, unit_context: { name: 'Unit 1', objectives: 'Add, subtract' } },
    });
    expect(regeneratePeriodAiReviews).toHaveBeenCalledWith('p1');
    expect(generateLessonPlanQuizzes).toHaveBeenCalledWith('p1');
    // The attempt is recorded for the admin monitor.
    expect(logs.some((l) => l.outcome === 'success')).toBe(true);
  });

  it('logs the failure and stops the chain when the edge function errors — never throws', async () => {
    const logs: any[] = [];
    mockFrom.mockImplementation(() => ({
      insert: (values: any) => {
        logs.push(values);
        return Promise.resolve({ error: null });
      },
      update: (values: any) => ({
        eq: () => Promise.resolve({ error: null }),
      }),
    }));
    mockInvoke.mockResolvedValue({ data: null, error: { message: 'AI review generation failed' } });

    await expect(runAiReviewInBackground('p1', [])).resolves.toBeUndefined();

    const log = logs.find((l) => l.outcome !== undefined);
    expect(log).toBeTruthy();
    expect(log.outcome).not.toBe('success');
    // The chain stops at the failed review — no point regenerating reviews or
    // quizzes off a failed submission state.
    expect(regeneratePeriodAiReviews).not.toHaveBeenCalled();
    expect(generateLessonPlanQuizzes).not.toHaveBeenCalled();
  });
});
