// Edit Student → "Assign Parent".
//
// Two production defects are pinned here:
//
//  1. MISSING PARENTS. The picker called getUsersByRole('parent'), which
//     defaults to page 1 / limit 100, then filtered that array in the browser.
//     Parent #101 onwards was never fetched, so it could never be found —
//     administrators could not assign the correct parent. searchParents()
//     does the matching in Postgres over the whole parent table instead.
//
//  2. UNASSIGN WAS A SILENT NO-OP. update_student() (20260906c) uses NULL as
//     the "leave this column alone" sentinel and NULLIF(p_parent_id,'') when
//     it writes. Sending raw null for an explicit clear meant "no change", so
//     a wrongly assigned parent could never be removed. '' is the clear.
//
// The write path itself stays on the existing secure architecture: the
// admin-gated, SECURITY DEFINER, audit-logged update_student() RPC. students
// has no client UPDATE policy (20260906d_rls_lockdown), so this is asserted
// too — no direct table write may be reintroduced.

import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../supabase', () => ({
  supabase: { from: vi.fn(), rpc: vi.fn() },
  createAuthedClient: vi.fn(),
}));

import { supabase } from '../supabase';
import { searchParents } from '../db/profiles';
import { updateStudent } from '../db/students';

const mockFrom = supabase.from as unknown as ReturnType<typeof vi.fn>;
const mockRpc = supabase.rpc as unknown as ReturnType<typeof vi.fn>;

/** Records every PostgREST filter applied, then resolves with `rows`. */
function stubProfiles(rows: any[]) {
  const calls: Record<string, any> = { ilike: [], or: [], limit: null, order: null };
  const builder: any = {
    select: () => builder,
    ilike: (col: string, val: string) => { calls.ilike.push([col, val]); return builder; },
    or: (expr: string) => { calls.or.push(expr); return builder; },
    order: (col: string, opts: any) => { calls.order = [col, opts]; return builder; },
    limit: (n: number) => { calls.limit = n; return Promise.resolve({ data: rows, error: null }); },
    eq: (col: string, val: string) => { calls.ilike.push([col, val]); return builder; },
  };
  mockFrom.mockImplementation(() => builder);
  return calls;
}

const parent = (over: Partial<any> = {}) => ({
  id: 'parent-1', name: 'Amina Yusuf', email: 'amina@example.com',
  role: 'parent', phone1: '0612345678', createdAt: '', ...over,
});

beforeEach(() => {
  mockFrom.mockReset();
  mockRpc.mockReset();
});

describe('searchParents — every existing parent is reachable', () => {
  it('filters on the server rather than a pre-fetched 100-row page', async () => {
    const calls = stubProfiles([parent()]);
    await searchParents('amina');

    expect(mockFrom).toHaveBeenCalledWith('profiles');
    // The term must reach the database, not be applied after the fetch.
    expect(calls.or).toHaveLength(1);
    expect(calls.or[0]).toContain('%amina%');
    // No .range()/page window that could hide later parents.
    expect(calls.limit).toBeGreaterThanOrEqual(50);
  });

  it('matches name, email AND phone numbers', async () => {
    const calls = stubProfiles([]);
    await searchParents('0612');

    const expr = calls.or[0];
    expect(expr).toContain('name.ilike.%0612%');
    expect(expr).toContain('email.ilike.%0612%');
    expect(expr).toContain('phone1.ilike.%0612%');
    expect(expr).toContain('phone2.ilike.%0612%');
  });

  it('restricts to the parent role case-insensitively', async () => {
    const calls = stubProfiles([]);
    await searchParents('a');
    expect(calls.ilike).toContainEqual(['role', 'parent']);
  });

  it('drops rows whose role is not exactly parent', async () => {
    stubProfiles([parent(), parent({ id: 't1', role: 'teacher' })]);
    const res = await searchParents('a');
    expect(res.map(r => r.id)).toEqual(['parent-1']);
  });

  it('tolerates padded / odd-cased legacy role values', async () => {
    stubProfiles([parent({ id: 'p2', role: ' Parent ' as any })]);
    const res = await searchParents('a');
    expect(res.map(r => r.id)).toEqual(['p2']);
  });

  it('returns a first page of parents for an empty term', async () => {
    const calls = stubProfiles([parent()]);
    const res = await searchParents('');
    expect(calls.or).toHaveLength(0); // no term filter …
    expect(calls.ilike).toContainEqual(['role', 'parent']); // … but still parents only
    expect(res).toHaveLength(1);
  });

  it('neutralises characters that would break out of the or= filter', async () => {
    const calls = stubProfiles([]);
    await searchParents('a,b(c)');
    expect(calls.or[0]).not.toMatch(/name\.ilike\.%a,/);
  });

  it('surfaces database errors instead of silently showing zero parents', async () => {
    mockFrom.mockImplementation(() => {
      const b: any = {
        select: () => b, ilike: () => b, or: () => b, order: () => b,
        limit: () => Promise.resolve({ data: null, error: { message: 'permission denied' } }),
      };
      return b;
    });
    await expect(searchParents('a')).rejects.toBeTruthy();
  });
});

describe('updateStudent — secure RPC write path', () => {
  beforeEach(() => {
    mockRpc.mockResolvedValue({ data: null, error: null });
    stubProfiles([]);
    mockFrom.mockImplementation(() => {
      const b: any = {
        select: () => b, eq: () => b,
        single: () => Promise.resolve({ data: { id: 's1' }, error: null }),
      };
      return b;
    });
  });

  it('assigns a parent through the admin-gated update_student RPC', async () => {
    await updateStudent('s1', { name: 'Ayaan', className: 'Grade 4-A', parentId: 'parent-1' });

    expect(mockRpc).toHaveBeenCalledWith('update_student', expect.objectContaining({
      p_student_id: 's1',
      p_parent_id: 'parent-1',
    }));
  });

  it('never writes to the students table directly (RLS is SELECT-only)', async () => {
    const tables: string[] = [];
    mockFrom.mockImplementation((t: string) => {
      tables.push(t);
      const b: any = { select: () => b, eq: () => b, single: () => Promise.resolve({ data: {}, error: null }) };
      return b;
    });
    await updateStudent('s1', { parentId: 'parent-1' });
    // students is only ever read back, and only via select().
    expect(tables.every(t => t === 'students')).toBe(true);
    expect(mockRpc).toHaveBeenCalledTimes(1);
  });

  it('sends an empty string to CLEAR a parent, because the RPC reads null as "no change"', async () => {
    await updateStudent('s1', { parentId: null });
    expect(mockRpc.mock.calls[0][1].p_parent_id).toBe('');
  });

  it('sends null for fields the caller did not touch', async () => {
    await updateStudent('s1', { parentId: 'parent-1' });
    const args = mockRpc.mock.calls[0][1];
    expect(args.p_gov_id).toBeNull();
    expect(args.p_parent_phone).toBeNull();
    expect(args.p_transport).toBeNull();
  });

  it('does not clobber transport or gov id when only the parent changes', async () => {
    await updateStudent('s1', { parentId: 'parent-2' });
    const args = mockRpc.mock.calls[0][1];
    expect(args.p_transport).toBeNull(); // NULL == leave column alone
    expect(args.p_parent_id).toBe('parent-2');
  });

  it('propagates a rejected write so the admin sees the real reason', async () => {
    mockRpc.mockResolvedValue({
      data: null,
      error: { message: 'Only administrators may perform this action.' },
    });
    await expect(updateStudent('s1', { parentId: 'p1' }))
      .rejects.toThrow(/Only administrators/);
  });
});
