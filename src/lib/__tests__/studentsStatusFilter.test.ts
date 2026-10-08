// students.status filtering in the data layer.
//
// These are the functions behind every current roster in the app (teacher class
// lists, attendance, marks entry, dashboards, the parent portal), so the rule
// "Former Students disappear from active lists, and nothing else changes" is
// asserted here with a mocked Supabase client.

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../supabase', () => ({
  supabase: { from: vi.fn() },
}));

import { supabase } from '../supabase';
import {
  filterStudentsByStatus,
  getStudentClasses,
  getStudents,
  getStudentsByClass,
  getStudentsByClasses,
  getStudentsByParent,
  getStudentsPaginated,
  isActiveStudentRecord,
} from '../db/students';
import type { Student } from '../../types';

const mockFrom = supabase.from as unknown as ReturnType<typeof vi.fn>;

const ACTIVE: Student = { id: 'student-1', name: 'Active Child', className: 'Grade 2-C', parentId: null, createdAt: '2026-01-01', status: 'active' };
const FORMER: Student = { id: 'student-2', name: 'Left Child', className: 'Grade 2-C', parentId: null, createdAt: '2026-01-01', status: 'former', transport: 'LEFT' };
// Rows written before the status column existed carry no value at all.
const LEGACY: Student = { id: 'student-3', name: 'Legacy Child', className: 'Grade 2-C', parentId: null, createdAt: '2026-01-01' };

const ROWS = [ACTIVE, FORMER, LEGACY];

/** Chain mock: records filters, ignores them, and returns every row. */
function mockTable(rows: unknown[] = ROWS) {
  const calls: Array<{ method: string; args: unknown[] }> = [];
  mockFrom.mockReset();
  mockFrom.mockImplementation(() => {
    const chain: any = {
      select: (columns?: string, opts?: unknown) => { calls.push({ method: 'select', args: [columns, opts] }); return chain; },
      order: () => chain,
      eq: (...args: unknown[]) => { calls.push({ method: 'eq', args }); return chain; },
      neq: (...args: unknown[]) => { calls.push({ method: 'neq', args }); return chain; },
      in: (...args: unknown[]) => { calls.push({ method: 'in', args }); return chain; },
      ilike: () => chain,
      range: (from: number, to: number) => {
        const slice = rows.slice(from, to + 1);
        return Promise.resolve({ data: slice, error: null, count: rows.length });
      },
      then: (onF: any, onR: any) => Promise.resolve({ data: rows, error: null, count: rows.length }).then(onF, onR),
    };
    return chain;
  });
  return calls;
}

beforeEach(() => {
  mockFrom.mockReset();
});

describe('the active/former predicate', () => {
  it('treats a missing status as active so nobody disappears', () => {
    expect(isActiveStudentRecord(ACTIVE)).toBe(true);
    expect(isActiveStudentRecord(FORMER)).toBe(false);
    expect(isActiveStudentRecord(LEGACY)).toBe(true);
    expect(isActiveStudentRecord({ status: null } as Student)).toBe(true);
    expect(isActiveStudentRecord(null)).toBe(true);
  });

  it('filters in all three modes', () => {
    expect(filterStudentsByStatus(ROWS).map(s => s.id)).toEqual(['student-1', 'student-3']);
    expect(filterStudentsByStatus(ROWS, 'all').map(s => s.id)).toEqual(['student-1', 'student-2', 'student-3']);
    expect(filterStudentsByStatus(ROWS, 'former').map(s => s.id)).toEqual(['student-2']);
  });
});

describe('roster readers default to active students only', () => {
  it('getStudents excludes Former Students by default and keeps them on request', async () => {
    mockTable();
    expect((await getStudents()).map(s => s.id)).toEqual(['student-1', 'student-3']);
    expect((await getStudents(undefined, 'all')).map(s => s.id)).toEqual(['student-1', 'student-2', 'student-3']);
    expect((await getStudents(undefined, 'former')).map(s => s.id)).toEqual(['student-2']);
  });

  it('requests the status columns so the database can filter too', async () => {
    const calls = mockTable();
    await getStudents();
    expect(calls[0].args[0]).toContain('status');
    expect(calls[0].args[0]).toContain('statusUpdatedAt');
  });

  it('getStudentsByClass / ByClasses / ByParent exclude leavers', async () => {
    mockTable();
    expect((await getStudentsByClass('Grade 2-C')).map(s => s.id)).toEqual(['student-1', 'student-3']);
    expect((await getStudentsByClasses(['Grade 2-C'])).map(s => s.id)).toEqual(['student-1', 'student-3']);
    expect((await getStudentsByParent('parent-1')).map(s => s.id)).toEqual(['student-1', 'student-3']);
    expect((await getStudentsByParent('parent-1', 'all')).map(s => s.id)).toEqual(['student-1', 'student-2', 'student-3']);
  });

  it('getStudentClasses lists only classes that still have active students', async () => {
    mockTable([
      { ...FORMER, className: 'Grade 9-Z' },
      { ...ACTIVE, className: 'Grade 2-C' },
    ]);
    expect(await getStudentClasses()).toEqual(['Grade 2-C']);
    expect(await getStudentClasses('all')).toEqual(['Grade 2-C', 'Grade 9-Z']);
  });

  it('getStudentsPaginated pushes the status filter to the server and reports the filtered total', async () => {
    const calls = mockTable([ACTIVE, LEGACY]);
    const res = await getStudentsPaginated(1, 50);
    expect(res.students.map(s => s.id)).toEqual(['student-1', 'student-3']);
    expect(res.total).toBe(2);
    expect(calls.some(c => c.method === 'eq' && c.args[0] === 'status' && c.args[1] === 'active')).toBe(true);
  });

  it('getStudentsPaginated does not filter when every student is wanted', async () => {
    const calls = mockTable();
    const res = await getStudentsPaginated(1, 50, undefined, 'all');
    expect(res.students.map(s => s.id)).toEqual(['student-1', 'student-2', 'student-3']);
    expect(calls.some(c => c.method === 'eq' && c.args[0] === 'status')).toBe(false);
  });
});
