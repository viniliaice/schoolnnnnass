import { describe, expect, it } from 'vitest';
import type { Student, Subject } from '../../types';
import {
  EXAMPLE_SUBJECT_ORDER,
  canonicalSubjectName,
  orderByCanonicalSubjects,
  orderSubjectNames,
  workbookSubjectHeader,
  workbookSubjectName,
} from '../bulk-grades/subjectOrder';
import { buildGradeColumns, buildRosterWorkbook, GRADES_SHEET_NAME, workbookFileName } from '../bulk-grades/workbook';
import * as XLSX from 'xlsx';

function subject(id: string, name: string): Subject {
  return { id, name, createdAt: '2026-01-01T00:00:00Z' } as Subject;
}
function student(id: string, name: string): Student {
  return { id, name, className: 'Grade 5-A', parentId: null, createdAt: '2026-01-01T00:00:00Z' } as Student;
}

const ALL_BLOCKS = ['HW1', 'HW2', 'HW3', 'HW4', 'CPW1', 'CPW2', 'CPW3', 'CPW4', 'ATTENDANCE', 'MT', 'AKHLAAQ'] as const;

function subjectHeaders(name: string): string[] {
  return [
    `${name} HW1`, `${name} HW2`, `${name} HW3`, `${name} HW4`,
    `${name} CPW1`, `${name} CPW2`, `${name} CPW3`, `${name} CPW4`,
    `${name} Attendance`, `${name} MT`, `${name} Akhlaaq`,
  ];
}

describe('canonical subject order definition', () => {
  it('is exactly English → Math → Science → Social → Somali → Arabic → Tarabiya', () => {
    expect([...EXAMPLE_SUBJECT_ORDER]).toEqual([
      'English', 'Math', 'Science', 'Social', 'Somali', 'Arabic', 'Tarabiya',
    ]);
  });

  it('normalizes database naming differences to the canonical subject name', () => {
    expect(canonicalSubjectName('Mathematics')).toBe('Math');
    expect(canonicalSubjectName('maths')).toBe('Math');
    expect(canonicalSubjectName('Social Studies')).toBe('Social');
    expect(canonicalSubjectName('Tarbiya')).toBe('Tarabiya');
    expect(canonicalSubjectName('TARABIYAH')).toBe('Tarabiya');
    expect(canonicalSubjectName('  english  ')).toBe('English');
    expect(canonicalSubjectName('Physics')).toBeNull();
  });

  it('produces the exact visible workbook subject headers', () => {
    expect(workbookSubjectName('Mathematics')).toBe('Math');
    expect(workbookSubjectName('Social Studies')).toBe('Social');
    expect(workbookSubjectHeader('English')).toBe('ENGLISH');
    expect(workbookSubjectHeader('Mathematics')).toBe('MATH');
    expect(workbookSubjectHeader('Tarbiya')).toBe('TARABIYA');
  });

  it('orders names into the master order regardless of input order', () => {
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

describe('example download column order', () => {
  it('all seven subjects produce the exact required flat header sequence', () => {
    const subjects = [
      subject('a', 'Arabic'), subject('b', 'Tarbiya'), subject('c', 'Somali'),
      subject('d', 'Social Studies'), subject('e', 'Science'), subject('f', 'Mathematics'),
      subject('g', 'English'),
    ];
    const columns = buildGradeColumns(subjects.map(s => s.name), [...ALL_BLOCKS]);
    expect(columns.map(c => c.header)).toEqual([
      ...subjectHeaders('ENGLISH'),
      ...subjectHeaders('MATH'),
      ...subjectHeaders('SCIENCE'),
      ...subjectHeaders('SOCIAL'),
      ...subjectHeaders('SOMALI'),
      ...subjectHeaders('ARABIC'),
      ...subjectHeaders('TARABIYA'),
    ]);
  });

  it('partial subject selections are reordered into the master order', () => {
    const columns = buildGradeColumns(['Arabic', 'English', 'Tarbiya'], [...ALL_BLOCKS]);
    const distinctSubjects = columns
      .map(c => c.header.replace(/\s+(?:HW\d|CPW\d|Attendance|MT|Akhlaaq)$/u, ''))
      .filter((name, i, arr) => arr.indexOf(name) === i);
    expect(distinctSubjects).toEqual(['ENGLISH', 'ARABIC', 'TARABIYA']);
  });

  it('a real workbook keeps Student Name first and only includes authorized subjects', () => {
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
      'Student Name',
      ...subjectHeaders('ENGLISH'),
      ...subjectHeaders('MATH'),
      ...subjectHeaders('ARABIC'),
      ...subjectHeaders('TARABIYA'),
    ]);
    expect(header.some(h => /SCIENCE|SOMALI|SOCIAL/.test(h))).toBe(false);
  });

  it('filename lists subjects in canonical order too', () => {
    expect(workbookFileName('Grade 5-A', ['Arabic', 'English', 'Tarbiya'])).toBe(
      'Grade_5-A_English_Arabic_Tarabiya_Grades.xlsx',
    );
  });
});
