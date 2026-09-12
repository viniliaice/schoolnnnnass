import { beforeEach, describe, expect, it, vi } from 'vitest';

// The supervisor's week selector must be driven by the STORED week data
// (`lesson_plans.week_label`), and it must let the database do the filtering so
// a growing plan history never gets downloaded just to be filtered here.

const { rpc, from } = vi.hoisted(() => ({ rpc: vi.fn(), from: vi.fn() }));

vi.mock('../supabase', () => ({ supabase: { rpc, from } }));
vi.mock('../db/lessonPlanQuizzes', () => ({ generateLessonPlanQuizzes: vi.fn() }));

import { fetchPlansBySupervisorForWeek, fetchSupervisorPlanWeeks } from '../db/lessonPlans';

const REVIEW_STATUSES = ['submitted', 'in_review', 'approved', 'rejected', 'ai_failed'];

type FakeTable = {
  chain: any;
  selects: string[];
  filters: Array<[string, unknown[]]>;
};

function fakeTable(rows: unknown[]): FakeTable {
  const table: FakeTable = { chain: null, selects: [], filters: [] };
  const chain: any = {
    select: (cols: string) => {
      table.selects.push(cols);
      return chain;
    },
    in: (col: string, vals: unknown[]) => {
      table.filters.push([col, vals]);
      return chain;
    },
    eq: (col: string, val: unknown) => {
      table.filters.push([col, [val]]);
      return chain;
    },
    order: () => chain,
    limit: () => chain,
    single: async () => ({ data: rows[0] ?? null, error: null }),
    maybeSingle: async () => ({ data: rows[0] ?? null, error: null }),
    then: (onFulfilled: any, onRejected: any) =>
      Promise.resolve({ data: rows, error: null }).then(onFulfilled, onRejected),
  };
  table.chain = chain;
  return table;
}

beforeEach(() => {
  vi.clearAllMocks();
  // Default: the timeout sweep RPC succeeds and expires nothing.
  rpc.mockImplementation(async (name: string) => {
    if (name === 'expire_stuck_ai_reviews') return { data: [], error: null };
    return { data: null, error: { message: `unexpected rpc ${name}`, code: '42883' } };
  });
});

describe('fetchSupervisorPlanWeeks — the week dropdown', () => {
  it('reads aggregated week counts from the database', async () => {
    rpc.mockImplementation(async (name: string) => {
      if (name === 'expire_stuck_ai_reviews') return { data: [], error: null };
      return {
        data: [
          { week_label: '2026-W07', plan_count: '18' },
          { week_label: '2026-W05', plan_count: '4' },
        ],
        error: null,
      };
    });

    const weeks = await fetchSupervisorPlanWeeks();

    expect(rpc).toHaveBeenCalledWith('list_lesson_plan_weeks', { p_statuses: REVIEW_STATUSES });
    expect(weeks).toEqual([
      { week_label: '2026-W07', plan_count: 18 },
      { week_label: '2026-W05', plan_count: 4 },
    ]);
    // The dropdown never pulls plan rows.
    expect(from).not.toHaveBeenCalled();
  });

  it('falls back to counting week_label alone when the aggregate RPC is missing', async () => {
    const table = fakeTable([
      { week_label: '2026-W07' },
      { week_label: '2026-W07' },
      { week_label: '2026-W05' },
      { week_label: '  ' },
    ]);
    from.mockReturnValue(table.chain);

    const weeks = await fetchSupervisorPlanWeeks();

    expect(table.selects).toEqual(['week_label']);
    expect(table.filters).toEqual([['status', REVIEW_STATUSES]]);
    expect(weeks).toEqual([
      { week_label: '2026-W07', plan_count: 2 },
      { week_label: '2026-W05', plan_count: 1 },
    ]);
  });
});

describe('fetchPlansBySupervisorForWeek — one week at a time', () => {
  it('asks the database for exactly the selected week labels', async () => {
    const table = fakeTable([
      { id: 'p1', week_label: '2026-W07', profiles: { name: 'Ms. Fatima' } },
    ]);
    from.mockReturnValue(table.chain);

    const plans = await fetchPlansBySupervisorForWeek(['2026-W07']);

    expect(table.selects).toEqual(['*, profiles!lesson_plans_teacher_id_fkey(name)']);
    expect(table.filters).toEqual([
      ['status', REVIEW_STATUSES],
      ['week_label', ['2026-W07']],
    ]);
    expect(plans).toEqual([
      expect.objectContaining({ id: 'p1', week_label: '2026-W07', teacher_name: 'Ms. Fatima' }),
    ]);
  });

  it('sends every stored spelling of a week so legacy labels are not lost', async () => {
    const table = fakeTable([]);
    from.mockReturnValue(table.chain);

    await fetchPlansBySupervisorForWeek(['2026-W07', '2026-W7']);

    expect(table.filters).toContainEqual(['week_label', ['2026-W07', '2026-W7']]);
  });

  it('never filters on the teacher-entered title', async () => {
    const table = fakeTable([]);
    from.mockReturnValue(table.chain);

    await fetchPlansBySupervisorForWeek(['2026-W07']);

    expect(table.filters.map(([column]) => column)).not.toContain('title');
    // Only the review-status and week filters are applied — nothing else can
    // pull another week's rows into the result.
    expect(table.filters.map(([column]) => column)).toEqual(['status', 'week_label']);
  });

  it('returns nothing without querying when the week holds no labels', async () => {
    await expect(fetchPlansBySupervisorForWeek([])).resolves.toEqual([]);
    expect(from).not.toHaveBeenCalled();
  });
});
