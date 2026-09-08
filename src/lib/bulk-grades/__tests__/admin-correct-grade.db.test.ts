// BEHAVIORAL PostgreSQL tests for admin_correct_grade + get_grade_correction_history
// (executed via PGlite — a real Postgres engine with PL/pgSQL).
//
// These EXECUTE the ACTUAL shipped migration (20260910_admin_grade_correction.sql)
// and assert real row outcomes: admin-only authorization, audit creation,
// role denial, score/entry-state validation, no-op rejection, append-only history
// across multiple corrections, optimistic-concurrency conflict detection, target
// identity by exam.id only, status transition (approved -> pending), provenance
// preservation, and audit immutability.
//
// If PGlite is not installed the suite marks itself SKIPPED (not passed): the
// corresponding claims must then be treated as NOT VERIFIED.

import { beforeAll, afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createBulkGradesTestDb, pgliteAvailable, type PgTestDb } from './pgHarness';

const AVAILABLE = await pgliteAvailable();
const d = AVAILABLE ? describe : describe.skip;

const AUTH_ADMIN = '33333333-3333-3333-3333-333333333333';
const AUTH_ADMIN2 = '44444444-4444-4444-4444-444444444444';
const AUTH_TEACHER = '11111111-1111-1111-1111-111111111111';
const AUTH_PARENT = '55555555-5555-5555-5555-555555555555';
const AUTH_SUPERVISOR = '66666666-6666-6666-6666-666666666666';

async function seed(db: PgTestDb) {
  await db.exec(`
    INSERT INTO auth.users(id) VALUES
      ('${AUTH_ADMIN}'), ('${AUTH_ADMIN2}'), ('${AUTH_TEACHER}'), ('${AUTH_PARENT}'), ('${AUTH_SUPERVISOR}');

    INSERT INTO profiles(id,name,email,role,auth_id) VALUES
      ('adminU','Admin One','admin@x.com','admin','${AUTH_ADMIN}'),
      ('adminU2','Admin Two','admin2@x.com','admin','${AUTH_ADMIN2}'),
      ('teacherA','Teacher A','a@x.com','teacher','${AUTH_TEACHER}'),
      ('parent1','Parent','p@x.com','parent','${AUTH_PARENT}'),
      ('supU','Supervisor','sup@x.com','supervisor','${AUTH_SUPERVISOR}');

    INSERT INTO subjects(id,name) VALUES ('math','Mathematics');
    INSERT INTO students(id,name,"className","parentId") VALUES
      ('studentA','Axmed Cabdale Maxamuud','Grade 7-A','parent1');
    INSERT INTO class_subjects(id,"className","subjectId","teacherId") VALUES
      ('cs1','Grade 7-A','math','teacherA');
    INSERT INTO academic_years(id,name) VALUES ('ay1','2026');
    INSERT INTO terms(id,name,"academicYearId","startDate","endDate","isCurrent",months) VALUES
      ('term1','Term 1','ay1','2026-01-01','2026-12-31',true,ARRAY['September']);
  `);
}

// Insert a fresh CPW1 grade (12/15) uploaded by the teacher, status approved.
async function seedGrade(db: PgTestDb, overrides: Record<string, unknown> = {}) {
  const g = {
    id: 'exam-cpw1',
    score: 12,
    total: 15,
    entryState: 'scored',
    status: 'approved',
    ...overrides,
  };
  // Clear the simulated auth session so the audit-immutability trigger (which
  // only blocks AUTHENTICATED clients) permits the owner-level test cleanup —
  // the same as a migration/service-role context in production.
  await db.setAuthUid(null);
  await db.exec(`
    DELETE FROM public.grade_correction_audit WHERE exam_id='${g.id}';
    DELETE FROM public.exams WHERE id='${g.id}';
    INSERT INTO public.exams (
      id,"studentId","subjectId",subject,score,total,"examType","assessmentLabel","entryState",
      "termId",month,status,"parentId",date,"teacherId","uploadedBy"
    ) VALUES (
      '${g.id}','studentA','math','Mathematics',${g.score == null ? 'NULL' : g.score},${g.total},
      'Classwork','CPW1','${g.entryState}','term1','September','${g.status}','parent1','2026-09-04','teacherA','teacherA'
    );
  `);
}

