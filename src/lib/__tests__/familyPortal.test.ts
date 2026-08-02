import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../supabase', () => ({
  supabase: { from: vi.fn() },
}));

import { supabase } from '../supabase';
import { getParentFamilyCard } from '../db/familyPortal';

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
