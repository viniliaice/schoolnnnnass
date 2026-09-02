import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../supabase', () => ({
  supabase: { rpc: vi.fn() },
}));

vi.mock('../db/audit', () => ({
  createAuditLog: vi.fn(),
}));

import { supabase } from '../supabase';
import { createAuditLog } from '../db/audit';
import { lookupGateFamily, recordRelease } from '../db/gate';

const rpc = supabase.rpc as unknown as ReturnType<typeof vi.fn>;
const audit = createAuditLog as unknown as ReturnType<typeof vi.fn>;

beforeEach(() => {
  rpc.mockReset();
  audit.mockReset();
  audit.mockResolvedValue(undefined);
});

describe('lookupGateFamily', () => {
  it('returns found with students', async () => {
    rpc.mockResolvedValue({
      data: [{ id: 's1', name: 'Fartun Axmed', className: 'Grade 4-A', transport: 'WALKER', familyId: '0421', parentPhone: '634537584' }],
      error: null,
    });
    const res = await lookupGateFamily('MBK-0421');
    expect(res.found).toBe(true);
    expect(res.familyId).toBe('0421');
    expect(res.students).toHaveLength(1);
    expect(rpc).toHaveBeenCalledWith('lookup_family', { p_family_id: '0421' });
    expect(audit).not.toHaveBeenCalled();
  });

  it('audit-logs NOT FOUND and returns found=false', async () => {
    rpc.mockResolvedValue({ data: [], error: null });
    const res = await lookupGateFamily('9999');
    expect(res.found).toBe(false);
    expect(res.students).toEqual([]);
    expect(audit).toHaveBeenCalledWith('family_ids.gate_not_found', { familyId: '9999' });
  });

  it('throws on RPC error without auditing', async () => {
    rpc.mockResolvedValue({ data: null, error: { message: 'rpc boom' } });
    await expect(lookupGateFamily('0421')).rejects.toThrow(/rpc boom/);
    expect(audit).not.toHaveBeenCalled();
  });
});

describe('recordRelease', () => {
  it('records a successful handoff with the selected driver, staff, and timestamp', async () => {
    rpc.mockResolvedValue({
      data: { id: 7, studentId: 's1', familyId: '0421', staffId: 'office-umal', pickupPersonId: 'pickup-1', createdAt: '2026-08-02T14:00:00Z' },
      error: null,
    });
    const record = await recordRelease('s1', '0421', 'pickup-1');
    expect(record).toMatchObject({ studentId: 's1', familyId: '0421', staffId: 'office-umal', pickupPersonId: 'pickup-1' });
    expect(rpc).toHaveBeenCalledWith('record_release', { p_student_id: 's1', p_family_id: '0421', p_pickup_person_id: 'pickup-1' });
  });

  it('refuses to release with no driver selected (never calls the RPC)', async () => {
    await expect(recordRelease('s1', '0421', '')).rejects.toThrow(/driver must be selected/);
    await expect(recordRelease('s1', '0421', '' as unknown as string)).rejects.toThrow(/driver must be selected/);
    expect(rpc).not.toHaveBeenCalled();
  });

  it('throws when the RPC rejects the release (e.g. student not in family)', async () => {
    rpc.mockResolvedValue({ data: null, error: { message: 'Student does not belong to the given family.' } });
    await expect(recordRelease('s1', '9999', 'pickup-1')).rejects.toThrow(/does not belong/);
  });

  it('throws when the driver is not authorized for the student', async () => {
    rpc.mockResolvedValue({ data: null, error: { message: 'Driver is not authorized to pick up this student.' } });
    await expect(recordRelease('s1', '0421', 'pickup-9')).rejects.toThrow(/not authorized/);
  });
});
