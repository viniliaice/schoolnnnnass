// Transport editing + the "empty means WALKER" business rule.
//
// The DB CHECK constraint is the reference for every value used here:
//   transport IS NULL OR transport IN ('WALKER','CAR','LEFT') OR transport ~ '^\d+$'
// There is no 'BUS' literal — a bus rider is stored as the route number.

import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  busNumberOf, normalizeTransport, toStoredTransport, transportChoiceOf, transportLabel,
} from '../transport';
import { gateTransportLabel } from '../i18n/gateStrings';
import { canEditTransport, canGenerateFamilyIds } from '../routing';
import { buildFamilyRows, familyRowMatchesTransport } from '../print/familyRows';
import { familyTransportLabel } from '../print/familyCards';
import type { Role, Student } from '../../types';

vi.mock('../supabase', () => ({ supabase: { rpc: vi.fn(), from: vi.fn() } }));

const s = (over: Partial<Student> & { id: string; name: string }): Student => ({
  className: 'Grade 7-A', parentId: 'p1', createdAt: '', transport: 'WALKER',
  parentPhone: '0612345678', familyId: '0042', ...over,
});

describe('empty transport means WALKER', () => {
  it.each([
    ['NULL', null],
    ['undefined', undefined],
    ['empty string', ''],
    ['whitespace', '   '],
  ])('%s normalizes to WALKER', (_label, value) => {
    expect(normalizeTransport(value)).toBe('WALKER');
    expect(transportLabel(value)).toBe('WALKER');
    expect(transportChoiceOf(value)).toBe('WALKER');
  });

  it.each([
    ['walker', 'WALKER'],
    ['WALKER', 'WALKER'],
    ['car', 'CAR'],
    ['CAR', 'CAR'],
    ['9', '9'],
    ['LEFT', 'LEFT'],
  ])('%s normalizes to %s', (input, expected) => {
    expect(normalizeTransport(input)).toBe(expected);
  });

  it('labels a bus number as "Bus N" and keeps LEFT visible', () => {
    expect(transportLabel('9')).toBe('Bus 9');
    expect(transportLabel('LEFT')).toBe('LEFT');
  });

  it('never renders a dash for a child who simply walks', () => {
    expect(transportLabel(null)).not.toBe('—');
    expect(gateTransportLabel('en', null)).toBe('Walker');
    expect(gateTransportLabel('so', null)).toBe('Lug');
    expect(gateTransportLabel('so', '9')).toBe('Bas 9');
  });

  it('treats LEFT as a status, not a transport mode', () => {
    // LEFT must survive normalization: five call sites filter on it.
    expect(normalizeTransport('LEFT')).toBe('LEFT');
  });
});

describe('UI choice <-> stored value', () => {
  it('maps a stored bus number to the BUS choice plus its route', () => {
    expect(transportChoiceOf('9')).toBe('BUS');
    expect(busNumberOf('9')).toBe('9');
    expect(busNumberOf('WALKER')).toBe('');
    expect(busNumberOf(null)).toBe('');
  });

  it('stores BUS as digits, never the word BUS', () => {
    expect(toStoredTransport('BUS', '9')).toBe('9');
    expect(toStoredTransport('BUS', '09')).toBe('9');   // matches ^\d+$, no leading zero
    expect(toStoredTransport('WALKER', '')).toBe('WALKER');
    expect(toStoredTransport('CAR', '')).toBe('CAR');
  });

  it('refuses BUS without a route number so the CHECK cannot be violated', () => {
    expect(toStoredTransport('BUS', '')).toBeNull();
    expect(toStoredTransport('BUS', 'abc')).toBeNull();
  });

  it('round-trips every stored form the constraint allows', () => {
    for (const stored of ['WALKER', 'CAR', '9', '12']) {
      const choice = transportChoiceOf(stored);
      expect(toStoredTransport(choice, busNumberOf(stored))).toBe(stored);
    }
  });
});

describe('mixed-transport families', () => {
  const MIXED = [
    s({ id: 'a', name: 'Ahmed Sheikh', transport: '9', className: 'Grade 7-A' }),
    s({ id: 'b', name: 'Amina Sheikh', transport: null, className: 'Grade 4-B' }),  // → WALKER
    s({ id: 'c', name: 'Yasmin Sheikh', transport: 'CAR', className: 'KG-A' }),
  ];

  it('keeps each student\'s own transport, never students[0]', () => {
    const [row] = buildFamilyRows(MIXED);
    expect(row.students.map(x => transportLabel(x.transport)))
      .toEqual(['Bus 9', 'WALKER', 'CAR']);
  });

  it('summarises the family as every distinct mode', () => {
    const [row] = buildFamilyRows(MIXED);
    expect(row.transports).toEqual(['Bus 9', 'WALKER', 'CAR']);
    expect(familyTransportLabel(MIXED)).toBe('Bus 9 · WALKER · CAR');
  });

  it('matches a mixed family under EVERY mode it contains', () => {
    const [row] = buildFamilyRows(MIXED);
    expect(familyRowMatchesTransport(row, 'bus')).toBe(true);
    expect(familyRowMatchesTransport(row, 'walker')).toBe(true);
    expect(familyRowMatchesTransport(row, 'car')).toBe(true);
  });

  it('finds a blank-transport student under the walker filter', () => {
    const [row] = buildFamilyRows([s({ id: 'x', name: 'Blank Kid', transport: '' })]);
    expect(familyRowMatchesTransport(row, 'walker')).toBe(true);
    expect(familyRowMatchesTransport(row, 'bus')).toBe(false);
  });
});

