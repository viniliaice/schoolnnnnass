// SAFE BATCH MERGE — eligibility contract, executed against real PostgreSQL
// (PGlite) using the ACTUAL shipped migrations. Every assertion here is about
// what the DATABASE decides: the frontend never computes eligibility.
//
// No production database is touched: PGlite is an in-process WASM Postgres that
// is created, seeded with synthetic students and destroyed inside this file.

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  createDuplicateBatchTestDb,
  pgliteAvailable,
  seedEnrollment,
  seedProfile,
  seedStudent,
  type PgDuplicateDb,
} from './pgDuplicateBatchHarness';

const ADMIN_UID = 'aaaaaaaa-0000-4000-8000-000000000001';

interface BatchRow {
  pairKey: string;
  keeperId: string;
  removedId: string;
  studentName: string;
  className: string;
  eligible: boolean;
  severity: string | null;
  exclusionCodes: string[];
  eligibilityCodes: string[];
  keeperIsParentAssigned: boolean;
  keeper: { id: string; parentId: string | null; govId: string | null; parentPhone: string | null; transport: string | null; familyId: string | null; createdAt: string };
  removed: { id: string; parentId: string | null; govId: string | null; parentPhone: string | null; transport: string | null; familyId: string | null; createdAt: string };
  enrollmentAction: string | null;
  history: Record<string, any>;
  resolution: { summary: Record<string, string>; mergeResolution: Record<string, any> };
  fingerprint: string | null;
}

interface BatchReport {
  summary: {
    candidatePairs: number;
    safeCount: number;
    excludedCount: number;
    blockedCount: number;
    needsReviewCount: number;
    studentsToMerge: number;
    recordsToRemove: number;
    studentIdsPreserved: number;
  };
  exclusionReasons: Record<string, number>;
  rows: BatchRow[];
  excludedRows: Array<{ pairKey: string; keeperId: string; removedId: string; studentName: string; className: string; severity: string; exclusionCodes: string[] }>;
  timings: { evaluateMs: number };
}

let db: PgDuplicateDb | null = null;
let seq = 0;

/** Fresh, collision-free student name per scenario (one candidate group each). */
function scenarioName(prefix: string) {
  seq += 1;
  return `${prefix} Test${seq} Xaaji`;
}

async function report(limit = 200): Promise<BatchReport> {
  if (!db) throw new Error('db not ready');
  return db.rpc<BatchReport>('get_safe_duplicate_batch', { p_limit: limit, p_offset: 0, p_include_excluded: true });
}

function findRow(rows: BatchRow[], keeperId: string) {
  return rows.find((r) => r.keeperId === keeperId);
}

interface PairSeed {
  name: string;
  className?: string;
  // keeper-side (record A by default: parent assigned)
  aId?: string;
  aParent?: string | null;
  aGov?: string | null;
  aPhone?: string | null;
  aTransport?: string | null;
  aFamily?: string | null;
  aCreated?: string;
  // removed-side (record B by default: unassigned)
  bId?: string;
  bParent?: string | null;
  bGov?: string | null;
  bPhone?: string | null;
  bTransport?: string | null;
  bFamily?: string | null;
  bCreated?: string;
  // enrollments
  aOpen?: boolean | { className?: string; academicYearId?: string | null };
  bOpen?: boolean | { className?: string; academicYearId?: string | null };
}

/** Seeds a two-record candidate group plus its open enrollments. */
async function seedPair(p: PairSeed) {
  if (!db) throw new Error('db not ready');
  const className = p.className ?? 'Foundation A';
  const aId = p.aId ?? `stu-a-${seq}-${Math.random().toString(36).slice(2, 7)}`;
  const bId = p.bId ?? `stu-b-${seq}-${Math.random().toString(36).slice(2, 7)}`;
  await seedStudent(db, {
    id: aId, name: p.name, className,
    parentId: p.aParent === undefined ? 'parent-1' : p.aParent,
    govId: p.aGov === undefined ? null : p.aGov,
    parentPhone: p.aPhone === undefined ? '634572257' : p.aPhone,
    transport: p.aTransport === undefined ? '25' : p.aTransport,
    familyId: p.aFamily === undefined ? '0010' : p.aFamily,
    createdAt: p.aCreated === undefined ? '2025-03-01T08:00:00Z' : p.aCreated,
  });
  await seedStudent(db, {
    id: bId, name: p.name, className,
    parentId: p.bParent === undefined ? null : p.bParent,
    govId: p.bGov === undefined ? null : p.bGov,
    parentPhone: p.bPhone === undefined ? null : p.bPhone,
    transport: p.bTransport === undefined ? '25' : p.bTransport,
    familyId: p.bFamily === undefined ? null : p.bFamily,
    createdAt: p.bCreated === undefined ? '2026-09-01T08:00:00Z' : p.bCreated,
  });

  const aOpen = p.aOpen === undefined ? true : p.aOpen;
  const bOpen = p.bOpen === undefined ? true : p.bOpen;
  if (aOpen) {
    const cfg = typeof aOpen === 'object' ? aOpen : {};
    await seedEnrollment(db, {
      id: `enr-${aId}-open`, studentId: aId,
      className: cfg.className ?? className,
      academicYearId: cfg.academicYearId === undefined ? 'ay-2026' : cfg.academicYearId,
    });
  }
  if (bOpen) {
    const cfg = typeof bOpen === 'object' ? bOpen : {};
    await seedEnrollment(db, {
      id: `enr-${bId}-open`, studentId: bId,
      className: cfg.className ?? className,
      academicYearId: cfg.academicYearId === undefined ? 'ay-2026' : cfg.academicYearId,
    });
  }
  return { aId, bId, className };
}

