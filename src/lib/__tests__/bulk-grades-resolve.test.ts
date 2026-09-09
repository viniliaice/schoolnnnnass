import { describe, expect, it } from 'vitest';
import * as XLSX from 'xlsx';
import type { Student, Subject } from '../../types';
import {
  buildRosterWorkbook,
  parseRosterWorkbook,
  GRADES_SHEET_NAME,
  ROSTER_METADATA_SHEET_NAME,
} from '../bulk-grades/workbook';
import { resolveWorkbook, type ResolveContext } from '../bulk-grades/resolve';
import type { AssessmentLabel } from '../excel-parser';

function subject(id: string, name: string): Subject {
  return { id, name, createdAt: '2026-01-01T00:00:00Z' } as Subject;
}
function student(id: string, name: string, className: string): Student {
  return { id, name, className, parentId: null, createdAt: '2026-01-01T00:00:00Z' } as Student;
}

const ARABIC = subject('arabic', 'Arabic');
const TARBIYA = subject('tarbiya', 'Tarbiya');
const MATH = subject('math', 'Math');

const CLASS = 'Grade 5-A';
const ROSTER = [
  student('MBK-1001', 'Ahmed Ali', CLASS),
  student('MBK-1002', 'Aisha Hassan', CLASS),
];

function context(overrides: Partial<ResolveContext> = {}): ResolveContext {
  return {
    className: CLASS,
    authorizedSubjects: [ARABIC, TARBIYA],
    roster: ROSTER,
    termId: 'term-1',
    termName: 'Term 1',
    month: 'September',
    date: '2026-09-08',
    ...overrides,
  };
}

function blankMetadataStudentIds(wb: XLSX.WorkBook, visibleRows: number[]) {
  const sheet = wb.Sheets[ROSTER_METADATA_SHEET_NAME];
  if (!sheet) throw new Error('Missing hidden roster metadata sheet');
  for (const rowNumber of visibleRows) {
    sheet[`B${rowNumber}`] = { t: 's', v: '' };
  }
}

function removeMetadataSheet(wb: XLSX.WorkBook) {
  delete wb.Sheets[ROSTER_METADATA_SHEET_NAME];
  wb.SheetNames = wb.SheetNames.filter(name => name !== ROSTER_METADATA_SHEET_NAME);
  if (wb.Workbook?.Sheets) wb.Workbook.Sheets = wb.Workbook.Sheets.filter(sheet => sheet.name !== ROSTER_METADATA_SHEET_NAME);
}

/** Build a workbook and set visible cell values by address, then parse. */
function makeParsed(
  subjects: Subject[],
  blocks: AssessmentLabel[],
  roster: Student[],
  edits: Record<string, string | number>,
) {
  const bytes = buildRosterWorkbook({ className: CLASS, subjects, blocks, roster });
  const wb = XLSX.read(bytes, { type: 'array' });
  const sheet = wb.Sheets[GRADES_SHEET_NAME];
  for (const [addr, value] of Object.entries(edits)) {
    sheet[addr] = typeof value === 'number' ? { t: 'n', v: value } : { t: 's', v: value };
  }
  const out = XLSX.write(wb, { bookType: 'xlsx', type: 'array' }) as ArrayBuffer;
  return parseRosterWorkbook(out);
}