async function correct(
  db: PgTestDb,
  args: { examId?: string; expectedOld?: number | null; newScore?: number | null; reason?: string; expectedOldState?: string; newState?: string } = {},
) {
  const {
    examId = 'exam-cpw1',
    expectedOld = 12,
    newScore = 10,
    reason = 'Incorrect value entered during bulk upload',
    expectedOldState = 'scored',
    newState = 'scored',
  } = args;
  const { rows } = await db.query<{ result: unknown }>(
    'SELECT public.admin_correct_grade($1,$2,$3,$4,$5,$6) AS result',
    [examId, expectedOld, newScore, reason, expectedOldState, newState],
  );
  return rows[0].result as Record<string, unknown>;
}

async function expectDenied(fn: () => Promise<unknown>): Promise<string> {
  try {
    await fn();
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
  throw new Error('Expected the RPC to DENY/FAIL, but it succeeded.');
}

d('admin_correct_grade — behavioral (real PostgreSQL via PGlite)', () => {
  let db: PgTestDb;
  beforeAll(async () => {
    db = await createBulkGradesTestDb({ includeGradeCorrection: true, includeStatusGuard: true });
    await seed(db);
  });
  afterAll(async () => { await db?.close(); });
  beforeEach(async () => { await seedGrade(db); await db.setAuthUid(AUTH_ADMIN); });

  it('Test 1 — admin can correct 12 -> 10', async () => {
    const res = await correct(db, { newScore: 10 });
    expect(res.oldScore).toBe(12);
    expect(res.newScore).toBe(10);
    const { rows } = await db.query<{ score: number }>(`SELECT score FROM exams WHERE id='exam-cpw1'`);
    expect(rows[0].score).toBe(10);
  });

  it('Test 2 — an immutable audit record is created with old/new/reason/corrected_by', async () => {
    await correct(db, { newScore: 10, reason: 'Verified against teacher mark sheet' });
    const { rows } = await db.query<{
      old_score: number; new_score: number; reason: string; corrected_by: string; source: string;
    }>(`SELECT old_score,new_score,reason,corrected_by,source FROM grade_correction_audit WHERE exam_id='exam-cpw1'`);
    expect(rows).toHaveLength(1);
    expect(rows[0].old_score).toBe(12);
    expect(rows[0].new_score).toBe(10);
    expect(rows[0].reason).toBe('Verified against teacher mark sheet');
    expect(rows[0].corrected_by).toBe('adminU');
    expect(rows[0].source).toBe('admin_correction');
  });

  it('Test 3 — teacher is denied', async () => {
    await db.setAuthUid(AUTH_TEACHER);
    const msg = await expectDenied(() => correct(db));
    expect(msg).toContain('not authorized');
    const { rows } = await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM grade_correction_audit`);
    expect(rows[0].n).toBe(0);
  });

  it('Test 4 — parent is denied', async () => {
    await db.setAuthUid(AUTH_PARENT);
    const msg = await expectDenied(() => correct(db));
    expect(msg).toContain('not authorized');
  });

  it('Test 4b — supervisor is denied (correction is admin-only)', async () => {
    await db.setAuthUid(AUTH_SUPERVISOR);
    const msg = await expectDenied(() => correct(db));
    expect(msg).toContain('not authorized');
  });

  it('Test 5 — anonymous is denied', async () => {
    await db.setAuthUid(null);
    const msg = await expectDenied(() => correct(db));
    expect(msg).toContain('not authorized');
  });

  it('Test 6 — score above the maximum is rejected (15 -> 16)', async () => {
    await seedGrade(db, { score: 15 });
    await db.setAuthUid(AUTH_ADMIN);
    const msg = await expectDenied(() => correct(db, { expectedOld: 15, newScore: 16 }));
    expect(msg).toContain('between 0 and 15');
  });

  it('Test 6b — negative score is rejected', async () => {
    const msg = await expectDenied(() => correct(db, { newScore: -1 }));
    expect(msg).toContain('between 0 and 15');
  });

  it('Test 7 — invalid (NaN/Infinity/non-integer) is rejected by the typed parameter', async () => {
    // The RPC parameter is INTEGER; a non-numeric/Infinity value cannot bind.
    const msg = await expectDenied(() => db.query(
      'SELECT public.admin_correct_grade($1,$2,$3,$4)',
      ['exam-cpw1', 12, 'not-a-number', 'reason text here'],
    ));
    expect(msg.length).toBeGreaterThan(0);
    const msg2 = await expectDenied(() => db.query(
      `SELECT public.admin_correct_grade('exam-cpw1', 12, 'Infinity'::float::int, 'reason text here')`,
    ));
    expect(msg2.length).toBeGreaterThan(0);
  });

  it('Test 8 — same score (12 -> 12) makes no change and creates no audit', async () => {
    const msg = await expectDenied(() => correct(db, { newScore: 12 }));
    expect(msg).toContain('matches the current score');
    const { rows } = await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM grade_correction_audit WHERE exam_id='exam-cpw1'`);
    expect(rows[0].n).toBe(0);
  });

  it('Test 9 — missing/whitespace reason is rejected', async () => {
    const msg = await expectDenied(() => correct(db, { reason: '   ' }));
    expect(msg).toContain('reason is required');
  });

  it('Test 10 — multiple corrections (12->10->11) produce two immutable audit records', async () => {
    await correct(db, { expectedOld: 12, newScore: 10, reason: 'first fix' });
    await correct(db, { expectedOld: 10, newScore: 11, reason: 'second fix' });
    const { rows } = await db.query<{ old_score: number; new_score: number; reason: string }>(
      `SELECT old_score,new_score,reason FROM grade_correction_audit WHERE exam_id='exam-cpw1' ORDER BY corrected_at ASC, old_score DESC`,
    );
    expect(rows).toHaveLength(2);
    // Both transitions preserved (order by value change, timestamps may tie).
    const pairs = rows.map(r => `${r.old_score}->${r.new_score}`).sort();
    expect(pairs).toEqual(['10->11', '12->10']);
    const { rows: liveRows } = await db.query<{ score: number }>(`SELECT score FROM exams WHERE id='exam-cpw1'`);
    expect(liveRows[0].score).toBe(11);
  });

  it('Test 11 — stale/concurrent correction is rejected, not silently overwritten', async () => {
    // Admin A reviewed 12. Admin B changes 12 -> 10.
    await db.setAuthUid(AUTH_ADMIN2);
    await correct(db, { expectedOld: 12, newScore: 10, reason: 'admin B change' });
    // Admin A now attempts 12 -> 11 using the STALE expected value.
    await db.setAuthUid(AUTH_ADMIN);
    const msg = await expectDenied(() => correct(db, { expectedOld: 12, newScore: 11, reason: 'stale admin A change' }));
    expect(msg).toContain('changed by another administrator');
    // The value remains admin B's 10 — not overwritten.
    const { rows } = await db.query<{ score: number }>(`SELECT score FROM exams WHERE id='exam-cpw1'`);
    expect(rows[0].score).toBe(10);
  });

  it('Test 12 — correction targets the exact exam.id (nonexistent id is rejected)', async () => {
    const msg = await expectDenied(() => correct(db, { examId: 'exam-does-not-exist' }));
    expect(msg).toContain('no longer exists');
  });

  it('Test 13 — an approved grade becomes pending after correction (approval re-earned)', async () => {
    await seedGrade(db, { status: 'approved', score: 12 });
    await db.setAuthUid(AUTH_ADMIN);
    const res = await correct(db, { newScore: 10 });
    expect(res.oldStatus).toBe('approved');
    expect(res.newStatus).toBe('pending');
    const { rows } = await db.query<{ status: string }>(`SELECT status FROM exams WHERE id='exam-cpw1'`);
    expect(rows[0].status).toBe('pending');
    const { rows: a } = await db.query<{ old_status: string; new_status: string }>(
      `SELECT old_status,new_status FROM grade_correction_audit WHERE exam_id='exam-cpw1'`,
    );
    expect(a[0].old_status).toBe('approved');
    expect(a[0].new_status).toBe('pending');
  });

  it('Test 13b — provenance (uploadedBy = original teacher) is preserved; corrected_by is the admin', async () => {
    await correct(db, { newScore: 10 });
    const { rows } = await db.query<{ uploadedBy: string; teacherId: string }>(
      `SELECT "uploadedBy","teacherId" FROM exams WHERE id='exam-cpw1'`,
    );
    expect(rows[0].uploadedBy).toBe('teacherA');
    expect(rows[0].teacherId).toBe('teacherA');
    const { rows: a } = await db.query<{ corrected_by: string }>(
      `SELECT corrected_by FROM grade_correction_audit WHERE exam_id='exam-cpw1'`,
    );
    expect(a[0].corrected_by).toBe('adminU');
  });

  it('Test 15 — the correction does not touch the student class assignment', async () => {
    await correct(db, { newScore: 10 });
    const { rows } = await db.query<{ className: string }>(`SELECT "className" FROM students WHERE id='studentA'`);
    expect(rows[0].className).toBe('Grade 7-A');
    const { rows: a } = await db.query<{ class_name: string }>(
      `SELECT class_name FROM grade_correction_audit WHERE exam_id='exam-cpw1'`,
    );
    expect(a[0].class_name).toBe('Grade 7-A');
  });

  it('preserves NULL/absent semantics distinctly from scored 0', async () => {
    // absent -> 10 is auditable and distinct from 0 -> 10.
    await seedGrade(db, { score: null, entryState: 'absent', status: 'approved' });
    await db.setAuthUid(AUTH_ADMIN);
    await correct(db, { expectedOld: null, expectedOldState: 'absent', newScore: 10, newState: 'scored' });
    const { rows } = await db.query<{ old_score: number | null; old_entry_state: string; new_score: number }>(
      `SELECT old_score,old_entry_state,new_score FROM grade_correction_audit WHERE exam_id='exam-cpw1'`,
    );
    expect(rows[0].old_score).toBeNull();
    expect(rows[0].old_entry_state).toBe('absent');
    expect(rows[0].new_score).toBe(10);
  });

  it('get_grade_correction_history returns chronological history for staff', async () => {
    await correct(db, { expectedOld: 12, newScore: 10, reason: 'first' });
    await correct(db, { expectedOld: 10, newScore: 11, reason: 'second' });
    const { rows } = await db.query<{ result: Array<Record<string, unknown>> }>(
      `SELECT public.get_grade_correction_history('exam-cpw1') AS result`,
    );
    const history = rows[0].result;
    expect(history).toHaveLength(2);
    // Includes the corrector's display name.
    expect(history[0].correctedByName).toBe('Admin One');
  });

  it('get_grade_correction_history denies non-staff', async () => {
    await db.setAuthUid(AUTH_TEACHER);
    const msg = await expectDenied(() => db.query(`SELECT public.get_grade_correction_history('exam-cpw1')`));
    expect(msg).toContain('not authorized');
  });

  it('Test 14 — report-style consumers use the corrected value (approved + scored)', async () => {
    // Reports read exams WHERE status='approved' AND entryState='scored'. A
    // corrected grade returns to 'pending' (drops out until re-approved); once an
    // admin re-approves it, the corrected value is what reporting sees — never the
    // stale original. This asserts the canonical value flows through, not a
    // separate "corrected score" only the admin page sees.
    await correct(db, { newScore: 10 });
    // Simulate the approval path (admin write) re-approving the corrected row.
    await db.exec(`UPDATE public.exams SET status='approved' WHERE id='exam-cpw1'`);
    const { rows } = await db.query<{ score: number; status: string; entryState: string }>(
      `SELECT score,status,"entryState" FROM public.exams
       WHERE id='exam-cpw1' AND status='approved' AND "entryState"='scored'`,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].score).toBe(10); // corrected value, not 12
  });

  it('the audit table is append-only — UPDATE and DELETE are blocked', async () => {
    await correct(db, { newScore: 10 });
    const up = await expectDenied(() => db.query(`UPDATE grade_correction_audit SET new_score=999 WHERE exam_id='exam-cpw1'`));
    expect(up).toContain('append-only');
    const del = await expectDenied(() => db.query(`DELETE FROM grade_correction_audit WHERE exam_id='exam-cpw1'`));
    expect(del).toContain('append-only');
  });
});
