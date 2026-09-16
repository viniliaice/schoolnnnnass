import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../supabase', () => ({
  supabase: {
    from: vi.fn(),
  },
}));

import { supabase } from '../supabase';
import { getUsers } from '../db/profiles';
import { getStudents } from '../db/students';
import { logAllClassSubjects } from '../db/classes';

const mockFrom = supabase.from as unknown as ReturnType<typeof vi.fn>;

beforeEach(() => {
  mockFrom.mockReset();
});

describe('database helpers', () => {
  it('getUsers returns rows from supabase', async () => {
    const users = [{ id: 'u1', name: 'Alice' }, { id: 'u2', name: 'Bob' }];
    // chain: supabase.from('profiles').select('*') -> resolves { data, error }
    mockFrom.mockImplementation((_table: string) => ({
      select: (_sel: any) => Promise.resolve({ data: users, error: null })
    }));

    const res = await getUsers();
    expect(res).toEqual(users);
    expect(mockFrom).toHaveBeenCalledWith('profiles');
  });

  it('getStudents returns rows from supabase', async () => {
    const students = [{ id: 's1', name: 'Student1' }];
    // New implementation uses .select().order().range() with pagination.
    const makeChain = (data: any) => {
      const chain: any = {};
      chain.order = () => chain;
      chain.range = () => Promise.resolve({ data, error: null });
      chain.then = (onFulfilled: any, onRejected: any) =>
        Promise.resolve({ data, error: null }).then(onFulfilled, onRejected);
      return chain;
    };
    mockFrom.mockImplementation((_table: string) => ({
      select: (_sel: any) => makeChain(students),
    }));

    const res = await getStudents();
    expect(res).toEqual(students);
    expect(mockFrom).toHaveBeenCalledWith('students');
  });

  it('logAllClassSubjects respects limit and returns range data', async () => {
    const rows = [{ id: 'c1' }, { id: 'c2' }];
    // chain: supabase.from('class_subjects').select('*').range(from,to)
    mockFrom.mockImplementation((_table: string) => ({
      select: (_sel: any) => ({
        range: (_from: number, _to: number) => Promise.resolve({ data: rows, error: null })
      })
    }));

    const res = await logAllClassSubjects(2);
    expect(res).toEqual(rows);
    expect(mockFrom).toHaveBeenCalledWith('class_subjects');
  });
});
