// PR #39 + PR #40 integration — Bulk Upload Grades, combined-state regression.
//
// Proves the COMBINED contract end to end on the real pipeline:
//   buildRosterWorkbook (PR #40 flat header) → real XLSX bytes → parseRosterWorkbook
//   with the UI's expected-column contract → resolveWorkbook → REAL
//   submit_bulk_grades (20260911 NUMERIC version, executed in PGlite) → exams.
//
// Half-point values (the PR #39 requirement) must reach `exams.score`
// unchanged, and every PR #40 guard (expected columns, identity, duplicates,
// authorization, preview/confirm, idempotency, atomicity) must keep holding.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as XLSX from 'xlsx';
import type { Student, Subject } from '../../../types';
import type { AssessmentLabel } from '../../excel-parser';
import { ASSESSMENT_BLOCKS } from '../assessments';
import { resolveWorkbook, type ResolveContext } from '../resolve';
import { buildRosterWorkbook, GRADES_SHEET_NAME, parseRosterWorkbook, ROSTER_METADATA_SHEET_NAME } from '../workbook';
import { createBulkGradesTestDb, pgliteAvailable, type PgTestDb } from './pgHarness';

const AVAILABLE = await pgliteAvailable();
const d = AVAILABLE ? describe : describe.skip;

const AUTH_A = '11111111-1111-1111-1111-111111111111';
const AUTH_B = '22222222-2222-2222-2222-222222222222';
const AUTH_PARENT = '44444444-4444-4444-4444-444444444444';

const CLASS = 'Grade 7-A';
const ENGLISH = { id: 'eng', name: 'English', createdAt: 'x' } as Subject;
const ARABIC = { id: 'ara', name: 'Arabic', createdAt: 'x' } as Subject;
const TARBIYA = { id: 'tar', name: 'Tarbiya', createdAt: 'x' } as Subject; // DB name; header prints TARABIYA
const MATHEMATICS = { id: 'math', name: 'Mathematics', createdAt: 'x' } as Subject; // NOT assigned to teacher A
const AUTH_SUBJECTS = [ENGLISH, ARABIC, TARBIYA];
const ALL_BLOCKS: AssessmentLabel[] = ['HW1', 'HW2', 'HW3', 'HW4', 'CPW1', 'CPW2', 'CPW3', 'CPW4', 'ATTENDANCE', 'MT', 'AKHLAAQ'];

const ROSTER: Student[] = [
  { id: 'MBK-7001', name: 'Axmed Cabdi', className: CLASS, parentId: 'parent1', createdAt: 'x' } as Student,
  { id: 'MBK-7002', name: 'Axmed Cabdi Hassan', className: CLASS, parentId: null, createdAt: 'x' } as Student,
  { id: 'MBK-7003', name: 'Hodan Warsame', className: CLASS, parentId: null, createdAt: 'x' } as Student,
  { id: 'MBK-7004', name: 'Hodan Warsame', className: CLASS, parentId: null, createdAt: 'x' } as Student,
];

const UI_OPTIONS = { expectedSubjects: AUTH_SUBJECTS.map(s => s.name), expectedBlocks: ALL_BLOCKS };

function context(overrides: Partial<ResolveContext> = {}): ResolveContext {
  return {
    className: CLASS,
    authorizedSubjects: AUTH_SUBJECTS,
    roster: ROSTER,
    termId: 'term1',
    termName: 'Term 1',
    month: 'September',
    date: '2026-09-15',
    ...overrides,
  };
}

/** Read the Grades sheet as a 2-D array (header row first). */
function gradesRows(bytes: ArrayBuffer): unknown[][] {
  const wb = XLSX.read(bytes, { type: 'array' });
  return XLSX.utils.sheet_to_json<unknown[]>(wb.Sheets[GRADES_SHEET_NAME], { header: 1, defval: null, raw: true });
}

