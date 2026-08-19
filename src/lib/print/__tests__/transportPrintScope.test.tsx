// MANDATORY REQUIREMENT: a transport-filtered student selection must never
// silently expand back into the complete family.
//
// The exact scenario from the correction:
//
//   Family MBK-0003
//     Axmed Cabdirashiid Daahir      G11   BUS 17
//     Cabdale Cabdirashiid Daahir    G10   WALKER
//     Maxamed Cabdirashiid Daahir    G9    BUS 17

import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  buildFamilyRows, busRouteOptions, familyRowMatchesSelection, studentsMatchingTransport,
  transportOptions, type TransportSelection,
} from '../familyRows';
import { resolvePrintBatch } from '../printBatch';
import { FamilyCardsDocument } from '../familyCards';
import type { Student } from '../../../types';

vi.mock('../../supabase', () => ({ supabase: { rpc: vi.fn(), from: vi.fn() } }));

const s = (over: Partial<Student> & { id: string; name: string }): Student => ({
  className: 'Grade 11-A', parentId: 'p3', createdAt: '', transport: 'WALKER',
  parentPhone: '0613334444', familyId: '0003', ...over,
});

const AXMED   = s({ id: 'ax', name: 'Axmed Cabdirashiid Daahir',   className: 'Grade 11-A', transport: '17' });
const CABDALE = s({ id: 'cb', name: 'Cabdale Cabdirashiid Daahir', className: 'Grade 10-A', transport: 'WALKER' });
const MAXAMED = s({ id: 'mx', name: 'Maxamed Cabdirashiid Daahir', className: 'Grade 9-A',  transport: '17' });
const FAMILY = [AXMED, CABDALE, MAXAMED];

const ROWS = buildFamilyRows(FAMILY);
const names = (list: Student[]) => list.map(x => x.name);

describe('Test 1 — WALKER filter returns 1 student', () => {
  it('matches Cabdale only', () => {
    const matched = studentsMatchingTransport(ROWS, 'walker');
    expect(matched).toHaveLength(1);
    expect(names(matched)).toEqual(['Cabdale Cabdirashiid Daahir']);
  });

  it('does NOT return the bus-riding siblings', () => {
    const matched = names(studentsMatchingTransport(ROWS, 'walker'));
    expect(matched).not.toContain('Axmed Cabdirashiid Daahir');
    expect(matched).not.toContain('Maxamed Cabdirashiid Daahir');
  });
});

describe('Test 2 — BUS 17 filter returns 2 students', () => {
  it('matches Axmed and Maxamed only', () => {
    const matched = studentsMatchingTransport(ROWS, 'bus:17');
    expect(matched).toHaveLength(2);
    expect(names(matched).sort()).toEqual([
      'Axmed Cabdirashiid Daahir',
      'Maxamed Cabdirashiid Daahir',
    ]);
    expect(names(matched)).not.toContain('Cabdale Cabdirashiid Daahir');
  });

  it('distinguishes a specific route from "any bus"', () => {
    const withRoute18 = buildFamilyRows([...FAMILY, s({ id: 'z', name: 'Other Kid', familyId: '0004', transport: '18' })]);
    expect(studentsMatchingTransport(withRoute18, 'bus:17')).toHaveLength(2);
    expect(studentsMatchingTransport(withRoute18, 'bus:18')).toHaveLength(1);
    expect(studentsMatchingTransport(withRoute18, 'bus')).toHaveLength(3);
  });
});

describe('Test 3 — WALKER print renders Cabdale only', () => {
  const batch = resolvePrintBatch({ kind: 'students', studentIds: ['cb'] }, FAMILY);

  it('resolves to one card carrying one student', () => {
    expect(batch.cardCount).toBe(1);
    expect(batch.studentCount).toBe(1);
    expect(names(batch.families[0].students)).toEqual(['Cabdale Cabdirashiid Daahir']);
  });

  it('reports the two siblings as intentionally omitted', () => {
    expect(batch.families[0].omittedSiblings).toBe(2);
    expect(batch.partialFamilies).toBe(true);
  });

  it('the rendered CARD contains Cabdale and G10, not Axmed or Maxamed', () => {
    const html = renderToStaticMarkup(
      <FamilyCardsDocument
        families={[{ familyId: '0003', parentName: 'Cabdirashiid Daahir', parentPhone: '0613334444',
                     students: batch.families[0].students }]}
        layout="pocket"
      />,
    );
    expect(html).toContain('Cabdale Cabdirashiid Daahir');
    expect(html).toContain('G10');
    expect(html).not.toContain('Axmed Cabdirashiid Daahir');
    expect(html).not.toContain('Maxamed Cabdirashiid Daahir');
  });
});

