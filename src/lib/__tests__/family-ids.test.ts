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
const from = supabase.from as unknown as ReturnType<typeof vi.fn>;
beforeEach(() => {
  rpc.mockReset();
  from.mockReset();
});

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

describe('assignFamilyOverride — oversized-ID guard', () => {
  it('pads short IDs to 4 digits and accepts MBK- prefixed input', async () => {
    rpc.mockResolvedValue({ data: null, error: null });
    await assignFamilyOverride('s1', '43');
    expect(rpc).toHaveBeenCalledWith('assign_family_override', { p_student_id: 's1', p_family_id: '43' });
    await assignFamilyOverride('s1', 'MBK-0043');
    expect(rpc).toHaveBeenCalledWith('assign_family_override', { p_student_id: 's1', p_family_id: '0043' });
  });

  it('rejects oversized IDs at input time so Generate can never be bricked', async () => {
    await expect(assignFamilyOverride('s1', '99999')).rejects.toThrow(/at most 4 digits/);
    await expect(assignFamilyOverride('s1', '123456789012')).rejects.toThrow(/at most 4 digits/);
    expect(rpc).not.toHaveBeenCalled();
  });

  it('rejects empty IDs without calling the RPC', async () => {
    await expect(assignFamilyOverride('s1', '')).rejects.toThrow(/required/);
    await expect(assignFamilyOverride('s1', 'abc')).rejects.toThrow(/required/);
    expect(rpc).not.toHaveBeenCalled();
  });
});

describe('applyTransportImport', () => {
  it('writes matched rows via the set_student_import_fields RPC, never a direct UPDATE', async () => {
    rpc.mockResolvedValue({ data: null, error: null });

    const parsed = parseTransportImport(
      'Name,Bus,Gov-id,SECOND NUMBER\nFartun Axmed,NB,634537584,+252634537584'
    );
    const rows = matchImportRows(parsed.rows, [
      { id: 's1', name: 'Fartun Axmed', className: 'Grade 1-A', parentId: null, createdAt: '' },
    ]);
    const result = await applyTransportImport(rows);
    expect(result).toEqual({ applied: 1, skipped: 0, errors: [] });
    expect(rpc).toHaveBeenCalledWith('set_student_import_fields', {
      p_student_id: 's1',
      p_gov_id: '634537584',
      p_transport: 'WALKER',
      p_parent_phone: '634537584', // +252 stripped
    });
    // Regression: the old direct UPDATE on students is RLS-denied — the
    // whole point of the fix is to stop using it.
    expect(supabase.from).not.toHaveBeenCalled();
  });

  it('skips ambiguous/unmatched rows without calling the RPC', async () => {
    rpc.mockResolvedValue({ data: null, error: null });
    const parsed = parseTransportImport('Name,Bus\nNobody Here,NB\nAhmed Yusuf,NB');
    const rows = matchImportRows(parsed.rows, [
      { id: 's1', name: 'Ahmed Yusuf', className: 'Grade 5-A', parentId: null, createdAt: '' },
    ]);
    const result = await applyTransportImport(rows);
    expect(result.applied).toBe(1);
    expect(result.skipped).toBe(1);
    expect(result.errors).toEqual([]);
    expect(rpc).toHaveBeenCalledTimes(1);
  });

  it('reports real per-row errors instead of silently showing 0 applied', async () => {
    rpc.mockImplementation((fn: string) => {
      if (fn === 'set_student_import_fields') {
        return Promise.resolve({ data: null, error: { message: 'Only admins may apply the transport import.' } });
      }
      return Promise.resolve({ data: null, error: null });
    });
    const parsed = parseTransportImport('Name,Bus\nFartun Axmed,NB\nCadnan Maxamed,9');
    const rows = matchImportRows(parsed.rows, [
      { id: 's1', name: 'Fartun Axmed', className: 'Grade 1-A', parentId: null, createdAt: '' },
      { id: 's2', name: 'Cadnan Maxamed', className: 'Grade 1-A', parentId: null, createdAt: '' },
    ]);
    const result = await applyTransportImport(rows);
    expect(result.applied).toBe(0);
    expect(result.skipped).toBe(2);
    expect(result.errors).toHaveLength(2);
    expect(result.errors[0]).toMatch(/Only admins may apply/);
  });

  it('sends transport null for LEFT rows', async () => {
    rpc.mockResolvedValue({ data: null, error: null });
    const parsed = parseTransportImport('Name,Bus\nFartun Axmed,LEFT');
    const rows = matchImportRows(parsed.rows, [
      { id: 's1', name: 'Fartun Axmed', className: 'Grade 1-A', parentId: null, createdAt: '' },
    ]);
    await applyTransportImport(rows);
    expect(rpc).toHaveBeenCalledWith('set_student_import_fields', expect.objectContaining({ p_transport: null }));
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
