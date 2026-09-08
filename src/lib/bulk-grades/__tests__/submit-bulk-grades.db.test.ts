// BEHAVIORAL PostgreSQL tests for submit_bulk_grades (executed via PGlite).
//
// These EXECUTE the real RPC against a real Postgres engine and assert actual
// row outcomes — authorization, wrong class/subject/teacher/student, tampered
// identity, atomic rollback, idempotency, approved-grade detection, and the
// old -> new change preview.
//
// If PGlite is not installed in the environment, the suite marks itself SKIPPED
// (not passed): the corresponding claims must then be treated as NOT VERIFIED.

import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import { createBulkGradesTestDb, pgliteAvailable, type PgTestDb } from './pgHarness';

const AVAILABLE = await pgliteAvailable();
const d = AVAILABLE ? describe : describe.skip;

// Deterministic UUIDs for auth users.
const AUTH_A = '11111111-1111-1111-1111-111111111111';
const AUTH_B = '22222222-2222-2222-2222-222222222222';
const AUTH_ADMIN = '33333333-3333-3333-3333-333333333333';

async function seed(db: PgTestDb) {
  await db.exec(`
    INSERT INTO auth.users(id) VALUES
      ('${AUTH_A}'), ('${AUTH_B}'), ('${AUTH_ADMIN}');

    INSERT INTO profiles(id,name,email,role,auth_id) VALUES
      ('teacherA','Teacher A','a@x.com','teacher','${AUTH_A}'),
      ('teacherB','Teacher B','b@x.com','teacher','${AUTH_B}'),
      ('adminU','Admin','admin@x.com','admin','${AUTH_ADMIN}'),
      ('parent1','Parent','p@x.com','parent',NULL);

    INSERT INTO subjects(id,name) VALUES
      ('arabic','Arabic'), ('math','Mathematics');

    INSERT INTO students(id,name,"className","parentId") VALUES
      ('studentA','Ahmed Ali','Grade 5-A','parent1'),
      ('studentB','Bilal Omar','Grade 5-B','parent1');

    -- Teacher A -> 5-A Arabic ; Teacher B -> 5-B Arabic. Math assigned to B in 5-A.
    INSERT INTO class_subjects(id,"className","subjectId","teacherId") VALUES
      ('cs1','Grade 5-A','arabic','teacherA'),
      ('cs2','Grade 5-B','arabic','teacherB'),
      ('cs3','Grade 5-A','math','teacherB');

    INSERT INTO academic_years(id,name) VALUES ('ay1','2026');
    INSERT INTO terms(id,name,"academicYearId","startDate","endDate","isCurrent",months) VALUES
      ('term1','Term 1','ay1','2026-01-01','2026-12-31',true,ARRAY['January','May','September']);
  `);
}

function rec(overrides: Record<string, unknown> = {}) {
  return JSON.stringify([{
    studentId: 'studentA', subjectId: 'arabic', assessmentLabel: 'MT',
    examType: 'Quiz', score: 17, total: 20, entryState: 'scored',
    month: 'May', date: '2026-05-10', termId: 'term1', ...overrides,
  }]);
}

async function callRpc(db: PgTestDb, records: string, key: string, confirm: boolean) {
  const { rows } = await db.query<{ result: unknown }>(
    'SELECT public.submit_bulk_grades($1::jsonb, $2, $3) AS result',
    [records, key, confirm],
  );
  return rows[0].result as Record<string, unknown>;
}

