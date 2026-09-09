// BEHAVIORAL PostgreSQL tests for half-point grade scores (executed via PGlite).
//
// These EXECUTE the ACTUAL shipped 20260911 migration — the NUMERIC score
// column, its whole/half-step CHECK, and the redefined submit_bulk_grades /
// admin_correct_grade RPCs — against a real Postgres engine and assert actual
// stored values. If PGlite is unavailable the suite marks itself SKIPPED.

import { beforeAll, afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createBulkGradesTestDb, pgliteAvailable, type PgTestDb } from './pgHarness';

const AVAILABLE = await pgliteAvailable();
const d = AVAILABLE ? describe : describe.skip;

const AUTH_A = '11111111-1111-1111-1111-111111111111';
const AUTH_ADMIN = '33333333-3333-3333-3333-333333333333';

async function seed(db: PgTestDb) {
  await db.exec(`
    INSERT INTO auth.users(id) VALUES ('${AUTH_A}'), ('${AUTH_ADMIN}');
    INSERT INTO profiles(id,name,email,role,auth_id) VALUES
      ('teacherA','Teacher A','a@x.com','teacher','${AUTH_A}'),
      ('adminU','Admin','admin@x.com','admin','${AUTH_ADMIN}');
    INSERT INTO subjects(id,name) VALUES ('arabic','Arabic');
    INSERT INTO students(id,name,"className","parentId") VALUES
      ('studentA','Ahmed Ali','Grade 5-A',NULL);
    INSERT INTO class_subjects(id,"className","subjectId","teacherId") VALUES
      ('cs1','Grade 5-A','arabic','teacherA');
    INSERT INTO academic_years(id,name) VALUES ('ay1','2026');
    INSERT INTO terms(id,name,"academicYearId","startDate","endDate","isCurrent",months) VALUES
      ('term1','Term 1','ay1','2026-01-01','2026-12-31',true,ARRAY['May']);
  `);
}

function hwRecord(overrides: Record<string, unknown> = {}) {
  return JSON.stringify([{
    studentId: 'studentA', subjectId: 'arabic', assessmentLabel: 'HW1',
    examType: 'Homework', score: 4.5, total: 5, entryState: 'scored',
    month: 'May', date: '2026-05-10', termId: 'term1', ...overrides,
  }]);
}

async function submit(db: PgTestDb, records: string, key: string, confirm: boolean) {
  const { rows } = await db.query<{ result: unknown }>(
    'SELECT public.submit_bulk_grades($1::jsonb, $2, $3) AS result',
    [records, key, confirm],
  );
  return rows[0].result as Record<string, unknown>;
}

async function expectDenied(fn: () => Promise<unknown>): Promise<string> {
  try { await fn(); } catch (e) { return e instanceof Error ? e.message : String(e); }
  throw new Error('Expected the RPC to DENY, but it succeeded.');
}