describe('resolveWorkbook', () => {
  it('produces subject-scoped BulkGradeRecords for authorized students', () => {
    // Columns: B=Arabic HW1, C=Arabic MT, D=Tarabiya HW1, E=Tarabiya MT
    const parsed = makeParsed([ARABIC, TARBIYA], ['HW1', 'MT'], ROSTER, {
      B2: 4, C2: 18, D2: 5, E2: 15,
    });
    const result = resolveWorkbook(parsed, context());
    expect(result.errors).toEqual([]);
    expect(result.validCount).toBe(4);
    expect(result.validStudentCount).toBe(1);
    expect(result.records).toEqual(expect.arrayContaining([
      expect.objectContaining({ studentId: 'MBK-1001', subjectId: 'arabic', assessmentLabel: 'HW1', score: 4, termId: 'term-1', month: 'September', date: '2026-09-08' }),
      expect.objectContaining({ studentId: 'MBK-1001', subjectId: 'tarbiya', assessmentLabel: 'MT', score: 15 }),
    ]));
  });

  it('keeps Arabic Akhlaaq and Tarbiya Akhlaaq as distinct records', () => {
    // B=Arabic Akhlaaq, C=Tarabiya Akhlaaq
    const parsed = makeParsed([ARABIC, TARBIYA], ['AKHLAAQ'], ROSTER, { B2: 8, C2: 3 });
    const result = resolveWorkbook(parsed, context());
    const akhlaaq = result.records.filter(r => r.assessmentLabel === 'AKHLAAQ' && r.studentId === 'MBK-1001');
    expect(akhlaaq).toEqual(expect.arrayContaining([
      expect.objectContaining({ subjectId: 'arabic', score: 8 }),
      expect.objectContaining({ subjectId: 'tarbiya', score: 3 }),
    ]));
    expect(new Set(akhlaaq.map(r => r.subjectId)).size).toBe(2);
  });

  it('rejects a student who is not in the current roster (wrong-class / stale)', () => {
    const parsed = makeParsed([ARABIC], ['HW1'], [
      ...ROSTER,
      student('MBK-9999', 'Outsider Kid', 'Grade 5-B'),
    ], { B4: 5 });
    const result = resolveWorkbook(parsed, context());
    expect(result.errors).toEqual(expect.arrayContaining([
      expect.objectContaining({ studentId: 'MBK-9999', message: expect.stringContaining('not currently in Grade 5-A') }),
    ]));
    expect(result.records.some(r => r.studentId === 'MBK-9999')).toBe(false);
  });

  it('rejects an unauthorized subject present in the workbook', () => {
    const parsed = makeParsed([ARABIC, MATH], ['HW1'], ROSTER, { B2: 4, C2: 3 });
    const result = resolveWorkbook(parsed, context({ authorizedSubjects: [ARABIC, TARBIYA] }));
    expect(result.unauthorizedSubjects).toContain('Math');
    expect(result.errors).toEqual(expect.arrayContaining([
      expect.objectContaining({ subjectName: 'Math', message: expect.stringContaining('not authorized') }),
    ]));
    expect(result.records.some(r => r.subjectId === 'arabic')).toBe(true);
    expect(result.records.some(r => r.subjectId === 'math')).toBe(false);
  });

  it('excludes rows with no entered scores', () => {
    const parsed = makeParsed([ARABIC], ['HW1'], ROSTER, { B2: 4 });
    const result = resolveWorkbook(parsed, context());
    expect(result.validStudentCount).toBe(1);
    expect(result.excludedCount).toBe(1);
  });

  it('resolves a student who moved into the class (roster is authoritative)', () => {
    const mover = student('MBK-7007', 'Mover Kid', CLASS);
    const parsed = makeParsed([ARABIC], ['HW1'], [...ROSTER, mover], { B4: 3 });
    const result = resolveWorkbook(parsed, context({ roster: [...ROSTER, mover] }));
    expect(result.errors).toEqual([]);
    expect(result.records.some(r => r.studentId === 'MBK-7007')).toBe(true);
  });
});

// ─── Needs Review: name-only identity ───────────────────────────────────────

/**
 * Build a parsed workbook, then blank the hidden Student ID metadata for a
 * given visible row so the row becomes name-only (name present, no trusted ID).
 */