/** Edit a generated workbook by header name (case-insensitive) and re-serialize to real XLSX bytes. */
function fill(bytes: ArrayBuffer, edit: (rows: unknown[][], col: (header: string) => number) => void): ArrayBuffer {
  const wb = XLSX.read(bytes, { type: 'array' });
  const rows = gradesRows(bytes);
  const header = (rows[0] as unknown[]).map(v => String(v ?? '').toUpperCase());
  const col = (h: string) => {
    const c = header.indexOf(h.toUpperCase());
    if (c < 0) throw new Error(`missing column "${h}" in ${header.join(', ')}`);
    return c;
  };
  edit(rows, col);
  wb.Sheets[GRADES_SHEET_NAME] = XLSX.utils.aoa_to_sheet(rows as never[][]);
  return XLSX.write(wb, { bookType: 'xlsx', type: 'array' }) as ArrayBuffer;
}

function record(overrides: Record<string, unknown> = {}) {
  return {
    studentId: 'MBK-7003', subjectId: 'eng', assessmentLabel: 'HW1', examType: 'Homework', total: 5, score: 4.5,
    entryState: 'scored', month: 'September', date: '2026-09-15', termId: 'term1', ...overrides,
  };
}

async function seed(db: PgTestDb) {
  await db.exec(`
    INSERT INTO auth.users(id) VALUES ('${AUTH_A}'),('${AUTH_B}'),('${AUTH_PARENT}');
    INSERT INTO profiles(id,name,email,role,auth_id) VALUES
      ('teacherA','Teacher A','a@x.com','teacher','${AUTH_A}'),
      ('teacherB','Teacher B','b@x.com','teacher','${AUTH_B}'),
      ('parent1','Parent','p@x.com','parent','${AUTH_PARENT}');
    INSERT INTO subjects(id,name) VALUES ('eng','English'),('ara','Arabic'),('tar','Tarbiya'),('math','Mathematics');
    INSERT INTO students(id,name,"className","parentId") VALUES
      ('MBK-7001','Axmed Cabdi','${CLASS}','parent1'),
      ('MBK-7002','Axmed Cabdi Hassan','${CLASS}',NULL),
      ('MBK-7003','Hodan Warsame','${CLASS}',NULL),
      ('MBK-7004','Hodan Warsame','${CLASS}',NULL),
      ('MBK-8001','Other Kid','Grade 8-A',NULL);
    INSERT INTO class_subjects(id,"className","subjectId","teacherId") VALUES
      ('cs1','${CLASS}','eng','teacherA'),
      ('cs2','${CLASS}','ara','teacherA'),
      ('cs3','${CLASS}','tar','teacherA'),
      ('cs4','${CLASS}','math','teacherB'),
      ('cs5','Grade 8-A','eng','teacherB');
    INSERT INTO academic_years(id,name) VALUES ('ay1','2026');
    INSERT INTO terms(id,name,"academicYearId","startDate","endDate","isCurrent",months) VALUES
      ('term1','Term 1','ay1','2026-01-01','2026-12-31',true,ARRAY['September']);
  `);
}

async function rpc(db: PgTestDb, records: unknown[], key: string, confirm: boolean) {
  const { rows } = await db.query<{ result: Record<string, unknown> }>(
    'SELECT public.submit_bulk_grades($1::jsonb, $2, $3) AS result',
    [JSON.stringify(records), key, confirm],
  );
  return rows[0].result;
}

async function denied(fn: () => Promise<unknown>): Promise<string> {
  try { await fn(); } catch (e) { return e instanceof Error ? e.message : String(e); }
  throw new Error('Expected the RPC to DENY, but it succeeded.');
}

async function scoreText(db: PgTestDb, studentId: string, subjectId: string, label: string) {
  const { rows } = await db.query<{ score: string | null; status: string }>(
    `SELECT score::text AS score, status FROM exams WHERE "studentId"=$1 AND "subjectId"=$2 AND "assessmentLabel"=$3`,
    [studentId, subjectId, label],
  );
  return rows[0] ?? null;
}

