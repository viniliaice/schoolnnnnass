import { describe, expect, it } from 'vitest';
import type { Student, Subject } from '../../types';
import { ASSESSMENT_BLOCKS, ASSESSMENT_GROUPS, orderBlocks } from '../bulk-grades/assessments';
import {
  buildGradeColumns,
  buildRosterWorkbook,
  GRADES_SHEET_NAME,
  INSTRUCTIONS_SHEET_NAME,
  isRosterWorkbook,
  parseGradeColumnHeader,
  parseRosterWorkbook,
  ROSTER_METADATA_SHEET_NAME,
  workbookFileName,
} from '../bulk-grades/workbook';
import { ASSESSMENT_DEFINITIONS, type AssessmentLabel } from '../excel-parser';
import * as XLSX from 'xlsx';

function subject(id: string, name: string): Subject {
  return { id, name, createdAt: '2026-01-01T00:00:00Z' } as Subject;
}
function student(id: string, name: string, className: string): Student {
  return { id, name, className, parentId: null, createdAt: '2026-01-01T00:00:00Z' } as Student;
}

const ENGLISH = subject('english', 'English');
const MATH = subject('math', 'Math');
const ARABIC = subject('arabic', 'Arabic');
const TARBIYA = subject('tarbiya', 'Tarbiya');
const ROSTER = [
  student('MBK-1001', 'Ahmed Ali', 'Grade 5-A'),
  student('MBK-1002', 'Aisha Hassan', 'Grade 5-A'),
  student('MBK-1003', 'Mohamed Omar', 'Grade 5-A'),
];

const ALL_BLOCKS: AssessmentLabel[] = ['HW1', 'HW2', 'HW3', 'HW4', 'CPW1', 'CPW2', 'CPW3', 'CPW4', 'ATTENDANCE', 'MT', 'AKHLAAQ'];

function headersFor(subjectName: string): string[] {
  return [
    `${subjectName} HW1`,
    `${subjectName} HW2`,
    `${subjectName} HW3`,
    `${subjectName} HW4`,
    `${subjectName} CPW1`,
    `${subjectName} CPW2`,
    `${subjectName} CPW3`,
    `${subjectName} CPW4`,
    `${subjectName} Attendance`,
    `${subjectName} MT`,
    `${subjectName} Akhlaaq`,
  ];
}

function removeMetadata(bytes: ArrayBuffer): ArrayBuffer {
  const wb = XLSX.read(bytes, { type: 'array' });
  delete wb.Sheets[ROSTER_METADATA_SHEET_NAME];
  wb.SheetNames = wb.SheetNames.filter(name => name !== ROSTER_METADATA_SHEET_NAME);
  if (wb.Workbook?.Sheets) wb.Workbook.Sheets = wb.Workbook.Sheets.filter(sheet => sheet.name !== ROSTER_METADATA_SHEET_NAME);
  return XLSX.write(wb, { bookType: 'xlsx', type: 'array' }) as ArrayBuffer;
}

function parseWithContract(bytes: ArrayBuffer, subjects: Subject[], blocks: AssessmentLabel[]) {
  return parseRosterWorkbook(bytes, {
    expectedSubjects: subjects.map(subjectValue => subjectValue.name),
    expectedBlocks: blocks,
  });
}

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

  it('orderBlocks normalizes click order to the canonical assessment order', () => {
    const ordered = orderBlocks(['MT', 'HW1', 'AKHLAAQ', 'HW2']).map(b => b.label);
    expect(ordered).toEqual(['HW1', 'HW2', 'MT', 'AKHLAAQ']);
  });
});

describe('grade column construction', () => {
  it('builds one flat header row using uppercase subject names and exact assessment names', () => {
    const columns = buildGradeColumns(['English'], ALL_BLOCKS);
    expect(columns.map(c => c.header)).toEqual(headersFor('ENGLISH'));
  });

  it('builds only the selected subjects and blocks in canonical order', () => {
    const columns = buildGradeColumns(['Tarbiya', 'Arabic', 'English', 'Math'], ['HW1', 'MT', 'AKHLAAQ']);
    expect(columns.map(c => c.header)).toEqual([
      'ENGLISH HW1', 'ENGLISH MT', 'ENGLISH Akhlaaq',
      'MATH HW1', 'MATH MT', 'MATH Akhlaaq',
      'ARABIC HW1', 'ARABIC MT', 'ARABIC Akhlaaq',
      'TARABIYA HW1', 'TARABIYA MT', 'TARABIYA Akhlaaq',
    ]);
  });

  it('keeps Arabic Akhlaaq and Tarabiya Akhlaaq as separate columns', () => {
    const columns = buildGradeColumns(['Arabic', 'Tarbiya'], ['AKHLAAQ']);
    const akhlaaq = columns.filter(c => c.block.label === 'AKHLAAQ');
    expect(akhlaaq.map(c => c.header)).toEqual(['ARABIC Akhlaaq', 'TARABIYA Akhlaaq']);
  });
});

