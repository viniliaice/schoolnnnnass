import { describe, expect, it } from 'vitest';
import { bucketOf, matchImportRows, parseTransportImport, summarizeImport } from '../import/transportImport';
import type { Student } from '../../types';

// Realistic header row from the MBK Google Sheet export.
const HEADER = [
  'number', 'Gov-id', 'Bus', 'Grade', 'Name', 'SECOND NUMBER', 'STATUS', 'books',
  'August', 'September', 'October', 'November', 'December', 'January', 'February',
  'March', 'April', 'May', 'D-Left', 'Bsd', 'NBSD', 'Column 22', 'Column 23', 'new', 'NB', 'F1A',
];

function csv(rows: string[][]): string {
  const escape = (cell: string) => (cell.includes(',') || cell.includes('"') ? `"${cell.replace(/"/g, '""')}"` : cell);
  return [HEADER.map(escape).join(','), ...rows.map(r => r.map(escape).join(','))].join('\n');
}

describe('parseTransportImport', () => {
  it('maps columns by header name regardless of order', () => {
    const text = [
      'Name,Bus,Gov-id,Grade,SECOND NUMBER',
      'xalimo xasan maxumed,NB,634555034,F5A,"+252634555034"',
    ].join('\n');
    const result = parseTransportImport(text);
    expect(result.mappedHeaders).toContain('govId');
    expect(result.mappedHeaders).toContain('bus');
    expect(result.rows).toHaveLength(1);
    const row = result.rows[0];
    expect(row.name).toBe('xalimo xasan maxumed');
    expect(row.govId).toBe('634555034');
    // xlsx coerces "+252..." cells to numbers; the digits (the grouping
    // contract) survive — normalizePhone downstream handles the rest.
    expect(row.secondNumber).toBe('252634555034');
    expect(row.transport).toEqual({ kind: 'walker', value: 'WALKER' });
  });

  it('handles quoted Gov-id values and embedded content', () => {
    const result = parseTransportImport(csv([
      ['21', '"22-992343"', '19', 'G7A', 'Abdalla Cumar  Maxamud', '', 'orphan'],
    ]));
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0].govId).toBe('22-992343');
  });

  it('parses bus numbers and flags unknown/LEFT', () => {
    const result = parseTransportImport(csv([
      ['1', '634537584', '9', 'F3A', 'Cadnan Maxamed Barkhad', '+252634564899', 'orphan'],
      ['2', '', 'LEFT', 'G2A', 'Muxsin xamse axmed', '', ''],
      ['3', '', '?', 'G2A', 'X Student', '', ''],
    ]));
    expect(result.rows).toHaveLength(3);
    expect(result.rows[0].transport).toEqual({ kind: 'bus', value: '9' });
    expect(result.rows[1].transport.kind).toBe('left');
    expect(result.rows[2].transport.kind).toBe('unknown');
    expect(result.issues.some(i => i.code === 'UNKNOWN_TRANSPORT')).toBe(true);
    expect(result.issues.some(i => i.code === 'STUDENT_LEFT')).toBe(true);
  });

  it('skips summary/noise rows', () => {
    const result = parseTransportImport(csv([
      ['', '', '', '', '0 students, 0 free', '', ''],
      ['17', '634537584', '9', 'F3A', 'Cadnan Maxamed Barkhad', '+252634564899', 'orphan'],
      ['', '', '', '', '1 students, 0 free +252634743705', '', ''],
    ]));
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0].name).toBe('Cadnan Maxamed Barkhad');
  });

  it('flags unmapped grade codes as warnings but still parses', () => {
    const result = parseTransportImport(csv([
      ['1', '', 'NB', 'F3A', 'Cadnan Maxamed Barkhad', '', ''],
    ]));
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0].appClass).toBeNull();
    expect(result.issues.some(i => i.code === 'UNMAPPED_CLASS')).toBe(true);
  });

  it('reports NO_HEADER for garbage input', () => {
    const result = parseTransportImport('hello\nworld\n');
    expect(result.issues.some(i => i.code === 'NO_HEADER')).toBe(true);
  });
});