async function expectDenied(fn: () => Promise<unknown>): Promise<string> {
  try {
    await fn();
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
  throw new Error('Expected the RPC to DENY, but it succeeded.');
}

d('submit_bulk_grades — behavioral (real PostgreSQL via PGlite)', () => {
  let db: PgTestDb;
  beforeAll(async () => { db = await createBulkGradesTestDb(); await seed(db); });
  afterAll(async () => { await db?.close(); });

  it('the unique (className, subjectId) constraint actually exists in the DB', async () => {
    const { rows } = await db.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM pg_indexes
       WHERE schemaname='public' AND tablename='class_subjects' AND indexname='uniq_class_subjects_active'`,
    );
    expect(rows[0].n).toBe(1);
    // And it truly rejects a duplicate assignment.
    const err = await expectDenied(() => db.query(
      `INSERT INTO class_subjects(id,"className","subjectId","teacherId") VALUES('dup','Grade 5-A','arabic','teacherB')`,
    ));
    expect(err.toLowerCase()).toContain('duplicate');
  });

  it('ALLOWED: Teacher A -> Student A -> Arabic commits exactly one row', async () => {
    await db.setAuthUid(AUTH_A);
    const res = await callRpc(db, rec({ score: 12 }), 'allowed-key-0001', true);
    expect(res.insertCount).toBe(1);
    const { rows } = await db.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM exams WHERE "studentId"='studentA' AND "subjectId"='arabic' AND "assessmentLabel"='MT'`,
    );
    expect(rows[0].n).toBe(1);
  });

  it('DENIED: Teacher A -> Student B (wrong class)', async () => {
    await db.setAuthUid(AUTH_A);
    const msg = await expectDenied(() => callRpc(db, rec({ studentId: 'studentB' }), 'wrongclass-key-01', true));
    expect(msg).toContain('assigned class subjects');
  });

  it('DENIED: Teacher A -> Student A -> Mathematics (wrong subject)', async () => {
    await db.setAuthUid(AUTH_A);
    const msg = await expectDenied(() => callRpc(db, rec({
      subjectId: 'math', assessmentLabel: 'MT', examType: 'Quiz', total: 20,
    }), 'wrongsubj-key-001', true));
    expect(msg).toContain('assigned class subjects');
  });

  it('DENIED: Teacher B -> Student A -> Arabic (wrong teacher)', async () => {
    await db.setAuthUid(AUTH_B);
    const msg = await expectDenied(() => callRpc(db, rec(), 'wrongteacher-key-1', true));
    expect(msg).toContain('assigned class subjects');
  });

  it('DENIED: tampered payload cannot inject teacherId/parentId/status/uploadedBy', async () => {
    await db.setAuthUid(AUTH_A);
    // Attempt to smuggle privileged fields — RPC ignores them and derives its own.
    const tampered = JSON.stringify([{
      studentId: 'studentA', subjectId: 'arabic', assessmentLabel: 'HW1',
      examType: 'Homework', score: 5, total: 5, entryState: 'scored',
      month: 'May', date: '2026-05-10', termId: 'term1',
      teacherId: 'teacherB', parentId: 'teacherB', status: 'approved', uploadedBy: 'teacherB',
    }]);
    const res = await callRpc(db, tampered, 'tamper-key-00001', true);
    expect(res.insertCount).toBe(1);
    const { rows } = await db.query<{ teacherId: string; status: string; uploadedBy: string }>(
      `SELECT "teacherId","status","uploadedBy" FROM exams WHERE "studentId"='studentA' AND "assessmentLabel"='HW1'`,
    );
    expect(rows[0].teacherId).toBe('teacherA'); // derived, not smuggled
    expect(rows[0].status).toBe('pending');     // forced, not 'approved'
    expect(rows[0].uploadedBy).toBe('teacherA');
  });

  it('DENIED: score above maximum is rejected', async () => {
    await db.setAuthUid(AUTH_A);
    const msg = await expectDenied(() => callRpc(db, rec({ assessmentLabel: 'HW2', examType: 'Homework', total: 5, score: 6 }), 'overmax-key-00001', true));
    expect(msg.toLowerCase()).toMatch(/invalid|score|state/);
  });

  it('ATOMICITY: a batch with one unauthorized record commits ZERO rows', async () => {
    await db.setAuthUid(AUTH_A);
    const before = await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM exams`);
    const batch = JSON.stringify([
      { studentId: 'studentA', subjectId: 'arabic', assessmentLabel: 'HW3', examType: 'Homework', score: 5, total: 5, entryState: 'scored', month: 'May', date: '2026-05-10', termId: 'term1' },
      { studentId: 'studentA', subjectId: 'arabic', assessmentLabel: 'HW4', examType: 'Homework', score: 4, total: 5, entryState: 'scored', month: 'May', date: '2026-05-10', termId: 'term1' },
      { studentId: 'studentB', subjectId: 'arabic', assessmentLabel: 'HW1', examType: 'Homework', score: 5, total: 5, entryState: 'scored', month: 'May', date: '2026-05-10', termId: 'term1' }, // unauthorized -> whole batch must roll back
    ]);
    await expectDenied(() => callRpc(db, batch, 'atomic-key-000001', true));
    const after = await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM exams`);
    expect(after.rows[0].n).toBe(before.rows[0].n); // nothing committed
    const hw3 = await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM exams WHERE "assessmentLabel"='HW3'`);
    expect(hw3.rows[0].n).toBe(0);
  });

  it('IDEMPOTENCY: same key + same payload does not double-insert', async () => {
    await db.setAuthUid(AUTH_A);
    const payload = rec({ assessmentLabel: 'CPW1', examType: 'Classwork', total: 15, score: 10 });
    const first = await callRpc(db, payload, 'idem-key-00000001', true);
    const second = await callRpc(db, payload, 'idem-key-00000001', true);
    expect(first.insertCount).toBe(1);
    // Second call returns the stored result and writes nothing new.
    const { rows } = await db.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM exams WHERE "studentId"='studentA' AND "assessmentLabel"='CPW1'`,
    );
    expect(rows[0].n).toBe(1);
    expect(second.insertCount).toBe(1);
  });

  it('PREVIEW old -> new: existing value comes from the DB, not the workbook', async () => {
    await db.setAuthUid(AUTH_A);
    // Seed an existing Arabic MT = 14 (approved) for studentA via direct insert.
    await db.exec(`
      DELETE FROM exams WHERE "studentId"='studentA' AND "subjectId"='arabic' AND "assessmentLabel"='MT';
      INSERT INTO exams(id,"studentId","subjectId",subject,score,total,"examType","assessmentLabel","entryState","termId",month,status,date,"teacherId")
      VALUES('ex-existing','studentA','arabic','Arabic',14,20,'Quiz','MT','scored','term1','May','approved','2026-05-10','teacherA');
    `);
    const preview = await callRpc(db, rec({ score: 17 }), 'preview-key-00001', false);
    expect(preview.updateCount).toBe(1);
    expect(preview.approvedChangeCount).toBe(1);
    expect(preview.requiresApprovedAcknowledgement).toBe(true);
    const changes = preview.changes as Array<Record<string, unknown>>;
    expect(changes).toHaveLength(1);
    expect(changes[0]).toMatchObject({
      studentId: 'studentA', studentName: 'Ahmed Ali', className: 'Grade 5-A',
      subject: 'Arabic', assessmentLabel: 'MT',
      existingScore: 14, newScore: 17, existingStatus: 'approved',
      changeType: 'update', isApproved: true,
    });
    // Preview must NOT write.
    const { rows } = await db.query<{ score: number; status: string }>(
      `SELECT score,status FROM exams WHERE id='ex-existing'`,
    );
    expect(rows[0].score).toBe(14);
    expect(rows[0].status).toBe('approved');
  });

  it('APPROVED overwrite on confirm resets status to pending and applies new score', async () => {
    await db.setAuthUid(AUTH_A);
    const res = await callRpc(db, rec({ score: 17 }), 'approved-commit-01', true);
    expect(res.updateCount).toBe(1);
    const { rows } = await db.query<{ score: number; status: string }>(
      `SELECT score,status FROM exams WHERE id='ex-existing'`,
    );
    expect(rows[0].score).toBe(17);
    expect(rows[0].status).toBe('pending');
  });

  it('ADMIN may upload for any teacher\'s class subject (role bypass of teacher-ownership)', async () => {
    await db.setAuthUid(AUTH_ADMIN);
    const res = await callRpc(db, rec({ studentId: 'studentB', subjectId: 'arabic', assessmentLabel: 'HW1', examType: 'Homework', total: 5, score: 3 }), 'admin-key-0000001', true);
    expect(res.insertCount).toBe(1);
    const { rows } = await db.query<{ teacherId: string }>(
      `SELECT "teacherId" FROM exams WHERE "studentId"='studentB' AND "assessmentLabel"='HW1'`,
    );
    expect(rows[0].teacherId).toBe('teacherB'); // derived assigned teacher, not the admin
  });

  it('DENIED: unauthenticated (no profile) cannot submit', async () => {
    await db.setAuthUid(null);
    const msg = await expectDenied(() => callRpc(db, rec(), 'anon-key-00000001', true));
    expect(msg).toContain('Only authenticated teachers and admins');
  });
});

