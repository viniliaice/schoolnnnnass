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
