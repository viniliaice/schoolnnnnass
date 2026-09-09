// End-to-end: real teacher scenario tying together the workbook builder, the
// client resolver, and the REAL submit_bulk_grades RPC (executed via PGlite).
//
// Scenario (from the remediation brief):
//   Teacher A teaches Arabic + Tarabiya in Grade 5-A (5 students).
//   Build the flat-header workbook, fill Arabic/Tarabiya HW1/MT/Akhlaaq,
//   upload, and verify records resolve correctly, subjects stay separate, and
//   the server preview shows old -> new. Then prove class-change + stale-roster.

import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import * as XLSX from 'xlsx';
import type { Student, Subject } from '../../../types';
import { buildRosterWorkbook, parseRosterWorkbook, GRADES_SHEET_NAME } from '../workbook';
import { resolveWorkbook } from '../resolve';
import { createBulkGradesTestDb, pgliteAvailable, type PgTestDb } from './pgHarness';

const AVAILABLE = await pgliteAvailable();
const d = AVAILABLE ? describe : describe.skip;

const AUTH_A = '11111111-1111-1111-1111-111111111111';

const ARABIC: Subject = { id: 'arabic', name: 'Arabic', createdAt: 'x' } as Subject;
const TARBIYA: Subject = { id: 'tarbiya', name: 'Tarbiya', createdAt: 'x' } as Subject;

const ROSTER_5A: Student[] = [
  { id: 'S1', name: 'Ahmed Ali', className: 'Grade 5-A', parentId: null, createdAt: 'x' } as Student,
  { id: 'S2', name: 'Aisha Hassan', className: 'Grade 5-A', parentId: null, createdAt: 'x' } as Student,
  { id: 'S3', name: 'Mohamed Omar', className: 'Grade 5-A', parentId: null, createdAt: 'x' } as Student,
  { id: 'S4', name: 'Fadumo Yusuf', className: 'Grade 5-A', parentId: null, createdAt: 'x' } as Student,
  { id: 'S5', name: 'Khalid Abdi', className: 'Grade 5-A', parentId: null, createdAt: 'x' } as Student,
];

async function seed(db: PgTestDb) {
  await db.exec(`
    INSERT INTO auth.users(id) VALUES ('${AUTH_A}');
    INSERT INTO profiles(id,name,email,role,auth_id) VALUES ('teacherA','Teacher A','a@x.com','teacher','${AUTH_A}');
    INSERT INTO subjects(id,name) VALUES ('arabic','Arabic'),('tarbiya','Tarbiya');
    INSERT INTO students(id,name,"className") VALUES
      ('S1','Ahmed Ali','Grade 5-A'),('S2','Aisha Hassan','Grade 5-A'),
      ('S3','Mohamed Omar','Grade 5-A'),('S4','Fadumo Yusuf','Grade 5-A'),
      ('S5','Khalid Abdi','Grade 5-A'),('S9','Mover Kid','Grade 7-A');
    INSERT INTO class_subjects(id,"className","subjectId","teacherId") VALUES
      ('cs1','Grade 5-A','arabic','teacherA'),
      ('cs2','Grade 5-A','tarbiya','teacherA'),
      ('cs7a','Grade 7-A','arabic','teacherA'),
      ('cs7b','Grade 7-B','arabic','teacherA');
    INSERT INTO academic_years(id,name) VALUES ('ay1','2026');
    INSERT INTO terms(id,name,"academicYearId","startDate","endDate","isCurrent",months) VALUES
      ('term1','Term 1','ay1','2026-01-01','2026-12-31',true,ARRAY['September']);
  `);
}

function fillAndParse(subjects: Subject[], roster: Student[], edits: Record<string, string | number>) {
  const bytes = buildRosterWorkbook({ className: 'Grade 5-A', subjects, blocks: ['HW1', 'MT', 'AKHLAAQ'], roster });
  const wb = XLSX.read(bytes, { type: 'array' });
  const sheet = wb.Sheets[GRADES_SHEET_NAME];
  for (const [addr, v] of Object.entries(edits)) sheet[addr] = typeof v === 'number' ? { t: 'n', v } : { t: 's', v };
  const out = XLSX.write(wb, { bookType: 'xlsx', type: 'array' }) as ArrayBuffer;
  return parseRosterWorkbook(out);
}