beforeAll(async () => {
  if (!(await pgliteAvailable())) return;
  db = await createDuplicateBatchTestDb();
  await db.exec(`
    INSERT INTO public.academic_years (id, name, "isCurrent") VALUES
      ('ay-2026','2026/2027', true), ('ay-2025','2025/2026', false);
    INSERT INTO public.terms (id, name, "academicYearId") VALUES ('term-1','Term 1','ay-2026');
    INSERT INTO public.subjects (id, name) VALUES ('sub-math','Math'), ('sub-eng','English');
  `);
  await seedProfile(db, 'admin-1', 'admin', 'Admin One', ADMIN_UID);
  await seedProfile(db, 'parent-1', 'parent', 'ahmed daahir aadan');
  await seedProfile(db, 'parent-2', 'parent', 'Parent Two');
  await db.setAuthUid(ADMIN_UID);
}, 180_000);

beforeEach(async () => {
  if (!db) return;
  // Isolate scenarios: wipe students (cascades to every child table) + audits.
  await db.exec(`
    DELETE FROM public.students;
    DELETE FROM public.student_merge_audits;
    DELETE FROM public.student_merge_batches;
    DELETE FROM public.audit_logs;
  `);
  await db.setAuthUid(ADMIN_UID);
});

afterAll(async () => { if (db) await db.close(); });

