import { describe, expect, it } from 'vitest';
import type { Student, Subject } from '../../types';
import { ASSESSMENT_BLOCKS, ASSESSMENT_GROUPS, orderBlocks } from '../bulk-grades/assessments';
import {
  buildGradeColumns,
  buildRosterWorkbook,
  isRosterWorkbook,
  parseGradeColumnHeader,
  parseRosterWorkbook,
  workbookFileName,
  GRADES_SHEET_NAME,
  INSTRUCTIONS_SHEET_NAME,
} from '../bulk-grades/workbook';
import { ASSESSMENT_DEFINITIONS } from '../excel-parser';
import * as XLSX from 'xlsx';

function subject(id: string, name: string): Subject {
  return { id, name, createdAt: '2026-01-01T00:00:00Z' } as Subject;
}
function student(id: string, name: string, className: string): Student {
  return { id, name, className, parentId: null, createdAt: '2026-01-01T00:00:00Z' } as Student;
}

const ARABIC = subject('arabic', 'Arabic');
const TARBIYA = subject('tarbiya', 'Tarbiya');
const ROSTER = [
  student('MBK-1001', 'Ahmed Ali', 'Grade 5-A'),
  student('MBK-1002', 'Aisha Hassan', 'Grade 5-A'),
  student('MBK-1003', 'Mohamed Omar', 'Grade 5-A'),
];

describe('assessment definitions single source of truth', () => {
  it('derives blocks and maxima from ASSESSMENT_DEFINITIONS only', () => {
    expect(ASSESSMENT_BLOCKS).toHaveLength(ASSESSMENT_DEFINITIONS.length);
    const maxByLabel = Object.fromEntries(ASSESSMENT_BLOCKS.map(b => [b.label, b.total]));
    expect(maxByLabel).toMatchObject({
      HW1: 5, HW2: 5, HW3: 5, HW4: 5,
      CPW1: 15, CPW2: 15, CPW3: 15, CPW4: 15,
      ATTENDANCE: 20, MT: 20, AKHLAAQ: 10,
    });
  });

  it('groups blocks into the five teacher-facing sections', () => {
    const byId = Object.fromEntries(ASSESSMENT_GROUPS.map(g => [g.id, g.blocks.map(b => b.label)]));
    expect(byId.homework).toEqual(['HW1', 'HW2', 'HW3', 'HW4']);
    expect(byId.cpw).toEqual(['CPW1', 'CPW2', 'CPW3', 'CPW4']);
    expect(byId.attendance).toEqual(['ATTENDANCE']);
    expect(byId.midterm).toEqual(['MT']);
    expect(byId.akhlaaq).toEqual(['AKHLAAQ']);
  });

  it('orderBlocks normalizes click order to the canonical sheet order', () => {
    const ordered = orderBlocks(['MT', 'HW1', 'AKHLAAQ', 'HW2']).map(b => b.label);
    expect(ordered).toEqual(['HW1', 'HW2', 'MT', 'AKHLAAQ']);
  });
});

describe('grade column construction', () => {
  it('builds only the selected subjects and blocks, subject-scoped', () => {
    const columns = buildGradeColumns(['Arabic', 'Tarbiya'], ['HW1', 'MT', 'AKHLAAQ']);
    expect(columns.map(c => c.header)).toEqual([
      'Arabic HW1', 'Arabic MT', 'Arabic Akhlaaq',
      'Tarbiya HW1', 'Tarbiya MT', 'Tarbiya Akhlaaq',
    ]);
  });

  it('keeps Arabic Akhlaaq and Tarbiya Akhlaaq as separate columns', () => {
    const columns = buildGradeColumns(['Arabic', 'Tarbiya'], ['AKHLAAQ']);
    const akhlaaq = columns.filter(c => c.block.label === 'AKHLAAQ');
    expect(akhlaaq.map(c => c.subjectName)).toEqual(['Arabic', 'Tarbiya']);
  });
});