function makeLegacyNameOnly(
  subjects: Subject[],
  blocks: AssessmentLabel[],
  roster: Student[],
  rowToBlank: number,
  edits: Record<string, string | number>,
  nameOverride?: string,
) {
  const bytes = buildRosterWorkbook({ className: CLASS, subjects, blocks, roster });
  const wb = XLSX.read(bytes, { type: 'array' });
  blankMetadataStudentIds(wb, [rowToBlank]);
  const sheet = wb.Sheets[GRADES_SHEET_NAME];
  if (nameOverride != null) sheet[`A${rowToBlank}`] = { t: 's', v: nameOverride };
  for (const [addr, value] of Object.entries(edits)) {
    sheet[addr] = typeof value === 'number' ? { t: 'n', v: value } : { t: 's', v: value };
  }
  const out = XLSX.write(wb, { bookType: 'xlsx', type: 'array' }) as ArrayBuffer;
  return parseRosterWorkbook(out);
}

describe('resolveWorkbook — Needs Review (name-only matching)', () => {
  it('A/B: a name-only row with one candidate is Needs Review, not Valid/Error', () => {
    const parsed = makeLegacyNameOnly([ARABIC], ['HW1'], ROSTER, 2, { B2: 4 });
    const result = resolveWorkbook(parsed, context());
    expect(result.reviewCount).toBe(1);
    expect(result.errors).toEqual([]);
    expect(result.validCount).toBe(0);
    const review = result.reviews[0];
    expect(review.rowNumber).toBe(2);
    expect(review.studentName).toBe('Ahmed Ali');
    expect(review.candidates).toHaveLength(1);
    expect(review.candidates[0]).toMatchObject({ id: 'MBK-1001', name: 'Ahmed Ali', className: CLASS });
    expect(review.message).toContain('name-only match');
  });

  it('C: multiple same-name candidates are all shown for explicit choice', () => {
    const twins = [
      student('MBK-2001', 'Sameer Nur', CLASS),
      student('MBK-2002', 'Sameer Nur', CLASS),
    ];
    const parsed = makeLegacyNameOnly([ARABIC], ['HW1'], twins, 2, { B2: 4 });
    const result = resolveWorkbook(parsed, context({ roster: twins }));
    expect(result.reviewCount).toBe(1);
    expect(result.reviews[0].candidates).toHaveLength(2);
    expect(result.reviews[0].reason).toContain('2 possible students');
    expect(result.records).toHaveLength(0);
  });

  it('D: choosing a candidate reruns validation and produces a valid record', () => {
    const parsed = makeLegacyNameOnly([ARABIC], ['HW1'], ROSTER, 2, { B2: 4 });
    const result = resolveWorkbook(parsed, context({
      decisions: { 2: { action: 'use', studentId: 'MBK-1001' } },
    }));
    expect(result.reviewCount).toBe(0);
    expect(result.errors).toEqual([]);
    expect(result.records).toEqual([
      expect.objectContaining({ studentId: 'MBK-1001', subjectId: 'arabic', assessmentLabel: 'HW1', score: 4 }),
    ]);
  });

  it('E: excluding a review row creates no record and counts as excluded', () => {
    const parsed = makeLegacyNameOnly([ARABIC], ['HW1'], ROSTER, 2, { B2: 4, B3: 5 });
    const before = resolveWorkbook(parsed, context());
    expect(before.reviewCount).toBe(1);
    expect(before.excludedCount).toBe(0);

    const result = resolveWorkbook(parsed, context({
      decisions: { 2: { action: 'exclude' } },
    }));
    expect(result.reviewCount).toBe(0);
    expect(result.records.some(r => r.studentId === 'MBK-1001')).toBe(false);
    expect(result.excludedCount).toBe(1);
    expect(result.records.some(r => r.studentId === 'MBK-1002')).toBe(true);
  });

  it('H: a name-only row with no roster candidate remains an Error', () => {
    const parsed = makeLegacyNameOnly([ARABIC], ['HW1'], ROSTER, 2, { B2: 4 }, 'salmaan axmed carab');
    const result = resolveWorkbook(parsed, context());
    expect(result.reviewCount).toBe(0);
    expect(result.errors).toEqual(expect.arrayContaining([
      expect.objectContaining({
        rowNumber: 2,
        removableRow: 2,
        message: expect.stringContaining('No roster student matches legacy name "salmaan axmed carab"'),
      }),
    ]));
  });

  it('H2: excluding a no-roster-match error row clears the error and counts as excluded', () => {
    const parsed = makeLegacyNameOnly([ARABIC], ['HW1'], ROSTER, 2, { B2: 4 }, 'salmaan axmed carab');
    const before = resolveWorkbook(parsed, context());
    const after = resolveWorkbook(parsed, context({
      decisions: { 2: { action: 'exclude' } },
    }));
    expect(before.errors.some(e => e.rowNumber === 2)).toBe(true);
    expect(after.errors).toHaveLength(0);
    expect(after.reviewCount).toBe(0);
    expect(after.excludedCount).toBe(before.excludedCount + 1);
    expect(after.records).toHaveLength(0);
  });

  it('J(client): choosing a student not in the current roster becomes an Error', () => {
    const parsed = makeLegacyNameOnly([ARABIC], ['HW1'], ROSTER, 2, { B2: 4 });
    const result = resolveWorkbook(parsed, context({
      decisions: { 2: { action: 'use', studentId: 'MBK-DOES-NOT-BELONG' } },
    }));
    expect(result.reviewCount).toBe(0);
    expect(result.records).toHaveLength(0);
    expect(result.errors).toEqual(expect.arrayContaining([
      expect.objectContaining({ rowNumber: 2, message: expect.stringContaining('no longer in') }),
    ]));
  });

  it('M: Maxamed Cabdijabar Ibrahim / Grade 11-A / row 2 → actionable Needs Review', () => {
    const CLASS_11A = 'Grade 11-A';
    const maxamed = student('MBK-11-001', 'Maxamed Cabdijabar Ibrahim', CLASS_11A);
    const roster11 = [maxamed, student('MBK-11-002', 'Other Student', CLASS_11A)];
    const parsed = makeLegacyNameOnly([ARABIC], ['HW1'], roster11, 2, { B2: 5 });
    const result = resolveWorkbook(parsed, context({ className: CLASS_11A, roster: roster11 }));
    expect(result.validCount).toBe(0);
    expect(result.reviewCount).toBe(1);
    const review = result.reviews[0];
    expect(review).toMatchObject({ rowNumber: 2, studentName: 'Maxamed Cabdijabar Ibrahim' });
    expect(review.message).toContain('name-only match');
    expect(review.candidates).toEqual([
      { id: 'MBK-11-001', name: 'Maxamed Cabdijabar Ibrahim', className: CLASS_11A },
    ]);
    const resolved = resolveWorkbook(parsed, context({
      className: CLASS_11A,
      roster: roster11,
      decisions: { 2: { action: 'use', studentId: 'MBK-11-001' } },
    }));
    expect(resolved.reviewCount).toBe(0);
    expect(resolved.records).toEqual([
      expect.objectContaining({ studentId: 'MBK-11-001', subjectId: 'arabic', assessmentLabel: 'HW1', score: 5 }),
    ]);
  });

  it('I: two workbook rows resolving to the same student stay an Error', () => {
    const parsed = makeLegacyNameOnly([ARABIC], ['HW1'], ROSTER, 3, { B2: 4, B3: 5, A3: 'Ahmed Ali' });
    const result = resolveWorkbook(parsed, context({
      decisions: { 3: { action: 'use', studentId: 'MBK-1001' } },
    }));
    expect(result.errors).toEqual(expect.arrayContaining([
      expect.objectContaining({ message: expect.stringContaining('Duplicate') }),
    ]));
  });

  it('L: a normal downloaded workbook with hidden IDs produces no reviews', () => {
    const parsed = makeParsed([ARABIC], ['HW1'], ROSTER, { B2: 4, B3: 5 });
    const result = resolveWorkbook(parsed, context());
    expect(result.reviewCount).toBe(0);
    expect(result.errors).toEqual([]);
    expect(result.validCount).toBe(2);
  });
});

