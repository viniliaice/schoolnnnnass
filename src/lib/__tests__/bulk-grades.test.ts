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
