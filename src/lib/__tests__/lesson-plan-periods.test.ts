import { describe, it, expect, vi, beforeEach } from 'vitest';

import {
  clampPeriodCount,
  createEmptyPeriods,
  resizePeriods,
  periodsFromDb,
  emptyInstructionalPeriods,
  PeriodCell,
} from '../lessonPlanPeriods';
import { LessonPlanPeriod } from '../../types';

// ─── Helpers ────────────────────────────────────────────────────────────────

function fillCell(cell: PeriodCell, topic: string, isFree = false): PeriodCell {
  return { ...cell, topic, isFree, subject: isFree ? '' : cell.subject || 'subject-1' };
}

function dbPeriod(overrides: Partial<LessonPlanPeriod> = {}): LessonPlanPeriod {
  return {
    id: `period-${overrides.day ?? 'Saturday'}-${overrides.period_number ?? 1}`,
    plan_id: 'plan-1',
    day: overrides.day ?? 'Saturday',
    period_number: overrides.period_number ?? 1,
    class_name: overrides.class_name ?? 'Foundation-KG',
    subject: overrides.subject ?? 'subject-1',
    is_free: overrides.is_free ?? false,
    topic: overrides.topic ?? '',
    objective: overrides.objective ?? null,
    activities: overrides.activities ?? '',
    slide_number: overrides.slide_number ?? null,
    details: overrides.details ?? [],
    sort_order: overrides.sort_order ?? 0,
    created_at: '2026-09-01T00:00:00Z',
    updated_at: '2026-09-01T00:00:00Z',
  };
}

// ─── Test 1 + Test 4: four periods and no forced extra periods ─────────────
describe('createEmptyPeriods — dynamic period count', () => {
  it('creates exactly 4 periods per day for a 4-period plan (no 5 or 6)', () => {
    const cells = createEmptyPeriods(4);
    const perDay = cells.filter((c) => c.day === 'Saturday');
    expect(perDay).toHaveLength(4);
    expect(perDay.map((c) => c.period_number)).toEqual([1, 2, 3, 4]);
    expect(cells.some((c) => c.period_number === 5 || c.period_number === 6)).toBe(false);
    expect(cells).toHaveLength(4 * 5);
  });

  it('creates exactly 5 periods per day for a 5-period plan', () => {
    const cells = createEmptyPeriods(5);
    const perDay = cells.filter((c) => c.day === 'Monday');
    expect(perDay.map((c) => c.period_number)).toEqual([1, 2, 3, 4, 5]);
  });

  it('creates exactly 6 periods per day for a 6-period plan', () => {
    const cells = createEmptyPeriods(6);
    const perDay = cells.filter((c) => c.day === 'Tuesday');
    expect(perDay.map((c) => c.period_number)).toEqual([1, 2, 3, 4, 5, 6]);
  });

  it('clamps counts into the allowed 4–6 range', () => {
    expect(clampPeriodCount(0)).toBe(4);
    expect(clampPeriodCount(-3)).toBe(4);
    expect(clampPeriodCount(2.9)).toBe(4);
    expect(clampPeriodCount(3)).toBe(4);
    expect(clampPeriodCount(4.9)).toBe(4);
    expect(clampPeriodCount(7)).toBe(6);
    expect(clampPeriodCount(100)).toBe(6);
    expect(clampPeriodCount(NaN)).toBe(4);
    expect(createEmptyPeriods(0)).toHaveLength(4 * 5);
  });
});

