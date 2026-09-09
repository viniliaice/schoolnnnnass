import { describe, expect, it } from 'vitest';
import * as XLSX from 'xlsx';
import type { Student, Subject } from '../../types';
import { buildRosterWorkbook, parseRosterWorkbook, GRADES_SHEET_NAME } from '../bulk-grades/workbook';
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

/** Build a workbook and set cell values by address, then parse. */
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
    // Columns: C=Arabic HW1, D=Arabic MT, E=Tarbiya HW1, F=Tarbiya MT
    const parsed = makeParsed([ARABIC, TARBIYA], ['HW1', 'MT'], ROSTER, {
      C2: 4, D2: 18, E2: 5, F2: 15,
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
    // C=Arabic Akhlaaq, D=Tarbiya Akhlaaq
    const parsed = makeParsed([ARABIC, TARBIYA], ['AKHLAAQ'], ROSTER, { C2: 8, D2: 3 });
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
    ], { C4: 5 });
    const result = resolveWorkbook(parsed, context());
    expect(result.errors).toEqual(expect.arrayContaining([
      expect.objectContaining({ studentId: 'MBK-9999', message: expect.stringContaining('not currently in Grade 5-A') }),
    ]));
    // No record produced for the intruder.
    expect(result.records.some(r => r.studentId === 'MBK-9999')).toBe(false);
  });

  it('rejects an unauthorized subject present in the workbook', () => {
    // Teacher authorized for Arabic + Tarbiya only; workbook has Math.
    const parsed = makeParsed([ARABIC, MATH], ['HW1'], ROSTER, { C2: 4, D2: 3 });
    const result = resolveWorkbook(parsed, context({ authorizedSubjects: [ARABIC, TARBIYA] }));
    expect(result.unauthorizedSubjects).toContain('Math');
    expect(result.errors).toEqual(expect.arrayContaining([
      expect.objectContaining({ subjectName: 'Math', message: expect.stringContaining('not authorized') }),
    ]));
    // Arabic still resolves.
    expect(result.records.some(r => r.subjectId === 'arabic')).toBe(true);
    expect(result.records.some(r => r.subjectId === 'math')).toBe(false);
  });

  it('excludes rows with no entered scores', () => {
    const parsed = makeParsed([ARABIC], ['HW1'], ROSTER, { C2: 4 }); // only Ahmed scored
    const result = resolveWorkbook(parsed, context());
    expect(result.validStudentCount).toBe(1);
    expect(result.excludedCount).toBe(1); // Aisha row blank
  });

  it('resolves a student who moved into the class (roster is authoritative)', () => {
    // Student physically in the workbook via ID; roster now includes a mover.
    const mover = student('MBK-7007', 'Mover Kid', CLASS);
    const parsed = makeParsed([ARABIC], ['HW1'], [...ROSTER, mover], { C4: 3 });
    const result = resolveWorkbook(parsed, context({ roster: [...ROSTER, mover] }));
    expect(result.errors).toEqual([]);
    expect(result.records.some(r => r.studentId === 'MBK-7007')).toBe(true);
  });
});

// ─── Needs Review: legacy / name-only identity ──────────────────────────────

/**
 * Build a parsed workbook, then BLANK OUT the prefilled Student ID cell for a
 * given row so the row becomes a legacy / name-only row (name present, no ID).
 * The name cell keeps the roster name unless `nameOverride` is supplied.
 */
function makeLegacyNameOnly(
  subjects: Subject[],
  blocks: AssessmentLabel[],
  roster: Student[],
  idRowToBlank: number,       // worksheet row index (2 = first student)
  edits: Record<string, string | number>,
  nameOverride?: string,
) {
  const bytes = buildRosterWorkbook({ className: CLASS, subjects, blocks, roster });
  const wb = XLSX.read(bytes, { type: 'array' });
  const sheet = wb.Sheets[GRADES_SHEET_NAME];
  // Column A = Student ID, Column B = Student Name.
  sheet[`A${idRowToBlank}`] = { t: 's', v: '' };
  if (nameOverride != null) sheet[`B${idRowToBlank}`] = { t: 's', v: nameOverride };
  for (const [addr, value] of Object.entries(edits)) {
    sheet[addr] = typeof value === 'number' ? { t: 'n', v: value } : { t: 's', v: value };
  }
  const out = XLSX.write(wb, { bookType: 'xlsx', type: 'array' }) as ArrayBuffer;
  return parseRosterWorkbook(out);
}