describe('parseGradeColumnHeader', () => {
  it('parses flat subject + assessment headers into canonical subject mapping', () => {
    expect(parseGradeColumnHeader('ENGLISH HW1')).toMatchObject({ subjectName: 'English', block: { label: 'HW1', examType: 'Homework', total: 5 } });
    expect(parseGradeColumnHeader('MATH CPW1')).toMatchObject({ subjectName: 'Math', block: { label: 'CPW1', examType: 'Classwork', total: 15 } });
    expect(parseGradeColumnHeader('SOCIAL Attendance')).toMatchObject({ subjectName: 'Social', block: { label: 'ATTENDANCE', examType: 'Attendance', total: 20 } });
    expect(parseGradeColumnHeader('ARABIC MT')).toMatchObject({ subjectName: 'Arabic', block: { label: 'MT', examType: 'Quiz', total: 20 } });
    expect(parseGradeColumnHeader('TARABIYA Akhlaaq')).toMatchObject({ subjectName: 'Tarabiya', block: { label: 'AKHLAAQ', examType: 'Discipline', total: 10 } });
  });

  it('returns null for unrecognized headers', () => {
    expect(parseGradeColumnHeader('ARABIC Homework')).toBeNull();
    expect(parseGradeColumnHeader('Student Name')).toBeNull();
    expect(parseGradeColumnHeader('')).toBeNull();
  });
});

describe('workbook file name', () => {
  it('produces a class + subjects file name in canonical order', () => {
    expect(workbookFileName('Grade 5-A', ['Arabic', 'Tarbiya'])).toBe('Grade_5-A_Arabic_Tarabiya_Grades.xlsx');
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

  it('creates Instructions + Grades sheets plus hidden roster metadata', () => {
    const wb = XLSX.read(bytes, { type: 'array' });
    expect(wb.SheetNames).toEqual([INSTRUCTIONS_SHEET_NAME, GRADES_SHEET_NAME, ROSTER_METADATA_SHEET_NAME]);
    expect(wb.Workbook?.Sheets?.find(s => s.name === ROSTER_METADATA_SHEET_NAME)?.Hidden).toBe(2);

    const rows = XLSX.utils.sheet_to_json<unknown[]>(wb.Sheets[GRADES_SHEET_NAME], { header: 1, defval: null });
    expect(rows[0]).toEqual([
      'Student Name',
      'ARABIC HW1', 'ARABIC HW2', 'ARABIC MT', 'ARABIC Akhlaaq',
      'TARABIYA HW1', 'TARABIYA HW2', 'TARABIYA MT', 'TARABIYA Akhlaaq',
    ]);
    expect(rows[1]?.[0]).toBe('Ahmed Ali');
    expect(rows[3]?.[0]).toBe('Mohamed Omar');
  });

  it('has exactly one visible header row and no merged subject header cells', () => {
    const wb = XLSX.read(bytes, { type: 'array' });
    const sheet = wb.Sheets[GRADES_SHEET_NAME];
    const rows = XLSX.utils.sheet_to_json<unknown[]>(sheet, { header: 1, defval: null });
    expect(rows[0][0]).toBe('Student Name');
    expect(rows[1][0]).toBe('Ahmed Ali');
    expect(sheet['!merges'] ?? []).toEqual([]);
    const header = rows[0] as string[];
    expect(new Set(header).size).toBe(header.length);
  });

  it('is recognized as a roster workbook', () => {
    expect(isRosterWorkbook(bytes)).toBe(true);
  });

  it('leaves the Grades sheet fully editable (no sheet protection / read-only mode)', () => {
    const wb = XLSX.read(bytes, { type: 'array' });
    expect('!protect' in wb.Sheets[GRADES_SHEET_NAME]).toBe(false);
  });

  it('parses entered grades back with hidden roster IDs and subject-scoped identity', () => {
    const wb = XLSX.read(bytes, { type: 'array' });
    const sheet = wb.Sheets[GRADES_SHEET_NAME];
    sheet.B2 = { t: 'n', v: 4 };   // ARABIC HW1
    sheet.D2 = { t: 'n', v: 17 };  // ARABIC MT
    sheet.I2 = { t: 'n', v: 9 };   // TARABIYA Akhlaaq
    const out = XLSX.write(wb, { bookType: 'xlsx', type: 'array' }) as ArrayBuffer;

    const parsed = parseRosterWorkbook(out);
    expect(parsed.issues.filter(i => i.severity === 'error')).toEqual([]);
    expect(parsed.subjects).toEqual(['Arabic', 'Tarabiya']);
    const ahmed = parsed.students.find(s => s.studentId === 'MBK-1001')!;
    expect(ahmed.scores).toEqual(expect.arrayContaining([
      expect.objectContaining({ subjectName: 'Arabic', assessmentLabel: 'HW1', score: 4, entryState: 'scored' }),
      expect.objectContaining({ subjectName: 'Arabic', assessmentLabel: 'MT', score: 17 }),
      expect.objectContaining({ subjectName: 'Tarabiya', assessmentLabel: 'AKHLAAQ', score: 9 }),
    ]));
    expect(ahmed.scores.some(s => s.subjectName === 'Arabic' && s.assessmentLabel === 'AKHLAAQ')).toBe(false);
  });

  it('supports name-only uploads when the visible sheet has no Student ID column and hidden metadata is absent', () => {
    const wb = XLSX.read(removeMetadata(bytes), { type: 'array' });
    wb.Sheets[GRADES_SHEET_NAME].B2 = { t: 'n', v: 4.5 };
    const out = XLSX.write(wb, { bookType: 'xlsx', type: 'array' }) as ArrayBuffer;
    const parsed = parseRosterWorkbook(out);
    expect(parsed.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'MISSING_STUDENT_ID', severity: 'warning', row: 2 }),
    ]));
    const ahmed = parsed.students.find(s => s.rowNumber === 2)!;
    expect(ahmed.studentId).toBeNull();
    expect(ahmed.studentName).toBe('Ahmed Ali');
    expect(ahmed.scores).toEqual(expect.arrayContaining([
      expect.objectContaining({ subjectName: 'Arabic', assessmentLabel: 'HW1', score: 4.5 }),
    ]));
  });
});

