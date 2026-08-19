import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../supabase', () => ({ supabase: { rpc: vi.fn(), from: vi.fn() } }));

import { supabase } from '../supabase';
import { getParentNames } from '../db/familyIds';

const from = supabase.from as unknown as ReturnType<typeof vi.fn>;
beforeEach(() => from.mockReset());

/** Minimal PostgREST-ish builder: .select().in() resolves to {data,error}. */
function mockProfiles(handler: (ids: string[]) => { data?: unknown; error?: unknown }) {
  from.mockReturnValue({
    select: () => ({ in: (_col: string, ids: string[]) => Promise.resolve(handler(ids)) }),
  });
}

describe('getParentNames — must never stall the families table', () => {
  it('chunks large id lists instead of one enormous URL', async () => {
    const seen: number[] = [];
    mockProfiles(ids => {
      seen.push(ids.length);
      return { data: ids.map(id => ({ id, name: `Parent ${id}` })), error: null };
    });

    const ids = Array.from({ length: 250 }, (_, i) => `p${i}`);
    const names = await getParentNames(ids);

    expect(seen.length).toBe(3);              // 100 + 100 + 50
    expect(Math.max(...seen)).toBeLessThanOrEqual(100);
    expect(names.size).toBe(250);
    expect(names.get('p0')).toBe('Parent p0');
  });

  it('degrades to no-name instead of rejecting when profiles is unreadable', async () => {
    // office/supervisor cannot read profiles — this must not blow up the page.
    mockProfiles(() => ({ data: null, error: { message: 'permission denied' } }));
    await expect(getParentNames(['p1', 'p2'])).resolves.toEqual(new Map());
  });

  it('returns partial results when only one chunk fails', async () => {
    let call = 0;
    mockProfiles(ids => {
      call += 1;
      if (call === 2) return { data: null, error: { message: 'boom' } };
      return { data: ids.map(id => ({ id, name: `N-${id}` })), error: null };
    });
    const names = await getParentNames(Array.from({ length: 150 }, (_, i) => `p${i}`));
    expect(names.size).toBe(100);
  });

  it('short-circuits an empty list without touching the network', async () => {
    await expect(getParentNames([])).resolves.toEqual(new Map());
    expect(from).not.toHaveBeenCalled();
  });

  it('deduplicates repeated parent ids (siblings share a parent)', async () => {
    const seen: string[][] = [];
    mockProfiles(ids => { seen.push(ids); return { data: [], error: null }; });
    await getParentNames(['p1', 'p1', 'p1', 'p2']);
    expect(seen[0]).toEqual(['p1', 'p2']);
  });
});
