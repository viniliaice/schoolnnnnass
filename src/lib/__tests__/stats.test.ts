import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../supabase', () => ({
  supabase: {
    rpc: vi.fn(),
    from: vi.fn(),
  },
}));

import { supabase } from '../supabase';
import { getSystemStats } from '../db/stats';

const mockRpc = supabase.rpc as unknown as ReturnType<typeof vi.fn>;

beforeEach(() => {
  mockRpc.mockReset();
});

describe('getSystemStats', () => {
  it('uses the get_system_stats RPC and normalizes numeric values', async () => {
    mockRpc.mockResolvedValue({
      data: {
        totalTeachers: '2',
        totalParents: 3,
        totalStudents: '42',
        totalExams: 100,
        pendingExams: '4',
        approvedExams: 90,
        rejectedExams: '6',
        averageScore: '81.25',
      },
      error: null,
    });

    await expect(getSystemStats()).resolves.toEqual({
      totalTeachers: 2,
      totalParents: 3,
      totalStudents: 42,
      totalExams: 100,
      pendingExams: 4,
      approvedExams: 90,
      rejectedExams: 6,
      averageScore: 81.25,
    });

    expect(mockRpc).toHaveBeenCalledWith('get_system_stats');
  });

  it('throws non-RPC errors instead of hiding them', async () => {
    const error = { code: '42501', message: 'permission denied' };
    mockRpc.mockResolvedValue({ data: null, error });

    await expect(getSystemStats()).rejects.toEqual(error);
  });
});