d('half-point scores — behavioral (real PostgreSQL via PGlite)', () => {
  let db: PgTestDb;
  beforeAll(async () => {
    db = await createBulkGradesTestDb({ includeGradeCorrection: true, includeHalfPoints: true });
    await seed(db);
  });
  afterAll(async () => { await db?.close(); });
  beforeEach(async () => {
    // Reset to an unauthenticated context first: the append-only audit trigger
    // blocks DELETE while auth.uid() is set, so cleanup must run as "no JWT".
    await db.setAuthUid(null);
    await db.exec(`DELETE FROM exams; DELETE FROM grade_correction_audit; DELETE FROM grade_uploads;`);
  });

  it('submit_bulk_grades stores a 4.5 homework score faithfully (not rounded)', async () => {
    await db.setAuthUid(AUTH_A);
    const res = await submit(db, hwRecord({ score: 4.5 }), 'half-key-000001', true);
    expect(res.insertCount).toBe(1);
    const { rows } = await db.query<{ score: string }>(
      `SELECT score FROM exams WHERE "studentId"='studentA' AND "assessmentLabel"='HW1'`,
    );
    expect(Number(rows[0].score)).toBe(4.5);
  });

  it('submit_bulk_grades accepts a whole number too (4)', async () => {
    await db.setAuthUid(AUTH_A);
    await submit(db, hwRecord({ score: 4 }), 'half-key-000002', true);
    const { rows } = await db.query<{ score: string }>(
      `SELECT score FROM exams WHERE "studentId"='studentA' AND "assessmentLabel"='HW1'`,
    );
    expect(Number(rows[0].score)).toBe(4);
  });

  it('submit_bulk_grades rejects a quarter point (4.25)', async () => {
    await db.setAuthUid(AUTH_A);
    const msg = await expectDenied(() => submit(db, hwRecord({ score: 4.25 }), 'half-key-000003', true));
    expect(msg.toLowerCase()).toContain('whole or half');
  });

  it('submit_bulk_grades rejects a half point that exceeds the maximum (5.5 > 5)', async () => {
    await db.setAuthUid(AUTH_A);
    const msg = await expectDenied(() => submit(db, hwRecord({ score: 5.5 }), 'half-key-000004', true));
    expect(msg.toLowerCase()).toContain('invalid');
  });

  it('the DB CHECK itself rejects a direct quarter-point insert', async () => {
    const msg = await expectDenied(() => db.query(
      `INSERT INTO exams(id,"studentId",subject,score,total,"examType","entryState",month,status,date,"teacherId")
       VALUES('x1','studentA','Arabic',4.25,5,'Homework','scored','May','pending','2026-05-10','teacherA')`,
    ));
    expect(msg.length).toBeGreaterThan(0);
  });

  it('admin_correct_grade corrects a whole score to a half point (4 -> 4.5)', async () => {
    // Seed an approved HW1 = 4 via the bulk RPC, then correct it.
    await db.setAuthUid(AUTH_A);
    await submit(db, hwRecord({ score: 4 }), 'half-key-000005', true);
    const { rows: ex } = await db.query<{ id: string }>(
      `SELECT id FROM exams WHERE "studentId"='studentA' AND "assessmentLabel"='HW1'`,
    );
    const examId = ex[0].id;
    await db.query(`UPDATE exams SET status='approved' WHERE id=$1`, [examId]);

    await db.setAuthUid(AUTH_ADMIN);
    const { rows } = await db.query<{ result: Record<string, unknown> }>(
      'SELECT public.admin_correct_grade($1,$2,$3,$4,$5,$6) AS result',
      [examId, 4, 4.5, 'Partial credit awarded on review', 'scored', 'scored'],
    );
    expect(Number(rows[0].result.oldScore)).toBe(4);
    expect(Number(rows[0].result.newScore)).toBe(4.5);
    const { rows: after } = await db.query<{ score: string; status: string }>(
      `SELECT score, status FROM exams WHERE id=$1`, [examId],
    );
    expect(Number(after[0].score)).toBe(4.5);
    expect(after[0].status).toBe('pending');
    // The audit records the half-point before/after faithfully.
    const { rows: audit } = await db.query<{ old_score: string; new_score: string }>(
      `SELECT old_score, new_score FROM grade_correction_audit WHERE exam_id=$1`, [examId],
    );
    expect(Number(audit[0].old_score)).toBe(4);
    expect(Number(audit[0].new_score)).toBe(4.5);
  });

  it('admin_correct_grade rejects a quarter-point correction (4 -> 4.25)', async () => {
    await db.setAuthUid(AUTH_A);
    await submit(db, hwRecord({ score: 4 }), 'half-key-000006', true);
    const { rows: ex } = await db.query<{ id: string }>(
      `SELECT id FROM exams WHERE "studentId"='studentA' AND "assessmentLabel"='HW1'`,
    );
    await db.setAuthUid(AUTH_ADMIN);
    const msg = await expectDenied(() => db.query(
      'SELECT public.admin_correct_grade($1,$2,$3,$4,$5,$6)',
      [ex[0].id, 4, 4.25, 'attempted quarter point', 'scored', 'scored'],
    ));
    expect(msg.toLowerCase()).toContain('whole or half');
  });
});
