import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../supabase', () => ({
  supabase: {
    from: vi.fn(),
    rpc: vi.fn(),
  },
}));

import { supabase } from '../supabase';

const mockFrom = supabase.from as unknown as ReturnType<typeof vi.fn>;
const mockRpc = supabase.rpc as unknown as ReturnType<typeof vi.fn>;

beforeEach(() => {
  mockFrom.mockReset();
  mockRpc.mockReset();
});

describe('promoteAllClasses', () => {
  it('promotes each class to its next grade level', async () => {
    mockFrom.mockImplementation(() => ({
      select: () => Promise.resolve({
        data: [{ className: 'Grade 1-A' }, { className: 'Grade 2-A' }],
        error: null,
      }),
    }));

    mockRpc
      .mockResolvedValueOnce({
        data: [
          { promoted_id: 's1', student_name: 'Alice', old_class: 'Grade 1-A', new_class: 'Grade 2-A' },
        ],
        error: null,
      })
      .mockResolvedValueOnce({
        data: [
          { promoted_id: 's2', student_name: 'Bob', old_class: 'Grade 2-A', new_class: 'Grade 3-A' },
        ],
        error: null,
      });

    const { promoteAllClasses } = await import('../db/promotions');
    const result = await promoteAllClasses();

    expect(result.promoted).toHaveLength(2);
    expect(result.promoted[0]).toEqual({ fromClass: 'Grade 2-A', toClass: 'Grade 3-A', count: 1 });
    expect(result.promoted[1]).toEqual({ fromClass: 'Grade 1-A', toClass: 'Grade 2-A', count: 1 });
    expect(result.failed).toHaveLength(0);
  });

  it('promotes Grade 12 students to Graduated', async () => {
    mockFrom.mockImplementation(() => ({
      select: () => Promise.resolve({
        data: [{ className: 'Grade 12-A' }, { className: 'Grade 12-B' }],
        error: null,
      }),
    }));

    mockRpc
      .mockResolvedValueOnce({
        data: [
          { promoted_id: 's3', student_name: 'Charlie', old_class: 'Grade 12-A', new_class: 'Graduated' },
        ],
        error: null,
      })
      .mockResolvedValueOnce({
        data: [
          { promoted_id: 's4', student_name: 'Diana', old_class: 'Grade 12-B', new_class: 'Graduated' },
        ],
        error: null,
      });

    const { promoteAllClasses } = await import('../db/promotions');
    const result = await promoteAllClasses();

    expect(result.promoted).toHaveLength(2);
    expect(result.promoted[0]).toEqual({ fromClass: 'Grade 12-A', toClass: 'Graduated', count: 1 });
    expect(result.promoted[1]).toEqual({ fromClass: 'Grade 12-B', toClass: 'Graduated', count: 1 });
    expect(result.failed).toHaveLength(0);
  });

  it('collects failed classes without stopping the loop', async () => {
    mockFrom.mockImplementation(() => ({
      select: () => Promise.resolve({
        data: [{ className: 'Grade 1-A' }, { className: 'Grade 2-A' }],
        error: null,
      }),
    }));

    mockRpc
      .mockRejectedValueOnce(new Error('RPC error'))
      .mockResolvedValueOnce({
        data: [
          { promoted_id: 's5', student_name: 'Eve', old_class: 'Grade 1-A', new_class: 'Grade 2-A' },
        ],
        error: null,
      });

    const { promoteAllClasses } = await import('../db/promotions');
    const result = await promoteAllClasses();

    expect(result.promoted).toHaveLength(1);
    expect(result.promoted[0]).toEqual({ fromClass: 'Grade 1-A', toClass: 'Grade 2-A', count: 1 });
    expect(result.failed).toEqual(['Grade 2-A']);
  });

  it('returns empty result when no classes exist', async () => {
    mockFrom.mockImplementation(() => ({
      select: () => Promise.resolve({ data: [], error: null }),
    }));

    const { promoteAllClasses } = await import('../db/promotions');
    const result = await promoteAllClasses();

    expect(result.promoted).toHaveLength(0);
    expect(result.failed).toHaveLength(0);
  });

  it('skips non-promotable classes', async () => {
    mockFrom.mockImplementation(() => ({
      select: () => Promise.resolve({
        data: [{ className: 'Unknown-X' }],
        error: null,
      }),
    }));

    const { promoteAllClasses } = await import('../db/promotions');
    const result = await promoteAllClasses();

    expect(result.promoted).toHaveLength(0);
    expect(result.failed).toHaveLength(0);
  });

  it('throws on query error', async () => {
    mockFrom.mockImplementation(() => ({
      select: () => Promise.resolve({ data: null, error: new Error('DB error') }),
    }));

    const { promoteAllClasses } = await import('../db/promotions');
    await expect(promoteAllClasses()).rejects.toThrow('DB error');
  });
});