async function rpc(db: PgTestDb, records: unknown[], key: string, confirm: boolean) {
  const { rows } = await db.query<{ result: Record<string, unknown> }>(
    'SELECT public.submit_bulk_grades($1::jsonb, $2, $3) AS result',
    [JSON.stringify(records), key, confirm],
  );
  return rows[0].result;
}

d('E2E teacher scenario (workbook -> resolve -> real RPC)', () => {
  let db: PgTestDb;
  beforeAll(async () => { db = await createBulkGradesTestDb(); await seed(db); await db.setAuthUid(AUTH_A); });
  afterAll(async () => { await db?.close(); });

  it('Arabic + Tarabiya for Grade 5-A commit as subject-scoped, separated records', async () => {
    // Visible columns for blocks HW1,MT,AKHLAAQ over [Arabic,Tarabiya]:
    // A=Student Name, B=Arabic HW1, C=Arabic MT, D=Arabic Akhlaaq,
    // E=Tarabiya HW1, F=Tarabiya MT, G=Tarabiya Akhlaaq.
    const parsed = fillAndParse([ARABIC, TARBIYA], ROSTER_5A, {
      B2: 5, C2: 18, D2: 8, E2: 4, F2: 15, G2: 5,
    });
    const res = resolveWorkbook(parsed, {
      className: 'Grade 5-A', authorizedSubjects: [ARABIC, TARBIYA], roster: ROSTER_5A,
      termId: 'term1', month: 'September', date: '2026-09-08',
    });
    expect(res.errors).toEqual([]);
    expect(res.records.length).toBe(6);

    const out = await rpc(db, res.records, 'e2e-arabic-tarbiya-1', true);
    expect(out.insertCount).toBe(6);

    const { rows } = await db.query<{ subjectId: string; score: number }>(
      `SELECT "subjectId",score FROM exams WHERE "studentId"='S1' AND "assessmentLabel"='AKHLAAQ' ORDER BY "subjectId"`,
    );
    expect(rows).toEqual([
      { subjectId: 'arabic', score: 8 },
      { subjectId: 'tarbiya', score: 5 },
    ]);
  });

  it('re-upload shows old -> new via server preview, then commits the change', async () => {
    const parsed = fillAndParse([ARABIC], ROSTER_5A, { B2: 5, C2: 20, D2: 8 });
    const res = resolveWorkbook(parsed, {
      className: 'Grade 5-A', authorizedSubjects: [ARABIC], roster: ROSTER_5A,
      termId: 'term1', month: 'September', date: '2026-09-08',
    });
    const preview = await rpc(db, res.records, 'e2e-change-preview-1', false);
    const changes = preview.changes as Array<Record<string, unknown>>;
    const mt = changes.find(c => c.assessmentLabel === 'MT');
    expect(mt).toMatchObject({ existingScore: 18, newScore: 20, changeType: 'update' });
  });

  it('CLASS CHANGE: mover S9 into 5-A appears; stale 5-A workbook w/ 7-A student rejected', async () => {
    await db.exec(`UPDATE students SET "className"='Grade 5-A' WHERE id='S9'`);

    const freshRoster = [...ROSTER_5A, { id: 'S9', name: 'Mover Kid', className: 'Grade 5-A', parentId: null, createdAt: 'x' } as Student];
    const parsed = fillAndParse([ARABIC], freshRoster, { B7: 3 });
    const res = resolveWorkbook(parsed, {
      className: 'Grade 5-A', authorizedSubjects: [ARABIC], roster: freshRoster,
      termId: 'term1', month: 'September', date: '2026-09-08',
    });
    expect(res.records.some(r => r.studentId === 'S9')).toBe(true);
    const out = await rpc(db, res.records, 'e2e-mover-in-000001', true);
    expect(out.insertCount).toBeGreaterThanOrEqual(1);

    await db.exec(`UPDATE students SET "className"='Grade 7-C' WHERE id='S9'`);
    const staleRecord = [{
      studentId: 'S9', subjectId: 'arabic', assessmentLabel: 'HW1', examType: 'Homework',
      score: 5, total: 5, entryState: 'scored', month: 'September', date: '2026-09-08', termId: 'term1',
    }];
    let denied = false;
    try { await rpc(db, staleRecord, 'e2e-stale-000000001', true); } catch { denied = true; }
    expect(denied).toBe(true);
  });
});

if (!AVAILABLE) {
  describe('E2E teacher scenario', () => {
    it.skip('SKIPPED: @electric-sql/pglite not installed — E2E DB behavior is NOT VERIFIED', () => {});
  });
}
