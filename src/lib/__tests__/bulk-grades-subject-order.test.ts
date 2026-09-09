import { describe, expect, it } from 'vitest';
import type { Student, Subject } from '../../types';
import {
  EXAMPLE_SUBJECT_ORDER,
  canonicalSubjectName,
  orderByCanonicalSubjects,
  orderSubjectNames,
} from '../bulk-grades/subjectOrder';
import { buildGradeColumns, buildRosterWorkbook, workbookFileName, GRADES_SHEET_NAME } from '../bulk-grades/workbook';
import * as XLSX from 'xlsx';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function subject(id: string, name: string): Subject {
  return { id, name, createdAt: '2026-01-01T00:00:00Z' } as Subject;
}
function student(id: string, name: string): Student {
  return { id, name, className: 'Grade 5-A', parentId: null, createdAt: '2026-01-01T00:00:00Z' } as Student;
}

const ALL_BLOCKS = ['HW1', 'HW2', 'HW3', 'HW4', 'CPW1', 'CPW2', 'CPW3', 'CPW4', 'ATTENDANCE', 'MT', 'AKHLAAQ'] as const;

/** The exact 11-column assessment order every subject must expose, as headers. */
function subjectHeaders(name: string): string[] {
  return [
    `${name} HW1`, `${name} HW2`, `${name} HW3`, `${name} HW4`,
    `${name} CPW1`, `${name} CPW2`, `${name} CPW3`, `${name} CPW4`,
    `${name} Attendance`, `${name} MT`, `${name} Akhlaaq`,
  ];
}

// ---------------------------------------------------------------------------
// subjectOrder module
// ---------------------------------------------------------------------------

describe('canonical subject order definition', () => {
  it('is exactly English → Math → Science → Social → Somali → Arabic → Tarabiya', () => {
    expect([...EXAMPLE_SUBJECT_ORDER]).toEqual([
      'English', 'Math', 'Science', 'Social', 'Somali', 'Arabic', 'Tarabiya',
    ]);
  });

  it('normalizes harmless database naming differences to the canonical subject', () => {
    expect(canonicalSubjectName('Mathematics')).toBe('Math');
    expect(canonicalSubjectName('maths')).toBe('Math');
    expect(canonicalSubjectName('Social Studies')).toBe('Social');
    expect(canonicalSubjectName('Tarbiya')).toBe('Tarabiya');
    expect(canonicalSubjectName('TARABIYAH')).toBe('Tarabiya');
    expect(canonicalSubjectName('  english  ')).toBe('English');
    expect(canonicalSubjectName('Physics')).toBeNull();
  });

  it('orders names into the master order regardless of input order (preserving original names)', () => {
    // The function REORDERS but never renames — the parser keys on the original
    // subject name, so "Tarbiya" must stay "Tarbiya" even though it ranks as Tarabiya.
    expect(orderSubjectNames(['Arabic', 'English', 'Tarbiya', 'Math'])).toEqual(
      ['English', 'Math', 'Arabic', 'Tarbiya'],
    );
  });

  it('is a stable sort that appends unknown subjects after known ones', () => {
    expect(orderSubjectNames(['Physics', 'Math', 'History', 'English'])).toEqual(
      ['English', 'Math', 'Physics', 'History'],
    );
  });

  it('reorders arbitrary item shapes by their subject name', () => {
    const items = [
      { s: 'Arabic', n: 1 },
      { s: 'English', n: 2 },
      { s: 'Science', n: 3 },
    ];
    expect(orderByCanonicalSubjects(items, x => x.s).map(x => x.s)).toEqual(
      ['English', 'Science', 'Arabic'],
    );
  });
});

// ---------------------------------------------------------------------------
// Required regression scenarios (spec §14 / §15)
// ---------------------------------------------------------------------------