// Regression: the RPC must coexist with the status-guard trigger (20260909).
// The RPC runs as a teacher context and always writes 'pending', so the guard
// must be a harmless no-op and every RPC behavior must be unchanged.
d('submit_bulk_grades coexists with the exam status guard trigger', () => {
  let db: PgTestDb;
  beforeAll(async () => { db = await createBulkGradesTestDb({ includeStatusGuard: true }); await seed(db); });
  afterAll(async () => { await db?.close(); });

  it('teacher commit still succeeds and rows land as pending with the guard installed', async () => {
    await db.setAuthUid(AUTH_A);
    const res = await callRpc(db, rec({ assessmentLabel: 'HW1', examType: 'Homework', total: 5, score: 4 }), 'guard-coexist-0001', true);
    expect(res.insertCount).toBe(1);
    const { rows } = await db.query<{ status: string; score: number }>(
      `SELECT status,score FROM exams WHERE "studentId"='studentA' AND "assessmentLabel"='HW1'`,
    );
    expect(rows[0].status).toBe('pending');
    expect(rows[0].score).toBe(4);
  });

  it('approved-overwrite via RPC still resets to pending with the guard installed', async () => {
    await db.setAuthUid(AUTH_A);
    await db.exec(`
      INSERT INTO exams(id,"studentId","subjectId",subject,score,total,"examType","assessmentLabel","entryState","termId",month,status,date,"teacherId")
      VALUES('ex-guard-appr','studentA','arabic','Arabic',14,20,'Quiz','MT','scored','term1','May','approved','2026-05-10','teacherA')
      ON CONFLICT DO NOTHING;
    `);
    const res = await callRpc(db, rec({ score: 17 }), 'guard-overwrite-01', true);
    expect(res.updateCount).toBe(1);
    const { rows } = await db.query<{ status: string; score: number }>(
      `SELECT status,score FROM exams WHERE id='ex-guard-appr'`,
    );
    expect(rows[0].status).toBe('pending');
    expect(rows[0].score).toBe(17);
  });
});

// Loud marker so a skipped DB suite cannot be mistaken for a passing one.
if (!AVAILABLE) {
  describe('submit_bulk_grades — behavioral DB tests', () => {
    it.skip('SKIPPED: @electric-sql/pglite not installed — DB behavior is NOT VERIFIED in this run', () => {});
  });
}
