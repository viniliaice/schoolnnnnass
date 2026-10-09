// Deploy-order safety for students.status.
//
// The client release and the migration ship together, but a database can still
// be behind (a staged rollout, a restored snapshot, a self-hosted copy). Asking
// PostgREST for a column that does not exist fails the WHOLE query, which would
// blank every roster in the app. So every student read retries once with the
// legacy column list: the feature degrades to "no former-student filtering"
// instead of breaking student lists.
//
// Separate file on purpose — the fallback flips module-level state, and other
// tests must keep seeing a migrated database.

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../supabase', () => ({
  supabase: { from: vi.fn() },
}));

import { supabase } from '../supabase';
import { getStudents, getStudentsByClass, getStudentsPaginated } from '../db/students';
import type { Student } from '../../types';

const mockFrom = supabase.from as unknown as ReturnType<typeof vi.fn>;

const ROWS: Student[] = [
  { id: 'student-1', name: 'Active Child', className: 'Grade 2-C', parentId: null, createdAt: '2026-01-01' } as Student,
];

const MISSING_COLUMN = { code: '42703', message: 'column students.status does not exist' };

/** A database that has not run 20261008 yet: any select of `status` fails. */
function mockUnmigratedDatabase(rows: unknown[] = ROWS) {
  const selects: string[] = [];
  mockFrom.mockReset();
  mockFrom.mockImplementation(() => {
    let columns = '';
    const resolve = () => columns.includes('status')
      ? Promise.resolve({ data: null, error: MISSING_COLUMN, count: null })
      : Promise.resolve({ data: rows, error: null, count: rows.length });
    const chain: any = {
      select: (cols: string) => { columns = cols ?? ''; selects.push(columns); return chain; },
      order: () => chain,
      eq: () => chain,
      neq: () => chain,
      in: () => chain,
      ilike: () => chain,
      range: () => resolve(),
      then: (onF: any, onR: any) => resolve().then(onF, onR),
    };
    return chain;
  });
  return selects;
}

beforeEach(() => {
  mockFrom.mockReset();
});

describe('legacy column fallback', () => {
  it('retries getStudents without the status columns and still returns students', async () => {
    const selects = mockUnmigratedDatabase();
    const res = await getStudents();
    expect(res).toHaveLength(1);
    expect(res[0].id).toBe('student-1');
    expect(selects[0]).toContain('status');          // first attempt asks for it
    expect(selects[1]).not.toContain('status');      // retry uses the legacy list
  });

  it('applies the same fallback to class rosters', async () => {
    mockUnmigratedDatabase();
    const res = await getStudentsByClass('Grade 2-C');
    expect(res).toHaveLength(1);
  });

  it('remembers the database has no status column (no repeated failing round-trips)', async () => {
    const selects = mockUnmigratedDatabase();
    await getStudents();
    selects.length = 0;
    await getStudents();
    await getStudentsByClass('Grade 2-C');
    expect(selects.length).toBeGreaterThan(0);
    expect(selects.every(columns => !columns.includes('status'))).toBe(true);
  });

  it('falls back for the paginated reader too, and still returns a usable page', async () => {
    mockUnmigratedDatabase();
    const res = await getStudentsPaginated(1, 50);
    expect(res.students).toHaveLength(1);
    expect(typeof res.total).toBe('number');
  });
});