describe('example download column order (spec §14)', () => {
  it('Test 1 — all seven subjects produce the exact required column sequence', () => {
    const subjects = [
      subject('a', 'Arabic'), subject('b', 'Tarbiya'), subject('c', 'Somali'),
      subject('d', 'Social Studies'), subject('e', 'Science'), subject('f', 'Mathematics'),
      subject('g', 'English'),
    ];
    const columns = buildGradeColumns(subjects.map(s => s.name), [...ALL_BLOCKS]);
    // Headers use each subject's ORIGINAL name (the parser keys on that), but the
    // ORDER follows the canonical master order.
    expect(columns.map(c => c.header)).toEqual([
      ...subjectHeaders('English'),
      ...subjectHeaders('Mathematics'),
      ...subjectHeaders('Science'),
      ...subjectHeaders('Social Studies'),
      ...subjectHeaders('Somali'),
      ...subjectHeaders('Arabic'),
      ...subjectHeaders('Tarbiya'),
    ]);
  });

  it('Test 2 — partial subjects are reordered into the master order', () => {
    const columns = buildGradeColumns(['Arabic', 'English', 'Tarbiya'], [...ALL_BLOCKS]);
    const distinctSubjects = columns
      .map(c => c.subjectName)
      .filter((name, i, arr) => arr.indexOf(name) === i);
    expect(distinctSubjects).toEqual(['English', 'Arabic', 'Tarbiya']);
  });

  it('Test 3 — a single subject still gets all 11 assessment columns in order', () => {
    const columns = buildGradeColumns(['Mathematics'], [...ALL_BLOCKS]);
    expect(columns.map(c => c.header)).toEqual(subjectHeaders('Mathematics'));
  });

  it('Test 4 — the template is fixed even when no grades exist', () => {
    // buildGradeColumns never consults existing grade data; a class with no
    // records yields the same full template.
    const columns = buildGradeColumns(['English'], [...ALL_BLOCKS]);
    expect(columns).toHaveLength(11);
    expect(columns.map(c => c.block.label)).toEqual([...ALL_BLOCKS]);
  });

  it('Test 5 — a random database return order still yields the master order', () => {
    const scrambled = ['Somali', 'Tarbiya', 'English', 'Arabic', 'Science', 'Social Studies', 'Mathematics'];
    const distinct = buildGradeColumns(scrambled, [...ALL_BLOCKS])
      .map(c => c.subjectName)
      .filter((name, i, arr) => arr.indexOf(name) === i);
    expect(distinct).toEqual(['English', 'Mathematics', 'Science', 'Social Studies', 'Somali', 'Arabic', 'Tarbiya']);
  });
});

describe('realistic teacher workflow (spec §15)', () => {
  it('authorized for English, Math, Arabic, Tarabiya downloads them in master order', () => {
    // Teacher clicked the checkboxes in a scrambled order.
    const selected = [subject('ar', 'Arabic'), subject('ta', 'Tarbiya'), subject('en', 'English'), subject('ma', 'Math')];
    const bytes = buildRosterWorkbook({
      className: 'Grade 5-A',
      subjects: selected,
      blocks: [...ALL_BLOCKS],
      roster: [student('MBK-1', 'Axmed Cabdale Maxamuud')],
    });
    const wb = XLSX.read(bytes, { type: 'array' });
    const header = XLSX.utils.sheet_to_json<unknown[]>(wb.Sheets[GRADES_SHEET_NAME], { header: 1 })[0] as string[];
    expect(header).toEqual([
      'Student ID', 'Student Name',
      ...subjectHeaders('English'),
      ...subjectHeaders('Math'),
      ...subjectHeaders('Arabic'),
      ...subjectHeaders('Tarbiya'),
    ]);
    // Unauthorized subjects (Science, Somali, Social) never appear.
    expect(header.some(h => /Science|Somali|Social/.test(h))).toBe(false);
    // Blank Student ID workflow untouched: the ID column still exists and the
    // roster ID is prefilled (never required to be typed by the teacher).
    expect(header[0]).toBe('Student ID');
  });

  it('filename lists subjects in master order too', () => {
    expect(workbookFileName('Grade 5-A', ['Arabic', 'English', 'Tarbiya'])).toBe(
      'Grade_5-A_English_Arabic_Tarbiya_Grades.xlsx',
    );
  });
});