describe('structural workbook validation against the canonical download contract', () => {
  it('treats Student Name as a mandatory structural header', () => {
    const bytes = buildRosterWorkbook({ className: 'Grade 5-A', subjects: [ENGLISH], blocks: ['HW1'], roster: ROSTER });
    const wb = XLSX.read(bytes, { type: 'array' });
    const sheet = wb.Sheets[GRADES_SHEET_NAME];
    sheet.A1 = { t: 's', v: 'Learner Name' };

    const parsed = parseWithContract(XLSX.write(wb, { bookType: 'xlsx', type: 'array' }) as ArrayBuffer, [ENGLISH], ['HW1']);
    expect(parsed.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'MISSING_HEADER', severity: 'error' }),
    ]));
  });

  it.each([
    ['first expected column', 'ENGLISH HW1', ['ENGLISH HW1']],
    ['middle expected column', 'ENGLISH HW2', ['ENGLISH HW2']],
    ['last expected column', 'ARABIC HW2', ['ARABIC HW2']],
    ['multiple expected columns', null, ['ENGLISH HW1', 'ARABIC HW2']],
  ])('flags physically missing %s', (_label, headerToBlank, expectedMissing) => {
    const subjects = [ENGLISH, ARABIC];
    const blocks: AssessmentLabel[] = ['HW1', 'HW2'];
    const bytes = buildRosterWorkbook({ className: 'Grade 5-A', subjects, blocks, roster: ROSTER });
    const wb = XLSX.read(bytes, { type: 'array' });
    const sheet = wb.Sheets[GRADES_SHEET_NAME];
    const header = XLSX.utils.sheet_to_json<string[]>(sheet, { header: 1 })[0] as string[];

    const blankHeader = (headerText: string) => {
      const columnIndex = header.indexOf(headerText);
      expect(columnIndex).toBeGreaterThanOrEqual(0);
      sheet[XLSX.utils.encode_cell({ r: 0, c: columnIndex })] = { t: 's', v: '' };
    };

    if (headerToBlank) blankHeader(headerToBlank);
    else expectedMissing.forEach(blankHeader);

    const parsed = parseWithContract(XLSX.write(wb, { bookType: 'xlsx', type: 'array' }) as ArrayBuffer, subjects, blocks);
    const missingMessages = parsed.issues.filter(issue => issue.code === 'MISSING_EXPECTED_COLUMN').map(issue => issue.message);

    expect(missingMessages).toHaveLength(expectedMissing.length);
    expectedMissing.forEach(expectedHeader => {
      expect(missingMessages.some(message => message.includes(`"${expectedHeader}"`))).toBe(true);
    });
  });

  it('treats blank-but-present columns as structurally present', () => {
    const subjects = [ENGLISH, ARABIC];
    const blocks: AssessmentLabel[] = ['HW1', 'HW2'];
    const bytes = buildRosterWorkbook({ className: 'Grade 5-A', subjects, blocks, roster: ROSTER });
    const parsed = parseWithContract(bytes, subjects, blocks);
    expect(parsed.issues.some(issue => issue.code === 'MISSING_EXPECTED_COLUMN')).toBe(false);
    expect(parsed.issues.some(issue => issue.code === 'UNEXPECTED_COLUMN')).toBe(false);
  });

  it('keeps duplicate grade columns as explicit structural errors', () => {
    const subjects = [ENGLISH];
    const blocks: AssessmentLabel[] = ['HW1', 'HW2'];
    const bytes = buildRosterWorkbook({ className: 'Grade 5-A', subjects, blocks, roster: ROSTER });
    const wb = XLSX.read(bytes, { type: 'array' });
    const rows = XLSX.utils.sheet_to_json<unknown[]>(wb.Sheets[GRADES_SHEET_NAME], { header: 1, defval: '' });
    rows[0] = ['Student Name', 'ENGLISH HW1', 'ENGLISH HW2', 'ENGLISH HW1'];
    wb.Sheets[GRADES_SHEET_NAME] = XLSX.utils.aoa_to_sheet(rows);

    const parsed = parseWithContract(XLSX.write(wb, { bookType: 'xlsx', type: 'array' }) as ArrayBuffer, subjects, blocks);
    expect(parsed.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'DUPLICATE_COLUMN', severity: 'error', cell: 'D1' }),
    ]));
  });

  it('keeps unknown grade headers as explicit structural errors', () => {
    const subjects = [ENGLISH];
    const blocks: AssessmentLabel[] = ['HW1', 'HW2'];
    const bytes = buildRosterWorkbook({ className: 'Grade 5-A', subjects, blocks, roster: ROSTER });
    const wb = XLSX.read(bytes, { type: 'array' });
    const sheet = wb.Sheets[GRADES_SHEET_NAME];
    sheet.C1 = { t: 's', v: 'ENGLISH Homework 2' };

    const parsed = parseWithContract(XLSX.write(wb, { bookType: 'xlsx', type: 'array' }) as ArrayBuffer, subjects, blocks);
    expect(parsed.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'UNKNOWN_COLUMN', severity: 'error', cell: 'C1' }),
      expect.objectContaining({ code: 'MISSING_EXPECTED_COLUMN', severity: 'error' }),
    ]));
  });

  it('allows reordered expected columns because parsing remains header-based', () => {
    const subjects = [ENGLISH, ARABIC];
    const blocks: AssessmentLabel[] = ['HW1', 'HW2'];
    const bytes = buildRosterWorkbook({ className: 'Grade 5-A', subjects, blocks, roster: ROSTER });
    const wb = XLSX.read(bytes, { type: 'array' });
    const sheet = wb.Sheets[GRADES_SHEET_NAME];
    const rows = XLSX.utils.sheet_to_json<unknown[]>(sheet, { header: 1, defval: '' });
    rows[0] = ['Student Name', 'ARABIC HW2', 'ENGLISH HW1', 'ARABIC HW1', 'ENGLISH HW2'];
    wb.Sheets[GRADES_SHEET_NAME] = XLSX.utils.aoa_to_sheet(rows);

    const parsed = parseWithContract(XLSX.write(wb, { bookType: 'xlsx', type: 'array' }) as ArrayBuffer, subjects, blocks);
    expect(parsed.issues.filter(issue => issue.severity === 'error')).toEqual([]);
    expect(parsed.columns.map(column => `${column.subjectName} ${column.block.label}`)).toEqual([
      'Arabic HW2',
      'English HW1',
      'Arabic HW1',
      'English HW2',
    ]);
  });

  it('uses the selected subject subset as the expected contract', () => {
    const subjects = [ENGLISH, ARABIC];
    const blocks: AssessmentLabel[] = ['HW1', 'MT'];
    const bytes = buildRosterWorkbook({ className: 'Grade 5-A', subjects, blocks, roster: ROSTER });
    const wb = XLSX.read(bytes, { type: 'array' });
    const rows = XLSX.utils.sheet_to_json<unknown[]>(wb.Sheets[GRADES_SHEET_NAME], { header: 1, defval: '' });
    rows[0] = ['Student Name', 'ENGLISH HW1', 'ENGLISH MT', 'ARABIC HW1', 'ARABIC MT', 'MATH HW1'];
    wb.Sheets[GRADES_SHEET_NAME] = XLSX.utils.aoa_to_sheet(rows);

    const parsed = parseWithContract(XLSX.write(wb, { bookType: 'xlsx', type: 'array' }) as ArrayBuffer, subjects, blocks);
    expect(parsed.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'UNEXPECTED_COLUMN', severity: 'error', cell: 'F1' }),
    ]));
  });
});

