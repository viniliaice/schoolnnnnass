import { describe, expect, it } from 'vitest';
import {
  buildFamilyRows, classOptions, familyRowMatches, familyRowMatchesClass,
  familyRowMatchesTransport, filterFamilyRows,
} from '../familyRows';
import type { Student } from '../../../types';

const s = (over: Partial<Student> & { id: string; name: string }): Student => ({
  className: 'Grade 7-A', parentId: 'p1', createdAt: '', transport: 'WALKER',
  parentPhone: '0612345678', familyId: '0042', ...over,
});

const ROSTER: Student[] = [
  s({ id: 'a', name: 'Ahmed Xasan', className: 'Grade 7-A', transport: '9' }),
  s({ id: 'b', name: 'Amina Xasan', className: 'Grade 4-B', transport: 'WALKER' }),
  s({ id: 'c', name: 'Cali Nuur', familyId: '0017', parentId: 'p2', className: 'Grade 5-A',
      transport: 'CAR', parentPhone: '0681122334' }),
  s({ id: 'd', name: 'Left Child', familyId: '0099', parentId: 'p3', transport: 'LEFT' }),
  s({ id: 'e', name: 'No Family', familyId: null, parentId: null }),
];
const NAMES = new Map([['p1', 'Xasan Maxamed Cabdi'], ['p2', 'Cali Nuur Cumar']]);

describe('buildFamilyRows', () => {
  const rows = buildFamilyRows(ROSTER, NAMES);

  it('creates one row per family, sorted by family id', () => {
    expect(rows.map(r => r.familyId)).toEqual(['0017', '0042']);
  });

  it('excludes students who left, and drops all-left families', () => {
    expect(rows.find(r => r.familyId === '0099')).toBeUndefined();
  });

  it('ignores students with no family id', () => {
    expect(rows.flatMap(r => r.students).map(s2 => s2.id)).not.toContain('e');
  });

  it('carries display id, parent name, phone and counts', () => {
    const fam = rows.find(r => r.familyId === '0042')!;
    expect(fam.displayId).toBe('MBK-0042');
    expect(fam.parentName).toBe('Xasan Maxamed Cabdi');
    expect(fam.parentPhone).toBe('0612345678');
    expect(fam.studentCount).toBe(2);
  });

  it('lists every distinct transport mode (not just the first student)', () => {
    expect(buildFamilyRows(ROSTER, NAMES).find(r => r.familyId === '0042')!.transports)
      .toEqual(['Bus 9', 'WALKER']);
  });

  it('sorts students by name within the family', () => {
    expect(rows.find(r => r.familyId === '0042')!.students.map(x => x.name))
      .toEqual(['Ahmed Xasan', 'Amina Xasan']);
  });

  it('tolerates a missing parent-name map', () => {
    expect(buildFamilyRows(ROSTER)[0].parentName).toBe('');
  });

  it('normalizes short/prefixed ids to the canonical 4-digit key', () => {
    const rows2 = buildFamilyRows([s({ id: 'x', name: 'X', familyId: '42' })]);
    expect(rows2[0].familyId).toBe('0042');
  });
});

describe('familyRowMatches — one box, four targets', () => {
  const [fam17, fam42] = buildFamilyRows(ROSTER, NAMES);

  it('matches a family id in any form', () => {
    for (const q of ['42', '0042', 'MBK-0042', 'mbk-0042']) {
      expect(familyRowMatches(fam42, q), q).toBe(true);
    }
  });

  it('matches a student name', () => {
    expect(familyRowMatches(fam42, 'amina')).toBe(true);
    expect(familyRowMatches(fam42, 'Ahmed Xasan')).toBe(true);
  });

  it('matches the parent/family name', () => {
    expect(familyRowMatches(fam42, 'xasan maxamed')).toBe(true);
    expect(familyRowMatches(fam17, 'Cali Nuur Cumar')).toBe(true);
  });

  it('matches the phone, with or without formatting', () => {
    expect(familyRowMatches(fam42, '0612345678')).toBe(true);
    expect(familyRowMatches(fam42, '061 234 5678')).toBe(true);
  });

  it('matches a class', () => {
    expect(familyRowMatches(fam42, 'Grade 4-B')).toBe(true);
  });

  it('empty query matches everything; unrelated query matches nothing', () => {
    expect(familyRowMatches(fam42, '   ')).toBe(true);
    expect(familyRowMatches(fam42, 'zzzz')).toBe(false);
  });
});

describe('transport filter treats the WHOLE family', () => {
  const fam42 = buildFamilyRows(ROSTER, NAMES).find(r => r.familyId === '0042')!;

  it('a mixed family matches BOTH of its modes', () => {
    expect(familyRowMatchesTransport(fam42, 'bus')).toBe(true);
    expect(familyRowMatchesTransport(fam42, 'walker')).toBe(true);
  });

  it('does not match a mode nobody in the family uses', () => {
    expect(familyRowMatchesTransport(fam42, 'car')).toBe(false);
  });

  it('"all" always matches', () => {
    expect(familyRowMatchesTransport(fam42, 'all')).toBe(true);
  });
});

describe('class filter + combined filtering', () => {
  const rows = buildFamilyRows(ROSTER, NAMES);

  it('matches if ANY child is in the class', () => {
    const fam42 = rows.find(r => r.familyId === '0042')!;
    expect(familyRowMatchesClass(fam42, 'Grade 4-B')).toBe(true);
    expect(familyRowMatchesClass(fam42, 'Grade 9-A')).toBe(false);
    expect(familyRowMatchesClass(fam42, '')).toBe(true);
  });

  it('combines search + transport + class', () => {
    expect(filterFamilyRows(rows, { query: 'xasan', transport: 'bus' }).map(r => r.familyId))
      .toEqual(['0042']);
    expect(filterFamilyRows(rows, { query: 'xasan', transport: 'car' })).toEqual([]);
    expect(filterFamilyRows(rows, { className: 'Grade 5-A' }).map(r => r.familyId))
      .toEqual(['0017']);
    expect(filterFamilyRows(rows, {}).length).toBe(2);
  });

  it('lists class options for the filter dropdown', () => {
    expect(classOptions(rows)).toEqual(['Grade 4-B', 'Grade 5-A', 'Grade 7-A']);
  });
});