describe('safe batch eligibility — INCLUDED (the common safe pattern)', () => {
  it('includes parent-assigned vs unassigned, same normalized name, same class, no conflicts', async () => {
    if (!db) return;
    const name = scenarioName('Craxmaan');
    const { aId, bId } = await seedPair({ name, aGov: 'GB-77123', aPhone: '634572257', bPhone: null });
    // A has the established history; B is the empty newer record.
    await db.exec(`
      INSERT INTO public.exams (id,"studentId","subjectId",subject,score,total,"examType","assessmentLabel","termId",month,status,date)
      SELECT 'ex-a-'||g, '${aId}', 'sub-math', 'Math', 15, 20, 'CA', 'HW'||g, 'term-1', 'September', 'approved', DATE '2026-09-01'
      FROM generate_series(1,23) g;
      INSERT INTO public.homework (id,"studentId","className",subject,title,"dueDate")
      VALUES ('hw-a-1','${aId}','Foundation A','Math','HW 1', DATE '2026-09-05');
      INSERT INTO public.student_promotions (id,"studentId","fromClass","toClass","academicYearId")
      VALUES ('pr-a-1','${aId}','Foundation B','Foundation A','ay-2026');
    `);

    const res = await report();
    expect(res.summary.candidatePairs).toBe(1);
    expect(res.summary.safeCount).toBe(1);
    expect(res.summary.excludedCount).toBe(0);
    expect(res.summary.studentsToMerge).toBe(1);
    expect(res.summary.recordsToRemove).toBe(1);
    expect(res.summary.studentIdsPreserved).toBe(1);

    const row = res.rows[0];
    expect(row.eligible).toBe(true);
    expect(row.keeperId).toBe(aId);
    expect(row.removedId).toBe(bId);
    expect(row.keeperIsParentAssigned).toBe(true);
    expect(row.removed.parentId).toBeNull();
    expect(row.eligibilityCodes).toEqual(expect.arrayContaining([
      'candidate_group_has_exactly_two_records',
      'same_normalized_name',
      'same_current_class',
      'exactly_one_parent_assigned',
      'keeper_is_parent_assigned',
      'same_transport',
      'parent_phone_keeper_only',
      'enrollment_consolidate',
      'no_history_conflicts',
      'history_transfer_safe',
    ]));
    expect(row.exclusionCodes).toEqual([]);
    expect(row.enrollmentAction).toBe('consolidate');
    expect(row.history.exams).toMatchObject({ keeper: 23, removed: 0, conflicts: 0 });
    expect(row.history.homework).toMatchObject({ keeper: 1, removed: 0 });
    expect(row.history.promotions).toMatchObject({ keeper: 1, removed: 0 });
    expect(row.fingerprint).toMatch(/^[0-9a-f]{32}$/);
    // The resolution handed to the existing merge RPC is fully specified.
    expect(row.resolution.mergeResolution.profile_resolution).toMatchObject({
      name: 'canonical', class_name: 'canonical', parent_id: 'canonical',
      gov_id: 'canonical', parent_phone: 'canonical', transport: 'canonical',
    });
    expect(row.resolution.mergeResolution.enrollment_resolution).toEqual({ action: 'consolidate', keep: 'canonical' });
    expect(row.resolution.mergeResolution.exam_resolution).toEqual([]);
  });

  it('keeps the parent-assigned record even when it is the NEWER Student ID', async () => {
    if (!db) return;
    const name = scenarioName('Newer');
    // Record A: older but unassigned. Record B: newer WITH the parent.
    const { aId, bId } = await seedPair({
      name,
      aParent: null, aCreated: '2024-01-05T08:00:00Z', aPhone: null, aFamily: null,
      bParent: 'parent-1', bCreated: '2026-09-10T08:00:00Z', bPhone: '634000111', bFamily: '0010',
    });
    const res = await report();
    expect(res.summary.safeCount).toBe(1);
    const row = findRow(res.rows, bId);
    expect(row).toBeTruthy();
    // Batch rule is "keep the parent-assigned record" — NOT "keep the older record".
    expect(row!.keeperId).toBe(bId);
    expect(row!.removedId).toBe(aId);
    expect(row!.eligibilityCodes).toContain('keeper_is_parent_assigned');
  });

  it('is name-order independent: (A,B) and (B,A) produce the same keeper and pair key', async () => {
    if (!db) return;
    const name = scenarioName('Order');
    const { aId, bId } = await seedPair({ name });
    const forward = await db.rpc<Record<string, any>>('_safe_batch_evaluate_pair', { p_a_id: aId, p_b_id: bId, p_group_size: 2, p_deep: true });
    const backward = await db.rpc<Record<string, any>>('_safe_batch_evaluate_pair', { p_a_id: bId, p_b_id: aId, p_group_size: 2, p_deep: true });
    expect(forward.keeperId).toBe(aId);
    expect(backward.keeperId).toBe(aId);
    expect(forward.pairKey).toBe(backward.pairKey);
    expect(forward.fingerprint).toBe(backward.fingerprint);
  });

  it('preserves a Gov ID that only exists on the unassigned record (never discarded)', async () => {
    if (!db) return;
    const name = scenarioName('GovMove');
    const { aId, bId } = await seedPair({ name, aGov: null, bGov: 'gb-991' });
    const res = await report();
    const row = findRow(res.rows, aId);
    expect(row?.eligible).toBe(true);
    expect(row?.eligibilityCodes).toContain('gov_id_from_removed_preserved');
    expect(row?.resolution.mergeResolution.profile_resolution.gov_id).toBe('duplicate');
    expect(row?.resolution.summary.govId).toBe('duplicate');
  });

  it('accepts identical Gov IDs written in different formats (existing loose match key)', async () => {
    if (!db) return;
    const name = scenarioName('GovSame');
    const { aId } = await seedPair({ name, aGov: '16-005772', bGov: ' 16005772 ' });
    const res = await report();
    const row = findRow(res.rows, aId);
    expect(row?.eligible).toBe(true);
    expect(row?.eligibilityCodes).toContain('same_gov_id');
  });

  it('accepts a duplicate with real history when nothing conflicts', async () => {
    if (!db) return;
    const name = scenarioName('History');
    const { aId, bId } = await seedPair({ name });
    await db.exec(`
      INSERT INTO public.exams (id,"studentId","subjectId",subject,score,total,"examType","assessmentLabel","termId",month,status,date)
      VALUES ('ex-a-1','${aId}','sub-math','Math',10,20,'CA','HW1','term-1','September','approved', DATE '2026-09-01');
      INSERT INTO public.exams (id,"studentId","subjectId",subject,score,total,"examType","assessmentLabel","termId",month,status,date)
      VALUES ('ex-b-1','${bId}','sub-eng','English',11,20,'CA','HW1','term-1','September','approved', DATE '2026-09-01');
      INSERT INTO public.attendance (id,"studentId","className",date,status) VALUES
        ('at-a-1','${aId}','Foundation A', DATE '2026-09-02','present'),
        ('at-b-1','${bId}','Foundation A', DATE '2026-09-03','present');
      INSERT INTO public.quizzes (id,title) VALUES ('qz-1','Quiz 1');
      INSERT INTO public.quiz_attempts (id,"quizId","studentId",status) VALUES
        ('qa-a-1','qz-1','${aId}','submitted');
      INSERT INTO public.report_comments (id,"studentId","termId","teacherComment") VALUES
        ('rc-b-1','${bId}','term-1','Good');
      INSERT INTO public.release_log ("studentId","familyId","staffId") VALUES ('${bId}','0010','admin-1');
      INSERT INTO public.authorized_pickups (id,name,"phoneNumber","photoPath") VALUES ('pk-1','Driver One','639000000','x.jpg');
      INSERT INTO public.authorized_pickup_students ("authorizedPickupId","studentId") VALUES ('pk-1','${bId}');
      INSERT INTO public.homework (id,"studentId","className",subject,title,"dueDate") VALUES ('hw-b-1','${bId}','Foundation A','Math','HW', DATE '2026-09-09');
      INSERT INTO public.student_promotions (id,"studentId","fromClass","toClass") VALUES ('pr-b-1','${bId}','Foundation B','Foundation A');
    `);
    const res = await report();
    const row = findRow(res.rows, aId);
    expect(row?.eligible).toBe(true);
    expect(row?.exclusionCodes).toEqual([]);
    expect(row?.history.exams).toMatchObject({ keeper: 1, removed: 1, conflicts: 0 });
    expect(row?.history.attendance).toMatchObject({ keeper: 1, removed: 1, conflicts: 0 });
    expect(row?.history.quizAttempts).toMatchObject({ keeper: 1, removed: 0, conflicts: 0 });
    expect(row?.history.reportComments).toMatchObject({ keeper: 0, removed: 1, conflicts: 0 });
    expect(row?.history.releaseLogs).toMatchObject({ keeper: 0, removed: 1, conflicts: 0 });
    expect(row?.history.authorizedPickups).toMatchObject({ keeper: 0, removed: 1 });
  });

  it('supports enrollment transfer when only the unassigned record has an open enrollment', async () => {
    if (!db) return;
    const name = scenarioName('Transfer');
    const { aId } = await seedPair({ name, aOpen: false, bOpen: true });
    const res = await report();
    const row = findRow(res.rows, aId);
    expect(row?.eligible).toBe(true);
    expect(row?.enrollmentAction).toBe('transfer');
    expect(row?.resolution.mergeResolution.enrollment_resolution).toEqual({ action: 'transfer', keep: 'canonical' });
  });

  it('supports preserve_history when the unassigned record has no open enrollment', async () => {
    if (!db) return;
    const name = scenarioName('Preserve');
    const { aId, bId } = await seedPair({ name, aOpen: true, bOpen: false });
    await seedEnrollment(db, { id: `enr-${bId}-hist`, studentId: bId, className: 'Foundation A', academicYearId: 'ay-2025', effectiveFrom: '2025-06-01', effectiveTo: '2026-05-30' });
    const res = await report();
    const row = findRow(res.rows, aId);
    expect(row?.eligible).toBe(true);
    expect(row?.enrollmentAction).toBe('preserve_history');
    expect(row?.history.enrollments).toMatchObject({ keeperOpen: 1, removedOpen: 0, removedHistory: 1 });
  });
});