describe('flat-header + half-point regression tests', () => {
  it('Test 1 — exact English headers', () => {
    const header = buildGradeColumns(['English'], ALL_BLOCKS).map(c => c.header);
    expect(header).toEqual(headersFor('ENGLISH'));
  });

  it('Test 2 — exact subject ordering from random input order', () => {
    const header = ['Student Name', ...buildGradeColumns(['Tarabiya', 'Arabic', 'English', 'Math'], ALL_BLOCKS).map(c => c.header)];
    expect(header).toEqual([
      'Student Name',
      ...headersFor('ENGLISH'),
      ...headersFor('MATH'),
      ...headersFor('ARABIC'),
      ...headersFor('TARABIYA'),
    ]);
  });

  it('Test 3 / Test 4 — half-point scores parse exactly with no truncation', () => {
    const bytes = buildRosterWorkbook({ className: 'Grade 5-A', subjects: [ENGLISH, MATH, ARABIC], blocks: ['HW1', 'HW2', 'CPW1', 'MT'], roster: ROSTER });
    const wb = XLSX.read(bytes, { type: 'array' });
    const sheet = wb.Sheets[GRADES_SHEET_NAME];
    const header = XLSX.utils.sheet_to_json<string[]>(sheet, { header: 1 })[0] as string[];
    const put = (headerText: string, rowNumber: number, value: number) => {
      const col = header.indexOf(headerText);
      expect(col).toBeGreaterThanOrEqual(0);
      sheet[XLSX.utils.encode_cell({ r: rowNumber - 1, c: col })] = { t: 'n', v: value };
    };
    put('ENGLISH HW1', 2, 4.5);
    put('ENGLISH CPW1', 2, 12.5);
    put('MATH HW2', 2, 3.5);
    put('ARABIC MT', 2, 17.5);

    const out = XLSX.write(wb, { bookType: 'xlsx', type: 'array' }) as ArrayBuffer;
    const parsed = parseRosterWorkbook(out);
    const ahmed = parsed.students.find(s => s.studentId === 'MBK-1001')!;

    const englishHw1 = ahmed.scores.find(s => s.subjectName === 'English' && s.assessmentLabel === 'HW1')!;
    const englishCpw1 = ahmed.scores.find(s => s.subjectName === 'English' && s.assessmentLabel === 'CPW1')!;
    const mathHw2 = ahmed.scores.find(s => s.subjectName === 'Math' && s.assessmentLabel === 'HW2')!;
    const arabicMt = ahmed.scores.find(s => s.subjectName === 'Arabic' && s.assessmentLabel === 'MT')!;

    expect(englishHw1.score).toBe(4.5);
    expect(englishCpw1.score).toBe(12.5);
    expect(mathHw2.score).toBe(3.5);
    expect(arabicMt.score).toBe(17.5);
    expect(englishHw1.score).not.toBe(4);
    expect(englishCpw1.score).not.toBe(12);
  });

  it('Test 5 / Test 6 — validates maxima while preserving half-step-only rules', () => {
    const bytes = buildRosterWorkbook({ className: 'Grade 5-A', subjects: [ENGLISH], blocks: ['HW1', 'CPW1', 'MT', 'AKHLAAQ'], roster: ROSTER });
    const wb = XLSX.read(bytes, { type: 'array' });
    const sheet = wb.Sheets[GRADES_SHEET_NAME];

    // Accepted maxima.
    sheet.B2 = { t: 'n', v: 5 };
    sheet.C2 = { t: 'n', v: 15 };
    sheet.D2 = { t: 'n', v: 20 };
    sheet.E2 = { t: 'n', v: 10 };
    let parsed = parseRosterWorkbook(XLSX.write(wb, { bookType: 'xlsx', type: 'array' }) as ArrayBuffer);
    expect(parsed.issues.filter(i => i.code === 'INVALID_SCORE')).toEqual([]);

    // Rejected above-maximum values.
    sheet.B2 = { t: 'n', v: 5.5 };
    sheet.C2 = { t: 'n', v: 15.5 };
    sheet.D2 = { t: 'n', v: 20.5 };
    parsed = parseRosterWorkbook(XLSX.write(wb, { bookType: 'xlsx', type: 'array' }) as ArrayBuffer);
    const messages = parsed.issues.filter(i => i.code === 'INVALID_SCORE').map(i => i.message);
    expect(messages.some(message => message.includes('cannot exceed 5'))).toBe(true);
    expect(messages.some(message => message.includes('cannot exceed 15'))).toBe(true);
    expect(messages.some(message => message.includes('cannot exceed 20'))).toBe(true);

    // Quarter points remain invalid.
    sheet.B2 = { t: 'n', v: 4.25 };
    sheet.C2 = { t: 'n', v: 12.25 };
    sheet.D2 = { t: 'n', v: 20 };
    sheet.E2 = { t: 'n', v: 10 };
    parsed = parseRosterWorkbook(XLSX.write(wb, { bookType: 'xlsx', type: 'array' }) as ArrayBuffer);
    const quarterPointMessages = parsed.issues.filter(i => i.code === 'INVALID_SCORE').map(i => i.message);
    expect(quarterPointMessages.every(message => message.includes('whole or half points'))).toBe(true);
  });

  it('Test 8 — example download round trip maps realistic scores to the correct subject + assessment', () => {
    const subjects = [
      subject('so', 'Social Studies'),
      subject('ta', 'Tarbiya'),
      subject('en', 'English'),
      subject('ma', 'Mathematics'),
      subject('ar', 'Arabic'),
    ];
    const bytes = buildRosterWorkbook({ className: 'Grade 5-A', subjects, blocks: ALL_BLOCKS, roster: ROSTER });
    const wb = XLSX.read(bytes, { type: 'array' });
    const sheet = wb.Sheets[GRADES_SHEET_NAME];
    const header = XLSX.utils.sheet_to_json<string[]>(sheet, { header: 1 })[0] as string[];

    const put = (rowNumber: number, headerText: string, value: number) => {
      const col = header.indexOf(headerText);
      expect(col).toBeGreaterThanOrEqual(0);
      sheet[XLSX.utils.encode_cell({ r: rowNumber - 1, c: col })] = { t: 'n', v: value };
    };

    put(2, 'ENGLISH HW1', 4.5);
    put(2, 'ENGLISH CPW1', 12.5);
    put(2, 'MATH HW2', 3.5);
    put(2, 'ARABIC MT', 17.5);
    put(2, 'SOCIAL Attendance', 19.5);
    put(2, 'TARABIYA Akhlaaq', 9.5);

    const parsed = parseRosterWorkbook(XLSX.write(wb, { bookType: 'xlsx', type: 'array' }) as ArrayBuffer);
    expect(parsed.issues.filter(i => i.severity === 'error')).toEqual([]);
    const ahmed = parsed.students.find(s => s.studentId === 'MBK-1001')!;
    expect(ahmed.scores).toEqual(expect.arrayContaining([
      expect.objectContaining({ subjectName: 'English', assessmentLabel: 'HW1', examType: 'Homework', total: 5, score: 4.5 }),
      expect.objectContaining({ subjectName: 'English', assessmentLabel: 'CPW1', examType: 'Classwork', total: 15, score: 12.5 }),
      expect.objectContaining({ subjectName: 'Math', assessmentLabel: 'HW2', examType: 'Homework', total: 5, score: 3.5 }),
      expect.objectContaining({ subjectName: 'Arabic', assessmentLabel: 'MT', examType: 'Quiz', total: 20, score: 17.5 }),
      expect.objectContaining({ subjectName: 'Social', assessmentLabel: 'ATTENDANCE', examType: 'Attendance', total: 20, score: 19.5 }),
      expect.objectContaining({ subjectName: 'Tarabiya', assessmentLabel: 'AKHLAAQ', examType: 'Discipline', total: 10, score: 9.5 }),
    ]));
  });
});
