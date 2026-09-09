// BEHAVIORAL direct-table RLS tests for the exams security boundary.
//
// Runs as a real, non-owner `authenticated` role with RLS enforced, using the
// ACTUAL shipped exam policies (20260802) and the ACTUAL status-guard trigger
// (20260909). Proves the direct-table boundary that PostgREST exposes — the gap
// that the SECURITY DEFINER RPC tests could not cover.
//
// Skips loudly if PGlite is unavailable (then this boundary is NOT VERIFIED).

import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import { createExamRlsTestDb, pgliteAvailable, type RlsTestDb } from './rlsHarness';

const AVAILABLE = await pgliteAvailable();
const d = AVAILABLE ? describe : describe.skip;

const AUTH_A = '11111111-1111-1111-1111-111111111111';
const AUTH_B = '22222222-2222-2222-2222-222222222222';
const AUTH_ADMIN = '33333333-3333-3333-3333-333333333333';

async function seed(db: RlsTestDb) {
  await db.asOwner();
  await db.exec(`
    INSERT INTO profiles(id,name,email,role,auth_id) VALUES
      ('teacherA','Teacher A','a@x.com','teacher','${AUTH_A}'),
      ('teacherB','Teacher B','b@x.com','teacher','${AUTH_B}'),
      ('adminU','Admin','admin@x.com','admin','${AUTH_ADMIN}');
    INSERT INTO subjects(id,name) VALUES ('arabic','Arabic'),('math','Mathematics');
    INSERT INTO students(id,name,"className") VALUES
      ('sA','Ahmed','Grade 5-A'),('sB','Bilal','Grade 5-B');
    INSERT INTO class_subjects(id,"className","subjectId","teacherId") VALUES
      ('cs1','Grade 5-A','arabic','teacherA'),
      ('cs2','Grade 5-B','arabic','teacherB');
    -- A pending grade owned by Teacher A (for update tests).
    INSERT INTO exams(id,"studentId","subjectId",subject,score,total,"examType","assessmentLabel","entryState",month,status,date,"teacherId")
      VALUES ('exA','sA','arabic','Arabic',12,20,'Quiz','MT','scored','May','pending','2026-05-10','teacherA');
    -- A pending grade owned by Teacher B (Teacher A must never touch it).
    INSERT INTO exams(id,"studentId","subjectId",subject,score,total,"examType","assessmentLabel","entryState",month,status,date,"teacherId")
      VALUES ('exB','sB','arabic','Arabic',10,20,'Quiz','MT','scored','May','pending','2026-05-10','teacherB');
  `);
}

const baseRow = (over: Record<string, unknown> = {}) => ({
  id: 'exNew', studentId: 'sA', subjectId: 'arabic', subject: 'Arabic', score: 5, total: 5,
  examType: 'Homework', assessmentLabel: 'HW1', entryState: 'scored', month: 'May',
  status: 'pending', date: '2026-05-10', teacherId: 'teacherA', ...over,
});

