import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the supabase client module before importing the functions under test
const mockFrom = vi.fn();
const mockSupabase = {
  from: mockFrom,
};

vi.mock('../supabase', () => ({
  supabase: mockSupabase,
}));

import { getUsers, getStudents, logAllClassSubjects } from '../database';

beforeEach(() => {
  mockFrom.mockReset();
});

describe('database helpers', () => {
  it('getUsers returns rows from supabase', async () => {
    const users = [{ id: 'u1', name: 'Alice' }, { id: 'u2', name: 'Bob' }];
    // chain: supabase.from('users').select('*') -> resolves { data, error }
    mockFrom.mockImplementation((table: string) => ({
      select: (_sel: any) => Promise.resolve({ data: users, error: null })
    }));

    const res = await getUsers();
    expect(res).toEqual(users);
    expect(mockFrom).toHaveBeenCalledWith('users');
  });

  it('getStudents returns rows from supabase', async () => {
    const students = [{ id: 's1', name: 'Student1' }];
    mockFrom.mockImplementation((table: string) => ({
      select: (_sel: any) => Promise.resolve({ data: students, error: null })
    }));

    const res = await getStudents();
    expect(res).toEqual(students);
    expect(mockFrom).toHaveBeenCalledWith('students');
  });

  it('logAllClassSubjects respects limit and returns range data', async () => {
    const rows = [{ id: 'c1' }, { id: 'c2' }];
    // chain: supabase.from('class_subjects').select('*').range(from,to)
    mockFrom.mockImplementation((table: string) => ({
      select: (_sel: any) => ({
        range: (_from: number, _to: number) => Promise.resolve({ data: rows, error: null })
      })
    }));

    const res = await logAllClassSubjects(2);
    expect(res).toEqual(rows);
    expect(mockFrom).toHaveBeenCalledWith('class_subjects');
  });
});
