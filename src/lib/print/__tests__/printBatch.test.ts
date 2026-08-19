import { describe, expect, it } from 'vitest';
import { describePrintBatch, normalizeFamilyKey, resolvePrintBatch, type PrintSource } from '../printBatch';
import type { Student } from '../../../types';

const student = (over: Partial<Student> & { id: string; name: string }): Student => ({
  className: 'Grade 7-A',
  parentId: null,
  createdAt: '',
  transport: 'WALKER',
  parentPhone: null,
  familyId: null,
  ...over,
});

/** Roster from the brief: A+B share 0015, C is 0021, plus an unselected sibling. */
const ROSTER: Student[] = [
  student({ id: 'a', name: 'Ahmed Xasan', familyId: '0015', className: 'Grade 7-A' }),
  student({ id: 'b', name: 'Bishaaro Xasan', familyId: '0015', className: 'Grade 3-B' }),
  student({ id: 'd', name: 'Deeqa Xasan', familyId: '0015', className: 'KG-A' }),
  student({ id: 'c', name: 'Cali Nuur', familyId: '0021', className: 'Grade 5-A' }),
  student({ id: 'n', name: 'Nimco NoFamily', familyId: null }),
  student({ id: 'l', name: 'Layla Left', familyId: '0030', transport: 'LEFT' }),
];

describe('normalizeFamilyKey', () => {
  it('accepts raw, padded and display forms', () => {
    expect(normalizeFamilyKey('42')).toBe('0042');
    expect(normalizeFamilyKey('0042')).toBe('0042');
    expect(normalizeFamilyKey('MBK-0042')).toBe('0042');
    expect(normalizeFamilyKey(null)).toBe('');
    expect(normalizeFamilyKey('')).toBe('');
  });
});

describe('resolvePrintBatch — students source', () => {
  it('collapses siblings: A+B+C selected produces exactly 2 cards', () => {
    const source: PrintSource = { kind: 'students', studentIds: ['a', 'b', 'c'] };
    const batch = resolvePrintBatch(source, ROSTER);
    expect(batch.cardCount).toBe(2);
    expect(batch.families.map(f => f.familyId)).toEqual(['0015', '0021']);
    expect(batch.duplicatesMerged).toBe(1);
  });

  it('expands each family to its FULL roster, including unselected siblings', () => {
    const batch = resolvePrintBatch({ kind: 'students', studentIds: ['a'] }, ROSTER);
    expect(batch.cardCount).toBe(1);
    // Deeqa and Bishaaro were never selected but must still be on the card.
    expect(batch.families[0].students.map(s => s.name)).toEqual([
      'Ahmed Xasan', 'Bishaaro Xasan', 'Deeqa Xasan',
    ]);
  });

  it('reports students with no family ID instead of dropping them', () => {
    const batch = resolvePrintBatch({ kind: 'students', studentIds: ['a', 'n'] }, ROSTER);
    expect(batch.cardCount).toBe(1);
    expect(batch.skippedNoFamilyId.map(s => s.name)).toEqual(['Nimco NoFamily']);
  });

  it('reports students who left and never prints them', () => {
    const batch = resolvePrintBatch({ kind: 'students', studentIds: ['a', 'l'] }, ROSTER);
    expect(batch.cardCount).toBe(1);
    expect(batch.skippedLeft.map(s => s.name)).toEqual(['Layla Left']);
    expect(batch.families.map(f => f.familyId)).not.toContain('0030');
  });

  it('ignores unknown student ids', () => {
    const batch = resolvePrintBatch({ kind: 'students', studentIds: ['ghost', 'a'] }, ROSTER);
    expect(batch.cardCount).toBe(1);
  });

  it('selecting every sibling of one family still yields one card', () => {
    const batch = resolvePrintBatch({ kind: 'students', studentIds: ['a', 'b', 'd'] }, ROSTER);
    expect(batch.cardCount).toBe(1);
    expect(batch.duplicatesMerged).toBe(2);
  });
});

describe('resolvePrintBatch — families source', () => {
  it('prints one family', () => {
    const batch = resolvePrintBatch({ kind: 'families', familyIds: ['0015'] }, ROSTER);
    expect(batch.cardCount).toBe(1);
    expect(batch.families[0].students).toHaveLength(3);
  });

  it('prints several selected families, sorted by family ID', () => {
    const batch = resolvePrintBatch({ kind: 'families', familyIds: ['0021', '0015'] }, ROSTER);
    expect(batch.families.map(f => f.familyId)).toEqual(['0015', '0021']);
    expect(batch.cardCount).toBe(2);
  });

  it('accepts display-formatted ids and dedupes mixed forms', () => {
    const batch = resolvePrintBatch({ kind: 'families', familyIds: ['MBK-0015', '15', '0015'] }, ROSTER);
    expect(batch.cardCount).toBe(1);
    expect(batch.duplicatesMerged).toBe(2);
  });

  it('excludes students who left from an otherwise printable family', () => {
    const roster = [...ROSTER, student({ id: 'x', name: 'Aaliyah Nuur', familyId: '0021', transport: 'LEFT' })];
    const batch = resolvePrintBatch({ kind: 'families', familyIds: ['0021'] }, roster);
    expect(batch.families[0].students.map(s => s.name)).toEqual(['Cali Nuur']);
  });

  it('skips a family whose members have all left (no blank card)', () => {
    const batch = resolvePrintBatch({ kind: 'families', familyIds: ['0030'] }, ROSTER);
    expect(batch.cardCount).toBe(0);
  });

  it('returns an empty batch for an empty selection', () => {
    const batch = resolvePrintBatch({ kind: 'families', familyIds: [] }, ROSTER);
    expect(batch.cardCount).toBe(0);
    expect(batch.families).toEqual([]);
  });
});

describe('describePrintBatch', () => {
  it('states the student→card collapse for the dialog', () => {
    const source: PrintSource = { kind: 'students', studentIds: ['a', 'b', 'c'] };
    const batch = resolvePrintBatch(source, ROSTER);
    expect(describePrintBatch(batch, source)).toBe('3 students → 2 cards · 1 duplicate family merged');
  });

  it('mentions skipped students', () => {
    const source: PrintSource = { kind: 'students', studentIds: ['a', 'n'] };
    const batch = resolvePrintBatch(source, ROSTER);
    expect(describePrintBatch(batch, source)).toContain('1 skipped');
  });

  it('is concise for family selections', () => {
    const source: PrintSource = { kind: 'families', familyIds: ['0015'] };
    expect(describePrintBatch(resolvePrintBatch(source, ROSTER), source)).toBe('1 card');
  });
});

describe('purity — printing can never generate an ID', () => {
  it('only ever returns family IDs already present on the roster', () => {
    const batch = resolvePrintBatch({ kind: 'families', familyIds: ['9999'] }, ROSTER);
    expect(batch.cardCount).toBe(0); // no such family -> no card, no allocation
  });

  it('does not mutate the roster it is given', () => {
    const snapshot = JSON.stringify(ROSTER);
    resolvePrintBatch({ kind: 'students', studentIds: ['a', 'b', 'c'] }, ROSTER);
    expect(JSON.stringify(ROSTER)).toBe(snapshot);
  });
});