async function insert(db: RlsTestDb, r: Record<string, unknown>) {
  return db.query(
    `INSERT INTO exams(id,"studentId","subjectId",subject,score,total,"examType","assessmentLabel","entryState",month,status,date,"teacherId")
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
    [r.id, r.studentId, r.subjectId, r.subject, r.score, r.total, r.examType, r.assessmentLabel, r.entryState, r.month, r.status, r.date, r.teacherId],
  );
}

async function expectDenied(fn: () => Promise<unknown>): Promise<string> {
  try { await fn(); } catch (e) { return e instanceof Error ? e.message : String(e); }
  throw new Error('Expected RLS to DENY, but the statement succeeded.');
}

// --- The vulnerability, demonstrated WITHOUT the guard ----------------------
d('exams RLS — status self-approval vulnerability (guard OFF, demonstrates the hole)', () => {
  let db: RlsTestDb;
  beforeAll(async () => { db = await createExamRlsTestDb({ includeStatusGuard: false }); await seed(db); });
  afterAll(async () => { await db?.close(); });

  it('WITHOUT the guard, a teacher CAN directly insert an approved grade (this is the bug)', async () => {
    await db.asAuthenticated(AUTH_A);
    await insert(db, baseRow({ id: 'exSelfApprove', status: 'approved' }));
    await db.asOwner();
    const { rows } = await db.query<{ status: string }>(`SELECT status FROM exams WHERE id='exSelfApprove'`);
    expect(rows[0].status).toBe('approved'); // demonstrates the pre-fix hole
  });
});

// --- The fix, and the full direct-table boundary, with the guard ON ---------
d('exams RLS + status guard (guard ON, real authenticated role)', () => {
  let db: RlsTestDb;
  beforeAll(async () => { db = await createExamRlsTestDb({ includeStatusGuard: true }); await seed(db); });
  afterAll(async () => { await db?.close(); });

  it('FIX: teacher inserting status=approved is forced back to pending', async () => {
    await db.asAuthenticated(AUTH_A);
    await insert(db, baseRow({ id: 'exFixIns', status: 'approved' }));
    await db.asOwner();
    const { rows } = await db.query<{ status: string }>(`SELECT status FROM exams WHERE id='exFixIns'`);
    expect(rows[0].status).toBe('pending');
  });

  it('FIX: teacher updating their own pending grade to approved is forced back to pending', async () => {
    await db.asAuthenticated(AUTH_A);
    await db.query(`UPDATE exams SET status='approved', score=19 WHERE id='exA'`);
    await db.asOwner();
    const { rows } = await db.query<{ status: string; score: number }>(`SELECT status,score FROM exams WHERE id='exA'`);
    expect(rows[0].status).toBe('pending'); // status coerced
    expect(rows[0].score).toBe(19);         // legitimate score edit preserved
  });

  it('legitimate: teacher can still insert their own pending grade', async () => {
    await db.asAuthenticated(AUTH_A);
    await insert(db, baseRow({ id: 'exLegit', assessmentLabel: 'HW2' }));
    await db.asOwner();
    const { rows } = await db.query<{ status: string }>(`SELECT status FROM exams WHERE id='exLegit'`);
    expect(rows[0].status).toBe('pending');
  });

  it('admin approval path still works (status guard does not touch admins)', async () => {
    await db.asAuthenticated(AUTH_ADMIN);
    await db.query(`UPDATE exams SET status='approved' WHERE id='exA'`);
    await db.asOwner();
    const { rows } = await db.query<{ status: string }>(`SELECT status FROM exams WHERE id='exA'`);
    expect(rows[0].status).toBe('approved');
  });

  it('DENIED by RLS: teacher A cannot INSERT a grade for Teacher B\'s class', async () => {
    await db.asAuthenticated(AUTH_A);
    const msg = await expectDenied(() => insert(db, baseRow({ id: 'exX1', studentId: 'sB', teacherId: 'teacherA' })));
    expect(msg.toLowerCase()).toContain('row-level security');
  });

  it('DENIED by RLS: teacher A cannot INSERT for an unauthorized subject', async () => {
    await db.asAuthenticated(AUTH_A);
    const msg = await expectDenied(() => insert(db, baseRow({ id: 'exX2', subjectId: 'math', total: 20, examType: 'Quiz', assessmentLabel: 'MT' })));
    expect(msg.toLowerCase()).toContain('row-level security');
  });

  it('DENIED by RLS: teacher A cannot INSERT a row claiming teacherId = Teacher B', async () => {
    await db.asAuthenticated(AUTH_A);
    const msg = await expectDenied(() => insert(db, baseRow({ id: 'exX3', teacherId: 'teacherB' })));
    expect(msg.toLowerCase()).toContain('row-level security');
  });

  it('DENIED by RLS: teacher A cannot UPDATE Teacher B\'s grade at all', async () => {
    await db.asAuthenticated(AUTH_A);
    // RLS USING clause hides exB from A, so the UPDATE matches zero rows.
    const res = await db.query<{ id: string }>(`UPDATE exams SET score=1 WHERE id='exB' RETURNING id`);
    expect(res.rows.length).toBe(0);
    await db.asOwner();
    const { rows } = await db.query<{ score: number }>(`SELECT score FROM exams WHERE id='exB'`);
    expect(rows[0].score).toBe(10); // untouched
  });

  it('DENIED by RLS: teacher A cannot re-assign their own row to Teacher B (WITH CHECK)', async () => {
    await db.asAuthenticated(AUTH_A);
    const msg = await expectDenied(() => db.query(`UPDATE exams SET "teacherId"='teacherB' WHERE id='exLegit'`));
    expect(msg.toLowerCase()).toContain('row-level security');
  });

  it('DENIED by RLS: teacher A cannot move their row to an unauthorized student (WITH CHECK)', async () => {
    await db.asAuthenticated(AUTH_A);
    const msg = await expectDenied(() => db.query(`UPDATE exams SET "studentId"='sB' WHERE id='exLegit'`));
    expect(msg.toLowerCase()).toContain('row-level security');
  });

  it('teacher A cannot even SELECT Teacher B\'s rows (read isolation)', async () => {
    await db.asAuthenticated(AUTH_A);
    const { rows } = await db.query<{ id: string }>(`SELECT id FROM exams WHERE "teacherId"='teacherB'`);
    expect(rows.length).toBe(0);
  });
});

if (!AVAILABLE) {
  describe('exams RLS boundary', () => {
    it.skip('SKIPPED: @electric-sql/pglite not installed — direct-table RLS boundary is NOT VERIFIED', () => {});
  });
}