describe('Test 4 — BUS 17 print renders Axmed and Maxamed only', () => {
  const batch = resolvePrintBatch({ kind: 'students', studentIds: ['ax', 'mx'] }, FAMILY);

  it('merges the two siblings onto ONE card without adding Cabdale', () => {
    expect(batch.cardCount).toBe(1);
    expect(batch.studentCount).toBe(2);
    expect(names(batch.families[0].students)).toEqual([
      'Axmed Cabdirashiid Daahir',
      'Maxamed Cabdirashiid Daahir',
    ]);
    expect(batch.families[0].omittedSiblings).toBe(1);
  });

  it('the rendered CARD contains Axmed G11 and Maxamed G9, not Cabdale', () => {
    const html = renderToStaticMarkup(
      <FamilyCardsDocument
        families={[{ familyId: '0003', parentName: 'Cabdirashiid Daahir', parentPhone: '0613334444',
                     students: batch.families[0].students }]}
        layout="pocket"
      />,
    );
    expect(html).toContain('Axmed Cabdirashiid Daahir');
    expect(html).toContain('G11');
    expect(html).toContain('Maxamed Cabdirashiid Daahir');
    expect(html).toContain('G9');
    expect(html).not.toContain('Cabdale Cabdirashiid Daahir');
  });
});

describe('Test 5 — family print still renders ALL active siblings', () => {
  const batch = resolvePrintBatch({ kind: 'families', familyIds: ['0003'] }, FAMILY);

  it('renders all three, proving the two modes differ deliberately', () => {
    expect(batch.cardCount).toBe(1);
    expect(batch.studentCount).toBe(3);
    expect(names(batch.families[0].students)).toEqual([
      'Axmed Cabdirashiid Daahir',
      'Cabdale Cabdirashiid Daahir',
      'Maxamed Cabdirashiid Daahir',
    ]);
    expect(batch.families[0].omittedSiblings).toBe(0);
    expect(batch.partialFamilies).toBe(false);
  });

  it('the rendered CARD contains every sibling', () => {
    const html = renderToStaticMarkup(
      <FamilyCardsDocument
        families={[{ familyId: '0003', parentName: 'Cabdirashiid Daahir', parentPhone: '0613334444',
                     students: batch.families[0].students }]}
        layout="pocket"
      />,
    );
    for (const n of ['Axmed', 'Cabdale', 'Maxamed']) expect(html).toContain(n);
  });
});

describe('the two modes are not interchangeable', () => {
  it('selecting every sibling individually equals the family print', () => {
    const viaStudents = resolvePrintBatch({ kind: 'students', studentIds: ['ax', 'cb', 'mx'] }, FAMILY);
    const viaFamily = resolvePrintBatch({ kind: 'families', familyIds: ['0003'] }, FAMILY);
    expect(names(viaStudents.families[0].students)).toEqual(names(viaFamily.families[0].students));
    expect(viaStudents.families[0].omittedSiblings).toBe(0);
  });

  it('selecting a subset does NOT equal the family print', () => {
    const subset = resolvePrintBatch({ kind: 'students', studentIds: ['cb'] }, FAMILY);
    const whole = resolvePrintBatch({ kind: 'families', familyIds: ['0003'] }, FAMILY);
    expect(subset.studentCount).toBe(1);
    expect(whole.studentCount).toBe(3);
  });
});

describe('empty transport still means WALKER in student selection', () => {
  const BLANK = s({ id: 'bl', name: 'Blank Kid', familyId: '0005', parentId: 'p9', transport: null });
  const EMPTY = s({ id: 'em', name: 'Empty Kid', familyId: '0005', parentId: 'p9', transport: '' });
  const rows = buildFamilyRows([BLANK, EMPTY, AXMED]);

  it('appears under WALKER', () => {
    const matched = names(studentsMatchingTransport(rows, 'walker'));
    expect(matched).toContain('Blank Kid');
    expect(matched).toContain('Empty Kid');
  });

  it('does NOT appear under BUS or CAR', () => {
    expect(names(studentsMatchingTransport(rows, 'bus'))).not.toContain('Blank Kid');
    expect(names(studentsMatchingTransport(rows, 'car'))).not.toContain('Blank Kid');
    expect(names(studentsMatchingTransport(rows, 'bus:17'))).not.toContain('Empty Kid');
  });

  it('is printable through the WALKER selection', () => {
    const ids = studentsMatchingTransport(rows, 'walker').map(x => x.id);
    const batch = resolvePrintBatch({ kind: 'students', studentIds: ids }, [BLANK, EMPTY, AXMED]);
    expect(batch.studentCount).toBe(2);
    expect(names(batch.families.flatMap(f => f.students)).sort()).toEqual(['Blank Kid', 'Empty Kid']);
  });
});

