import { describe, it, expect, vi, beforeEach } from 'vitest';

// The commit path is a single RPC call. The RPC itself is admin-gated in
// SQL (supabase/migrations/20260906_student_class_import.sql); here we assert
// the client sends the right payload and surfaces DB errors (so a rejected
// non-admin or failed validation aborts with "nothing changed").

vi.mock('../supabase', () => ({
  supabase: {
    rpc: vi.fn(),
  },
}));

import { supabase } from '../supabase';
import { applyStudentClassImport } from '../db/classImport';

const mockRpc = supabase.rpc as unknown as ReturnType<typeof vi.fn>;

beforeEach(() => {
  mockRpc.mockReset();
});

describe('applyStudentClassImport', () => {
  it('sends changes + new students + academic year to the atomic RPC', async () => {
    mockRpc.mockResolvedValueOnce({
      data: {
        importRef: 'class-import-123',
        updatedCount: 1,
        createdCount: 1,
        skippedCount: 0,
        changes: [{ studentId: 'MBK-1001', name: 'Ahmed Ali', fromClass: 'Grade 7-A', toClass: 'Grade 7-B' }],
        created: [{ studentId: 'MBK-1402', name: 'Yusuf Hassan', className: 'Grade 6-A' }],
      },
      error: null,
    });

    const result = await applyStudentClassImport(
      [{ studentId: 'MBK-1001', toClass: 'Grade 7-B' }],
      [{ id: 'MBK-1402', name: 'Yusuf Hassan', className: 'Grade 6-A', govId: null, parentPhone: null }],
      'ay-2026',
      'class-import-123',
    );

    expect(mockRpc).toHaveBeenCalledWith('apply_student_class_import', {
      p_changes: [{ studentId: 'MBK-1001', toClass: 'Grade 7-B' }],
      p_new_students: [{ id: 'MBK-1402', name: 'Yusuf Hassan', className: 'Grade 6-A', govId: null, parentPhone: null }],
      p_academic_year_id: 'ay-2026',
      p_import_ref: 'class-import-123',
    });
    expect(result.updatedCount).toBe(1);
    expect(result.createdCount).toBe(1);
    expect(result.changes[0].toClass).toBe('Grade 7-B');
  });

  it('propagates the RPC error so a non-admin or invalid row aborts the whole import', async () => {
    mockRpc.mockResolvedValueOnce({
      data: null,
      error: { message: 'Only admins may apply a student class import.' },
    });

    await expect(applyStudentClassImport([], [], null)).rejects.toThrowError(/Only admins/);
  });

  it('propagates validation errors (class does not exist)', async () => {
    mockRpc.mockResolvedValueOnce({
      data: null,
      error: { message: 'Class "Grade 9-Z" does not exist.' },
    });

    await expect(
      applyStudentClassImport([{ studentId: 'MBK-1001', toClass: 'Grade 9-Z' }], [], null),
    ).rejects.toThrowError(/does not exist/);
  });
});