// ─── Test 7: save/reload keeps the same period count ────────────────────────
describe('resizePeriods — adding/removing periods preserves data', () => {
  it('removing periods keeps periods 1..4 and drops 5/6', () => {
    const six = createEmptyPeriods(6).map((c, i) => fillCell(c, `Topic ${c.period_number}`));
    const four = resizePeriods(six, 4);
    const saturday = four.filter((c) => c.day === 'Saturday');
    expect(saturday.map((c) => c.period_number)).toEqual([1, 2, 3, 4]);
    expect(saturday[0].topic).toBe('Topic 1');
    expect(saturday[3].topic).toBe('Topic 4');
  });

  it('adding a period appends only the new empty period', () => {
    const four = createEmptyPeriods(4).map((c, i) => fillCell(c, `Topic ${c.period_number}`));
    const six = resizePeriods(four, 6);
    const saturday = six.filter((c) => c.day === 'Saturday');
    expect(saturday.map((c) => c.period_number)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(saturday[0].topic).toBe('Topic 1');
    expect(saturday[5].topic).toBe('');
  });

  it('resizing to the same count is a no-op', () => {
    const four = createEmptyPeriods(4);
    const resized = resizePeriods(four, 4);
    expect(resized).toHaveLength(four.length);
    expect(resized.every((c, i) => c === four[i])).toBe(true);
  });
});

// ─── Test 6: existing 5/6-period plans still load ──────────────────────────
describe('periodsFromDb — backwards compatibility', () => {
  it('renders an existing 5-period plan as 5 periods, with all rows intact', () => {
    const rows: LessonPlanPeriod[] = [];
    for (const day of ['Saturday', 'Sunday', 'Monday', 'Tuesday', 'Wednesday'] as const) {
      for (let p = 1; p <= 5; p++) {
        rows.push(dbPeriod({ day, period_number: p, topic: `${day} P${p}` }));
      }
    }
    const cells = periodsFromDb(rows, 5);
    expect(cells.filter((c) => c.day === 'Saturday').map((c) => c.period_number)).toEqual([1, 2, 3, 4, 5]);
    expect(cells.find((c) => c.day === 'Tuesday' && c.period_number === 5)?.topic).toBe('Tuesday P5');
    expect(cells.some((c) => c.period_number === 6)).toBe(false);
  });

  it('renders an existing 6-period plan as 6 periods', () => {
    const rows: LessonPlanPeriod[] = [];
    for (const day of ['Saturday', 'Sunday', 'Monday', 'Tuesday', 'Wednesday'] as const) {
      for (let p = 1; p <= 6; p++) {
        rows.push(dbPeriod({ day, period_number: p }));
      }
    }
    const cells = periodsFromDb(rows, 6);
    expect(cells.filter((c) => c.day === 'Saturday')).toHaveLength(6);
    expect(cells.find((c) => c.day === 'Saturday' && c.period_number === 6)).toBeDefined();
  });

  it('renders a 4-period saved plan as 4 periods, without adding 5 or 6', () => {
    const rows: LessonPlanPeriod[] = [];
    for (const day of ['Saturday', 'Sunday', 'Monday', 'Tuesday', 'Wednesday'] as const) {
      for (let p = 1; p <= 4; p++) {
        rows.push(dbPeriod({ day, period_number: p }));
      }
    }
    const cells = periodsFromDb(rows, 4);
    expect(cells.filter((c) => c.day === 'Saturday')).toHaveLength(4);
    expect(cells.some((c) => c.period_number === 5 || c.period_number === 6)).toBe(false);
  });
});

// ─── Test 5: submission validation is against the plan's own periods ───────
describe('emptyInstructionalPeriods — submission validation', () => {
  it('a fully completed 4-period plan has no empty periods', () => {
    const cells = createEmptyPeriods(4).map((c) => fillCell(c, `Topic ${c.period_number}`));
    expect(emptyInstructionalPeriods(cells)).toHaveLength(0);
  });

  it('a 4-period plan is not rejected because period 5/6 is missing', () => {
    const cells = createEmptyPeriods(4).map((c) => fillCell(c, `Topic ${c.period_number}`));
    // The plan only ever contains periods 1-4; nothing to complain about.
    expect(cells.length).toBe(20);
    expect(emptyInstructionalPeriods(cells)).toHaveLength(0);
  });

  it('flags only real empty instructional periods', () => {
    const cells = createEmptyPeriods(4).map((c, i) => fillCell(c, i === 2 ? '' : `Topic ${c.period_number}`));
    cells[3] = fillCell(cells[3], 'Free', true);
    expect(emptyInstructionalPeriods(cells)).toHaveLength(1);
  });
});

// ─── RPC payload: count is saved together with the periods ─────────────────
vi.mock('../supabase', () => ({
  supabase: {
    from: vi.fn(),
    rpc: vi.fn(),
    functions: { invoke: vi.fn() },
  },
}));

import { supabase } from '../supabase';
import { savePeriods } from '../db/lessonPlans';

const mockFrom = supabase.from as unknown as ReturnType<typeof vi.fn>;
const mockRpc = supabase.rpc as unknown as ReturnType<typeof vi.fn>;

beforeEach(() => {
  mockFrom.mockReset();
  mockRpc.mockReset();
  mockFrom.mockImplementation(() => ({
    select: () => ({
      eq: () => ({
        single: () => Promise.resolve({ data: { status: 'draft', id: 'p1', teacher_id: 't1' }, error: null }),
      }),
    }),
  }));
  mockRpc.mockResolvedValue({ data: [], error: null });
});

describe('savePeriods payload — dynamic period count', () => {
  it('saves 4 periods for a 4-period plan and stores period_count 4', async () => {
    const periods = createEmptyPeriods(4).map((c, i) => fillCell(c, `Topic ${c.period_number}`)).map((c) => ({
      day: c.day,
      period_number: c.period_number,
      topic: c.topic,
    }));
    await savePeriods({ plan_id: 'p1', periods: periods as any, period_count: 4 });

    expect(mockRpc).toHaveBeenCalledWith('save_lesson_plan_periods', expect.objectContaining({
      p_plan_id: 'p1',
      p_period_count: 4,
    }));
    const call = mockRpc.mock.calls[0][1] as { p_periods: Array<{ day: string; period_number: number; topic: string }> };
    expect(call.p_periods).toHaveLength(4 * 5);
    expect(call.p_periods.every((p) => p.topic.startsWith('Topic '))).toBe(true);
  });

  it('does not send periods 5 or 6 for a four-period plan', async () => {
    const periods = createEmptyPeriods(4).map((c) => fillCell(c, `Topic ${c.period_number}`));
    await savePeriods({ plan_id: 'p1', periods: periods.map((p) => ({ day: p.day, period_number: p.period_number, topic: p.topic })) as any, period_count: 4 });

    const call = mockRpc.mock.calls[0][1] as { p_periods: Array<{ period_number: number }> };
    const periodNumbers = call.p_periods.map((p) => p.period_number);
    expect(Math.max(...periodNumbers)).toBe(4);
    expect(periodNumbers).not.toContain(5);
    expect(periodNumbers).not.toContain(6);
  });

  it('works for 5 and 6 periods as well', async () => {
    for (const count of [5, 6]) {
      const periods = createEmptyPeriods(count).map((c) => ({ day: c.day, period_number: c.period_number, topic: `T${c.period_number}` }));
      await savePeriods({ plan_id: 'p1', periods: periods as any, period_count: count });
      const call = mockRpc.mock.calls.at(-1)![1] as { p_period_count: number; p_periods: Array<{ period_number: number }> };
      expect(call.p_period_count).toBe(count);
      expect(Math.max(...call.p_periods.map((p) => p.period_number))).toBe(count);
    }
  });
});