async function count(db: PgTestDb, where = 'TRUE', params: unknown[] = []) {
  const { rows } = await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM exams WHERE ${where}`, params);
  return rows[0].n;
}

d('PR #39 + PR #40 integration — Bulk Upload Grades combined state (real XLSX → real RPC)', () => {
  let db: PgTestDb;
  const template = buildRosterWorkbook({
    className: CLASS, subjects: [TARBIYA, ARABIC, ENGLISH], blocks: [...ALL_BLOCKS].reverse(), roster: ROSTER,
    termName: 'Term 1', month: 'September', assessmentDate: '2026-09-15',
  });

  beforeAll(async () => {
    db = await createBulkGradesTestDb({ includeStatusGuard: true, includeGradeCorrection: true, includeHalfPoints: true });
    await seed(db);
    await db.setAuthUid(AUTH_A);
  });
  afterAll(async () => { await db?.close(); });

  it('fresh workbook follows the PR #40 contract (flat header, Student Name first, hidden metadata, no formulas)', () => {
    const wb = XLSX.read(template, { type: 'array' });
    expect(wb.SheetNames).toEqual(['Instructions', 'Grades', ROSTER_METADATA_SHEET_NAME]);
    expect(wb.Workbook?.Sheets?.find(s => s.name === ROSTER_METADATA_SHEET_NAME)?.Hidden).toBe(2);
    const rows = gradesRows(template);
    const blockNames = ['HW1', 'HW2', 'HW3', 'HW4', 'CPW1', 'CPW2', 'CPW3', 'CPW4', 'Attendance', 'MT', 'Akhlaaq'];
    expect(rows[0]).toEqual([
      'Student Name',
      ...blockNames.map(b => `ENGLISH ${b}`),
      ...blockNames.map(b => `ARABIC ${b}`),
      ...blockNames.map(b => `TARABIYA ${b}`),
    ]);
    expect(rows).toHaveLength(1 + ROSTER.length);
    expect((rows[1] as unknown[]).slice(1).every(v => v === '' || v == null)).toBe(true);
    const grades = wb.Sheets[GRADES_SHEET_NAME] as Record<string, unknown>;
    expect(grades['!merges']).toBeUndefined();
    expect(grades['!protect']).toBeUndefined();
    expect(Object.values(grades).some(cell => typeof cell === 'object' && cell !== null && 'f' in (cell as object))).toBe(false);
    const instructions = XLSX.utils.sheet_to_json<string[]>(wb.Sheets.Instructions, { header: 1 }).flat().join('\n');
    expect(instructions).toContain('Do NOT sort or reorder the student rows');
  });

  it('half points survive XLSX → parser(UI contract) → resolver → preview (no write) → confirm → exams.score', async () => {
    const filled = fill(template, (rows, col) => {
      rows[1][col('ENGLISH HW1')] = 4.5;
      rows[1][col('ENGLISH HW2')] = 3.5;
      rows[1][col('ENGLISH CPW1')] = 12.5;
      rows[1][col('ENGLISH CPW2')] = 11.5;
      rows[1][col('ARABIC HW1')] = 4.5;
      rows[1][col('ARABIC CPW1')] = 14.5;
      rows[1][col('ARABIC MT')] = 17.5;
      rows[1][col('TARABIYA Akhlaaq')] = 9.5;
      rows[1][col('ENGLISH Attendance')] = 19.5;
    });
    // Numeric cells, not text.
    const sheet = XLSX.read(filled, { type: 'array' }).Sheets[GRADES_SHEET_NAME];
    const c = (gradesRows(filled)[0] as string[]).indexOf('ENGLISH HW1');
    expect(sheet[XLSX.utils.encode_cell({ r: 1, c })]).toMatchObject({ t: 'n', v: 4.5 });

    const parsed = parseRosterWorkbook(filled, UI_OPTIONS);
    expect(parsed.issues.filter(i => i.severity === 'error')).toEqual([]);
    expect(parsed.students[0].studentId).toBe('MBK-7001'); // recovered from hidden metadata
    const resolved = resolveWorkbook(parsed, context());
    expect(resolved.errors).toEqual([]);
    expect(resolved.reviews).toEqual([]);
    expect(resolved.records).toHaveLength(9);

    const before = await count(db);
    const preview = await rpc(db, resolved.records, 'integration-half-000001', false);
    expect(await count(db)).toBe(before); // preview writes nothing
    const previewed = (preview.changes as Array<Record<string, unknown>>).map(x => [x.subject, x.assessmentLabel, x.newScore]).sort();
    expect(previewed).toEqual([
      ['Arabic', 'CPW1', 14.5], ['Arabic', 'HW1', 4.5], ['Arabic', 'MT', 17.5],
      ['English', 'ATTENDANCE', 19.5], ['English', 'CPW1', 12.5], ['English', 'CPW2', 11.5], ['English', 'HW1', 4.5], ['English', 'HW2', 3.5],
      ['Tarbiya', 'AKHLAAQ', 9.5],
    ].sort());

    const committed = await rpc(db, resolved.records, 'integration-half-000001', true);
    expect(committed.insertCount).toBe(9);

    const { rows } = await db.query<{ subjectId: string; assessmentLabel: string; examType: string; score: string; total: number; status: string; teacherId: string; uploadedBy: string; parentId: string | null }>(
      `SELECT "subjectId","assessmentLabel","examType",score::text AS score,total,status,"teacherId","uploadedBy","parentId"
         FROM exams WHERE "studentId"='MBK-7001' ORDER BY "subjectId","assessmentLabel"`,
    );
    expect(rows.map(r => [r.subjectId, r.assessmentLabel, r.examType, r.score, r.total])).toEqual([
      ['ara', 'CPW1', 'Classwork', '14.5', 15],
      ['ara', 'HW1', 'Homework', '4.5', 5],
      ['ara', 'MT', 'Quiz', '17.5', 20],
      ['eng', 'ATTENDANCE', 'Attendance', '19.5', 20],
      ['eng', 'CPW1', 'Classwork', '12.5', 15],
      ['eng', 'CPW2', 'Classwork', '11.5', 15],
      ['eng', 'HW1', 'Homework', '4.5', 5],
      ['eng', 'HW2', 'Homework', '3.5', 5],
      ['tar', 'AKHLAAQ', 'Discipline', '9.5', 10],
    ]);
    expect(rows.every(r => r.status === 'pending' && r.teacherId === 'teacherA' && r.uploadedBy === 'teacherA' && r.parentId === 'parent1')).toBe(true);
  });

  it('idempotency: same key + same payload does not duplicate; same key + different payload is rejected', async () => {
    const parsed = parseRosterWorkbook(fill(template, (rows, col) => { rows[1][col('ENGLISH HW1')] = 4.5; }), UI_OPTIONS);
    const { records } = resolveWorkbook(parsed, context());
    const before = await count(db, `"studentId"='MBK-7001'`);
    const first = await rpc(db, records, 'integration-idem-000001', true);
    const second = await rpc(db, records, 'integration-idem-000001', true);
    expect(second).toEqual(first);
    expect(await count(db, `"studentId"='MBK-7001'`)).toBe(before);
    const other = resolveWorkbook(parseRosterWorkbook(fill(template, (rows, col) => { rows[1][col('ENGLISH HW1')] = 3.5; }), UI_OPTIONS), context()).records;
    expect(await denied(() => rpc(db, other, 'integration-idem-000001', true))).toMatch(/already used/i);
    expect((await scoreText(db, 'MBK-7001', 'eng', 'HW1'))?.score).toBe('4.5');
  });

  it('half-point update 12 → 12.5 on an approved grade requires acknowledgement and lands exactly', async () => {
    await db.setAuthUid(null);
    await db.exec(`UPDATE exams SET score=12, status='approved' WHERE "studentId"='MBK-7001' AND "subjectId"='eng' AND "assessmentLabel"='CPW1'`);
    await db.setAuthUid(AUTH_A);
    const { records } = resolveWorkbook(parseRosterWorkbook(fill(template, (rows, col) => { rows[1][col('ENGLISH CPW1')] = 12.5; }), UI_OPTIONS), context());
    const preview = await rpc(db, records, 'integration-update-00001', false);
    expect(preview.requiresConfirmation).toBe(true);
    expect(preview.requiresApprovedAcknowledgement).toBe(true);
    const change = (preview.changes as Array<Record<string, unknown>>)[0];
    expect([change.existingScore, change.newScore, change.changeType]).toEqual([12, 12.5, 'update']);
    expect((await scoreText(db, 'MBK-7001', 'eng', 'CPW1'))?.score).toBe('12'); // preview did not write
    await rpc(db, records, 'integration-update-00001', true);
    expect(await scoreText(db, 'MBK-7001', 'eng', 'CPW1')).toEqual({ score: '12.5', status: 'pending' });
  });

  it('invalid scores are rejected by the parser AND by the server', async () => {
    // Parser (real XLSX cells)
    const parsed = parseRosterWorkbook(fill(template, (rows, col) => {
      rows[1][col('ENGLISH HW1')] = 4.25;
      rows[1][col('ENGLISH CPW1')] = 12.25;
      rows[1][col('ENGLISH HW2')] = 5.5;
      rows[1][col('ENGLISH CPW2')] = 15.5;
      rows[1][col('ENGLISH MT')] = 20.5;
      rows[1][col('TARABIYA Akhlaaq')] = 10.5;
      rows[2][col('ENGLISH HW1')] = 5; // valid, on the maximum
    }), UI_OPTIONS);
    expect(parsed.issues.filter(i => i.code === 'INVALID_SCORE')).toHaveLength(6);
    expect(parsed.students[1].scores.map(s => s.score)).toEqual([5]);
    // Server (client bypassed) — each is denied, including a tampered total.
    const bad = [
      record({ score: 4.25 }),
      record({ assessmentLabel: 'CPW1', examType: 'Classwork', total: 15, score: 12.25 }),
      record({ score: 5.5 }),
      record({ assessmentLabel: 'CPW1', examType: 'Classwork', total: 15, score: 15.5 }),
      record({ assessmentLabel: 'MT', examType: 'Quiz', total: 20, score: 20.5 }),
      record({ subjectId: 'tar', assessmentLabel: 'AKHLAAQ', examType: 'Discipline', total: 10, score: 10.5 }),
      record({ total: 6, score: 5.5 }),
      record({ assessmentLabel: 'MT', examType: 'Midterm', total: 20, score: 17.5 }),
    ];
    for (const [i, rec] of bad.entries()) {
      expect(await denied(() => rpc(db, [rec], `integration-bad-${String(i).padStart(7, '0')}`, true)), JSON.stringify(rec)).toBeTruthy();
    }
    // Database constraint (RPC bypassed entirely)
    await db.setAuthUid(null);
    const msg = await denied(() => db.exec(`INSERT INTO exams(id,"studentId","subjectId",subject,score,total,"examType","assessmentLabel","termId",month,status,date)
      VALUES ('direct-quarter','MBK-7003','eng','English',4.25,5,'Homework','HW1','term1','September','pending','2026-09-15')`));
    expect(msg).toMatch(/exams_score_entry_state_check/);
    await db.setAuthUid(AUTH_A);
    expect(await count(db, `"studentId"='MBK-7003'`)).toBe(0);
  });

  it('atomicity: valid half-point + valid integer + one invalid score → nothing is written', async () => {
    const batch = [record({ score: 4 }), record({ assessmentLabel: 'HW2', score: 4.5 }), record({ assessmentLabel: 'HW3', score: 5.5 })];
    expect(await denied(() => rpc(db, batch, 'integration-atomic-0001', true))).toMatch(/whole or half/i);
    expect(await count(db, `"studentId"='MBK-7003'`)).toBe(0);
  });

  it('security: client-supplied status/teacherId/uploadedBy/parentId are ignored; foreign subject/class/role are denied', async () => {
    await rpc(db, [record({ status: 'approved', teacherId: 'teacherB', uploadedBy: 'teacherB', parentId: 'parent1' })], 'integration-spoof-00001', true);
    const { rows } = await db.query<{ status: string; teacherId: string; uploadedBy: string; parentId: string | null; score: string }>(
      `SELECT status,"teacherId","uploadedBy","parentId",score::text AS score FROM exams WHERE "studentId"='MBK-7003' AND "assessmentLabel"='HW1'`,
    );
    expect(rows[0]).toEqual({ status: 'pending', teacherId: 'teacherA', uploadedBy: 'teacherA', parentId: null, score: '4.5' });

    // Subject not assigned to teacher A (Math is teacher B's) — even though the alias parses.
    expect(await denied(() => rpc(db, [record({ subjectId: 'math' })], 'integration-sec-math-01', true))).toMatch(/assigned class subjects/i);
    // Student from another class.
    expect(await denied(() => rpc(db, [record({ studentId: 'MBK-8001' })], 'integration-sec-class-1', true))).toBeTruthy();
    // Teacher B (Grade 8-A English) may not touch Grade 7-A English.
    await db.setAuthUid(AUTH_B);
    expect(await denied(() => rpc(db, [record({ studentId: 'MBK-7001' })], 'integration-sec-class-2', true))).toBeTruthy();
    // Parent / anonymous are denied even for a preview.
    await db.setAuthUid(AUTH_PARENT);
    expect(await denied(() => rpc(db, [record()], 'integration-sec-role-01', false))).toBeTruthy();
    await db.setAuthUid(null);
    expect(await denied(() => rpc(db, [record()], 'integration-sec-role-02', false))).toBeTruthy();
    await db.setAuthUid(AUTH_A);
    expect(await count(db, `"subjectId"='math' OR "studentId"='MBK-8001'`)).toBe(0);
  });

  it('header contract: reorder is header-bound; deleted / duplicate / unknown / unauthorized-alias columns are explicit errors', () => {
    const values: Record<string, number> = { HW1: 1, HW2: 2, HW3: 3, HW4: 4, CPW1: 10, CPW2: 11, CPW3: 12, CPW4: 13, Attendance: 14, MT: 15, Akhlaaq: 9.5 };
    const labelOf: Record<string, string> = { Attendance: 'ATTENDANCE', Akhlaaq: 'AKHLAAQ' };
    const filled = fill(template, (rows, col) => { for (const [b, v] of Object.entries(values)) rows[1][col(`ENGLISH ${b}`)] = v; });

    // Reorder: swap HW1/HW2 and move Akhlaaq to column B.
    const reordered = fill(filled, (rows, col) => {
      const i1 = col('ENGLISH HW1'), i2 = col('ENGLISH HW2'), ia = col('ENGLISH Akhlaaq');
      for (const r of rows) { const t = r[i1]; r[i1] = r[i2]; r[i2] = t; const a = r.splice(ia, 1)[0]; r.splice(1, 0, a); }
    });
    expect(gradesRows(reordered)[0].slice(0, 4)).toEqual(['Student Name', 'ENGLISH Akhlaaq', 'ENGLISH HW2', 'ENGLISH HW1']);
    const p1 = parseRosterWorkbook(reordered, UI_OPTIONS);
    expect(p1.issues.filter(i => i.severity === 'error')).toEqual([]);
    for (const [b, v] of Object.entries(values)) {
      expect(p1.students[0].scores.find(s => s.subjectName === 'English' && s.assessmentLabel === (labelOf[b] ?? b))?.score, b).toBe(v);
    }

    // Delete ENGLISH CPW3 → explicit MISSING_EXPECTED_COLUMN; remaining values stay on their headers.
    const deleted = fill(filled, (rows, col) => { const i = col('ENGLISH CPW3'); for (const r of rows) r.splice(i, 1); });
    const p2 = parseRosterWorkbook(deleted, UI_OPTIONS);
    expect(p2.issues.filter(i => i.code === 'MISSING_EXPECTED_COLUMN').map(i => i.message)).toEqual([expect.stringContaining('"ENGLISH CPW3"')]);
    expect(p2.students[0].scores.find(s => s.assessmentLabel === 'CPW4')?.score).toBe(13);

    // Duplicate header, unknown assessment, unknown subject, alias of an unauthorized subject.
    const tampered = fill(filled, (rows) => {
      rows[0].push('ENGLISH HW1', 'ENGLISH TEST99', 'RandomSubject HW1', 'Mathematics HW1', 'Maths HW1');
      rows[1].push(1, 1, 1, 4.5, 4.5);
    });
    const p3 = parseRosterWorkbook(tampered, UI_OPTIONS);
    const codes = (code: string) => p3.issues.filter(i => i.code === code).map(i => i.message);
    expect(codes('DUPLICATE_COLUMN')).toEqual([expect.stringContaining('"ENGLISH HW1"'), expect.stringContaining('"Maths HW1"')]);
    expect(codes('UNKNOWN_COLUMN')).toEqual([expect.stringContaining('"ENGLISH TEST99"')]);
    expect(codes('UNEXPECTED_COLUMN')).toEqual([expect.stringContaining('"RandomSubject HW1"'), expect.stringContaining('"Mathematics HW1"')]);
    expect(codes('MISSING_EXPECTED_COLUMN')).toEqual([]);
    expect(p3.students[0].scores.filter(s => s.assessmentLabel === 'HW1' && s.subjectName === 'English').map(s => s.score)).toEqual([1]);

    // Resolver: the Math alias is unauthorized for teacher A regardless of spelling.
    const resolved = resolveWorkbook(parseRosterWorkbook(fill(filled, (rows) => { rows[0].push('Mathematics HW1'); rows[1].push(4.5); })), context());
    expect(resolved.unauthorizedSubjects).toEqual(['Math']);
    expect(resolved.errors.some(e => /not authorized to upload "Math"/.test(e.message))).toBe(true);
  });

  it('alias-named DB subjects (Mathematics) pass the UI contract for the teacher who IS assigned them', () => {
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([['Student ID', 'Student Name', 'Mathematics HW1', 'Mathematics CPW1'], ['MBK-7001', 'Axmed Cabdi', 4.5, 12.5]]), GRADES_SHEET_NAME);
    const bytes = XLSX.write(wb, { bookType: 'xlsx', type: 'array' }) as ArrayBuffer;
    const parsed = parseRosterWorkbook(bytes, { expectedSubjects: ['Mathematics'], expectedBlocks: ['HW1', 'CPW1'] });
    expect(parsed.issues.filter(i => i.severity === 'error')).toEqual([]);
    const resolved = resolveWorkbook(parsed, context({ authorizedSubjects: [MATHEMATICS] }));
    expect(resolved.errors).toEqual([]);
    expect(resolved.records.map(r => [r.subjectId, r.assessmentLabel, r.score])).toEqual([['math', 'HW1', 4.5], ['math', 'CPW1', 12.5]]);
  });

  it('identity: blank identity never assigns silently; exact and same-name matches go to Needs Review; duplicates are caught after identity', () => {
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([
      ['Student Name', 'ENGLISH HW1', 'ENGLISH HW2', 'ARABIC HW1', 'ARABIC HW2'],
      ['Axmed Cabdi', 4.5, 3.5, 2.5, null],
      ['Hodan Warsame', 3, null, null, null],
      ['Hodan Warsame', 2, null, null, null],
      ['Axmed Cabdi Hassan', 1, null, null, null],
      ['Nobody Real', 5, null, null, null],
    ]), GRADES_SHEET_NAME);
    const parsed = parseRosterWorkbook(XLSX.write(wb, { bookType: 'xlsx', type: 'array' }) as ArrayBuffer, { expectedSubjects: ['English', 'Arabic'], expectedBlocks: ['HW1', 'HW2'] });
    expect(parsed.issues.filter(i => i.severity === 'error')).toEqual([]);
    expect(parsed.issues.filter(i => i.code === 'DUPLICATE_STUDENT_ROW')).toEqual([]); // blank IDs are not duplicates
    expect(parsed.students.map(s => s.studentId)).toEqual([null, null, null, null, null]);

    const first = resolveWorkbook(parsed, context());
    expect(first.records).toEqual([]); // nothing is auto-assigned
    const candidates = Object.fromEntries(first.reviews.map(r => [r.rowNumber, r.candidates.map(c => c.id).sort()]));
    expect(candidates).toEqual({ 2: ['MBK-7001'], 3: ['MBK-7003', 'MBK-7004'], 4: ['MBK-7003', 'MBK-7004'], 5: ['MBK-7002'] });
    expect(first.errors.map(e => e.rowNumber)).toEqual([6]); // "Nobody Real" is a hard error

    // Both Hodan rows pointed at the same student → duplicate HW1 after identity resolution.
    const clash = resolveWorkbook(parsed, context({ decisions: {
      2: { action: 'use', studentId: 'MBK-7001' }, 3: { action: 'use', studentId: 'MBK-7003' }, 4: { action: 'use', studentId: 'MBK-7003' },
      5: { action: 'use', studentId: 'MBK-7002' }, 6: { action: 'exclude' },
    } }));
    expect(clash.errors.filter(e => /Duplicate HW1/.test(e.message)).map(e => e.studentId)).toEqual(['MBK-7003']);

    // Correct decisions → clean; same student across HW1/HW2 and English/Arabic is NOT a duplicate.
    const clean = resolveWorkbook(parsed, context({ decisions: {
      2: { action: 'use', studentId: 'MBK-7001' }, 3: { action: 'use', studentId: 'MBK-7003' }, 4: { action: 'use', studentId: 'MBK-7004' },
      5: { action: 'use', studentId: 'MBK-7002' }, 6: { action: 'exclude' },
    } }));
    expect(clean.errors).toEqual([]);
    expect(clean.reviews).toEqual([]);
    expect(clean.records.map(r => [r.studentId, r.subjectId, r.assessmentLabel, r.score])).toEqual([
      ['MBK-7001', 'eng', 'HW1', 4.5], ['MBK-7001', 'eng', 'HW2', 3.5], ['MBK-7001', 'ara', 'HW1', 2.5],
      ['MBK-7003', 'eng', 'HW1', 3], ['MBK-7004', 'eng', 'HW1', 2], ['MBK-7002', 'eng', 'HW1', 1],
    ]);
  });

  it('identity: reordered template rows with unique names fall back to Needs Review instead of trusting hidden metadata', () => {
    const sorted = fill(template, (rows) => {
      const [header, r1, r2, r3, r4] = rows;
      rows.length = 0;
      rows.push(header, r4, r3, r2, r1);
      rows[1][1] = 1; rows[2][1] = 2; rows[3][1] = 3; rows[4][1] = 4;
    });
    const parsed = parseRosterWorkbook(sorted, UI_OPTIONS);
    expect(parsed.students.map(s => s.studentId)).toEqual([null, null, null, null]);
    const resolved = resolveWorkbook(parsed, context());
    expect(resolved.records).toEqual([]);
    expect(resolved.reviews.map(r => r.rowNumber)).toEqual([2, 3, 4, 5]);
  });

  it('assessment contract is the shared ASSESSMENT_BLOCKS table (HW/5, CPW/15, Attendance/20, MT→Quiz/20, Akhlaaq→Discipline/10)', () => {
    expect(ASSESSMENT_BLOCKS.map(b => [b.label, b.examType, b.total])).toEqual([
      ['HW1', 'Homework', 5], ['HW2', 'Homework', 5], ['HW3', 'Homework', 5], ['HW4', 'Homework', 5],
      ['CPW1', 'Classwork', 15], ['CPW2', 'Classwork', 15], ['CPW3', 'Classwork', 15], ['CPW4', 'Classwork', 15],
      ['ATTENDANCE', 'Attendance', 20], ['MT', 'Quiz', 20], ['AKHLAAQ', 'Discipline', 10],
    ]);
  });
});