describe('matchImportRows', () => {
  const students: Student[] = [
    { id: 's1', name: 'xalimo xasan maxumed', className: 'Grade 5-A', parentId: null, createdAt: '2026-01-01' },
    { id: 's2', name: 'Cadnan Maxamed Barkhad', className: 'Grade 7-A', parentId: null, createdAt: '2026-01-01' },
    { id: 's3', name: 'Abdalla Cumar  Maxamud', className: 'Grade 7-A', parentId: null, createdAt: '2026-01-01' },
    { id: 's4', name: 'Ahmed Yusuf', className: 'Grade 5-A', parentId: null, createdAt: '2026-01-01' },
    { id: 's5', name: 'Ahmed Yusuf', className: 'Grade 5-B', parentId: null, createdAt: '2026-01-01' },
  ];

  function rowsFrom(names: string[], grades: string[]): ReturnType<typeof parseTransportImport>['rows'] {
    // 5-column header: Name, Bus, Gov-id, Grade, SECOND NUMBER
    const csvText = names.map((n, i) => [n, 'NB', '', grades[i] ?? '', ''].join(',')).join('\n');
    return parseTransportImport(`Name,Bus,Gov-id,Grade,SECOND NUMBER\n${csvText}`).rows;
  }

  it('matches single candidates by normalized name', () => {
    const rows = matchImportRows(rowsFrom(['xalimo xasan maxumed'], ['G5A']), students);
    expect(rows[0].match).toBe('matched');
    expect(rows[0].studentId).toBe('s1');
    expect(rows[0].classMismatch).toBe(false);
  });

  it('flags class mismatch as a warning signal but still matches', () => {
    const rows = matchImportRows(rowsFrom(['Cadnan Maxamed Barkhad'], ['G2A']), students);
    expect(rows[0].match).toBe('matched');
    expect(rows[0].classMismatch).toBe(true);
  });

  it('disambiguates duplicates by class code', () => {
    const rows = matchImportRows(rowsFrom(['Ahmed Yusuf'], ['G5B']), students);
    expect(rows[0].match).toBe('matched');
    expect(rows[0].studentId).toBe('s5');
  });

  it('flags truly ambiguous duplicates', () => {
    // G4A is unmapped → no class disambiguation → both candidates remain.
    const rows = matchImportRows(rowsFrom(['Ahmed Yusuf'], ['G4A']), students);
    expect(rows[0].match).toBe('ambiguous');
  });

  it('marks unknown names unmatched', () => {
    const rows = matchImportRows(rowsFrom(['Nobody Here'], ['G1A']), students);
    expect(rows[0].match).toBe('unmatched');
  });

  it('summarizes counts', () => {
    const rows = matchImportRows(rowsFrom(['xalimo xasan maxumed', 'Ahmed Yusuf', 'Nobody'], ['G5A', 'G4A', 'G1A']), students);
    const summary = summarizeImport(rows);
    expect(summary.matched).toBe(1);
    expect(summary.ambiguous).toBe(1);
    expect(summary.unmatched).toBe(1);
  });
});

describe('bucketOf', () => {
  it('classifies NB markers, empty, digits, and unknown', () => {
    expect(bucketOf('NB')).toBe('nb');
    expect(bucketOf('n/b')).toBe('nb');
    expect(bucketOf('0')).toBe('nb');
    expect(bucketOf('-')).toBe('nb');
    expect(bucketOf('')).toBe('empty');
    expect(bucketOf('  ')).toBe('empty');
    expect(bucketOf('9')).toBe('bus');
    expect(bucketOf('19')).toBe('bus');
    expect(bucketOf('?')).toBe('other');
    expect(bucketOf('Bike')).toBe('other');
  });
});

describe('busRaw tracking', () => {
  it('preserves the raw Bus cell value for bucket filtering', () => {
    const result = parseTransportImport(csv([
      ['1', '', 'NB', 'G2A', 'X Student', '', ''],
      ['2', '', 'LEFT', 'G2A', 'Y Student', '', ''],
      ['3', '', '', 'G2A', 'Z Student', '', ''],
      ['4', '', '9', 'G2A', 'W Student', '', ''],
    ]));
    expect(result.rows.map(r => r.busRaw)).toEqual(['NB', 'LEFT', '', '9']);
  });
});