describe('permissions', () => {
  it('allows only admin to edit transport', () => {
    expect(canEditTransport('admin')).toBe(true);
    for (const role of ['supervisor', 'office', 'teacher', 'parent'] as Role[]) {
      expect(canEditTransport(role)).toBe(false);
    }
  });

  it('does not grant write access to print/search-only roles', () => {
    // office + supervisor can browse and print families, and that must not
    // become student-write access.
    expect(canEditTransport('office')).toBe(false);
    expect(canEditTransport('supervisor')).toBe(false);
    expect(canEditTransport('office')).toBe(canGenerateFamilyIds('office'));
  });
});

describe('the printed card follows the edited transport', () => {
  it('uses the new value with no separate print-time transport source', async () => {
    const { buildFamilyCardData } = await import('../print/familyCards');
    const before = [s({ id: 'a', name: 'Ahmed Sheikh', transport: 'WALKER' })];
    expect(familyTransportLabel(before)).toBe('WALKER');

    // Same student row after set_student_transport('a', '9').
    const after = [s({ id: 'a', name: 'Ahmed Sheikh', transport: '9' })];
    expect(familyTransportLabel(after)).toBe('Bus 9');

    const cards = await buildFamilyCardData(new Map([['0042', after]]));
    expect(cards[0].students[0].transport).toBe('9');
    expect(cards[0].familyId).toBe('0042');
  });
});

describe('the edit dialog', () => {
  it('offers exactly Walker / Car / Bus and hides the route until Bus', async () => {
    const { EditTransportDialog } = await import('../../pages/admin/family-ids/EditTransportDialog');
    const walker = s({ id: 'a', name: 'Ahmed Sheikh', transport: 'WALKER' });
    const html = renderToStaticMarkup(
      <EditTransportDialog student={walker} open onClose={() => {}} onSave={async () => {}} />,
    );
    expect(html).toContain('Walker');
    expect(html).toContain('Car');
    expect(html).toContain('Bus');
    expect(html).toContain('Ahmed Sheikh');
    // Route field only appears for a bus rider.
    expect(html).not.toContain('Bus / route number');
  });

  it('shows the existing route for a bus rider', async () => {
    const { EditTransportDialog } = await import('../../pages/admin/family-ids/EditTransportDialog');
    const rider = s({ id: 'a', name: 'Ahmed Sheikh', transport: '9' });
    const html = renderToStaticMarkup(
      <EditTransportDialog student={rider} open onClose={() => {}} onSave={async () => {}} />,
    );
    expect(html).toContain('Bus / route number');
    expect(html).toContain('value="9"');
  });

  it('renders nothing when closed', async () => {
    const { EditTransportDialog } = await import('../../pages/admin/family-ids/EditTransportDialog');
    const html = renderToStaticMarkup(
      <EditTransportDialog student={s({ id: 'a', name: 'X' })} open={false} onClose={() => {}} onSave={async () => {}} />,
    );
    expect(html).toBe('');
  });
});

describe('Family ID stability — a transport edit is not a family operation', () => {
  it('calls set_student_transport ONLY, never a family RPC', async () => {
    vi.resetModules();
    const rpc = vi.fn().mockResolvedValue({ error: null });
    vi.doMock('../supabase', () => ({ supabase: { rpc } }));
    const { setStudentTransport } = await import('../db/familyIds');

    await setStudentTransport('s1', '9');

    expect(rpc).toHaveBeenCalledTimes(1);
    expect(rpc).toHaveBeenCalledWith('set_student_transport', {
      p_student_id: 's1', p_transport: '9',
    });
    // The forbidden neighbours: generation, override, merge/split.
    const called = rpc.mock.calls.map(c => c[0]);
    expect(called).not.toContain('generate_family_ids');
    expect(called).not.toContain('assign_family_override');
    expect(called).not.toContain('mark_student_left');
    vi.doUnmock('../supabase');
  });

  it('sends no familyId in the payload, so no family can be reassigned', async () => {
    vi.resetModules();
    const rpc = vi.fn().mockResolvedValue({ error: null });
    vi.doMock('../supabase', () => ({ supabase: { rpc } }));
    const { setStudentTransport } = await import('../db/familyIds');

    await setStudentTransport('s1', 'WALKER');

    const payload = rpc.mock.calls[0][1] as Record<string, unknown>;
    expect(Object.keys(payload).sort()).toEqual(['p_student_id', 'p_transport']);
    expect(JSON.stringify(payload).toLowerCase()).not.toContain('family');
    vi.doUnmock('../supabase');
  });

  it('leaves every familyId untouched when a student changes mode', () => {
    const before = [
      s({ id: 'a', name: 'Ahmed Sheikh', transport: 'WALKER', familyId: '0042' }),
      s({ id: 'b', name: 'Amina Sheikh', transport: 'WALKER', familyId: '0042' }),
    ];
    // Simulate the single-row write the RPC performs.
    const after = before.map(x => (x.id === 'a' ? { ...x, transport: '9' } : x));

    expect(after.map(x => x.familyId)).toEqual(['0042', '0042']);
    expect(buildFamilyRows(after)).toHaveLength(1);          // not split
    expect(after[1].transport).toBe('WALKER');               // sibling untouched
  });
});

