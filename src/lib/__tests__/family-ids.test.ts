import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../supabase', () => ({
  supabase: { rpc: vi.fn(), from: vi.fn() },
}));

import { supabase } from '../supabase';
import {
  assignFamilyOverride, applyTransportImport, generateFamilyIds,
  groupStudentsByFamily, lookupFamily, setStudentTransport,
} from '../db/familyIds';
import { parseTransportImport, matchImportRows } from '../import/transportImport';

const rpc = supabase.rpc as unknown as ReturnType<typeof vi.fn>;
beforeEach(() => rpc.mockReset());

describe('generateFamilyIds', () => {
  it('calls the RPC and returns the summary', async () => {
    rpc.mockResolvedValue({
      data: { familiesCreated: 42, studentsAssigned: 61, unattached: [], totalFamilies: 248 },
      error: null,
    });
    await expect(generateFamilyIds()).resolves.toMatchObject({ familiesCreated: 42, totalFamilies: 248 });
    expect(rpc).toHaveBeenCalledWith('generate_family_ids');
  });

  it('throws on RPC error', async () => {
    rpc.mockResolvedValue({ data: null, error: { message: 'Only admins may generate family IDs.' } });
    await expect(generateFamilyIds()).rejects.toThrow(/Only admins/);
  });
});

describe('lookupFamily', () => {
  it('passes the family ID and returns students', async () => {
    rpc.mockResolvedValue({
      data: [{ id: 's1', name: 'Fartun', familyId: '0421', transport: 'WALKER', parentPhone: '634537584' }],
      error: null,
    });
    await expect(lookupFamily('0421')).resolves.toHaveLength(1);
    expect(rpc).toHaveBeenCalledWith('lookup_family', { p_family_id: '0421' });
  });
});

describe('setStudentTransport / assignFamilyOverride', () => {
  it('forwards arguments to their RPCs', async () => {
    rpc.mockResolvedValue({ data: null, error: null });
    await setStudentTransport('s1', 'CAR');
    expect(rpc).toHaveBeenCalledWith('set_student_transport', { p_student_id: 's1', p_transport: 'CAR' });
    await assignFamilyOverride('s1', '0043');
    expect(rpc).toHaveBeenCalledWith('assign_family_override', { p_student_id: 's1', p_family_id: '0043' });
  });
});

describe('applyTransportImport', () => {
  it('writes only matched rows; skips ambiguous/unmatched', async () => {
    const update = vi.fn(() => ({ eq: vi.fn(() => Promise.resolve({ error: null })) }));
    vi.mocked(supabase.from).mockReturnValue({ update } as unknown as ReturnType<typeof supabase.from>);

    const parsed = parseTransportImport(
      'Name,Bus,Gov-id,SECOND NUMBER\nFartun Axmed,NB,634537584,+252634537584'
    );
    const rows = matchImportRows(parsed.rows, [
      { id: 's1', name: 'Fartun Axmed', className: 'Grade 1-A', parentId: null, createdAt: '' },
    ]);
    const result = await applyTransportImport(rows);
    expect(result.applied).toBe(1);
    expect(result.skipped).toBe(0);
    const calls = update.mock.calls as unknown as Array<[Record<string, unknown>]>;
    const payload = calls[0][0];
    expect(payload).toMatchObject({ govId: '634537584', transport: 'WALKER' });
    expect(payload.parentPhone).toBe('634537584'); // +252 stripped
  });
});

describe('groupStudentsByFamily / unattached helpers', () => {
  it('groups by familyId and finds unattached', () => {
    const students = [
      { id: 's1', name: 'A', className: 'G1-A', parentId: null, createdAt: '', familyId: '0421' },
      { id: 's2', name: 'B', className: 'G1-A', parentId: null, createdAt: '', familyId: '0421' },
      { id: 's3', name: 'C', className: 'G1-A', parentId: null, createdAt: '', familyId: null },
    ];
    const groups = groupStudentsByFamily(students as never);
    expect(groups.get('0421')).toHaveLength(2);
  });
});
