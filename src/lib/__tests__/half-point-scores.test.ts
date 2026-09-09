import { describe, expect, it } from 'vitest';
import * as XLSX from 'xlsx';
import {
  formatScore,
  isHalfStep,
  isScoreTextInvalid,
  parseScoreInput,
  parseScoreWithin,
} from '../scores';
import { interpretScoreCell } from '../excel-parser';
import { buildRosterWorkbook, parseRosterWorkbook, GRADES_SHEET_NAME } from '../bulk-grades/workbook';
import type { Student, Subject } from '../../types';

function subject(id: string, name: string): Subject {
  return { id, name, createdAt: '2026-01-01T00:00:00Z' } as Subject;
}
function student(id: string, name: string): Student {
  return { id, name, className: 'Grade 5-A', parentId: null, createdAt: '2026-01-01T00:00:00Z' } as Student;
}

// ---------------------------------------------------------------------------
// Shared score helpers (manual entry screens)
// ---------------------------------------------------------------------------

describe('parseScoreInput — half points are never truncated', () => {
  it('keeps half points exactly as entered', () => {
    expect(parseScoreInput('4.5')).toBe(4.5);
    expect(parseScoreInput('3.5')).toBe(3.5);
    expect(parseScoreInput('12.5')).toBe(12.5);
    expect(parseScoreInput('14.5')).toBe(14.5);
    expect(parseScoreInput('17.5')).toBe(17.5);
  });

  it('does NOT truncate the way parseInt did', () => {
    expect(parseScoreInput('4.5')).not.toBe(4);
    expect(parseScoreInput('12.5')).not.toBe(12);
    // Guard against a regression back to parseInt.
    expect(parseScoreInput('4.5')).not.toBe(parseInt('4.5', 10));
  });

  it('accepts whole numbers and zero', () => {
    expect(parseScoreInput('0')).toBe(0);
    expect(parseScoreInput('4')).toBe(4);
    expect(parseScoreInput('15')).toBe(15);
    expect(parseScoreInput(12.5)).toBe(12.5);
  });

  it('treats blank as "no score", never as 0', () => {
    expect(parseScoreInput('')).toBeNull();
    expect(parseScoreInput('   ')).toBeNull();
    expect(parseScoreInput(null)).toBeNull();
    expect(parseScoreInput(undefined)).toBeNull();
  });

  it('rejects quarter points and junk', () => {
    expect(parseScoreInput('4.25')).toBeNull();
    expect(parseScoreInput('12.25')).toBeNull();
    expect(parseScoreInput('4.75')).toBeNull();
    expect(parseScoreInput('abc')).toBeNull();
    expect(parseScoreInput('4abc')).toBeNull();
    expect(parseScoreInput('-1')).toBeNull();
  });
});

describe('parseScoreWithin / isScoreTextInvalid — maximum enforcement', () => {
  it('accepts values at the assessment maximum', () => {
    expect(parseScoreWithin('5', 5)).toBe(5);       // HW1
    expect(parseScoreWithin('15', 15)).toBe(15);    // CPW1
    expect(parseScoreWithin('20', 20)).toBe(20);    // MT / Attendance
    expect(parseScoreWithin('10', 10)).toBe(10);    // Akhlaaq
  });

  it('accepts half points below the maximum', () => {
    expect(parseScoreWithin('4.5', 5)).toBe(4.5);
    expect(parseScoreWithin('14.5', 15)).toBe(14.5);
    expect(parseScoreWithin('19.5', 20)).toBe(19.5);
    expect(parseScoreWithin('9.5', 10)).toBe(9.5);
  });

  it('rejects values above the maximum', () => {
    expect(isScoreTextInvalid('5.5', 5)).toBe(true);
    expect(isScoreTextInvalid('15.5', 15)).toBe(true);
    expect(isScoreTextInvalid('20.5', 20)).toBe(true);
  });

  it('rejects quarter points', () => {
    expect(isScoreTextInvalid('4.25', 5)).toBe(true);
    expect(isScoreTextInvalid('12.25', 15)).toBe(true);
  });

  it('does not flag a blank cell as an error', () => {
    expect(isScoreTextInvalid('', 5)).toBe(false);
    expect(isScoreTextInvalid('   ', 15)).toBe(false);
  });
});

describe('isHalfStep / formatScore', () => {
  it('recognizes whole and half points only', () => {
    expect(isHalfStep(4)).toBe(true);
    expect(isHalfStep(4.5)).toBe(true);
    expect(isHalfStep(4.25)).toBe(false);
  });
  it('formats without trailing zeros', () => {
    expect(formatScore(4)).toBe('4');
    expect(formatScore(4.5)).toBe('4.5');
    expect(formatScore(null)).toBe('—');
  });
});

// ---------------------------------------------------------------------------
// Excel pipeline: half points survive a real XLSX round trip
// ---------------------------------------------------------------------------