describe('safe batch eligibility — EXCLUDED profile conflicts', () => {
  it('REGRESSION (current screen): different parent phones → Needs individual review, reason "Parent phone conflict"', async () => {
    if (!db) return;
    // C/raxmaan Axmed Daahir · Foundation A
    //   A: parent ahmed daahir aadan, phone 634572257, transport 25
    //   B: Unassigned,                phone 634453468, transport 25
    const name = 'C/raxmaan Axmed Daahir';
    const { aId } = await seedPair({
      name,
      aPhone: '634572257',
      bPhone: '634453468',
      aTransport: '25',
      bTransport: '25',
    });
    const res = await report();
    expect(res.summary.safeCount).toBe(0);
    expect(res.summary.excludedCount).toBe(1);
    expect(res.summary.blockedCount).toBe(1);
    expect(res.exclusionReasons.parent_phone_conflict).toBe(1);
    const excluded = res.excludedRows.find((r) => r.keeperId === aId);
    expect(excluded?.exclusionCodes).toContain('parent_phone_conflict');
    expect(excluded?.severity).toBe('blocked');
    // Being unassigned is NOT enough: the phone conflict decides.
    expect(excluded?.exclusionCodes).not.toContain('both_parents_assigned');
  });

  it('excludes phone numbers that differ only by the 252 prefix as IDENTICAL (normalized)', async () => {
    if (!db) return;
    const name = scenarioName('PhoneNorm');
    const { aId } = await seedPair({ name, aPhone: '252634572257', bPhone: '634572257' });
    const res = await report();
    const row = findRow(res.rows, aId);
    expect(row?.eligible).toBe(true);
    expect(row?.eligibilityCodes).toContain('same_parent_phone');
  });

  it('treats a phone that only the unassigned record has as transferable, not as an exclusion', async () => {
    // Policy v2 (20261008): one-sided data is missing information on the keeper,
    // not a conflict. The value is carried across instead of forcing a review.
    if (!db) return;
    const name = scenarioName('PhoneOnlyB');
    const { aId } = await seedPair({ name, aPhone: null, bPhone: '634453468' });
    const res = await report();
    expect(res.summary.safeCount).toBe(1);
    const row = findRow(res.rows, aId);
    expect(row?.eligible).toBe(true);
    expect(row?.eligibilityCodes).toContain('parent_phone_from_removed_preserved');
  });

  it('excludes both-parents-assigned pairs (parent conflict)', async () => {
    if (!db) return;
    const name = scenarioName('BothParents');
    const { aId } = await seedPair({ name, aParent: 'parent-1', bParent: 'parent-2' });
    const res = await report();
    expect(res.summary.safeCount).toBe(0);
    const excluded = res.excludedRows.find((r) => r.keeperId === aId);
    expect(excluded?.exclusionCodes).toEqual(expect.arrayContaining(['both_parents_assigned', 'parent_conflict']));
    expect(excluded?.severity).toBe('blocked');
    expect(res.exclusionReasons.both_parents_assigned).toBe(1);
  });

  it('excludes when both records are unassigned (no keeper under the batch rule)', async () => {
    if (!db) return;
    const name = scenarioName('NoParents');
    const { aId, bId } = await seedPair({ name, aParent: null, bParent: null });
    const res = await report();
    expect(res.summary.safeCount).toBe(0);
    const excluded = res.excludedRows.find((r) => r.removedId === bId || r.keeperId === aId);
    expect(excluded?.exclusionCodes).toContain('both_parents_unassigned');
    expect(excluded?.severity).toBe('review');
  });

  it('excludes conflicting Gov IDs', async () => {
    if (!db) return;
    const name = scenarioName('GovClash');
    const { aId } = await seedPair({ name, aGov: '111', bGov: '222' });
    const res = await report();
    expect(res.summary.safeCount).toBe(0);
    expect(res.excludedRows.find((r) => r.keeperId === aId)?.exclusionCodes).toContain('gov_id_conflict');
    expect(res.exclusionReasons.gov_id_conflict).toBe(1);
  });

  it('excludes a Gov ID that belongs to a third student', async () => {
    if (!db) return;
    const name = scenarioName('GovThird');
    const { aId } = await seedPair({ name, aGov: 'THIRD-77', bGov: null });
    // The strict unique index stores 'THIRD 77' differently, but the loose match
    // key (gov_id_match_key) is identical — exactly the case the guard exists for.
    await seedStudent(db, { id: 'stu-third-gov', name: 'Someone Else Entirely', className: 'Grade 9-Z', govId: 'THIRD 77', parentId: 'parent-2', createdAt: '2025-01-01T08:00:00Z' });
    const res = await report();
    expect(res.summary.safeCount).toBe(0);
    expect(res.excludedRows.find((r) => r.keeperId === aId)?.exclusionCodes).toContain('gov_id_belongs_to_third_student');
  });

  it('excludes conflicting transport values', async () => {
    if (!db) return;
    const name = scenarioName('TransportClash');
    const { aId } = await seedPair({ name, aTransport: '25', bTransport: '18' });
    const res = await report();
    expect(res.summary.safeCount).toBe(0);
    expect(res.excludedRows.find((r) => r.keeperId === aId)?.exclusionCodes).toContain('transport_conflict');
    expect(res.exclusionReasons.transport_conflict).toBe(1);
  });

  it('treats a transport value that only the unassigned record has as transferable', async () => {
    // Policy v2: transport is a scalar (WALKER | CAR | bus number) whose only
    // relational link is authorized_pickup_students, which the merge RPC already
    // moves. A blank keeper is missing data, not a conflict.
    if (!db) return;
    const name = scenarioName('TransportOnlyB');
    const { aId } = await seedPair({ name, aTransport: null, bTransport: '25' });
    const res = await report();
    expect(res.summary.safeCount).toBe(1);
    const row = findRow(res.rows, aId);
    expect(row?.eligible).toBe(true);
    expect(row?.eligibilityCodes).toContain('transport_from_removed_preserved');
  });

  it('excludes conflicting family IDs', async () => {
    if (!db) return;
    const name = scenarioName('FamilyClash');
    const { aId } = await seedPair({ name, aFamily: '0010', bFamily: '0099' });
    const res = await report();
    expect(res.excludedRows.find((r) => r.keeperId === aId)?.exclusionCodes).toContain('family_id_conflict');
  });

  it('never treats records in different classes as batch candidates', async () => {
    if (!db) return;
    const name = scenarioName('DiffClass');
    await seedStudent(db, { id: 'stu-dc-a', name, className: 'Foundation A', parentId: 'parent-1', parentPhone: '634572257', transport: '25', createdAt: '2025-01-01T08:00:00Z' });
    await seedStudent(db, { id: 'stu-dc-b', name, className: 'Foundation B', parentId: null, parentPhone: null, transport: '25', createdAt: '2026-01-01T08:00:00Z' });
    const res = await report();
    // Different current class ⇒ not even a candidate group (class changes must
    // preserve the stable Student ID, they are never a batch merge).
    expect(res.summary.candidatePairs).toBe(0);
    expect(res.summary.safeCount).toBe(0);
  });

  it('excludes a candidate group with more than two records', async () => {
    if (!db) return;
    const name = scenarioName('Triple');
    await seedPair({ name });
    await seedStudent(db, { id: 'stu-triple-c', name, className: 'Foundation A', parentId: null, parentPhone: null, transport: '25', createdAt: '2026-09-05T08:00:00Z' });
    const res = await report();
    expect(res.summary.safeCount).toBe(0);
    expect(res.excludedRows[0]?.exclusionCodes).toContain('group_has_more_than_two_records');
  });

  it('excludes a record marked LEFT', async () => {
    if (!db) return;
    const name = scenarioName('Left');
    const { aId } = await seedPair({ name, bTransport: 'LEFT', bPhone: null });
    const res = await report();
    expect(res.summary.safeCount).toBe(0);
    expect(res.excludedRows.find((r) => r.keeperId === aId)?.exclusionCodes).toContain('student_marked_left');
  });

  it('excludes when the assigned parent profile does not exist', async () => {
    if (!db) return;
    const name = scenarioName('GhostParent');
    // students.parentId has an FK in production; drop it for this scenario so the
    // defensive guard can be proven (the merge RPC validates parent existence too).
    await db.exec(`DO $$ DECLARE c RECORD; BEGIN
      FOR c IN SELECT conname FROM pg_constraint
                WHERE conrelid = 'public.students'::regclass AND contype = 'f'
                  AND confrelid = 'public.profiles'::regclass LOOP
        EXECUTE format('ALTER TABLE public.students DROP CONSTRAINT %I', c.conname);
      END LOOP;
    END $$;`);
    try {
      const { aId } = await seedPair({ name, aParent: 'parent-does-not-exist' });
      const res = await report();
      expect(res.summary.safeCount).toBe(0);
      expect(res.excludedRows.find((r) => r.keeperId === aId)?.exclusionCodes).toContain('parent_profile_missing');
    } finally {
      await db.exec('DELETE FROM public.students;');
      await db.exec('ALTER TABLE public.students ADD CONSTRAINT students_parentId_fkey FOREIGN KEY ("parentId") REFERENCES public.profiles(id) ON DELETE SET NULL;');
    }
  });
});

