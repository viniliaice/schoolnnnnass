// FORMER STUDENTS / STUDENT CLEANUP — executed against real PostgreSQL
// (PGlite, in-process WASM) using the ACTUAL shipped migrations
// (20261008_former_students_cleanup.sql + 20261008b_former_students_roster_filters.sql).
//
// Every safety rule the feature promises is asserted here against what the
// DATABASE decides, because the database — not the browser — is the enforcement
// point:
//   * System ID (students.id) is the only match key; a name never identifies a
//     student and never deactivates one.
//   * missing / unknown / ambiguous System IDs are refused even when the client
//     explicitly asks to deactivate them.
//   * an ID match with a different name needs a per-row admin confirmation.
//   * nothing is ever deleted, and every historical child row survives.
//   * students who are NOT in the uploaded file are never touched.
//   * rollback restores the exact previous status/transport and skips students
//     whose status changed after the import.
//
// No production database is contacted: the instance is created, seeded with
// synthetic students and destroyed inside this file.

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  createFormerStudentsTestDb,
  pgliteAvailable,
  readMigration,
  seedExam,
  seedProfile,
  seedStudent,
  type PgFormerDb,
  type UploadedRow,
} from './pgFormerStudentsHarness';

const ADMIN_UID = 'dddddddd-0000-4000-8000-0000000000a1';
const ADMIN_ID = 'admin-1';
const TEACHER_UID = 'dddddddd-0000-4000-8000-0000000000b2';
const PARENT_UID = 'dddddddd-0000-4000-8000-0000000000c3';
const SUPERVISOR_UID = 'dddddddd-0000-4000-8000-0000000000d4';

const ROLLBACK_PHRASE = 'ROLLBACK IMPORT';

interface PreviewRow {
  rowNumber: number;
  uploadedName: string;
  uploadedSystemId: string;
  matchedStudentId: string | null;
  databaseName: string | null;
  databaseSystemId: string | null;
  className: string | null;
  databaseStatus: string | null;
  databaseTransport: string | null;
  matchStatus: 'exact_match' | 'id_match_name_conflict' | 'possible_duplicate' | 'requires_review' | 'not_found' | 'already_former';
  nameMatch: 'exact' | 'normalized' | 'different' | 'missing' | null;
  nameSimilarity: number | null;
  reasons: string[];
  autoSafe: boolean;
  requiresReview: boolean;
  blocked: boolean;
  defaultAction: 'deactivate' | 'review' | 'none';
  requestedAction: string;
  adminConfirmed: boolean;
}

interface PreviewSummary {
  totalUploaded: number;
  validRecords: number;
  missingNames: number;
  missingSystemIds: number;
  duplicateSystemIds: number;
  duplicateNames: number;
  foundInDatabase: number;
  notFoundInDatabase: number;
  exactMatches: number;
  nameConflicts: number;
  possibleDuplicates: number;
  requiresReviewStatus: number;
  alreadyFormer: number;
  requiresReview: number;
  readyToDeactivate: number;
  noAction: number;
  blocked: number;
}

interface PreviewResult {
  dryRun: boolean;
  writesPerformed: number;
  summary: PreviewSummary;
  rows: PreviewRow[];
  policy: { confirmPhrase: string; rollbackConfirmPhrase: string; maxRows: number };
}

interface ApplyResult {
  importId: string;
  importNumber: number;
  committed: boolean;
  deactivated: number;
  skipped: number;
  keptActive: number;
  blocked: number;
  deleted: number;
  formerStudentIds: string[];
  skippedRows: Array<{ rowNumber: number; uploadedSystemId: string; reason: string }>;
  summary: PreviewSummary;
}

interface RollbackResult {
  importId: string;
  restored: number;
  skipped: number;
  restoredStudentIds: string[];
  skippedRows: Array<{ studentId: string; reason: string }>;
  importStatus: 'rolled_back' | 'partially_rolled_back';
}

let db: PgFormerDb | null = null;
let seq = 0;

/** Unique names keep rows from colliding across scenarios (duplicate-name rule). */
function uniqueName(prefix: string) {
  seq += 1;
  return `${prefix} Unique${seq}`;
}

function row(rowNumber: number, name: string, systemId: string, extra: Partial<UploadedRow> = {}): UploadedRow {
  return { rowNumber, name, systemId, ...extra };
}

async function preview(rows: UploadedRow[]): Promise<PreviewResult> {
  if (!db) throw new Error('db not ready');
  return db.rpc<PreviewResult>('preview_former_student_import', { p_rows: rows });
}

async function apply(rows: UploadedRow[], fileName = 'leavers-2026.xlsx'): Promise<ApplyResult> {
  if (!db) throw new Error('db not ready');
  return db.rpc<ApplyResult>('apply_former_student_import', {
    p_rows: rows,
    p_file_name: fileName,
    p_reason: 'Term cleanup',
  });
}

async function studentRow(id: string) {
  if (!db) throw new Error('db not ready');
  const { rows } = await db.query<{
    id: string; name: string; className: string; status: string; transport: string | null;
    parentId: string | null; govId: string | null; familyId: string | null; parentPhone: string | null;
    statusUpdatedAt: string | null; statusUpdatedBy: string | null;
  }>('SELECT * FROM public.students WHERE id = $1', [id]);
  return rows[0];
}

async function countRows(table: string, where = '', params: unknown[] = []): Promise<number> {
  if (!db) throw new Error('db not ready');
  const { rows } = await db.query<{ n: string }>(
    `SELECT count(*)::text AS n FROM public.${table}${where ? ` WHERE ${where}` : ''}`, params);
  return Number(rows[0]?.n ?? 0);
}

const available = await pgliteAvailable();
const maybe = available ? describe : describe.skip;