describe('parseGradeColumnHeader', () => {
  it('parses subject + block, preserving multi-word subject names', () => {
    expect(parseGradeColumnHeader('Social Studies MT')).toMatchObject({ subjectName: 'Social Studies', block: { label: 'MT' } });
    expect(parseGradeColumnHeader('Arabic Akhlaaq')).toMatchObject({ subjectName: 'Arabic', block: { label: 'AKHLAAQ' } });
    expect(parseGradeColumnHeader('Arabic Attendance')).toMatchObject({ subjectName: 'Arabic', block: { label: 'ATTENDANCE' } });
  });
  it('returns null for unrecognized headers', () => {
    expect(parseGradeColumnHeader('Arabic Homework')).toBeNull();
    expect(parseGradeColumnHeader('Student ID')).toBeNull();
    expect(parseGradeColumnHeader('')).toBeNull();
  });
});

describe('workbook file name', () => {
  it('produces a class + subjects file name', () => {
    expect(workbookFileName('Grade 5-A', ['Arabic', 'Tarbiya'])).toBe('Grade_5-A_Arabic_Tarbiya_Grades.xlsx');
  });
});

describe('roster workbook build + parse roundtrip', () => {
  const bytes = buildRosterWorkbook({
    className: 'Grade 5-A',
    subjects: [ARABIC, TARBIYA],
    blocks: ['HW1', 'HW2', 'MT', 'AKHLAAQ'],
    roster: ROSTER,
    termName: 'Term 1',
    month: 'September',
    assessmentDate: '2026-09-08',
  });

  it('creates an Instructions sheet and a single Grades sheet prefilled with the roster', () => {
    const wb = XLSX.read(bytes, { type: 'array' });
    expect(wb.SheetNames).toEqual([INSTRUCTIONS_SHEET_NAME, GRADES_SHEET_NAME]);
    const rows = XLSX.utils.sheet_to_json<unknown[]>(wb.Sheets[GRADES_SHEET_NAME], { header: 1, defval: null });
    expect(rows[0]).toEqual([
      'Student ID', 'Student Name',
      'Arabic HW1', 'Arabic HW2', 'Arabic MT', 'Arabic Akhlaaq',
      'Tarbiya HW1', 'Tarbiya HW2', 'Tarbiya MT', 'Tarbiya Akhlaaq',
    ]);
    // Roster prefilled: IDs and names present, grade cells blank.
    expect(rows[1]?.[0]).toBe('MBK-1001');
    expect(rows[1]?.[1]).toBe('Ahmed Ali');
    expect(rows[3]?.[0]).toBe('MBK-1003');
  });

  it('is recognized as a roster workbook', () => {
    expect(isRosterWorkbook(bytes)).toBe(true);
  });

  it('parses entered grades back with subject-scoped identity', () => {
    // Fill Ahmed's Arabic HW1=4, Arabic MT=17, Tarbiya Akhlaaq=9.
    const wb = XLSX.read(bytes, { type: 'array' });
    const sheet = wb.Sheets[GRADES_SHEET_NAME];
    sheet['C2'] = { t: 'n', v: 4 };   // Arabic HW1
    sheet['E2'] = { t: 'n', v: 17 };  // Arabic MT
    sheet['J2'] = { t: 'n', v: 9 };   // Tarbiya Akhlaaq
    const out = XLSX.write(wb, { bookType: 'xlsx', type: 'array' }) as ArrayBuffer;

    const parsed = parseRosterWorkbook(out);
    expect(parsed.issues.filter(i => i.severity === 'error')).toEqual([]);
    expect(parsed.subjects).toEqual(['Arabic', 'Tarbiya']);
    const ahmed = parsed.students.find(s => s.studentId === 'MBK-1001')!;
    expect(ahmed.scores).toEqual(expect.arrayContaining([
      expect.objectContaining({ subjectName: 'Arabic', assessmentLabel: 'HW1', score: 4, entryState: 'scored' }),
      expect.objectContaining({ subjectName: 'Arabic', assessmentLabel: 'MT', score: 17 }),
      expect.objectContaining({ subjectName: 'Tarbiya', assessmentLabel: 'AKHLAAQ', score: 9 }),
    ]));
    // No Arabic Akhlaaq written -> not present, proving isolation.
    expect(ahmed.scores.some(s => s.subjectName === 'Arabic' && s.assessmentLabel === 'AKHLAAQ')).toBe(false);
  });

  it('rejects a score above its maximum', () => {
    const wb = XLSX.read(bytes, { type: 'array' });
    wb.Sheets[GRADES_SHEET_NAME]['C2'] = { t: 'n', v: 6 }; // HW1 max 5
    const out = XLSX.write(wb, { bookType: 'xlsx', type: 'array' }) as ArrayBuffer;
    const parsed = parseRosterWorkbook(out);
    expect(parsed.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'INVALID_SCORE', message: expect.stringContaining('cannot exceed 5') }),
    ]));
  });

  it('records Absent and N/A explicitly and leaves blank cells unrecorded', () => {
    const wb = XLSX.read(bytes, { type: 'array' });
    wb.Sheets[GRADES_SHEET_NAME]['C2'] = { t: 's', v: 'Absent' };
    wb.Sheets[GRADES_SHEET_NAME]['D2'] = { t: 's', v: 'N/A' };
    const out = XLSX.write(wb, { bookType: 'xlsx', type: 'array' }) as ArrayBuffer;
    const parsed = parseRosterWorkbook(out);
    const ahmed = parsed.students.find(s => s.studentId === 'MBK-1001')!;
    expect(ahmed.scores).toEqual(expect.arrayContaining([
      expect.objectContaining({ assessmentLabel: 'HW1', entryState: 'absent', score: null }),
      expect.objectContaining({ assessmentLabel: 'HW2', entryState: 'not_applicable', score: null }),
    ]));
  });

  it('detects an unknown/renamed column header (tampering)', () => {
    const wb = XLSX.read(bytes, { type: 'array' });
    wb.Sheets[GRADES_SHEET_NAME]['C1'] = { t: 's', v: 'Arabic Bonus' };
    const out = XLSX.write(wb, { bookType: 'xlsx', type: 'array' }) as ArrayBuffer;
    const parsed = parseRosterWorkbook(out);
    expect(parsed.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'UNKNOWN_COLUMN' }),
    ]));
  });

  it('detects a manually added row with no Student ID', () => {
    const wb = XLSX.read(bytes, { type: 'array' });
    // Add a 5th row (index 4 = A5) with only a name, no ID.
    wb.Sheets[GRADES_SHEET_NAME]['B5'] = { t: 's', v: 'Intruder Student' };
    wb.Sheets[GRADES_SHEET_NAME]['C5'] = { t: 'n', v: 3 };
    const ref = XLSX.utils.decode_range(wb.Sheets[GRADES_SHEET_NAME]['!ref']!);
    ref.e.r = Math.max(ref.e.r, 4);
    wb.Sheets[GRADES_SHEET_NAME]['!ref'] = XLSX.utils.encode_range(ref);
    const out = XLSX.write(wb, { bookType: 'xlsx', type: 'array' }) as ArrayBuffer;
    const parsed = parseRosterWorkbook(out);
    expect(parsed.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'MISSING_STUDENT_ID' }),
    ]));
    // Missing identity is represented EXPLICITLY as null (never '') so it can
    // never be mistaken for a real student identity downstream, and its scores
    // are preserved for the Needs-Review stage.
    const nameOnly = parsed.students.find(s => s.studentName === 'Intruder Student')!;
    expect(nameOnly).toBeTruthy();
    expect(nameOnly.studentId).toBeNull();
    expect(nameOnly.scores.length).toBeGreaterThan(0);
  });
});
