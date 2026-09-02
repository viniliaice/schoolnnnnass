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
  it('records a driver release with the assigned driver, staff, and timestamp', async () => {
    rpc.mockResolvedValue({
      data: { id: 7, studentId: 's1', familyId: '0421', staffId: 'office-umal', pickupPersonId: 'pickup-1', mode: 'driver', createdAt: '2026-08-02T14:00:00Z' },
      error: null,
    });
    const record = await recordRelease('s1', '0421', 'pickup-1');
    expect(record).toMatchObject({ studentId: 's1', familyId: '0421', staffId: 'office-umal', pickupPersonId: 'pickup-1', mode: 'driver' });
    expect(rpc).toHaveBeenCalledWith('record_release', { p_student_id: 's1', p_family_id: '0421', p_pickup_person_id: 'pickup-1' });
  });

  it('records a walking release with a null driver (one-click)', async () => {
    rpc.mockResolvedValue({
      data: { id: 8, studentId: 's2', familyId: '0421', staffId: 'office-umal', pickupPersonId: null, mode: 'walking', createdAt: '2026-08-02T14:01:00Z' },
      error: null,
    });
    const record = await recordRelease('s2', '0421', null);
    expect(record.pickupPersonId).toBeNull();
    expect(record.mode).toBe('walking');
    expect(rpc).toHaveBeenCalledWith('record_release', { p_student_id: 's2', p_family_id: '0421', p_pickup_person_id: null });
  });

  it('throws when the RPC rejects a bus student', async () => {
    rpc.mockResolvedValue({ data: null, error: { message: 'Bus students cannot be released through the Dismissal Gate.' } });
    await expect(recordRelease('s1', '0421', null)).rejects.toThrow(/Bus students/);
  });

  it('throws when the RPC rejects a missing driver for a DRIVER student', async () => {
    rpc.mockResolvedValue({ data: null, error: { message: 'A driver must be selected before releasing this student.' } });
    await expect(recordRelease('s1', '0421', null)).rejects.toThrow(/driver must be selected/);
  });

  it('throws when the RPC rejects an unassigned driver', async () => {
    rpc.mockResolvedValue({ data: null, error: { message: 'Driver is not assigned to this student.' } });
    await expect(recordRelease('s1', '0421', 'pickup-9')).rejects.toThrow(/not assigned/);
  });

  it('throws when the RPC rejects a double release', async () => {
    rpc.mockResolvedValue({ data: null, error: { message: 'Student has already been released today.' } });
    await expect(recordRelease('s1', '0421', 'pickup-1')).rejects.toThrow(/already been released/);
  });
});