describe('safe batch eligibility — EXCLUDED enrollment + history conflicts', () => {
  it('excludes different academic years on the open enrollments', async () => {
    if (!db) return;
    const name = scenarioName('YearClash');
    const { aId } = await seedPair({ name, aOpen: { academicYearId: 'ay-2026' }, bOpen: { academicYearId: 'ay-2025' } });
    const res = await report();
    expect(res.summary.safeCount).toBe(0);
    expect(res.excludedRows.find((r) => r.keeperId === aId)?.exclusionCodes).toContain('enrollment_year_conflict');
  });

  it('excludes when an open enrollment class disagrees with the current class', async () => {
    if (!db) return;
    const name = scenarioName('EnrClass');
    const { aId } = await seedPair({ name, bOpen: { className: 'Foundation B' } });
    const res = await report();
    expect(res.summary.safeCount).toBe(0);
    expect(res.excludedRows.find((r) => r.keeperId === aId)?.exclusionCodes).toContain('enrollment_class_conflict');
  });

  it('excludes when neither record has an open enrollment (final invariant impossible)', async () => {
    if (!db) return;
    const name = scenarioName('NoOpen');
    const { aId } = await seedPair({ name, aOpen: false, bOpen: false });
    const res = await report();
    expect(res.summary.safeCount).toBe(0);
    expect(res.excludedRows.find((r) => r.keeperId === aId)?.exclusionCodes).toContain('no_open_enrollment');
  });

  it('excludes multiple open enrollments even when the unique index is absent', async () => {
    if (!db) return;
    const name = scenarioName('MultiOpen');
    const { aId } = await seedPair({ name });
    // Production blocks this state with uniq_student_enrollments_open; drop it to
    // prove the batch guard still refuses the ambiguous state.
    await db.exec('DROP INDEX IF EXISTS public.uniq_student_enrollments_open;');
    await seedEnrollment(db, { id: `enr-extra-open`, studentId: aId, className: 'Foundation A', academicYearId: 'ay-2026' });
    const res = await report();
    expect(res.summary.safeCount).toBe(0);
    expect(res.excludedRows.find((r) => r.keeperId === aId)?.exclusionCodes).toContain('multiple_open_enrollments');
    await db.exec(`DELETE FROM public.student_enrollments WHERE id = 'enr-extra-open';`);
    await db.exec('CREATE UNIQUE INDEX uniq_student_enrollments_open ON public.student_enrollments("studentId") WHERE "effectiveTo" IS NULL;');
  });

  it('excludes exam identity conflicts', async () => {
    if (!db) return;
    const name = scenarioName('ExamClash');
    const { aId, bId } = await seedPair({ name });
    await db.exec(`
      INSERT INTO public.exams (id,"studentId","subjectId",subject,score,total,"examType","assessmentLabel","termId",month,status,date) VALUES
        ('ex-a-1','${aId}','sub-math','Math',15,20,'CA','HW1','term-1','September','approved', DATE '2026-09-01'),
        ('ex-b-1','${bId}','sub-math','Math', 9,20,'CA','HW1','term-1','September','approved', DATE '2026-09-01');
    `);
    const res = await report();
    expect(res.summary.safeCount).toBe(0);
    expect(res.excludedRows.find((r) => r.keeperId === aId)?.exclusionCodes).toContain('exam_conflict');
    expect(res.exclusionReasons.exam_conflict).toBe(1);
  });

  it('excludes attendance date conflicts', async () => {
    if (!db) return;
    const name = scenarioName('AttClash');
    const { aId, bId } = await seedPair({ name });
    await db.exec(`
      INSERT INTO public.attendance (id,"studentId","className",date,status) VALUES
        ('at-a-1','${aId}','Foundation A', DATE '2026-09-02','present'),
        ('at-b-1','${bId}','Foundation A', DATE '2026-09-02','absent');
    `);
    const res = await report();
    expect(res.excludedRows.find((r) => r.keeperId === aId)?.exclusionCodes).toContain('attendance_conflict');
  });

  it('excludes quiz attempt conflicts', async () => {
    if (!db) return;
    const name = scenarioName('QuizClash');
    const { aId, bId } = await seedPair({ name });
    await db.exec(`
      INSERT INTO public.quizzes (id,title) VALUES ('qz-c1','Quiz C1');
      INSERT INTO public.quiz_attempts (id,"quizId","studentId",status,"totalEarned") VALUES
        ('qa-a-1','qz-c1','${aId}','submitted',8),
        ('qa-b-1','qz-c1','${bId}','submitted',3);
    `);
    const res = await report();
    expect(res.excludedRows.find((r) => r.keeperId === aId)?.exclusionCodes).toContain('quiz_conflict');
  });

  it('excludes release log conflicts (same UTC day)', async () => {
    if (!db) return;
    const name = scenarioName('RelClash');
    const { aId, bId } = await seedPair({ name });
    await db.exec(`
      INSERT INTO public.release_log ("studentId","familyId","staffId","createdAt") VALUES
        ('${aId}','0010','admin-1','2026-09-03T10:00:00Z'),
        ('${bId}','0010','admin-1','2026-09-03T15:00:00Z');
    `);
    const res = await report();
    expect(res.excludedRows.find((r) => r.keeperId === aId)?.exclusionCodes).toContain('release_conflict');
  });

  it('excludes report comment conflicts (same term)', async () => {
    if (!db) return;
    const name = scenarioName('RepClash');
    const { aId, bId } = await seedPair({ name });
    await db.exec(`
      INSERT INTO public.report_comments (id,"studentId","termId","teacherComment") VALUES
        ('rc-a-1','${aId}','term-1','Excellent'),
        ('rc-b-1','${bId}','term-1','Needs support');
    `);
    const res = await report();
    expect(res.excludedRows.find((r) => r.keeperId === aId)?.exclusionCodes).toContain('report_comment_conflict');
  });

  it('excludes a duplicate with rows in a student relationship the merge does not move', async () => {
    if (!db) return;
    const name = scenarioName('UnhandledChild');
    const { aId, bId } = await seedPair({ name });
    // A NEW child table (ON DELETE CASCADE) would silently destroy data on delete.
    await db.exec(`
      CREATE TABLE IF NOT EXISTS public.student_documents (
        id TEXT PRIMARY KEY,
        "studentId" TEXT NOT NULL REFERENCES public.students(id) ON DELETE CASCADE,
        title TEXT
      );
      INSERT INTO public.student_documents (id,"studentId",title) VALUES ('doc-1','${bId}','Birth certificate');
    `);
    const res = await report();
    expect(res.summary.safeCount).toBe(0);
    expect(res.excludedRows.find((r) => r.keeperId === aId)?.exclusionCodes).toContain('unhandled_child_dependency');
    await db.exec('DROP TABLE IF EXISTS public.student_documents;');
  });
});