// ─── Name-only / no Student ID metadata must never create false duplicates ──

/**
 * Build a workbook, then remove its hidden roster metadata entirely so every
 * visible row behaves like a blank-ID / name-only Google Sheet upload.
 */
function makeBlankIds(
  subjects: Subject[],
  blocks: AssessmentLabel[],
  roster: Student[],
  edits: Record<string, string | number> = {},
) {
  const bytes = buildRosterWorkbook({ className: CLASS, subjects, blocks, roster });
  const wb = XLSX.read(bytes, { type: 'array' });
  removeMetadataSheet(wb);
  const sheet = wb.Sheets[GRADES_SHEET_NAME];
  for (const [addr, value] of Object.entries(edits)) {
    sheet[addr] = typeof value === 'number' ? { t: 'n', v: value } : { t: 's', v: value };
  }
  const out = XLSX.write(wb, { bookType: 'xlsx', type: 'array' }) as ArrayBuffer;
  return parseRosterWorkbook(out);
}

describe('resolveWorkbook — name-only Google Sheet workflow', () => {
  const CLASS_11A = 'Grade 11-A';
  const ROSTER_11A = [
    student('S-11-001', 'Amiir sakariye', CLASS_11A),
    student('S-11-002', 'Axmed Cabdale Maxamuud', CLASS_11A),
    student('S-11-003', 'C/raxmaan Cumar Farax', CLASS_11A),
  ];
  const ctx11 = (overrides: Partial<ResolveContext> = {}): ResolveContext => context({
    className: CLASS_11A,
    authorizedSubjects: [ARABIC],
    roster: ROSTER_11A,
    ...overrides,
  });

  it('A/G: multiple name-only rows are separate rows with no false duplicates', () => {
    const parsed = makeBlankIds([ARABIC], ['HW1'], ROSTER_11A, { B2: 4, B3: 5, B4: 3 });
    expect(parsed.students.every(s => s.studentId == null)).toBe(true);

    const result = resolveWorkbook(parsed, ctx11());
    expect(result.errors.filter(e => /Duplicate/.test(e.message))).toHaveLength(0);
    expect(result.errors).toHaveLength(0);
    expect(result.reviewCount).toBe(3);
    expect(new Set(result.reviews.map(r => r.rowNumber)).size).toBe(3);
  });

  it('B: a name-only row with a single roster candidate is Needs Review', () => {
    const parsed = makeBlankIds([ARABIC], ['HW1'], ROSTER_11A, { B2: 4 });
    const result = resolveWorkbook(parsed, ctx11());
    expect(result.reviewCount).toBeGreaterThanOrEqual(1);
    const review = result.reviews.find(r => r.rowNumber === 2)!;
    expect(review.candidates).toEqual([
      expect.objectContaining({ id: 'S-11-001', className: CLASS_11A }),
    ]);
  });

  it('C: a name-only row with multiple same-name candidates shows all candidates', () => {
    const twins = [
      student('T-1', 'Cali Maxamed', CLASS_11A),
      student('T-2', 'Cali Maxamed', CLASS_11A),
    ];
    const parsed = makeBlankIds([ARABIC], ['HW1'], twins, { B2: 4 });
    const result = resolveWorkbook(parsed, ctx11({ roster: twins }));
    const review = result.reviews.find(r => r.rowNumber === 2)!;
    expect(review.candidates.map(c => c.id).sort()).toEqual(['T-1', 'T-2']);
    expect(result.errors).toHaveLength(0);
  });

  it('D: a name-only row with no roster candidate is an Error', () => {
    const parsed = makeBlankIds([ARABIC], ['HW1'], ROSTER_11A, { A2: 'salmaan axmed carab', B2: 4 });
    const result = resolveWorkbook(parsed, ctx11());
    expect(result.errors).toEqual(expect.arrayContaining([
      expect.objectContaining({
        rowNumber: 2,
        removableRow: 2,
        message: expect.stringContaining('No roster student matches legacy name "salmaan axmed carab"'),
      }),
    ]));
  });

  it('E: choosing a student attaches all of the name-only row scores, none lost', () => {
    const parsed = makeBlankIds(
      [ARABIC, TARBIYA],
      ['HW1', 'HW2', 'HW3', 'HW4'],
      ROSTER_11A,
      { B2: 5, C2: 4, D2: 3, E2: 2, F2: 5, G2: 4, H2: 3, I2: 2 },
    );
    const result = resolveWorkbook(parsed, ctx11({
      authorizedSubjects: [ARABIC, TARBIYA],
      decisions: { 2: { action: 'use', studentId: 'S-11-001' } },
    }));
    const mine = result.records.filter(r => r.studentId === 'S-11-001');
    expect(mine).toHaveLength(8);
    expect(result.errors).toHaveLength(0);
    expect(result.reviewCount).toBe(0);
  });

  it('F: two name-only rows resolved to the same student produce a real duplicate', () => {
    const parsed = makeBlankIds([ARABIC], ['HW1'], ROSTER_11A, { B2: 4, B3: 5 });
    const result = resolveWorkbook(parsed, ctx11({
      decisions: {
        2: { action: 'use', studentId: 'S-11-001' },
        3: { action: 'use', studentId: 'S-11-001' },
      },
    }));
    expect(result.errors).toEqual(expect.arrayContaining([
      expect.objectContaining({ message: expect.stringContaining('Duplicate') }),
    ]));
  });

  it('H: a full workbook with no visible Student ID metadata yields reviews, not false duplicates', () => {
    const ENGLISH = subject('english', 'English');
    const roster = [
      student('R1', 'Amiir sakariye', CLASS_11A),
      student('R2', 'Axmed Cabdale Maxamuud', CLASS_11A),
      student('R3', 'C/raxmaan Cumar Farax', CLASS_11A),
    ];
    const allBlocks: AssessmentLabel[] = ['HW1', 'HW2', 'HW3', 'HW4', 'CPW1', 'CPW2', 'CPW3', 'CPW4', 'ATTENDANCE', 'MT', 'AKHLAAQ'];
    const bytes = buildRosterWorkbook({ className: CLASS_11A, subjects: [ARABIC, ENGLISH], blocks: allBlocks, roster });
    const wb = XLSX.read(bytes, { type: 'array' });
    removeMetadataSheet(wb);
    const sheet = wb.Sheets[GRADES_SHEET_NAME];
    const ref = XLSX.utils.decode_range(sheet['!ref'] as string);
    for (let r = 2; r <= 4; r++) {
      for (let c = 1; c <= ref.e.c; c++) {
        const addr = XLSX.utils.encode_cell({ r: r - 1, c });
        sheet[addr] = { t: 'n', v: 3 };
      }
    }
    const out = XLSX.write(wb, { bookType: 'xlsx', type: 'array' }) as ArrayBuffer;
    const parsed = parseRosterWorkbook(out);

    const result = resolveWorkbook(parsed, ctx11({ authorizedSubjects: [ARABIC, ENGLISH], roster }));
    expect(result.errors.filter(e => /Duplicate/.test(e.message))).toHaveLength(0);
    expect(result.errors).toHaveLength(0);
    expect(result.reviewCount).toBe(3);
    expect(result.records).toHaveLength(0);

    const result2 = resolveWorkbook(parsed, ctx11({
      authorizedSubjects: [ARABIC, ENGLISH],
      roster,
      decisions: {
        2: { action: 'use', studentId: 'R1' },
        3: { action: 'use', studentId: 'R2' },
        4: { action: 'use', studentId: 'R3' },
      },
    }));
    expect(result2.reviewCount).toBe(0);
    expect(result2.errors).toHaveLength(0);
    expect(result2.records).toHaveLength(3 * 2 * 11);
  });
});
