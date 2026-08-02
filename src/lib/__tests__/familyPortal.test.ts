import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../supabase', () => ({
  supabase: { from: vi.fn() },
}));

import { supabase } from '../supabase';
import { getParentFamilyCard, getRecentReleases } from '../db/familyPortal';

const mockFrom = supabase.from as unknown as ReturnType<typeof vi.fn>;

function chainResolve(data: unknown) {
  mockFrom.mockImplementation(() => ({
    select: () => ({ eq: () => Promise.resolve({ data, error: null }) }),
  }));
}

beforeEach(() => mockFrom.mockReset());

describe('getParentFamilyCard', () => {
  it('scopes the query strictly to the logged-in parentId', async () => {
    chainResolve([]);
    const eq = vi.fn(() => Promise.resolve({ data: [], error: null }));
    mockFrom.mockImplementation(() => ({ select: () => ({ eq }) }));

    await getParentFamilyCard('parent-A');
    expect(mockFrom).toHaveBeenCalledWith('students');
    expect(eq).toHaveBeenCalledWith('parentId', 'parent-A');
  });

  it('returns the shared familyId + kids for the parent', async () => {
    chainResolve([
      { id: 's1', name: 'Fartun Axmed', className: 'Grade 4-A', parentId: 'parent-A', createdAt: '', govId: null, transport: 'WALKER', parentPhone: '634537584', familyId: '0421' },
      { id: 's2', name: 'Maxamed Axmed', className: 'Grade 2-B', parentId: 'parent-A', createdAt: '', govId: null, transport: 'WALKER', parentPhone: '634537584', familyId: '0421' },
    ]);
    const card = await getParentFamilyCard('parent-A');
    expect(card.familyId).toBe('0421');
    expect(card.pending).toBe(false);
    expect(card.students).toHaveLength(2);
    expect(card.students.every(s => s.parentId === 'parent-A')).toBe(true);
  });

  it('marks pending when children exist but Generate has not run', async () => {
    chainResolve([
      { id: 's1', name: 'Fartun Axmed', className: 'Grade 4-A', parentId: 'parent-A', createdAt: '', govId: null, transport: 'WALKER', parentPhone: '', familyId: null },
    ]);
    const card = await getParentFamilyCard('parent-A');
    expect(card.familyId).toBeNull();
    expect(card.pending).toBe(true);
  });

  it('returns empty (not pending) when the parent has no children', async () => {
    chainResolve([]);
    const card = await getParentFamilyCard('parent-A');
    expect(card.students).toEqual([]);
    expect(card.familyId).toBeNull();
    expect(card.pending).toBe(false);
  });

  it('throws on query error', async () => {
    mockFrom.mockImplementation(() => ({
      select: () => ({ eq: () => Promise.resolve({ data: null, error: { message: 'denied' } }) }),
    }));
    await expect(getParentFamilyCard('parent-A')).rejects.toThrow(/denied/);
  });
});

describe('getRecentReleases', () => {
  function mockKidsChain(kids: unknown[]) {
    mockFrom.mockImplementation((table: string) => {
      if (table === 'students') {
        return { select: () => ({ eq: () => Promise.resolve({ data: kids, error: null }) }) };
      }
      // release_log chain: select(...).in(...).order(...).limit(...)
      return {
        select: () => ({
          in: () => ({
            order: () => ({
              limit: () => Promise.resolve({ data: [], error: null }),
            }),
          }),
        }),
      };
    });
  }

  it('scopes releases to the parent\'s own children only', async () => {
    const kids = [{ id: 's1' }, { id: 's2' }];
    const inFn = vi.fn(() => ({
      order: () => ({ limit: () => Promise.resolve({ data: [], error: null }) }),
    }));
    mockFrom.mockImplementation((table: string) =>
      table === 'students'
        ? { select: () => ({ eq: () => Promise.resolve({ data: kids, error: null }) }) }
        : { select: () => ({ in: inFn }) },
    );

    await getRecentReleases('parent-A');
    expect(inFn).toHaveBeenCalledWith('studentId', ['s1', 's2']);
  });

  it('returns [] without querying release_log when the parent has no children', async () => {
    mockKidsChain([]);
    const res = await getRecentReleases('parent-A');
    expect(res).toEqual([]);
  });

  it('returns joined release rows', async () => {
    const rows = [
      { id: 1, studentId: 's1', familyId: '0421', staffId: 'office-umal', createdAt: '2026-08-02T14:00:00Z', students: { name: 'Fartun Axmed', className: 'Grade 4-A' } },
    ];
    mockFrom.mockImplementation((table: string) =>
      table === 'students'
        ? { select: () => ({ eq: () => Promise.resolve({ data: [{ id: 's1' }], error: null }) }) }
        : {
            select: () => ({
              in: () => ({
                order: () => ({ limit: () => Promise.resolve({ data: rows, error: null }) }),
              }),
            }),
          },
    );
    const res = await getRecentReleases('parent-A');
    expect(res).toHaveLength(1);
    expect(res[0].students?.name).toBe('Fartun Axmed');
  });
});
