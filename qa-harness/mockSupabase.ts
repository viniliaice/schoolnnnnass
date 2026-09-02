// QA-only fake Supabase: deterministic scenarios + tunable latency so layout
// shift can be measured without a live backend. Not part of the app build.
type Row = Record<string, unknown>;
const q = new URLSearchParams(location.search);
export const LATENCY = { family: Number(q.get('fam') ?? 250), drivers: Number(q.get('drv') ?? 1200) };

const FAMILIES: Record<string, Row[]> = {
  '0050': [
    { id: 's1', name: 'RAYAAN AXMAD', className: 'Grade 1-C', transport: 'DRIVER', familyId: '0050', parentPhone: '634537584' },
    { id: 's2', name: 'MOHAMED CALI', className: 'Grade 6-A', transport: '10', familyId: '0050', parentPhone: '634537584' },
    { id: 's3', name: 'HODAN XASAN', className: 'Grade 3-B', transport: 'WALKER', familyId: '0050', parentPhone: '634537584' },
  ],
  '0077': Array.from({ length: 6 }, (_, i) => ({
    id: `b${i}`, name: `STUDENT NUMBER ${i + 1}`, className: `Grade ${i + 1}-A`,
    transport: ['WALKER', 'DRIVER', '10', 'CAR', 'DRIVER', 'WALKER'][i], familyId: '0077', parentPhone: '611111111',
  })),
  '0001': [{ id: 'w1', name: 'RAYAAN', className: 'Grade 1-C', transport: 'WALKER', familyId: '0001', parentPhone: '622222222' }],
};
const PICKUPS: Record<string, Row[]> = {
  '0050': [{ id: 'd1', name: 'ASKO', phoneNumber: '980797', relationship: 'Uncle', photoPath: '', addedAt: '', studentIds: ['s1'] }],
  '0077': [{ id: 'd1', name: 'ASKO', phoneNumber: '980797', relationship: 'Uncle', photoPath: '', addedAt: '', studentIds: ['b1', 'b4'] }],
  '0001': [],
};
const DRIVERS = [
  { id: 'd1', name: 'ASKO', phoneNumber: '980797', relationship: 'Uncle', photoPath: '', addedAt: '', studentIds: [] },
  { id: 'd2', name: 'ABDULLAH', phoneNumber: '981244', relationship: 'Father', photoPath: '', addedAt: '', studentIds: [] },
  { id: 'd3', name: 'MOHAMED', phoneNumber: '982115', relationship: 'Neighbour', photoPath: '', addedAt: '', studentIds: [] },
];
const wait = (ms: number) => new Promise(r => setTimeout(r, ms));

export const supabase = {
  async rpc(fn: string, args: Record<string, string>) {
    if (fn === 'lookup_family') {
      await wait(LATENCY.family);
      return { data: FAMILIES[args.p_family_id] ?? [], error: null };
    }
    if (fn === 'get_family_pickups') {
      await wait(LATENCY.drivers);
      if (q.get('drvfail')) return { data: null, error: { message: 'driver lookup failed' } };
      return { data: PICKUPS[args.p_family_id] ?? [], error: null };
    }
    if (fn === 'search_authorized_pickups') {
      await wait(300);
      const s = (args.p_query ?? '').toLowerCase();
      return { data: DRIVERS.filter(d => !s || d.name.toLowerCase().includes(s) || d.phoneNumber.includes(s)), error: null };
    }
    if (fn === 'attach_students_to_authorized_pickup') {
      await wait(400);
      const fam = Object.keys(PICKUPS).find(k => (FAMILIES[k] ?? []).some(st => (args.p_student_ids as unknown as string[]).includes(st.id as string)));
      if (fam) {
        for (const p of PICKUPS[fam]) p.studentIds = (p.studentIds as string[]).filter(id => !(args.p_student_ids as unknown as string[]).includes(id));
        const d = DRIVERS.find(x => x.id === args.p_pickup_id)!;
        const existing = PICKUPS[fam].find(p => p.id === d.id);
        if (existing) existing.studentIds = [...(existing.studentIds as string[]), ...(args.p_student_ids as unknown as string[])];
        else PICKUPS[fam].push({ ...d, studentIds: [...(args.p_student_ids as unknown as string[])] });
      }
      return { data: {}, error: null };
    }
    if (fn === 'remove_student_driver') {
      await wait(300);
      for (const list of Object.values(PICKUPS)) for (const p of list) p.studentIds = (p.studentIds as string[]).filter(id => id !== args.p_student_id);
      return { data: null, error: null };
    }
    if (fn === 'record_release') {
      await wait(500);
      return { data: { id: 1, studentId: args.p_student_id, familyId: args.p_family_id, staffId: 'qa', pickupPersonId: args.p_pickup_person_id, mode: args.p_pickup_person_id ? 'driver' : 'walking', createdAt: new Date().toISOString() }, error: null };
    }
    return { data: null, error: null };
  },
  storage: { from: () => ({ createSignedUrl: async () => ({ data: null, error: true }) }) },
};
export const supabaseWithToken = () => supabase;
