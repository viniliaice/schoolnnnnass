// /qa for the zero-layout-shift gate loader: the family lookup and the driver
// lookup must go out IN PARALLEL and resolve as ONE complete snapshot, and a
// driver failure must degrade instead of blocking the family.

import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../supabase', () => ({ supabase: { rpc: vi.fn() } }));
vi.mock('../db/audit', () => ({ createAuditLog: vi.fn().mockResolvedValue(undefined) }));

import { supabase } from '../supabase';
import { buildAssignmentIndex, loadGateFamily, refreshGateFamilyDrivers } from '../gate/loadFamily';

const rpc = supabase.rpc as unknown as ReturnType<typeof vi.fn>;

const STUDENTS = [
  { id: 's1', name: 'Rayaan Axmad', className: 'Grade 1-C', transport: 'DRIVER', familyId: '0050', parentPhone: '634537584' },
  { id: 's2', name: 'Mohamed', className: 'Grade 6-A', transport: '10', familyId: '0050', parentPhone: null },
];
const PICKUPS = [
  { id: 'd1', name: 'ASKO', phoneNumber: '980797', relationship: null, photoPath: 'p.jpg', addedAt: '', studentIds: ['s1'] },
];

beforeEach(() => rpc.mockReset());

describe('loadGateFamily', () => {
  it('issues lookup_family and get_family_pickups in PARALLEL (no waterfall)', async () => {
    const started: string[] = [];
    let resolveLookup: (v: unknown) => void = () => {};
    rpc.mockImplementation((fn: string) => {
      started.push(fn);
      if (fn === 'lookup_family') return new Promise(res => { resolveLookup = res; });
      return Promise.resolve({ data: PICKUPS, error: null });
    });

    const promise = loadGateFamily('MBK-0050');
    await Promise.resolve();
    // The driver request must already be in flight before the family resolves.
    expect(started).toContain('lookup_family');
    expect(started).toContain('get_family_pickups');

    resolveLookup({ data: STUDENTS, error: null });
    const state = await promise;
    expect(state.found).toBe(true);
    expect(state.students).toHaveLength(2);
    expect(state.pickups).toHaveLength(1);
  });

  it('returns students AND their driver assignments in one snapshot', async () => {
    rpc.mockImplementation((fn: string) =>
      Promise.resolve({ data: fn === 'lookup_family' ? STUDENTS : PICKUPS, error: null }));
    const state = await loadGateFamily('0050');
    expect(state.assignmentByStudent).toEqual({ s1: 'd1' });
    expect(state.pickupsFailed).toBe(false);
  });

  it('degrades when the driver lookup fails — the family still renders', async () => {
    rpc.mockImplementation((fn: string) =>
      fn === 'lookup_family'
        ? Promise.resolve({ data: STUDENTS, error: null })
        : Promise.resolve({ data: null, error: { message: 'drivers down' } }));
    const state = await loadGateFamily('0050');
    expect(state.found).toBe(true);
    expect(state.students).toHaveLength(2);
    expect(state.pickups).toEqual([]);
    expect(state.pickupsFailed).toBe(true);
  });

  it('throws when the family lookup itself fails', async () => {
    rpc.mockImplementation((fn: string) =>
      fn === 'lookup_family'
        ? Promise.resolve({ data: null, error: { message: 'rpc boom' } })
        : Promise.resolve({ data: [], error: null }));
    await expect(loadGateFamily('0050')).rejects.toThrow(/rpc boom/);
  });

  it('reports not-found without inventing students', async () => {
    rpc.mockImplementation((fn: string) =>
      Promise.resolve({ data: fn === 'lookup_family' ? [] : [], error: null }));
    const state = await loadGateFamily('9999');
    expect(state.found).toBe(false);
    expect(state.students).toEqual([]);
  });
});

describe('buildAssignmentIndex', () => {
  it('maps each student to exactly one driver (first wins)', () => {
    expect(buildAssignmentIndex([
      { ...PICKUPS[0], id: 'd1', studentIds: ['s1', 's2'] },
      { ...PICKUPS[0], id: 'd2', studentIds: ['s2'] },
    ])).toEqual({ s1: 'd1', s2: 'd1' });
  });
});

describe('refreshGateFamilyDrivers', () => {
  it('folds new assignments into the SAME snapshot (students untouched)', async () => {
    rpc.mockResolvedValue({ data: PICKUPS, error: null });
    const before = {
      found: true, familyId: '0050', students: STUDENTS,
      pickups: [], assignmentByStudent: {}, pickupsFailed: false,
    };
    const after = await refreshGateFamilyDrivers(before);
    expect(after.students).toBe(before.students);
    expect(after.assignmentByStudent).toEqual({ s1: 'd1' });
  });

  it('keeps the existing family visible when the refresh fails', async () => {
    rpc.mockResolvedValue({ data: null, error: { message: 'nope' } });
    const before = {
      found: true, familyId: '0050', students: STUDENTS,
      pickups: PICKUPS, assignmentByStudent: { s1: 'd1' }, pickupsFailed: false,
    };
    const after = await refreshGateFamilyDrivers(before);
    expect(after.students).toEqual(STUDENTS);
    expect(after.pickupsFailed).toBe(true);
  });
});
