// Family-ID repair helpers: the no-parent worklist and the split action.
//
// Context: a Family ID is assigned once (parentId, else phone) and never
// reassigned. When two households share a phone — or a parent account is
// corrected after generation — one MBK number ends up covering two families,
// and only a deliberate split can separate them again. These tests lock the
// client contract for that repair path.

import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../supabase', () => ({
  supabase: { rpc: vi.fn(), from: vi.fn() },
}));

import { supabase } from '../supabase';
import {
  familyParentIds,
  findStudentsWithoutParent,
  splitFamilyMembers,
} from '../db/familyIds';
import type { Student } from '../../types';

const rpc = supabase.rpc as unknown as ReturnType<typeof vi.fn>;

function student(overrides: Partial<Student>): Student {
  return {
    id: 's1',
    name: 'Akram salebaan cabdi',
    className: 'Grade 2-B',
    parentId: null,
    createdAt: '',
    transport: 'WALKER',
    parentPhone: null,
    familyId: '0305',
    status: 'active',
    ...overrides,
  };
}

beforeEach(() => { rpc.mockReset(); });

describe('findStudentsWithoutParent', () => {
  it('returns only students with no parent account', () => {
    const rows = [
      student({ id: 'a', name: 'No parent' }),
      student({ id: 'b', name: 'Has parent', parentId: 'parent-1' }),
    ];
    expect(findStudentsWithoutParent(rows).map(s => s.id)).toEqual(['a']);
  });

  it('excludes leavers and former students — they are not the working roster', () => {
    const rows = [
      student({ id: 'active' }),
      student({ id: 'left', transport: 'LEFT' }),
      student({ id: 'former', status: 'former' }),
    ];
    expect(findStudentsWithoutParent(rows).map(s => s.id)).toEqual(['active']);
  });

  it('keeps students who already hold a Family ID (most of them do)', () => {
    const rows = [student({ id: 'has-id', familyId: '0305' }), student({ id: 'no-id', familyId: null })];
    expect(findStudentsWithoutParent(rows)).toHaveLength(2);
  });
});

describe('familyParentIds', () => {
  it('lists the distinct parent accounts inside one family (the merge signal)', () => {
    const kids = [
      student({ id: 'a', parentId: 'parent-B' }),
      student({ id: 'b', parentId: 'parent-A' }),
      student({ id: 'c', parentId: 'parent-A' }),
      student({ id: 'd', parentId: null }),
    ];
    expect(familyParentIds(kids)).toEqual(['parent-A', 'parent-B']);
  });

  it('returns a single entry for an ordinary family', () => {
    expect(familyParentIds([student({ parentId: 'parent-A' }), student({ id: 's2', parentId: 'parent-A' })]))
      .toEqual(['parent-A']);
  });

  it('ignores students with no parent link', () => {
    expect(familyParentIds([student({ parentId: null })])).toEqual([]);
  });
});

describe('splitFamilyMembers', () => {
  it('calls the split RPC with the normalized family id and deduped students', async () => {
    rpc.mockResolvedValue({
      data: { familyId: '0305', newFamilyId: '0679', studentsMoved: 3, remaining: 5 },
      error: null,
    });

    const result = await splitFamilyMembers('MBK-0305', ['a', 'b', 'a']);

    expect(rpc).toHaveBeenCalledWith('split_family_members', {
      p_family_id: '0305',
      p_student_ids: ['a', 'b'],
    });
    expect(result).toMatchObject({ newFamilyId: '0679', studentsMoved: 3, remaining: 5 });
  });

  it('refuses an empty selection without touching the database', async () => {
    await expect(splitFamilyMembers('0305', [])).rejects.toThrow(/at least one student/i);
    expect(rpc).not.toHaveBeenCalled();
  });

  it('surfaces the RPC error (e.g. the "leave one student" guard)', async () => {
    rpc.mockResolvedValue({
      data: null,
      error: { message: 'Leave at least one student in family 0305' },
    });
    await expect(splitFamilyMembers('0305', ['a'])).rejects.toMatchObject({
      message: expect.stringMatching(/leave at least one/i),
    });
  });
});