maybe('Former Students cleanup — database contract', () => {
  beforeAll(async () => {
    if (!available) return;
    db = await createFormerStudentsTestDb();
    await seedProfile(db!, ADMIN_ID, 'admin', 'Ayaan Admin', ADMIN_UID);
    await seedProfile(db!, 'teacher-1', 'teacher', 'Tahiya Teacher', TEACHER_UID);
    await seedProfile(db!, 'parent-1', 'parent', ' Hodan Parent', PARENT_UID);
    await seedProfile(db!, 'supervisor-1', 'supervisor', 'Sagal Supervisor', SUPERVISOR_UID);
    await db.setAuthUid(ADMIN_UID);
  }, 120_000);

  afterAll(async () => {
    await db?.close();
    db = null;
  });

  beforeEach(async () => {
    await db?.exec('RESET ROLE');
    await db?.setAuthUid(ADMIN_UID);
  });

  // ── 1. Schema ─────────────────────────────────────────────────────────────
  describe('schema', () => {
    it('adds students.status with an active default and a two-value CHECK', async () => {
      const name = uniqueName('Schema');
      const id = `student-schema-${seq}`;
      await seedStudent(db!, { id, name, className: 'Grade 3-A' });
      const s = await studentRow(id);
      expect(s.status).toBe('active');

      await expect(
        db!.query(`UPDATE public.students SET status = 'deleted' WHERE id = $1`, [id]),
      ).rejects.toThrow(/students_status_check|check constraint/i);
    });

    it('never deletes: there is no cleanup code path that removes a student row', async () => {
      const sql = readMigration('20261008_former_students_cleanup.sql');
      // The migration must not contain a DELETE/UPDATE against students that
      // removes data: the only students writes are the status/transport ones.
      expect(sql).not.toMatch(/DELETE\s+FROM\s+public\.students/i);
      expect(sql).not.toMatch(/DROP\s+TABLE/i);
      expect(sql).toMatch(/SET status = 'former'/i);
    });
  });

  // ── 2. Preview: matching by System ID only ────────────────────────────────
  describe('preview_former_student_import (dry run)', () => {
    it('matches exactly on System ID and agrees on the name', async () => {
      const name = uniqueName('Exact');
      const id = `student-exact-${seq}`;
      await seedStudent(db!, { id, name, className: 'Grade 4-B', transport: '7' });

      const res = await preview([row(2, name, id)]);
      expect(res.dryRun).toBe(true);
      expect(res.writesPerformed).toBe(0);
      const r = res.rows[0];
      expect(r.matchStatus).toBe('exact_match');
      expect(r.nameMatch).toBe('exact');
      expect(r.autoSafe).toBe(true);
      expect(r.defaultAction).toBe('deactivate');
      expect(r.databaseName).toBe(name);
      expect(r.className).toBe('Grade 4-B');
      expect(res.summary.readyToDeactivate).toBe(1);
      expect(res.summary.foundInDatabase).toBe(1);
    });

    it('treats capitalization and extra spaces as the same name (still safe)', async () => {
      const name = uniqueName('Normalised');
      const id = `student-norm-${seq}`;
      await seedStudent(db!, { id, name, className: 'Grade 4-B' });

      const messy = `  ${name.toUpperCase().split(' ').join('   ')} `;
      const r = (await preview([row(2, messy, id)])).rows[0];
      expect(r.matchStatus).toBe('exact_match');
      expect(r.nameMatch).toBe('normalized');
      expect(r.reasons).toContain('name_case_or_space_difference');
      expect(r.autoSafe).toBe(true);
    });

    it('flags an ID match whose name differs and refuses to call it safe', async () => {
      const name = uniqueName('Dbname');
      const id = `student-nameconf-${seq}`;
      await seedStudent(db!, { id, name, className: 'Grade 5-A' });

      const r = (await preview([row(2, 'Completely Other Person', id)])).rows[0];
      expect(r.matchStatus).toBe('id_match_name_conflict');
      expect(r.nameMatch).toBe('different');
      expect(r.autoSafe).toBe(false);
      expect(r.requiresReview).toBe(true);
      expect(r.defaultAction).toBe('review');
      expect(r.reasons).toContain('name_differs');
      expect(r.reasons).toContain('name_very_different');
      expect(Number(r.nameSimilarity)).toBe(0);
    });

    it('reports a small spelling drift as different but NOT very different', async () => {
      const id = `student-drift-${seq}`;
      const name = uniqueName('Drift');
      await seedStudent(db!, { id, name: `${name} Maxamed`, className: 'Grade 5-A' });

      const r = (await preview([row(2, `${name} Mohamed`, id)])).rows[0];
      expect(r.matchStatus).toBe('id_match_name_conflict');
      expect(r.reasons).toContain('name_differs');
      expect(r.reasons).not.toContain('name_very_different');
    });

    it('flags a missing System ID as not-found-free review and blocks it', async () => {
      const res = await preview([row(2, uniqueName('NoId'), '')]);
      const r = res.rows[0];
      expect(r.matchStatus).toBe('requires_review');
      expect(r.reasons).toContain('missing_system_id');
      expect(r.blocked).toBe(true);
      expect(r.autoSafe).toBe(false);
      expect(r.defaultAction).toBe('none');
      expect(r.matchedStudentId).toBeNull();
      expect(res.summary.missingSystemIds).toBe(1);
    });

    it('flags an unknown System ID as Not Found and never matches by name', async () => {
      // The name belongs to a real student; the System ID does not. A name-only
      // match must never be offered.
      const name = uniqueName('RealName');
      await seedStudent(db!, { id: `student-real-${seq}`, name, className: 'Grade 6-A' });

      const res = await preview([row(2, name, 'student-does-not-exist')]);
      const r = res.rows[0];
      expect(r.matchStatus).toBe('not_found');
      expect(r.reasons).toContain('system_id_not_found');
      expect(r.matchedStudentId).toBeNull();
      expect(r.databaseName).toBeNull();
      expect(r.blocked).toBe(true);
      expect(res.summary.notFoundInDatabase).toBe(1);
      expect(res.summary.foundInDatabase).toBe(0);
    });

    it('flags a missing name as unverified even when the System ID matches', async () => {
      const id = `student-noname-${seq}`;
      await seedStudent(db!, { id, name: uniqueName('HasName'), className: 'Grade 6-A' });

      const res = await preview([row(2, '', id)]);
      const r = res.rows[0];
      expect(r.autoSafe).toBe(false);
      expect(r.requiresReview).toBe(true);
      expect(r.nameMatch).toBe('missing');
      expect(r.reasons).toContain('missing_name');
      expect(res.summary.missingNames).toBe(1);
    });

    it('flags duplicate System IDs in the file as Possible Duplicate (never auto-safe)', async () => {
      const name = uniqueName('DupeId');
      const id = `student-dupe-${seq}`;
      await seedStudent(db!, { id, name, className: 'Grade 2-C' });

      const res = await preview([row(2, name, id), row(3, name, id)]);
      expect(res.rows.every((r) => r.matchStatus === 'possible_duplicate')).toBe(true);
      expect(res.rows.every((r) => r.autoSafe === false)).toBe(true);
      expect(res.rows.every((r) => r.requiresReview)).toBe(true);
      expect(res.summary.duplicateSystemIds).toBe(2);
    });

    it('flags duplicate names with different System IDs as Possible Duplicate', async () => {
      const name = uniqueName('SameName');
      const a = `student-samename-a-${seq}`;
      const b = `student-samename-b-${seq}`;
      await seedStudent(db!, { id: a, name, className: 'Grade 2-C' });
      await seedStudent(db!, { id: b, name, className: 'Grade 2-C' });

      const res = await preview([row(2, name, a), row(3, name, b)]);
      expect(res.rows.map((r) => r.matchStatus)).toEqual(['possible_duplicate', 'possible_duplicate']);
      expect(res.summary.duplicateNames).toBe(2);
      expect(res.summary.readyToDeactivate).toBe(0);
    });

    it('reports a student who is already a Former Student as a no-op', async () => {
      const name = uniqueName('AlreadyFormer');
      const id = `student-former-${seq}`;
      await seedStudent(db!, { id, name, className: 'Grade 7-A', status: 'former', transport: 'LEFT' });

      const res = await preview([row(2, name, id)]);
      const r = res.rows[0];
      expect(r.matchStatus).toBe('already_former');
      expect(r.reasons).toContain('already_former');
      expect(r.autoSafe).toBe(false);
      expect(r.defaultAction).toBe('none');
      expect(res.summary.alreadyFormer).toBe(1);
      expect(res.summary.readyToDeactivate).toBe(0);
    });

    it('counts the whole dashboard summary for a mixed file', async () => {
      const exactName = uniqueName('SummaryExact');
      const exactId = `student-sum-exact-${seq}`;
      const conflictName = uniqueName('SummaryConflict');
      const conflictId = `student-sum-conf-${seq}`;
      const dupeName = uniqueName('SummaryDupe');
      const dupeId = `student-sum-dupe-${seq}`;
      await seedStudent(db!, { id: exactId, name: exactName, className: 'Grade 1-A' });
      await seedStudent(db!, { id: conflictId, name: conflictName, className: 'Grade 1-A' });
      await seedStudent(db!, { id: dupeId, name: dupeName, className: 'Grade 1-A' });

      const res = await preview([
        row(2, exactName, exactId),                        // ✅ exact match
        row(3, 'Not The Same Child', conflictId),          // ⚠️ id match, name differs
        row(4, dupeName, dupeId),                          // ⚠️ duplicate (id + name)
        row(5, dupeName, dupeId),                          // ⚠️ duplicate (id + name)
        row(6, uniqueName('NoSystemId'), ''),              // ⚠️ no System ID → blocked
        row(7, '', 'student-sum-unknown'),                 // ❌ not found (+ no name)
        row(8, uniqueName('Ghost'), 'student-ghost-xyz'),  // ❌ not found
      ]);
      const s = res.summary;
      expect(s.totalUploaded).toBe(7);
      expect(s.validRecords).toBe(5);        // rows 6 and 7 are missing a field
      expect(s.missingNames).toBe(1);
      expect(s.missingSystemIds).toBe(1);
      expect(s.duplicateSystemIds).toBe(2);  // rows 4 + 5
      expect(s.duplicateNames).toBe(2);      // rows 4 + 5
      expect(s.foundInDatabase).toBe(4);
      expect(s.notFoundInDatabase).toBe(2);
      expect(s.exactMatches).toBe(1);
      expect(s.nameConflicts).toBe(1);
      expect(s.possibleDuplicates).toBe(2);
      expect(s.blocked).toBe(3);             // no id + 2 unknown ids
      expect(s.readyToDeactivate).toBe(1);
      expect(s.requiresReview).toBe(3);      // name conflict + 2 duplicates
      expect(res.rows.filter((r) => r.autoSafe).map((r) => r.rowNumber)).toEqual([2]);
      expect(res.rows.map((r) => r.matchStatus)).toEqual([
        'exact_match',
        'id_match_name_conflict',
        'possible_duplicate',
        'possible_duplicate',
        'requires_review',
        'not_found',
        'not_found',
      ]);
    });

    it('writes nothing at all', async () => {
      const before = {
        imports: await countRows('former_student_imports'),
        ledger: await countRows('student_status_changes'),
        audit: await countRows('audit_logs'),
      };
      const name = uniqueName('NoWrites');
      const id = `student-nowrites-${seq}`;
      await seedStudent(db!, { id, name, className: 'Grade 1-A' });

      await preview([row(2, name, id, { action: 'deactivate' })]);

      const s = await studentRow(id);
      expect(s.status).toBe('active');
      expect(await countRows('former_student_imports')).toBe(before.imports);
      expect(await countRows('student_status_changes')).toBe(before.ledger);
      expect(await countRows('audit_logs')).toBe(before.audit);
    });

    it('refuses more rows than the documented maximum', async () => {
      const many = Array.from({ length: 5001 }, (_, i) => row(i + 2, `Student ${i}`, `student-x-${i}`));
      const res = await db!.rpcSafe('preview_former_student_import', { p_rows: many });
      expect(res.error?.message).toMatch(/Too many rows/i);
    });
  });

  // ── 3. Authorization ──────────────────────────────────────────────────────
  describe('authorization', () => {
    const nonAdmins: Array<{ label: string; uid: string | null }> = [
      { label: 'teacher', uid: TEACHER_UID },
      { label: 'parent', uid: PARENT_UID },
      { label: 'supervisor', uid: SUPERVISOR_UID },
      { label: 'anonymous', uid: null },
    ];

    for (const actor of nonAdmins) {
      it(`refuses every cleanup RPC for ${actor.label}`, async () => {
        await db!.setAuthUid(actor.uid);
        const name = uniqueName('AuthCheck');
        const id = `student-auth-${seq}`;
        await db!.setAuthUid(ADMIN_UID);
        await seedStudent(db!, { id, name, className: 'Grade 1-A' });
        await db!.setAuthUid(actor.uid);

        const calls = [
          db!.rpcSafe('preview_former_student_import', { p_rows: [row(2, name, id)] }),
          db!.rpcSafe('apply_former_student_import', { p_rows: [row(2, name, id, { action: 'deactivate' })], p_file_name: 'x.csv' }),
          db!.rpcSafe('list_former_student_imports', { p_limit: 10, p_offset: 0 }),
          db!.rpcSafe('list_former_students', { p_search: '', p_class: null, p_limit: 10, p_offset: 0 }),
          db!.rpcSafe('set_student_former_status', { p_student_id: id, p_status: 'former', p_reason: 'nope' }),
          db!.rpcSafe('rollback_former_student_import', { p_import_id: 'fsi-nope', p_confirm_phrase: ROLLBACK_PHRASE }),
        ];
        const results = await Promise.all(calls);
        for (const r of results) {
          expect(r.error, JSON.stringify(r)).not.toBeNull();
          expect(r.error?.message).toMatch(/admins|administrator|permission denied/i);
        }

        // The student is untouched.
        await db!.setAuthUid(ADMIN_UID);
        expect((await studentRow(id)).status).toBe('active');
      });
    }

    it('does not let a signed-in user call the internal evaluator directly', async () => {
      await db!.exec('SET ROLE authenticated');
      await db!.setAuthUid(TEACHER_UID);
      const res = await db!.rpcSafe('_former_evaluate_rows', { p_rows: [row(2, 'Anyone', 'student-1')] });
      expect(res.error).not.toBeNull();
      expect(res.error?.message).toMatch(/permission denied/i);
      await db!.exec('RESET ROLE');
    });

    it('hides the new audit tables from non-admins through RLS', async () => {
      // Mirror what PostgREST grants a JWT role, so SET ROLE authenticated
      // behaves like a real signed-in request (RLS then applies).
      await db!.exec(`
        GRANT USAGE ON SCHEMA public TO authenticated;
        GRANT SELECT ON public.student_status_changes, public.former_student_imports,
                        public.former_student_import_rows, public.students TO authenticated;
      `);
      const name = uniqueName('RlsCheck');
      const id = `student-rls-${seq}`;
      await seedStudent(db!, { id, name, className: 'Grade 1-A' });
      await apply([row(2, name, id, { action: 'deactivate' })]);

      await db!.setAuthUid(TEACHER_UID);
      await db!.exec('SET ROLE authenticated');
      const ledger = await db!.query('SELECT count(*)::text AS n FROM public.student_status_changes');
      const imports = await db!.query('SELECT count(*)::text AS n FROM public.former_student_imports');
      expect(Number(ledger.rows[0].n)).toBe(0);
      expect(Number(imports.rows[0].n)).toBe(0);

      await db!.exec('RESET ROLE');
      await db!.setAuthUid(ADMIN_UID);
      // ... but no role can write them directly: the ledger has no INSERT policy.
      await db!.exec('SET ROLE authenticated');
      await expect(
        db!.query(`INSERT INTO public.student_status_changes
                     (id, "studentId", "previousStatus", "newStatus", reason)
                   VALUES ('forged', $1, 'active', 'former', 'former_manual')`, [id]),
      ).rejects.toThrow(/row-level security|permission denied/i);
      await db!.exec('RESET ROLE');
    });
  });

  // ── 4. Apply ──────────────────────────────────────────────────────────────
  describe('apply_former_student_import', () => {
    it('marks an exact match as former and preserves every historical record', async () => {
      const name = uniqueName('Applied');
      const id = `student-applied-${seq}`;
      await seedStudent(db!, {
        id, name, className: 'Grade 8-B', parentId: 'parent-1', govId: `GOV-${seq}`,
        parentPhone: '252615550000', transport: '9', familyId: '0421',
      });
      await db!.query(`INSERT INTO public.attendance (id,"studentId","className",date) VALUES ('att-${seq}',$1,'Grade 8-B',CURRENT_DATE)`, [id]);
      await db!.query(`INSERT INTO public.homework (id,"studentId","className",title) VALUES ('hw-${seq}',$1,'Grade 8-B','Old homework')`, [id]);
      await db!.query(`INSERT INTO public.quizzes (id,title,"className") VALUES ('qz-${seq}','Old quiz','Grade 8-B')`);
      await db!.query(`INSERT INTO public.quiz_attempts (id,"quizId","studentId","totalEarned","totalPossible") VALUES ('qa-${seq}',$1,$2,8,10)`, [`qz-${seq}`, id]);
      await db!.query(`INSERT INTO public.release_log ("studentId","familyId") VALUES ($1,'0421')`, [id]);
      await db!.query(`INSERT INTO public.student_enrollments (id,"studentId","className","effectiveFrom",reason) VALUES ('enr-${seq}',$1,'Grade 8-B','2026-06-01','import')`, [id]);
      await seedExam(db!, { id: `exam-${seq}`, studentId: id });

      const before = {
        exams: await countRows('exams', `"studentId" = $1`, [id]),
        attendance: await countRows('attendance', `"studentId" = $1`, [id]),
        homework: await countRows('homework', `"studentId" = $1`, [id]),
        quizAttempts: await countRows('quiz_attempts', `"studentId" = $1`, [id]),
        releases: await countRows('release_log', `"studentId" = $1`, [id]),
        enrollments: await countRows('student_enrollments', `"studentId" = $1`, [id]),
        students: await countRows('students'),
      };

      const res = await apply([row(2, name, id, { action: 'deactivate' })]);
      expect(res.committed).toBe(true);
      expect(res.deactivated).toBe(1);
      expect(res.deleted).toBe(0);
      expect(res.formerStudentIds).toEqual([id]);

      const s = await studentRow(id);
      expect(s.status).toBe('former');
      expect(s.transport).toBe('LEFT');
      expect(s.statusUpdatedBy).toBe(ADMIN_ID);
      expect(s.statusUpdatedAt).toBeTruthy();
      // Identity + relationships preserved exactly.
      expect(s.name).toBe(name);
      expect(s.id).toBe(id);
      expect(s.className).toBe('Grade 8-B');
      expect(s.parentId).toBe('parent-1');
      expect(s.govId).toBe(`GOV-${seq}`);
      expect(s.familyId).toBe('0421');
      expect(s.parentPhone).toBe('252615550000');

      // Every historical child row survived, and no student row was removed.
      expect(await countRows('exams', `"studentId" = $1`, [id])).toBe(before.exams);
      expect(await countRows('attendance', `"studentId" = $1`, [id])).toBe(before.attendance);
      expect(await countRows('homework', `"studentId" = $1`, [id])).toBe(before.homework);
      expect(await countRows('quiz_attempts', `"studentId" = $1`, [id])).toBe(before.quizAttempts);
      expect(await countRows('release_log', `"studentId" = $1`, [id])).toBe(before.releases);
      expect(await countRows('student_enrollments', `"studentId" = $1`, [id])).toBe(before.enrollments);
      expect(await countRows('students')).toBe(before.students);
    });

    it('leaves students who are NOT in the uploaded file completely unchanged', async () => {
      const leaver = uniqueName('Leaver');
      const leaverId = `student-leaver-${seq}`;
      const current = uniqueName('Current');
      const currentId = `student-current-${seq}`;
      await seedStudent(db!, { id: leaverId, name: leaver, className: 'Grade 3-C', transport: 'WALKER' });
      await seedStudent(db!, { id: currentId, name: current, className: 'Grade 3-C', transport: '4' });

      await apply([row(2, leaver, leaverId, { action: 'deactivate' })]);

      const untouched = await studentRow(currentId);
      expect(untouched.status).toBe('active');
      expect(untouched.transport).toBe('4');
      expect(untouched.statusUpdatedBy).toBeNull();
      expect((await studentRow(leaverId)).status).toBe('former');
      expect(await countRows('student_status_changes', `"studentId" = $1`, [currentId])).toBe(0);
    });

    it('honours Keep Active and unselected rows', async () => {
      const a = uniqueName('KeepA'); const aId = `student-keep-a-${seq}`;
      const b = uniqueName('KeepB'); const bId = `student-keep-b-${seq}`;
      await seedStudent(db!, { id: aId, name: a, className: 'Grade 3-C' });
      await seedStudent(db!, { id: bId, name: b, className: 'Grade 3-C' });

      const res = await apply([
        row(2, a, aId, { action: 'keep_active' }),
        row(3, b, bId, { action: 'review' }),
      ]);
      expect(res.deactivated).toBe(0);
      expect(res.keptActive).toBe(1);
      expect((await studentRow(aId)).status).toBe('active');
      expect((await studentRow(bId)).status).toBe('active');
    });

    it('REFUSES a name-conflict row unless the admin confirmed that exact row', async () => {
      const name = uniqueName('Conflicted');
      const id = `student-conf-${seq}`;
      await seedStudent(db!, { id, name, className: 'Grade 4-A' });

      const res = await apply([row(2, 'Someone Else Entirely', id, { action: 'deactivate' })]);
      expect(res.deactivated).toBe(0);
      expect(res.blocked).toBe(1);
      expect(res.skippedRows[0].reason).toBe('requires_manual_review');
      expect((await studentRow(id)).status).toBe('active');

      // Same row, explicitly reviewed and confirmed by the admin.
      const confirmed = await apply([
        row(2, 'Someone Else Entirely', id, { action: 'deactivate', adminConfirmed: true }),
      ]);
      expect(confirmed.deactivated).toBe(1);
      expect((await studentRow(id)).status).toBe('former');
    });

    it('REFUSES missing and unknown System IDs even when the client asks to deactivate', async () => {
      const known = uniqueName('Known');
      const knownId = `student-known-${seq}`;
      await seedStudent(db!, { id: knownId, name: known, className: 'Grade 4-A' });

      const res = await apply([
        row(2, uniqueName('NoId'), '', { action: 'deactivate', adminConfirmed: true }),
        row(3, known, 'student-never-existed', { action: 'deactivate', adminConfirmed: true }),
      ]);
      expect(res.deactivated).toBe(0);
      expect(res.blocked).toBe(2);
      expect((await studentRow(knownId)).status).toBe('active');
    });

    it('skips a student who is already a Former Student without a second ledger row', async () => {
      const name = uniqueName('TwiceFormer');
      const id = `student-twice-${seq}`;
      await seedStudent(db!, { id, name, className: 'Grade 4-A', status: 'former', transport: 'LEFT' });

      const res = await apply([row(2, name, id, { action: 'deactivate' })]);
      expect(res.deactivated).toBe(0);
      expect(res.skipped).toBe(1);
      expect(await countRows('student_status_changes', `"studentId" = $1`, [id])).toBe(0);
    });

    it('writes the ledger, the import history and one audit_logs entry', async () => {
      const name = uniqueName('Audited');
      const id = `student-audit-${seq}`;
      await seedStudent(db!, { id, name, className: 'Grade 9-A', transport: 'CAR', familyId: '0007' });

      const res = await apply([row(2, name, id, { action: 'deactivate' })], 'leavers-october.csv');

      const ledger = await db!.query<{ previousStatus: string; newStatus: string; reason: string; previousTransport: string | null; changedBy: string; changedByName: string; fileName: string; importId: string; studentName: string }>(
        `SELECT * FROM public.student_status_changes WHERE "studentId" = $1 ORDER BY "createdAt" DESC`, [id]);
      expect(ledger.rows).toHaveLength(1);
      expect(ledger.rows[0]).toMatchObject({
        studentName: name, previousStatus: 'active', newStatus: 'former',
        reason: 'former_import', previousTransport: 'CAR',
        changedBy: ADMIN_ID, changedByName: 'Ayaan Admin',
        fileName: 'leavers-october.csv', importId: res.importId,
      });

      const audit = await db!.query<{ details: Record<string, unknown> }>(
        `SELECT details FROM public.audit_logs WHERE action = 'students.former_import' ORDER BY id DESC LIMIT 1`);
      expect(audit.rows[0].details).toMatchObject({
        importId: res.importId, actor: ADMIN_ID, fileName: 'leavers-october.csv',
        uploaded: 1, deactivated: 1, deletedStudents: 0,
      });
      expect(audit.rows[0].details.formerStudentIds).toEqual([id]);

      const history = await db!.rpc<{ total: number; imports: Array<Record<string, unknown>> }>(
        'list_former_student_imports', { p_limit: 5, p_offset: 0 });
      const mine = history.imports.find((i) => i.id === res.importId);
      expect(mine).toMatchObject({
        fileName: 'leavers-october.csv', adminName: 'Ayaan Admin', status: 'applied',
        uploadedCount: 1, exactMatchCount: 1, deactivatedCount: 1,
      });
      expect(Number(mine?.importNumber)).toBeGreaterThan(0);

      const detail = await db!.rpc<{ import: Record<string, unknown>; rows: Array<Record<string, unknown>>; rowTotal: number }>(
        'get_former_student_import', { p_import_id: res.importId, p_limit: 50, p_offset: 0 });
      expect(detail.rowTotal).toBe(1);
      expect(detail.rows[0]).toMatchObject({
        uploadedSystemId: id, matchStatus: 'exact_match', actionTaken: 'deactivated',
        previousStatus: 'active', newStatus: 'former',
      });
    });

    it('applies a whole file of mixed rows exactly as the safety rules say', async () => {
      const exact = uniqueName('MixedExact'); const exactId = `student-mix-exact-${seq}`;
      const conflict = uniqueName('MixedConflict'); const conflictId = `student-mix-conf-${seq}`;
      const keep = uniqueName('MixedKeep'); const keepId = `student-mix-keep-${seq}`;
      await seedStudent(db!, { id: exactId, name: exact, className: 'Grade 2-B' });
      await seedStudent(db!, { id: conflictId, name: conflict, className: 'Grade 2-B' });
      await seedStudent(db!, { id: keepId, name: keep, className: 'Grade 2-B' });

      const res = await apply([
        row(2, exact, exactId, { action: 'deactivate' }),
        row(3, 'Wrong Name On Purpose', conflictId, { action: 'deactivate' }),
        row(4, keep, keepId, { action: 'keep_active' }),
        row(5, uniqueName('Ghost'), 'student-ghost-mixed', { action: 'deactivate' }),
      ]);

      expect(res.deactivated).toBe(1);
      expect(res.blocked).toBe(2);      // name conflict + not found
      expect(res.keptActive).toBe(1);
      expect((await studentRow(exactId)).status).toBe('former');
      expect((await studentRow(conflictId)).status).toBe('active');
      expect((await studentRow(keepId)).status).toBe('active');
    });
  });

  // ── 5. Rollback ───────────────────────────────────────────────────────────
  describe('rollback_former_student_import', () => {
    it('restores the previous status AND the exact previous transport', async () => {
      const name = uniqueName('Rollback');
      const id = `student-rollback-${seq}`;
      await seedStudent(db!, { id, name, className: 'Grade 5-C', transport: '12', familyId: '0088' });

      const res = await apply([row(2, name, id, { action: 'deactivate' })]);
      expect((await studentRow(id)).transport).toBe('LEFT');

      const needsPhrase = await db!.rpcSafe<RollbackResult>('rollback_former_student_import', {
        p_import_id: res.importId, p_confirm_phrase: 'whatever',
      });
      expect(needsPhrase.error?.message).toMatch(/ROLLBACK IMPORT/);
      expect((await studentRow(id)).status).toBe('former');

      const back = await db!.rpc<RollbackResult>('rollback_former_student_import', {
        p_import_id: res.importId, p_confirm_phrase: ROLLBACK_PHRASE,
      });
      expect(back.restored).toBe(1);
      expect(back.importStatus).toBe('rolled_back');

      const s = await studentRow(id);
      expect(s.status).toBe('active');
      expect(s.transport).toBe('12');   // exact previous value, not a default
      expect(s.familyId).toBe('0088');
      expect(await countRows('student_status_changes', `"studentId" = $1 AND reason = 'import_rollback'`, [id])).toBe(1);

      const history = await db!.rpc<{ imports: Array<Record<string, unknown>> }>(
        'list_former_student_imports', { p_limit: 5, p_offset: 0 });
      expect(history.imports.find((i) => i.id === res.importId)).toMatchObject({
        status: 'rolled_back', restoredCount: 1,
      });
    });

    it('refuses to roll the same import back twice', async () => {
      const name = uniqueName('Twice');
      const id = `student-twice-rb-${seq}`;
      await seedStudent(db!, { id, name, className: 'Grade 5-C' });
      const res = await apply([row(2, name, id, { action: 'deactivate' })]);
      await db!.rpc('rollback_former_student_import', { p_import_id: res.importId, p_confirm_phrase: ROLLBACK_PHRASE });

      const again = await db!.rpcSafe('rollback_former_student_import', {
        p_import_id: res.importId, p_confirm_phrase: ROLLBACK_PHRASE,
      });
      expect(again.error?.message).toMatch(/already rolled back/i);
    });

    it('SKIPS a student whose status changed after the import (audit-checked)', async () => {
      const protectedName = uniqueName('Protected');
      const protectedId = `student-protected-${seq}`;
      const normalName = uniqueName('Normal');
      const normalId = `student-normal-${seq}`;
      await seedStudent(db!, { id: protectedId, name: protectedName, className: 'Grade 6-B', transport: 'WALKER' });
      await seedStudent(db!, { id: normalId, name: normalName, className: 'Grade 6-B', transport: 'CAR' });

      const res = await apply([
        row(2, protectedName, protectedId, { action: 'deactivate' }),
        row(3, normalName, normalId, { action: 'deactivate' }),
      ]);
      expect(res.deactivated).toBe(2);

      // An administrator restores this one by hand, then marks them former
      // again (a real, later, unrelated decision).
      await db!.rpc('set_student_former_status', { p_student_id: protectedId, p_status: 'active', p_reason: 'Clerical error' });
      await db!.rpc('set_student_former_status', { p_student_id: protectedId, p_status: 'former', p_reason: 'Left again in November' });
      const manualTransport = (await studentRow(protectedId)).transport;

      const back = await db!.rpc<RollbackResult>('rollback_former_student_import', {
        p_import_id: res.importId, p_confirm_phrase: ROLLBACK_PHRASE,
      });
      expect(back.restored).toBe(1);
      expect(back.skipped).toBe(1);
      expect(back.restoredStudentIds).toEqual([normalId]);
      expect(back.skippedRows[0]).toMatchObject({ studentId: protectedId, reason: 'changed_after_import' });
      expect(back.importStatus).toBe('partially_rolled_back');

      // The later decision stands: the import did not overwrite it.
      expect((await studentRow(protectedId)).status).toBe('former');
      expect((await studentRow(protectedId)).transport).toBe(manualTransport);
      expect((await studentRow(normalId)).status).toBe('active');
      expect((await studentRow(normalId)).transport).toBe('CAR');
    });

    it('only ever touches the students of that one import', async () => {
      const a = uniqueName('BatchA'); const aId = `student-batch-a-${seq}`;
      const b = uniqueName('BatchB'); const bId = `student-batch-b-${seq}`;
      await seedStudent(db!, { id: aId, name: a, className: 'Grade 1-B' });
      await seedStudent(db!, { id: bId, name: b, className: 'Grade 1-B' });

      const importA = await apply([row(2, a, aId, { action: 'deactivate' })], 'batch-a.csv');
      await apply([row(2, b, bId, { action: 'deactivate' })], 'batch-b.csv');

      await db!.rpc('rollback_former_student_import', { p_import_id: importA.importId, p_confirm_phrase: ROLLBACK_PHRASE });
      expect((await studentRow(aId)).status).toBe('active');
      expect((await studentRow(bId)).status).toBe('former');
    });
  });

  // ── 6. Former Students directory + single-student actions ─────────────────
  describe('list_former_students / set_student_former_status', () => {
    it('lists only former students, searchable by name, System ID and class', async () => {
      const name = uniqueName('Directory');
      const id = `student-dir-${seq}`;
      const activeName = uniqueName('StillActive');
      const activeId = `student-dir-active-${seq}`;
      await seedStudent(db!, { id, name, className: 'Grade 12-A', transport: '3' });
      await seedStudent(db!, { id: activeId, name: activeName, className: 'Grade 12-A' });
      await apply([row(2, name, id, { action: 'deactivate' })]);

      const all = await db!.rpc<{ total: number; students: Array<Record<string, any>>; classes: string[] }>(
        'list_former_students', { p_search: '', p_class: null, p_limit: 500, p_offset: 0 });
      expect(all.students.some((s) => s.id === id)).toBe(true);
      expect(all.students.some((s) => s.id === activeId)).toBe(false);
      expect(all.classes).toContain('Grade 12-A');

      const byName = await db!.rpc<{ students: Array<Record<string, any>> }>(
        'list_former_students', { p_search: name, p_class: null, p_limit: 50, p_offset: 0 });
      expect(byName.students.map((s) => s.id)).toEqual([id]);
      expect(byName.students[0]).toMatchObject({
        name, className: 'Grade 12-A', status: 'former', markedFormerBy: ADMIN_ID, markedFormerByName: 'Ayaan Admin',
      });
      expect(byName.students[0].markedFormerAt).toBeTruthy();
      expect(byName.students[0].lastChange).toMatchObject({ reason: 'former_import', by: 'Ayaan Admin' });

      const byId = await db!.rpc<{ students: Array<Record<string, any>> }>(
        'list_former_students', { p_search: id, p_class: null, p_limit: 50, p_offset: 0 });
      expect(byId.students.map((s) => s.id)).toEqual([id]);

      const byClass = await db!.rpc<{ students: Array<Record<string, any>> }>(
        'list_former_students', { p_search: '', p_class: 'Grade 12-A', p_limit: 50, p_offset: 0 });
      expect(byClass.students.every((s) => s.className === 'Grade 12-A')).toBe(true);
      expect(byClass.students.some((s) => s.id === activeId)).toBe(false);
    });

    it('marks one student former and restores them to their previous transport', async () => {
      const name = uniqueName('Manual');
      const id = `student-manual-${seq}`;
      await seedStudent(db!, { id, name, className: 'Grade 7-C', transport: '5' });

      const marked = await db!.rpc<{ changed: boolean; status: string }>('set_student_former_status', {
        p_student_id: id, p_status: 'former', p_reason: 'Family moved abroad',
      });
      expect(marked).toMatchObject({ changed: true, status: 'former' });
      expect((await studentRow(id)).transport).toBe('LEFT');

      // Idempotent: marking again reports "already in state" and adds no ledger row.
      const again = await db!.rpc<{ changed: boolean; reason: string }>('set_student_former_status', {
        p_student_id: id, p_status: 'former', p_reason: 'again',
      });
      expect(again).toMatchObject({ changed: false, reason: 'already_in_state' });
      expect(await countRows('student_status_changes', `"studentId" = $1`, [id])).toBe(1);

      const restored = await db!.rpc<{ changed: boolean; status: string }>('set_student_former_status', {
        p_student_id: id, p_status: 'active', p_reason: 'Re-enrolled',
      });
      expect(restored).toMatchObject({ changed: true, status: 'active' });
      const s = await studentRow(id);
      expect(s.status).toBe('active');
      expect(s.transport).toBe('5');

      const audit = await db!.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM public.audit_logs WHERE action = 'students.status_change' AND details->>'studentId' = $1`, [id]);
      expect(Number(audit.rows[0].n)).toBe(2);
    });

    it('rejects an invalid status and an unknown student', async () => {
      const bad = await db!.rpcSafe('set_student_former_status', { p_student_id: 'student-1', p_status: 'deleted', p_reason: null });
      expect(bad.error?.message).toMatch(/active.*former|Status must be/i);

      const missing = await db!.rpcSafe('set_student_former_status', { p_student_id: 'student-nope', p_status: 'former', p_reason: null });
      expect(missing.error?.message).toMatch(/does not exist/i);
    });
  });

  // ── 7. Active-student surfaces ────────────────────────────────────────────
  describe('current-student surfaces exclude Former Students', () => {
    it('get_system_stats counts active students and reports former separately', async () => {
      const active = uniqueName('StatActive'); const activeId = `student-stat-a-${seq}`;
      const former = uniqueName('StatFormer'); const formerId = `student-stat-f-${seq}`;
      await seedStudent(db!, { id: activeId, name: active, className: 'Grade 3-D' });
      await seedStudent(db!, { id: formerId, name: former, className: 'Grade 3-D' });

      const before = await db!.rpc<{ totalStudents: number; formerStudents: number }>('get_system_stats');
      await apply([row(2, former, formerId, { action: 'deactivate' })]);
      const after = await db!.rpc<{ totalStudents: number; formerStudents: number }>('get_system_stats');

      expect(after.totalStudents).toBe(before.totalStudents - 1);
      expect(after.formerStudents).toBe(before.formerStudents + 1);
    });

    it('promote_students moves active students only', async () => {
      const from = `Grade 4-Promo-${seq}`;
      const active = uniqueName('PromoActive'); const activeId = `student-promo-a-${seq}`;
      const former = uniqueName('PromoFormer'); const formerId = `student-promo-f-${seq}`;
      await seedStudent(db!, { id: activeId, name: active, className: from });
      await seedStudent(db!, { id: formerId, name: former, className: from });
      await apply([row(2, former, formerId, { action: 'deactivate' })]);

      const promoted = await db!.query<{ promoted_id: string }>(
        `SELECT * FROM public.promote_students($1, $2, NULL)`, [from, `Grade 5-Promo-${seq}`]);
      expect(promoted.rows.map((r) => r.promoted_id)).toEqual([activeId]);
      expect((await studentRow(formerId)).className).toBe(from);
      expect((await studentRow(activeId)).className).toBe(`Grade 5-Promo-${seq}`);
    });

    it('teacher_exam_progress and the class progress grid ignore leavers', async () => {
      const cls = `Grade 4-Monitor-${seq}`;
      const a = uniqueName('MonA'); const aId = `student-mon-a-${seq}`;
      const b = uniqueName('MonB'); const bId = `student-mon-b-${seq}`;
      await db!.query(`INSERT INTO public.subjects (id,name) VALUES ('sub-mon-${seq}','Mathematics') ON CONFLICT DO NOTHING`);
      await db!.query(
        `INSERT INTO public.class_subjects (id,"className","subjectId","teacherId") VALUES ('cs-mon-${seq}',$1,$2,'teacher-1')`,
        [cls, `sub-mon-${seq}`]);
      await seedStudent(db!, { id: aId, name: a, className: cls });
      await seedStudent(db!, { id: bId, name: b, className: cls });
      await seedExam(db!, { id: `exam-mon-a-${seq}`, studentId: aId, month: 'October', examType: 'Quiz' });
      await seedExam(db!, { id: `exam-mon-b-${seq}`, studentId: bId, month: 'October', examType: 'Quiz' });

      const before = await db!.query<{ total_students: number }>(
        `SELECT "totalStudents" AS total_students FROM public.teacher_exam_progress
          WHERE "className" = $1 AND month = 'October'`, [cls]);
      expect(Number(before.rows[0]?.total_students)).toBe(2);

      await apply([row(2, b, bId, { action: 'deactivate' })]);

      const after = await db!.query<{ total_students: number }>(
        `SELECT "totalStudents" AS total_students FROM public.teacher_exam_progress
          WHERE "className" = $1 AND month = 'October'`, [cls]);
      expect(Number(after.rows[0]?.total_students)).toBe(1);

      const grid = await db!.rpc<Array<{ studentId: string }>>('get_class_student_subject_progress', {
        p_class_name: cls, p_month: 'October',
      });
      expect(grid.map((g) => g.studentId)).toEqual([aId]);
    });
  });

  // ── 8. Legacy backfill + idempotency ──────────────────────────────────────
  describe('legacy LEFT backfill', () => {
    it('normalizes students already marked transport = LEFT, once and traceably', async () => {
      const name = uniqueName('LegacyLeft');
      const id = `student-legacy-${seq}`;
      await seedStudent(db!, { id, name, className: 'Grade 2-A', transport: 'LEFT', familyId: '0303' });

      // Re-applying the migration is how the backfill reaches rows created
      // after the first run — and proves the whole file is idempotent.
      await db!.exec(readMigration('20261008_former_students_cleanup.sql'));
      await db!.exec(readMigration('20261008_former_students_cleanup.sql'));

      const s = await studentRow(id);
      expect(s.status).toBe('former');
      expect(s.familyId).toBe('0303');       // nothing else was touched
      const ledger = await db!.query<{ reason: string; n: string }>(
        `SELECT reason, count(*)::text AS n FROM public.student_status_changes
          WHERE "studentId" = $1 GROUP BY reason`, [id]);
      expect(ledger.rows).toEqual([{ reason: 'legacy_left_backfill', n: '1' }]);

      const audit = await db!.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM public.audit_logs WHERE action = 'students.status_backfill'`);
      expect(Number(audit.rows[0].n)).toBeGreaterThan(0);
    });

    it('keeps mark_student_left and students.status in sync', async () => {
      const name = uniqueName('FamilyLeft');
      const id = `student-family-left-${seq}`;
      await seedStudent(db!, { id, name, className: 'Grade 2-A', transport: 'WALKER', familyId: '0900' });

      await db!.rpc('mark_student_left', { p_student_id: id, p_left: true });
      let s = await studentRow(id);
      expect(s.status).toBe('former');
      expect(s.transport).toBe('LEFT');
      expect(s.familyId).toBe('0900');       // familyId preserved (unchanged behaviour)

      await db!.rpc('mark_student_left', { p_student_id: id, p_left: false });
      s = await studentRow(id);
      expect(s.status).toBe('active');
      expect(s.transport).toBeNull();
      expect(await countRows('student_status_changes', `"studentId" = $1`, [id])).toBe(2);
    });
  });
});