describe('safe batch eligibility — reporting + performance', () => {
  it('reports per-reason exclusion counts across many groups (summary-first)', async () => {
    if (!db) return;
    await seedPair({ name: scenarioName('Safe1') });
    await seedPair({ name: scenarioName('Safe2') });
    await seedPair({ name: scenarioName('PhoneX'), aPhone: '634572257', bPhone: '634453468' });
    await seedPair({ name: scenarioName('GovX'), aGov: '111', bGov: '222' });
    await seedPair({ name: scenarioName('ParentsX'), aParent: 'parent-1', bParent: 'parent-2' });

    const res = await report();
    expect(res.summary.candidatePairs).toBe(5);
    expect(res.summary.safeCount).toBe(2);
    expect(res.summary.excludedCount).toBe(3);
    expect(res.summary.blockedCount).toBe(3);
    expect(res.summary.needsReviewCount).toBe(0);
    expect(res.exclusionReasons).toMatchObject({
      parent_phone_conflict: 1,
      gov_id_conflict: 1,
      both_parents_assigned: 1,
    });
    expect(res.rows).toHaveLength(2);
    expect(res.excludedRows).toHaveLength(3);
  });

  it('paginates the safe rows without recomputing eligibility client-side', async () => {
    if (!db) return;
    for (let i = 0; i < 5; i += 1) await seedPair({ name: scenarioName(`Page${i}`) });
    const page1 = await db.rpc<BatchReport>('get_safe_duplicate_batch', { p_limit: 2, p_offset: 0, p_include_excluded: false });
    const page2 = await db.rpc<BatchReport>('get_safe_duplicate_batch', { p_limit: 2, p_offset: 2, p_include_excluded: false });
    expect(page1.rows).toHaveLength(2);
    expect(page2.rows).toHaveLength(2);
    expect(page1.summary.safeCount).toBe(5);
    expect(page2.summary.safeCount).toBe(5);
    expect(page1.rows.map((r) => r.pairKey)).not.toEqual(page2.rows.map((r) => r.pairKey));
    expect(page1.excludedRows).toEqual([]);
  });

  it('evaluates a few hundred candidate groups quickly and reports timings', async () => {
    if (!db) return;
    const N = 240;
    const values: string[] = [];
    for (let i = 0; i < N; i += 1) {
      const nm = `Perf Student${i} Name`;
      values.push(`('perf-a-${i}','${nm}','Foundation A','parent-1',NULL,'634572257','25','00${i % 100}','2025-01-01T08:00:00Z')`);
      values.push(`('perf-b-${i}','${nm}','Foundation A',NULL,NULL,NULL,'25',NULL,'2026-01-01T08:00:00Z')`);
    }
    await db.exec(`INSERT INTO public.students (id,name,"className","parentId","govId","parentPhone",transport,"familyId","createdAt") VALUES ${values.join(',')};`);
    const enr: string[] = [];
    for (let i = 0; i < N; i += 1) {
      enr.push(`('perf-enr-a-${i}','perf-a-${i}','Foundation A','ay-2026', DATE '2026-06-01', NULL,'import','perf')`);
      enr.push(`('perf-enr-b-${i}','perf-b-${i}','Foundation A','ay-2026', DATE '2026-09-01', NULL,'import','perf')`);
    }
    await db.exec(`INSERT INTO public.student_enrollments (id,"studentId","className","academicYearId","effectiveFrom","effectiveTo",reason,"sourceRef") VALUES ${enr.join(',')};`);

    const t0 = Date.now();
    const res = await report(50);
    const wallMs = Date.now() - t0;
    expect(res.summary.candidatePairs).toBe(N);
    expect(res.summary.safeCount).toBe(N);
    expect(res.rows).toHaveLength(50); // summary-first: only the page is shipped
    expect(typeof res.timings.evaluateMs).toBe('number');
    // PGlite (WASM) is slower than production Postgres; this bound is generous
    // and exists to catch an accidental O(n²) blow-up, not to benchmark.
    expect(res.timings.evaluateMs).toBeLessThan(60_000);
    expect(wallMs).toBeLessThan(90_000);
    // eslint-disable-next-line no-console
    console.log(`[perf] ${N} candidate groups → safe batch report in ${res.timings.evaluateMs} ms (wall ${wallMs} ms)`);
  }, 180_000);
});
