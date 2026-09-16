import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../supabase', () => ({
  supabase: {
    from: vi.fn(),
  },
}));

import { supabase } from '../supabase';
import { getStudents, getStudentClasses, getStudentsByClasses } from '../db/students';

const mockFrom = supabase.from as unknown as ReturnType<typeof vi.fn>;

beforeEach(() => {
  mockFrom.mockReset();
});

function makeStudents(count: number, start = 0) {
  return Array.from({ length: count }, (_, i) => ({
    id: `stu-${String(start + i + 1).padStart(5, '0')}`,
    name: `Student ${start + i + 1}`,
    className: `Grade ${(start + i) % 7 + 1}-A`,
    parentId: null,
    createdAt: '2026-01-01',
    govId: null,
    transport: 'WALKER',
    parentPhone: null,
    familyId: null,
  }));
}

function mockPaginated(tableData: any[]) {
  // Simulates supabase chain: .select().order().range(from,to) -> {data, error}
  // Also supports .select().in().order().range() and .select().eq().order().range()
  // For simplicity, we ignore filters and just slice by range.
  // The chain is thenable so `await query` works even when range returns chain.
  mockFrom.mockImplementation(() => {
    let rangeFrom = 0;
    let rangeTo = 999;
    const chain: any = {
      select: () => chain,
      order: () => chain,
      eq: () => chain,
      in: () => chain,
      ilike: () => chain,
      range: (from: number, to: number) => {
        rangeFrom = from;
        rangeTo = to;
        return chain;
      },
    };
    // Make chain thenable: awaiting it resolves to sliced data.
    chain.then = (onFulfilled: any, onRejected: any) => {
      const slice = tableData.slice(rangeFrom, rangeTo + 1);
      return Promise.resolve({ data: slice, error: null }).then(onFulfilled, onRejected);
    };
    return chain;
  });
}

describe('students pagination >1000', () => {
  it('getStudents fetches all pages beyond 1000', async () => {
    const allData = makeStudents(1500);
    mockPaginated(allData);

    const result = await getStudents();
    expect(result).toHaveLength(1500);
    expect(result[0].id).toBe('stu-00001');
    expect(result[1499].id).toBe('stu-01500');
    // Ensure no duplicates
    expect(new Set(result.map(s => s.id)).size).toBe(1500);
  });

  it('getStudents respects limit but still paginates up to limit', async () => {
    const allData = makeStudents(2500);
    mockPaginated(allData);

    const result = await getStudents(1500);
    expect(result).toHaveLength(1500);
  });

  it('getStudentClasses fetches all pages', async () => {
    const allData = makeStudents(1500).map(s => ({ className: s.className }));
    mockPaginated(allData);

    const classes = await getStudentClasses();
    // Should have distinct classes
    expect(classes.length).toBeGreaterThan(0);
    expect(classes.length).toBeLessThanOrEqual(7);
  });

  it('getStudentsByClasses paginates when limit >1000', async () => {
    const allData = makeStudents(1500);
    mockPaginated(allData);

    const result = await getStudentsByClasses(['Grade 1-A', 'Grade 2-A'], undefined, 1500);
    // Our mock ignores filter, so it returns 1500
    expect(result).toHaveLength(1500);
  });

  it('getStudentsByClasses with small limit still works single page', async () => {
    const allData = makeStudents(500);
    mockPaginated(allData);

    const result = await getStudentsByClasses(['Grade 1-A'], undefined, 100);
    expect(result).toHaveLength(100);
  });
});