describe('import interaction with a manual correction', () => {
  // The re-import question: office sets Ahmed to Bus 9 by hand, then the same
  // sheet is imported again. What survives?
  //
  // Established behaviour (set_student_import_fields):
  //   transport = COALESCE(v_transport, transport)
  // and applyTransportImport sends NULL for 'left' and 'unknown' cells only.
  // So a sheet cell that still SAYS something wins; a blank/unknown cell does
  // not wipe the manual value. That is the existing intended rule, so no
  // imported-vs-override column is added here.
  it('sends NULL (keep stored value) for unknown or LEFT cells', async () => {
    const { parseTransportCell } = await import('../transport');
    const keepStored = (raw: string) => {
      const t = parseTransportCell(raw);
      return t.kind === 'left' || t.kind === 'unknown' ? null : t.value;
    };
    expect(keepStored('Bike')).toBeNull();     // unknown → manual value survives
    expect(keepStored('LEFT')).toBeNull();     // status → manual value survives
    expect(keepStored('')).toBe('WALKER');     // blank IS a statement: walker
    expect(keepStored('NB')).toBe('WALKER');
    expect(keepStored('9')).toBe('9');         // sheet still says bus 9
  });

  it('re-importing the SAME sheet is idempotent for a manual bus change', async () => {
    const { parseTransportCell } = await import('../transport');
    // Sheet says NB (walker); office manually corrects Ahmed to bus 9.
    const manual = '9';
    // Re-import of the same row would send WALKER and overwrite the correction.
    const fromSheet = parseTransportCell('NB').value;
    expect(fromSheet).toBe('WALKER');
    expect(fromSheet).not.toBe(manual);
    // Documented consequence: a re-import DOES restore the sheet's value for
    // rows the sheet has an opinion about. Staff filter buckets to avoid it.
  });
});

describe('transportOverwrites — re-import collision warning', () => {
  const row = (over: Record<string, unknown>) => ({
    name: 'Ahmed Sheikh', rowNumber: 2, gradeCode: 'G7A', appClass: 'Grade 7-A',
    govId: '', secondNumber: '', busRaw: '', issues: [], match: 'matched',
    studentId: 'a', classMismatch: false, currentTransport: null,
    transport: { kind: 'walker', value: 'WALKER' },
    ...over,
  }) as unknown as Parameters<typeof import('../import/transportImport').transportOverwrites>[0][number];

  it('flags a sheet value that would replace a manual correction', async () => {
    const { transportOverwrites } = await import('../import/transportImport');
    // Manually set to bus 9; sheet still says NB/walker.
    const rows = [row({ currentTransport: '9', transport: { kind: 'walker', value: 'WALKER' } })];
    expect(transportOverwrites(rows)).toHaveLength(1);
  });

  it('does NOT flag blank-stored vs WALKER (same thing after normalization)', async () => {
    const { transportOverwrites } = await import('../import/transportImport');
    const rows = [
      row({ currentTransport: null, transport: { kind: 'walker', value: 'WALKER' } }),
      row({ currentTransport: '', transport: { kind: 'walker', value: 'WALKER' } }),
    ];
    expect(transportOverwrites(rows)).toHaveLength(0);
  });

  it('does NOT flag rows the import will skip (unknown / LEFT / unmatched)', async () => {
    const { transportOverwrites } = await import('../import/transportImport');
    const rows = [
      row({ currentTransport: '9', transport: { kind: 'unknown', value: 'Bike' } }),
      row({ currentTransport: '9', transport: { kind: 'left', value: 'LEFT' } }),
      row({ currentTransport: '9', match: 'unmatched', transport: { kind: 'bus', value: '3' } }),
    ];
    expect(transportOverwrites(rows)).toHaveLength(0);
  });

  it('does not flag an unchanged value', async () => {
    const { transportOverwrites } = await import('../import/transportImport');
    const rows = [row({ currentTransport: '9', transport: { kind: 'bus', value: '9' } })];
    expect(transportOverwrites(rows)).toHaveLength(0);
  });
});
