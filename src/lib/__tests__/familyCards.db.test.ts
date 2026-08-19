import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../supabase', () => ({
  supabase: { rpc: vi.fn(), from: vi.fn() },
}));

import { supabase } from '../supabase';
import { getFamilyCards } from '../db/familyCards';

const rpc = supabase.rpc as unknown as ReturnType<typeof vi.fn>;
const from = supabase.from as unknown as ReturnType<typeof vi.fn>;

beforeEach(() => {
  rpc.mockReset();
  from.mockReset();
});

const ROW = {
  familyId: '0042',
  parentName: 'Xasan Maxamed Cabdi',
  parentPhone: '612345678',
  students: [
    { id: 's1', name: 'Ahmed Sheikh', className: 'Grade 7-A', transport: 'WALKER', familyId: '0042' },
    { id: 's2', name: 'Amina Sheikh', className: 'Grade 4-B', transport: '9', familyId: '0042' },
  ],
};

describe('getFamilyCards', () => {
  it('reads card data through the get_family_cards RPC', async () => {
    rpc.mockResolvedValue({ data: [ROW], error: null });
    const cards = await getFamilyCards(['0042']);
    expect(rpc).toHaveBeenCalledWith('get_family_cards', { p_family_ids: ['0042'] });
    expect(cards).toHaveLength(1);
    expect(cards[0].familyId).toBe('0042');
    expect(cards[0].parentName).toBe('Xasan Maxamed Cabdi');
    expect(cards[0].students.map(s => s.className)).toEqual(['Grade 7-A', 'Grade 4-B']);
  });

  it('never falls back to a direct students/profiles REST read', async () => {
    // Regression: card content used to come from RLS-scoped getStudents() +
    // getParentNames(), so supervisors printed cards missing siblings and
    // office printed cards with no parent name.
    rpc.mockResolvedValue({ data: [ROW], error: null });
    await getFamilyCards(['0042']);
    expect(from).not.toHaveBeenCalled();
  });

  it('deduplicates requested ids and short-circuits an empty request', async () => {
    rpc.mockResolvedValue({ data: [ROW], error: null });
    await getFamilyCards(['0042', '0042']);
    expect(rpc).toHaveBeenCalledWith('get_family_cards', { p_family_ids: ['0042'] });

    rpc.mockClear();
    expect(await getFamilyCards([])).toEqual([]);
    expect(rpc).not.toHaveBeenCalled();
  });

  it('tolerates a family with no parent name or phone', async () => {
    rpc.mockResolvedValue({
      data: [{ familyId: '0007', parentName: '', parentPhone: '', students: [] }],
      error: null,
    });
    const [card] = await getFamilyCards(['0007']);
    expect(card.parentName).toBe('');
    expect(card.students).toEqual([]);
  });

  it('throws with the RPC error so the UI can report it', async () => {
    rpc.mockResolvedValue({ data: null, error: { message: 'permission denied' } });
    await expect(getFamilyCards(['0042'])).rejects.toThrow(/permission denied/);
  });
});

describe('printing never generates or changes a family ID', () => {
  const FORBIDDEN = [
    'generate_family_ids',
    'assign_family_override',
    'set_student_transport',
    'set_student_import_fields',
    'mark_student_left',
  ];

  it('the card read calls only get_family_cards', async () => {
    rpc.mockResolvedValue({ data: [ROW], error: null });
    await getFamilyCards(['0042', '0017']);

    const called = rpc.mock.calls.map(c => c[0] as string);
    expect(called).toEqual(['get_family_cards']);
    for (const fn of FORBIDDEN) expect(called).not.toContain(fn);
  });

  it('the print modules do not import any write path', async () => {
    // Static guard: if someone wires a generation call into the print layer,
    // this fails even if no test exercises that code path.
    const fs = await import('node:fs/promises');
    const files = [
      'src/lib/print/familyCards.tsx',
      'src/lib/db/familyCards.ts',
    ];
    for (const file of files) {
      const source = await fs.readFile(file, 'utf8');
      for (const fn of FORBIDDEN) {
        expect(source, `${file} must not reference ${fn}`).not.toContain(fn);
      }
    }
  });
});
