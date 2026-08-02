import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../supabase', () => ({
  supabase: { rpc: vi.fn() },
}));

vi.mock('../db/audit', () => ({
  createAuditLog: vi.fn(),
}));

import { supabase } from '../supabase';
import { createAuditLog } from '../db/audit';
import { lookupGateFamily } from '../db/gate';

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