describe('the transport dropdown is built from the data', () => {
  const rows = buildFamilyRows([...FAMILY, s({ id: 'z', name: 'Other', familyId: '0004', parentId: 'p8', transport: '18' })]);

  it('lists each real bus route, numerically sorted', () => {
    expect(busRouteOptions(rows)).toEqual(['17', '18']);
  });

  it('offers All / Walkers / Car / Any bus / each route', () => {
    expect(transportOptions(rows).map(([v]) => v))
      .toEqual(['all', 'walker', 'car', 'bus', 'bus:17', 'bus:18']);
    expect(transportOptions(rows).map(([, l]) => l))
      .toEqual(['All students', 'Walkers', 'Car pickup', 'Any bus', 'Bus 17', 'Bus 18']);
  });

  it('keeps a mixed family visible under every mode it contains', () => {
    const [mbk0003] = buildFamilyRows(FAMILY);
    for (const sel of ['walker', 'bus', 'bus:17'] as TransportSelection[]) {
      expect(familyRowMatchesSelection(mbk0003, sel)).toBe(true);
    }
    expect(familyRowMatchesSelection(mbk0003, 'car')).toBe(false);
  });
});

describe('students who left are never selected or printed', () => {
  it('excludes LEFT from every transport selection', () => {
    const rows = buildFamilyRows([AXMED, s({ id: 'gone', name: 'Gone Kid', transport: 'LEFT' })]);
    for (const sel of ['all', 'walker', 'car', 'bus', 'bus:17'] as TransportSelection[]) {
      expect(names(studentsMatchingTransport(rows, sel))).not.toContain('Gone Kid');
    }
  });
});

describe('the server roster must be re-narrowed at PDF build time', () => {
  // get_family_cards() ALWAYS returns the complete family (correct for family
  // mode). Without re-applying the restriction here, a WALKER selection turns
  // back into all three siblings when the PDF is built — the bug would be
  // invisible in resolvePrintBatch and only appear in the printed output.
  const SERVER_ANSWER = [{
    familyId: '0003',
    parentName: 'Cabdirashiid Daahir',
    parentPhone: '0613334444',
    students: [AXMED, CABDALE, MAXAMED],   // complete family, from the server
  }];

  const applyRestriction = (
    full: typeof SERVER_ANSWER,
    restrictTo?: Map<string, Set<string>>,
  ) => (restrictTo
    ? full
        .map(fam => ({ ...fam, students: fam.students.filter(s => restrictTo.get(fam.familyId)?.has(s.id)) }))
        .filter(fam => fam.students.length > 0)
    : full);

  it('narrows the complete server roster to the WALKER selection', () => {
    const batch = resolvePrintBatch({ kind: 'students', studentIds: ['cb'] }, FAMILY);
    const restrictTo = new Map(batch.families.map(f => [f.familyId, new Set(f.students.map(x => x.id))]));

    const data = applyRestriction(SERVER_ANSWER, restrictTo);
    expect(names(data[0].students)).toEqual(['Cabdale Cabdirashiid Daahir']);
    // Parent details still come from the server, only the student list narrows.
    expect(data[0].parentName).toBe('Cabdirashiid Daahir');
  });

  it('narrows to the BUS 17 pair', () => {
    const batch = resolvePrintBatch({ kind: 'students', studentIds: ['ax', 'mx'] }, FAMILY);
    const restrictTo = new Map(batch.families.map(f => [f.familyId, new Set(f.students.map(x => x.id))]));

    const data = applyRestriction(SERVER_ANSWER, restrictTo);
    expect(names(data[0].students)).toEqual([
      'Axmed Cabdirashiid Daahir', 'Maxamed Cabdirashiid Daahir',
    ]);
  });

  it('family mode passes no restriction and keeps everyone', () => {
    const data = applyRestriction(SERVER_ANSWER, undefined);
    expect(data[0].students).toHaveLength(3);
  });
});

describe('the families table drives the whole flow', () => {
  it('shows the mixed family with a per-student breakdown and an aggregate', async () => {
    const { FamiliesTable } = await import('../../../pages/admin/family-ids/FamiliesTable');
    const html = renderToStaticMarkup(
      <FamiliesTable students={FAMILY} parentNames={new Map([['p3', 'Cabdirashiid Daahir']])} loading={false} />,
    );
    expect(html).toContain('MBK-0003');
    // Each student's own transport, plus the mixed-family aggregate.
    expect(html).toContain('Bus 17');
    expect(html).toContain('WALKER');
    expect(html).toContain('Axmed Cabdirashiid Daahir');
    expect(html).toContain('Cabdale Cabdirashiid Daahir');
  });

  it('offers each real bus route in the dropdown, not a generic BUS', async () => {
    const { FamiliesTable } = await import('../../../pages/admin/family-ids/FamiliesTable');
    const withTwoRoutes = [...FAMILY, s({ id: 'z', name: 'Other Kid', familyId: '0004', parentId: 'p8', transport: '18' })];
    const html = renderToStaticMarkup(
      <FamiliesTable students={withTwoRoutes} parentNames={new Map()} loading={false} />,
    );
    expect(html).toContain('value="bus:17"');
    expect(html).toContain('value="bus:18"');
    expect(html).toContain('All students');
    expect(html).toContain('Any bus');
  });
});
