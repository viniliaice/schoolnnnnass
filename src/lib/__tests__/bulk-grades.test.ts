import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../supabase', () => ({
  supabase: { rpc: vi.fn() },
}));

import { supabase } from '../supabase';
import { submitBulkGrades } from '../db/bulkGrades';

const rpc = supabase.rpc as unknown as ReturnType<typeof vi.fn>;
const record = {
  studentId: 'student-1', subjectId: 'english', assessmentLabel: 'AKHLAAQ' as const,
  examType: 'Discipline' as const, score: 10, total: 10, entryState: 'scored' as const,
  month: 'August', date: '2026-08-02', termId: 'term-1',
};

beforeEach(() => rpc.mockReset());

describe('submitBulkGrades', () => {
  it('uses the server RPC for a no-write conflict preview', async () => {
    rpc.mockResolvedValue({ data: { requiresConfirmation: true, insertCount: 3, updateCount: 2, skippedCount: 0 }, error: null });
    await expect(submitBulkGrades([record], 'upload-key-12345', false)).resolves.toMatchObject({ requiresConfirmation: true, insertCount: 3, updateCount: 2 });
    expect(rpc).toHaveBeenCalledWith('submit_bulk_grades', {
      p_records: [record], p_idempotency_key: 'upload-key-12345', p_confirm_updates: false,
    });
  });

  it('surfaces structured RPC failures instead of reporting a false success', async () => {
    rpc.mockResolvedValue({ data: null, error: { message: 'Teachers may upload only their assigned class subjects.' } });
    await expect(submitBulkGrades([record], 'upload-key-12345', true)).rejects.toThrow('assigned class subjects');
  });
});

describe('submitBulkGrades — change preview parsing', () => {
  it('parses the server change list, approved flags, and old->new values', async () => {
    rpc.mockResolvedValue({
      data: {
        requiresConfirmation: true,
        insertCount: 1,
        updateCount: 1,
        approvedChangeCount: 1,
        requiresApprovedAcknowledgement: true,
        changes: [
          {
            studentId: 'student-1', studentName: 'Ahmed Ali', className: 'Grade 5-A',
            subject: 'Arabic', subjectId: 'arabic', assessmentLabel: 'MT', examType: 'Quiz',
            newScore: 17, newEntryState: 'scored', existingScore: 14, existingEntryState: 'scored',
            existingStatus: 'approved', changeType: 'update', isApproved: true,
          },
          {
            studentId: 'student-2', studentName: 'Aisha Hassan', className: 'Grade 5-A',
            subject: 'Tarbiya', subjectId: 'tarbiya', assessmentLabel: 'HW2', examType: 'Homework',
            newScore: 5, newEntryState: 'scored', existingScore: null, existingEntryState: null,
            existingStatus: null, changeType: 'new', isApproved: false,
          },
        ],
      },
      error: null,
    });
    const result = await submitBulkGrades([record], 'upload-key-12345', false);
    expect(result.approvedChangeCount).toBe(1);
    expect(result.requiresApprovedAcknowledgement).toBe(true);
    expect(result.changes).toHaveLength(2);
    expect(result.changes[0]).toMatchObject({ existingScore: 14, newScore: 17, isApproved: true, changeType: 'update' });
    expect(result.changes[1]).toMatchObject({ existingScore: null, newScore: 5, changeType: 'new', isApproved: false });
  });

  it('defaults change fields safely when the server omits them (backward compatible)', async () => {
    rpc.mockResolvedValue({ data: { requiresConfirmation: false, insertCount: 2, updateCount: 0 }, error: null });
    const result = await submitBulkGrades([record], 'upload-key-12345', false);
    expect(result.changes).toEqual([]);
    expect(result.approvedChangeCount).toBe(0);
    expect(result.requiresApprovedAcknowledgement).toBe(false);
  });
});