describe('resolveWorkbook — Needs Review (legacy name-only matching)', () => {
  // A. Legacy name-only match with exactly one candidate → Needs Review.
  it('A/B: a legacy name-only row with one candidate is Needs Review, not Valid/Error', () => {
    // Row 2 = Ahmed Ali; blank his ID so the row is name-only.
    const parsed = makeLegacyNameOnly([ARABIC], ['HW1'], ROSTER, 2, { C2: 4 });
    const result = resolveWorkbook(parsed, context());
    expect(result.reviewCount).toBe(1);
    expect(result.errors).toEqual([]);
    expect(result.validCount).toBe(0); // NOT auto-valid
    const review = result.reviews[0];
    expect(review.rowNumber).toBe(2);
    expect(review.studentName).toBe('Ahmed Ali');
    expect(review.candidates).toHaveLength(1);
    expect(review.candidates[0]).toMatchObject({ id: 'MBK-1001', name: 'Ahmed Ali', className: CLASS });
    expect(review.message).toContain('name-only match');
  });

  // C. Multiple candidates → all shown, none pre-selected.
  it('C: multiple same-name candidates are all shown for explicit choice', () => {
    const twins = [
      student('MBK-2001', 'Sameer Nur', CLASS),
      student('MBK-2002', 'Sameer Nur', CLASS),
    ];
    const parsed = makeLegacyNameOnly([ARABIC], ['HW1'], twins, 2, { C2: 4 });
    const result = resolveWorkbook(parsed, context({ roster: twins }));
    expect(result.reviewCount).toBe(1);
    expect(result.reviews[0].candidates).toHaveLength(2);
    expect(result.reviews[0].reason).toContain('2 possible students');
    expect(result.records).toHaveLength(0); // nothing chosen automatically
  });

  // D. "Use this student" → correct studentId inserted + full validation reruns.
  it('D: choosing a candidate reruns validation and produces a valid record', () => {
    const parsed = makeLegacyNameOnly([ARABIC], ['HW1'], ROSTER, 2, { C2: 4 });
    const result = resolveWorkbook(parsed, context({
      decisions: { 2: { action: 'use', studentId: 'MBK-1001' } },
    }));
    expect(result.reviewCount).toBe(0);
    expect(result.errors).toEqual([]);
    expect(result.records).toEqual([
      expect.objectContaining({ studentId: 'MBK-1001', subjectId: 'arabic', assessmentLabel: 'HW1', score: 4 }),
    ]);
  });

  // E. "Exclude row" → moves to Excluded, no record.
  it('E: excluding a review row creates no record and counts as excluded', () => {
    // Score BOTH roster rows so the only excluded row is the one we exclude.
    // Row 2 (Ahmed) is blanked to name-only; row 3 (Aisha) keeps her ID+score.
    const parsed = makeLegacyNameOnly([ARABIC], ['HW1'], ROSTER, 2, { C2: 4, C3: 5 });
    const before = resolveWorkbook(parsed, context());
    expect(before.reviewCount).toBe(1);
    expect(before.excludedCount).toBe(0); // both rows have scores

    const result = resolveWorkbook(parsed, context({
      decisions: { 2: { action: 'exclude' } },
    }));
    expect(result.reviewCount).toBe(0);
    expect(result.records.some(r => r.studentId === 'MBK-1001')).toBe(false); // Ahmed excluded
    expect(result.excludedCount).toBe(1);
    // Aisha still resolves normally.
    expect(result.records.some(r => r.studentId === 'MBK-1002')).toBe(true);
  });

  // H. No candidate for a legacy name → remains an ERROR (not Needs Review).
  it('H: a legacy name with no roster candidate remains an Error', () => {
    const parsed = makeLegacyNameOnly([ARABIC], ['HW1'], ROSTER, 2, { C2: 4 }, 'salmaan axmed carab');
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

  // H2: a no-candidate error row can be REMOVED directly from the UI (exclude
  // decision) — the teacher never has to go back to the spreadsheet.
  it('H2: excluding a no-roster-match error row clears the error and counts as excluded', () => {
    const parsed = makeLegacyNameOnly([ARABIC], ['HW1'], ROSTER, 2, { C2: 4 }, 'salmaan axmed carab');
    const before = resolveWorkbook(parsed, context());
    const after = resolveWorkbook(parsed, context({
      decisions: { 2: { action: 'exclude' } },
    }));
    // The error is gone and the row moved to Excluded — no spreadsheet edit needed.
    expect(before.errors.some(e => e.rowNumber === 2)).toBe(true);
    expect(after.errors).toHaveLength(0);
    expect(after.reviewCount).toBe(0);
    expect(after.excludedCount).toBe(before.excludedCount + 1);
    expect(after.records).toHaveLength(0);
  });

  // J-mirror: choosing a student who is NOT in the current class → Error (client
  // mirror of the server's stale-roster rejection).
  it('J(client): choosing a student not in the current roster becomes an Error', () => {
    const parsed = makeLegacyNameOnly([ARABIC], ['HW1'], ROSTER, 2, { C2: 4 });
    const result = resolveWorkbook(parsed, context({
      decisions: { 2: { action: 'use', studentId: 'MBK-DOES-NOT-BELONG' } },
    }));
    expect(result.reviewCount).toBe(0);
    expect(result.records).toHaveLength(0);
    expect(result.errors).toEqual(expect.arrayContaining([
      expect.objectContaining({ rowNumber: 2, message: expect.stringContaining('no longer in') }),
    ]));
  });

  // M. Exact regression case from the brief.
  it('M: Maxamed Cabdijabar Ibrahim / Grade 11-A / row 2 → actionable Needs Review', () => {
    const CLASS_11A = 'Grade 11-A';
    const maxamed = student('MBK-11-001', 'Maxamed Cabdijabar Ibrahim', CLASS_11A);
    const roster11 = [maxamed, student('MBK-11-002', 'Other Student', CLASS_11A)];
    const parsed = makeLegacyNameOnly([ARABIC], ['HW1'], roster11, 2, { C2: 5 });
    const result = resolveWorkbook(parsed, context({ className: CLASS_11A, roster: roster11 }));
    expect(result.validCount).toBe(0);         // NOT auto-valid
    expect(result.reviewCount).toBe(1);
    const review = result.reviews[0];
    expect(review).toMatchObject({ rowNumber: 2, studentName: 'Maxamed Cabdijabar Ibrahim' });
    expect(review.message).toContain('name-only match');
    expect(review.candidates).toEqual([
      { id: 'MBK-11-001', name: 'Maxamed Cabdijabar Ibrahim', className: CLASS_11A },
    ]);
    // And "Use this student" resolves it into a valid record.
    const resolved = resolveWorkbook(parsed, context({
      className: CLASS_11A, roster: roster11,
      decisions: { 2: { action: 'use', studentId: 'MBK-11-001' } },
    }));
    expect(resolved.reviewCount).toBe(0);
    expect(resolved.records).toEqual([
      expect.objectContaining({ studentId: 'MBK-11-001', subjectId: 'arabic', assessmentLabel: 'HW1', score: 5 }),
    ]);
  });

  // I. Duplicate workbook identity (both rows resolve to same student) → Error.
  it('I: two workbook rows resolving to the same student stay an Error', () => {
    // Ahmed appears with his ID (row 2) AND as a legacy name-only row that is
    // then matched to the same student → duplicate assessment identity.
    const parsed = makeLegacyNameOnly([ARABIC], ['HW1'], ROSTER, 3, { C2: 4, C3: 5, B3: 'Ahmed Ali' });
    // Row 3 was Aisha; we blanked her ID and renamed to Ahmed Ali (legacy dup).
    const result = resolveWorkbook(parsed, context({
      decisions: { 3: { action: 'use', studentId: 'MBK-1001' } },
    }));
    expect(result.errors).toEqual(expect.arrayContaining([
      expect.objectContaining({ message: expect.stringContaining('Duplicate') }),
    ]));
  });

  // L. Normal roster workbook (IDs present) → all Valid, zero reviews.
  it('L: a normal roster workbook with IDs produces no reviews', () => {
    const parsed = makeParsed([ARABIC], ['HW1'], ROSTER, { C2: 4, C3: 5 });
    const result = resolveWorkbook(parsed, context());
    expect(result.reviewCount).toBe(0);
    expect(result.errors).toEqual([]);
    expect(result.validCount).toBe(2);
  });
});

// ─── Blank Student ID must never create false duplicates ─────────────────────
//
// Real-world workflow: teachers upload Google Sheets exported to Excel with the
// Student ID column left completely BLANK for every row. A blank ID means
// "identity not yet resolved" — it must NEVER be treated as an identity, and two
// blank-ID rows must NEVER collide into a false duplicate.

/**
 * Build a workbook from a roster, then BLANK the Student ID cell for a set of
 * worksheet rows (2 = first student). Optionally rename those rows' names.
 * Every remaining cell keeps its prefilled value.
 */
function makeBlankIds(
  subjects: Subject[],
  blocks: AssessmentLabel[],
  roster: Student[],
  blankRows: number[],
  edits: Record<string, string | number> = {},
) {
  const bytes = buildRosterWorkbook({ className: CLASS, subjects, blocks, roster });
  const wb = XLSX.read(bytes, { type: 'array' });
  const sheet = wb.Sheets[GRADES_SHEET_NAME];
  for (const r of blankRows) sheet[`A${r}`] = { t: 's', v: '' };
  for (const [addr, value] of Object.entries(edits)) {
    sheet[addr] = typeof value === 'number' ? { t: 'n', v: value } : { t: 's', v: value };
  }
  const out = XLSX.write(wb, { bookType: 'xlsx', type: 'array' }) as ArrayBuffer;
  return parseRosterWorkbook(out);
}

describe('resolveWorkbook — blank Student ID (real-world Google Sheet)', () => {
  const CLASS_11A = 'Grade 11-A';
  // A realistic roster for the "no IDs typed" workflow.
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

  // A / G: three different blank-ID names → three separate Needs-Review rows,
  // ZERO duplicate errors caused by the blank IDs ('' + '' must not collide).
  it('A/G: multiple blank Student IDs are separate rows with no false duplicates', () => {
    // Blank all three IDs; each name matches exactly one roster student.
    const parsed = makeBlankIds([ARABIC], ['HW1'], ROSTER_11A, [2, 3, 4], { C2: 4, C3: 5, C4: 3 });
    // Parser must NOT emit '' as an identity.
    expect(parsed.students.every(s => s.studentId === null || s.studentId === undefined)).toBe(true);

    const result = resolveWorkbook(parsed, ctx11());
    expect(result.errors.filter(e => /Duplicate/.test(e.message))).toHaveLength(0);
    expect(result.errors).toHaveLength(0);
    expect(result.reviewCount).toBe(3);
    expect(new Set(result.reviews.map(r => r.rowNumber)).size).toBe(3);
  });

  // B: blank ID with exactly one candidate → Needs Review (not Error).
  it('B: blank ID with a single roster candidate is Needs Review', () => {
    const parsed = makeBlankIds([ARABIC], ['HW1'], ROSTER_11A, [2], { C2: 4 });
    const result = resolveWorkbook(parsed, ctx11());
    expect(result.reviewCount).toBeGreaterThanOrEqual(1);
    const review = result.reviews.find(r => r.rowNumber === 2)!;
    expect(review).toBeTruthy();
    expect(review.candidates).toEqual([
      expect.objectContaining({ id: 'S-11-001', className: CLASS_11A }),
    ]);
  });

  // C: blank ID with multiple candidates → Needs Review, all candidates shown.
  it('C: blank ID with multiple same-name candidates shows all candidates', () => {
    const twins = [
      student('T-1', 'Cali Maxamed', CLASS_11A),
      student('T-2', 'Cali Maxamed', CLASS_11A),
    ];
    const parsed = makeBlankIds([ARABIC], ['HW1'], twins, [2], { C2: 4 });
    const result = resolveWorkbook(parsed, ctx11({ roster: twins }));
    const review = result.reviews.find(r => r.rowNumber === 2)!;
    expect(review.candidates.map(c => c.id).sort()).toEqual(['T-1', 'T-2']);
    expect(result.errors).toHaveLength(0);
  });

  // D: blank ID with no candidate → Error (removable from the UI).
  it('D: blank ID with no roster candidate is an Error', () => {
    const parsed = makeBlankIds([ARABIC], ['HW1'], ROSTER_11A, [2], { B2: 'salmaan axmed carab', C2: 4 });
    const result = resolveWorkbook(parsed, ctx11());
    expect(result.errors).toEqual(expect.arrayContaining([
      expect.objectContaining({
        rowNumber: 2,
        removableRow: 2,
        message: expect.stringContaining('No roster student matches legacy name "salmaan axmed carab"'),
      }),
    ]));
  });

  // E: manual resolution attaches the row's FULL score set to the chosen student.
  it('E: choosing a student attaches all of the blank-ID row scores, none lost', () => {
    // Two subjects, all four HW blocks → 8 scores in one row.
    const parsed = makeBlankIds(
      [ARABIC, TARBIYA],
      ['HW1', 'HW2', 'HW3', 'HW4'],
      ROSTER_11A,
      [2],
      { C2: 5, D2: 4, E2: 3, F2: 2, G2: 5, H2: 4, I2: 3, J2: 2 },
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

  // F: TWO blank-ID rows resolved to the SAME student → genuine duplicate error.
  it('F: two blank-ID rows resolved to the same student produce a real duplicate', () => {
    const parsed = makeBlankIds([ARABIC], ['HW1'], ROSTER_11A, [2, 3], { C2: 4, C3: 5 });
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

  // H: the exact real-world workbook — every ID blank, MATH + ENGLISH, 11 blocks
  // each → resolves into Needs Review rows, NOT hundreds of duplicate errors.
  it('H: full real-world workbook (all IDs blank, two subjects × 11 blocks)', () => {
    const ENGLISH = subject('english', 'English');
    const roster = [
      student('R1', 'Amiir sakariye', CLASS_11A),
      student('R2', 'Axmed Cabdale Maxamuud', CLASS_11A),
      student('R3', 'C/raxmaan Cumar Farax', CLASS_11A),
    ];
    const allBlocks: AssessmentLabel[] = ['HW1','HW2','HW3','HW4','CPW1','CPW2','CPW3','CPW4','ATTENDANCE','MT','AKHLAAQ'];
    // Fill every grade cell for all three rows with valid values.
    const bytes = buildRosterWorkbook({ className: CLASS_11A, subjects: [ARABIC, ENGLISH], blocks: allBlocks, roster });
    const wb = XLSX.read(bytes, { type: 'array' });
    const sheet = wb.Sheets[GRADES_SHEET_NAME];
    const ref = XLSX.utils.decode_range(sheet['!ref'] as string);
    for (let r = 2; r <= 4; r++) {
      sheet[`A${r}`] = { t: 's', v: '' }; // blank the ID
      for (let c = 2; c <= ref.e.c; c++) { // columns C.. = grade cells
        const addr = XLSX.utils.encode_cell({ r: r - 1, c });
        // Modest valid score that fits every block's max (HW=5 is the smallest max).
        sheet[addr] = { t: 'n', v: 3 };
      }
    }
    const out = XLSX.write(wb, { bookType: 'xlsx', type: 'array' }) as ArrayBuffer;
    const parsed = parseRosterWorkbook(out);

    const result = resolveWorkbook(parsed, ctx11({ authorizedSubjects: [ARABIC, ENGLISH], roster }));
    // No explosion of duplicate errors from blank IDs.
    expect(result.errors.filter(e => /Duplicate/.test(e.message))).toHaveLength(0);
    expect(result.errors).toHaveLength(0);
    // Three students → three Needs-Review items, none auto-resolved.
    expect(result.reviewCount).toBe(3);
    expect(result.records).toHaveLength(0);

    // Resolve all three → every score record materializes (2 subjects × 11 = 22 each).
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