describe('interpretScoreCell keeps half points', () => {
  it('accepts whole and half points up to the total', () => {
    expect(interpretScoreCell('4.5', 5)).toEqual({ kind: 'scored', score: 4.5 });
    expect(interpretScoreCell(12.5, 15)).toEqual({ kind: 'scored', score: 12.5 });
    expect(interpretScoreCell('3.5', 5)).toEqual({ kind: 'scored', score: 3.5 });
    expect(interpretScoreCell('17.5', 20)).toEqual({ kind: 'scored', score: 17.5 });
  });
  it('rejects quarter points and over-maximum values', () => {
    expect(interpretScoreCell('4.25', 5).kind).toBe('invalid');
    expect(interpretScoreCell('12.25', 15).kind).toBe('invalid');
    expect(interpretScoreCell('5.5', 5).kind).toBe('invalid');
  });
  it('leaves blank cells blank (never 0)', () => {
    expect(interpretScoreCell('', 5)).toEqual({ kind: 'blank' });
    expect(interpretScoreCell(null, 5)).toEqual({ kind: 'blank' });
  });
});

describe('real XLSX round trip with half-point scores', () => {
  const ENGLISH = subject('english', 'English');
  const MATH = subject('math', 'Math');
  const ARABIC = subject('arabic', 'Arabic');
  const ROSTER = [student('MBK-1001', 'Amiir Sakariye'), student('MBK-1002', 'Axmed Cabdale Maxamuud')];

  const bytes = buildRosterWorkbook({
    className: 'Grade 5-A',
    subjects: [ARABIC, ENGLISH, MATH],
    blocks: ['HW1', 'HW2', 'CPW1', 'MT'],
    roster: ROSTER,
    termName: 'Term 1',
    month: 'September',
    assessmentDate: '2026-09-09',
  });

  /** Fill the generated template with real half-point scores and re-serialize. */
  function fillWorkbook(values: Record<string, number>): ArrayBuffer {
    const wb = XLSX.read(bytes, { type: 'array' });
    const sheet = wb.Sheets[GRADES_SHEET_NAME];
    const rows = XLSX.utils.sheet_to_json<unknown[]>(sheet, { header: 1, defval: null, raw: true });
    const header = (rows[0] || []).map(v => String(v ?? ''));
    for (const [columnHeader, value] of Object.entries(values)) {
      const c = header.indexOf(columnHeader);
      expect(c, `missing column "${columnHeader}"`).toBeGreaterThan(-1);
      rows[1]![c] = value; // first roster student
    }
    const filled = XLSX.utils.aoa_to_sheet(rows as never[][]);
    wb.Sheets[GRADES_SHEET_NAME] = filled;
    return XLSX.write(wb, { bookType: 'xlsx', type: 'array' }) as ArrayBuffer;
  }

  it('parses half points back out with the exact same numeric values', () => {
    const filled = fillWorkbook({
      'English HW1': 4.5,
      'English CPW1': 12.5,
      'Math HW2': 3.5,
      'Arabic MT': 17.5,
    });
    const parsed = parseRosterWorkbook(filled);
    expect(parsed.issues.filter(i => i.severity === 'error')).toEqual([]);

    const row = parsed.students[0]!;
    const at = (subjectName: string, label: string) =>
      row.scores.find(s => s.subjectName === subjectName && s.assessmentLabel === label)?.score;

    expect(at('English', 'HW1')).toBe(4.5);
    expect(at('English', 'CPW1')).toBe(12.5);
    expect(at('Math', 'HW2')).toBe(3.5);
    expect(at('Arabic', 'MT')).toBe(17.5);

    // Explicit no-truncation assertions.
    expect(at('English', 'HW1')).not.toBe(4);
    expect(at('English', 'CPW1')).not.toBe(12);
  });

  it('stores half points as real numeric Excel values (not text)', () => {
    const filled = fillWorkbook({ 'English HW1': 4.5 });
    const wb = XLSX.read(filled, { type: 'array' });
    const sheet = wb.Sheets[GRADES_SHEET_NAME];
    const rows = XLSX.utils.sheet_to_json<unknown[]>(sheet, { header: 1, defval: null, raw: true });
    const c = (rows[0] as string[]).indexOf('English HW1');
    const cell = sheet[XLSX.utils.encode_cell({ r: 1, c })];
    expect(cell.t).toBe('n');
    expect(cell.v).toBe(4.5);
  });

  it('leaves untouched cells blank rather than 0', () => {
    const filled = fillWorkbook({ 'English HW1': 4.5 });
    const parsed = parseRosterWorkbook(filled);
    const row = parsed.students[0]!;
    expect(row.scores.map(s => s.assessmentLabel)).toEqual(['HW1']);
    expect(row.scores.some(s => s.score === 0)).toBe(false);
  });

  it('rejects a quarter point and an over-maximum score in the workbook', () => {
    const filled = fillWorkbook({ 'English HW1': 4.25, 'English CPW1': 15.5 });
    const parsed = parseRosterWorkbook(filled);
    const errors = parsed.issues.filter(i => i.code === 'INVALID_SCORE');
    expect(errors).toHaveLength(2);
  });
});
