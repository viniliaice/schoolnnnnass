// SAFE BATCH MERGE — execution, chunking, staleness, authorization, audit and
// rollback, executed against real PostgreSQL (PGlite) with the ACTUAL shipped
// migrations (20260922 + 20260924 + 20260925).
//
// No production database is involved: PGlite is an in-process WASM Postgres
// created and destroyed inside this file, seeded only with synthetic students.

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  createDuplicateBatchTestDb,
  pgliteAvailable,
  seedEnrollment,
  seedProfile,
  seedStudent,
  type PgDuplicateDb,
} from './pgDuplicateBatchHarness';

const ADMIN_UID = 'bbbbbbbb-0000-4000-8000-000000000001';
const TEACHER_UID = 'bbbbbbbb-0000-4000-8000-000000000002';
const PARENT_UID = 'bbbbbbbb-0000-4000-8000-000000000003';
const SUPERVISOR_UID = 'bbbbbbbb-0000-4000-8000-000000000004';
const PHRASE = 'MERGE SAFE DUPLICATES';

interface MergedEntry {
  pairKey: string;
  keeperId: string;
  removedId: string;
  studentName: string;
  className: string;
  auditId: string;
  preservedStudentId: string;
  removedStudentId: string;
  enrollmentAction: Record<string, unknown>;
  before: Record<string, unknown>;
  after: Record<string, unknown>;
}

interface ChunkResult {
  batchId: string;
  adminId: string;
  policy: string;
  chunkSize: number;
  atomicChunk: boolean;
  committed: boolean;
  merged: MergedEntry[];
  skipped: Array<{ pairKey: string; reason: string; codes: string[] }>;
  blocked: Array<{ pairKey: string; reason: string; codes: string[]; severity?: string }>;
  failed: unknown[];
  totals: { eligibleAtStart: number; examined: number; merged: number; skipped: number; blocked: number; failed: number; remaining: number };
  durationMs: number;
}

interface PreviewResult {
  batchId: string;
  previewToken: string;
  dryRun: boolean;
  writesPerformed: number;
  confirmPhrase: string;
  ready: { studentsToMerge: number; recordsToBeRemoved: number; studentIdsPreserved: number };
  chunkPlan: { chunkSize: number; chunks: number; atomicPerChunk: boolean };
  assertions: Record<string, boolean>;
  rows: Array<{ pairKey: string; keeperId: string; removedId: string; studentName: string; className: string; fingerprint: string; history: Record<string, any>; keeper: Record<string, any>; removed: Record<string, any> }>;
  summary: { candidatePairs: number; safeCount: number; excludedCount: number; blockedCount: number; needsReviewCount: number };
  exclusionReasons: Record<string, number>;
  timings: Record<string, number>;
}

let db: PgDuplicateDb | null = null;
let seq = 0;

function uniqueName(prefix: string) {
  seq += 1;
  return `${prefix} Batch${seq} Student`;
}

async function preview(limit = 500): Promise<PreviewResult> {
  if (!db) throw new Error('db not ready');
  return db.rpc<PreviewResult>('preview_safe_duplicate_batch', { p_limit: limit });
}

/** Advisory reviewed list built from a preview (exactly what the UI sends). */
function reviewedList(p: PreviewResult) {
  return p.rows.map((r) => ({ keeperId: r.keeperId, removedId: r.removedId, fingerprint: r.fingerprint, pairKey: r.pairKey }));
}

async function runBatch(opts: {
  pairs?: unknown;
  chunkSize?: number;
  phrase?: string | null;
  reason?: string;
  batchId?: string;
}) {
  if (!db) throw new Error('db not ready');
  return db.rpc<ChunkResult>('merge_safe_duplicate_batch', {
    p_pairs: opts.pairs === undefined ? null : opts.pairs,
    p_chunk_size: opts.chunkSize ?? 25,
    p_confirm_phrase: opts.phrase === undefined ? PHRASE : opts.phrase,
    p_reason: opts.reason ?? 'September duplicate cleanup',
    p_batch_id: opts.batchId ?? null,
  });
}

interface SeedOpts {
  name?: string;
  className?: string;
  aPhone?: string | null;
  bPhone?: string | null;
  aGov?: string | null;
  bGov?: string | null;
  aParent?: string | null;
  bParent?: string | null;
  aTransport?: string | null;
  bTransport?: string | null;
  withHistory?: boolean;
  keeperIsNewer?: boolean;
}

/** Seeds one safe-by-default candidate pair and returns its ids. */
async function seedSafePair(opts: SeedOpts = {}) {
  if (!db) throw new Error('db not ready');
  const name = opts.name ?? uniqueName('Safe');
  const className = opts.className ?? 'Foundation A';
  const aId = `stu-ba-${seq}-${Math.random().toString(36).slice(2, 7)}`;
  const bId = `stu-bb-${seq}-${Math.random().toString(36).slice(2, 7)}`;
  const keeperIsNewer = !!opts.keeperIsNewer;

  await seedStudent(db, {
    id: aId, name, className,
    parentId: opts.aParent === undefined ? (keeperIsNewer ? null : 'parent-1') : opts.aParent,
    govId: opts.aGov === undefined ? null : opts.aGov,
    parentPhone: opts.aPhone === undefined ? (keeperIsNewer ? null : '634572257') : opts.aPhone,
    transport: opts.aTransport === undefined ? '25' : opts.aTransport,
    familyId: keeperIsNewer ? null : '0010',
    createdAt: keeperIsNewer ? '2026-09-20T08:00:00Z' : '2025-02-01T08:00:00Z',
  });
  await seedStudent(db, {
    id: bId, name, className,
    parentId: opts.bParent === undefined ? (keeperIsNewer ? 'parent-1' : null) : opts.bParent,
    govId: opts.bGov === undefined ? null : opts.bGov,
    parentPhone: opts.bPhone === undefined ? (keeperIsNewer ? '634572257' : null) : opts.bPhone,
    transport: opts.bTransport === undefined ? '25' : opts.bTransport,
    familyId: keeperIsNewer ? '0010' : null,
    createdAt: keeperIsNewer ? '2025-01-01T08:00:00Z' : '2026-09-10T08:00:00Z',
  });
  await seedEnrollment(db, { id: `enr-${aId}`, studentId: aId, className, academicYearId: 'ay-2026', effectiveFrom: '2026-06-01' });
  await seedEnrollment(db, { id: `enr-${bId}`, studentId: bId, className, academicYearId: 'ay-2026', effectiveFrom: '2026-09-01' });

  const keeperId = keeperIsNewer ? bId : aId;
  const removedId = keeperIsNewer ? aId : bId;

  if (opts.withHistory) {
    await db.exec(`
      INSERT INTO public.exams (id,"studentId","subjectId",subject,score,total,"examType","assessmentLabel","termId",month,status,date)
      SELECT 'ex-${keeperId}-'||g, '${keeperId}', 'sub-math', 'Math', 15, 20, 'CA', 'HW'||g, 'term-1', 'September','approved', DATE '2026-09-01'
      FROM generate_series(1,23) g;
      INSERT INTO public.homework (id,"studentId","className",subject,title,"dueDate")
      VALUES ('hw-${keeperId}','${keeperId}','${className}','Math','HW', DATE '2026-09-05');
      INSERT INTO public.student_promotions (id,"studentId","fromClass","toClass","academicYearId")
      VALUES ('pr-${keeperId}','${keeperId}','Foundation B','${className}','ay-2026');
      INSERT INTO public.exams (id,"studentId","subjectId",subject,score,total,"examType","assessmentLabel","termId",month,status,date)
      VALUES ('ex-${removedId}-1','${removedId}','sub-eng','English',12,20,'CA','HW9','term-1','September','approved', DATE '2026-09-04');
    `);
  }
  return { aId, bId, keeperId, removedId, name, className };
}

async function seedManySafePairs(n: number, prefix = 'Bulk') {
  const out: Array<{ keeperId: string; removedId: string; name: string }> = [];
  for (let i = 0; i < n; i += 1) {
    out.push(await seedSafePair({ name: `${prefix}${i} Batch Student`, className: 'Foundation A' }));
  }
  return out;
}

async function countStudents() {
  if (!db) throw new Error('db not ready');
  const { rows } = await db.query<{ n: string }>('SELECT count(*)::text AS n FROM public.students');
  return Number(rows[0].n);
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
  await seedProfile(db, 'teacher-1', 'teacher', 'Teacher One', TEACHER_UID);
  await seedProfile(db, 'parent-1', 'parent', 'ahmed daahir aadan', PARENT_UID);
  await seedProfile(db, 'supervisor-1', 'supervisor', 'Supervisor One', SUPERVISOR_UID);
  await db.setAuthUid(ADMIN_UID);
}, 180_000);

beforeEach(async () => {
  if (!db) return;
  await db.exec(`
    DROP TRIGGER IF EXISTS poison_exam_transfer ON public.exams;
    DELETE FROM public.students;
    DELETE FROM public.student_merge_audits;
    DELETE FROM public.student_merge_batches;
    DELETE FROM public.audit_logs;
  `);
  await db.setAuthUid(ADMIN_UID);
});

afterAll(async () => { if (db) await db.close(); });

describe('safe batch execution — happy path and invariants', () => {
  it('merges the safe pair, preserves the parent-assigned Student ID and removes the duplicate', async () => {
    if (!db) return;
    const { keeperId, removedId } = await seedSafePair({ withHistory: true });
    const p = await preview();
    expect(p.dryRun).toBe(true);
    expect(p.writesPerformed).toBe(0);
    expect(p.ready).toEqual({ studentsToMerge: 1, recordsToBeRemoved: 1, studentIdsPreserved: 1 });
    expect(p.chunkPlan).toMatchObject({ chunkSize: 25, chunks: 1, atomicPerChunk: true });
    expect(p.confirmPhrase).toBe(PHRASE);
    expect(Object.values(p.assertions).every(Boolean)).toBe(true);

    const before = await countStudents();
    const res = await runBatch({ pairs: reviewedList(p), batchId: p.batchId });

    expect(res.committed).toBe(true);
    expect(res.atomicChunk).toBe(true);
    expect(res.totals).toMatchObject({ merged: 1, skipped: 0, blocked: 0, failed: 0, remaining: 0 });
    expect(res.merged).toHaveLength(1);
    expect(res.merged[0].preservedStudentId).toBe(keeperId);
    expect(res.merged[0].removedStudentId).toBe(removedId);
    expect(res.failed).toEqual([]);

    // Final invariants
    const { rows: keeper } = await db.query<{ id: string; open: string }>(
      `SELECT s.id, (SELECT count(*)::text FROM public.student_enrollments e WHERE e."studentId" = s.id AND e."effectiveTo" IS NULL) AS open
       FROM public.students s WHERE s.id = $1`, [keeperId]);
    expect(keeper).toHaveLength(1);
    expect(keeper[0].open).toBe('1'); // exactly one open enrollment on the keeper

    const { rows: gone } = await db.query('SELECT id FROM public.students WHERE id = $1', [removedId]);
    expect(gone).toHaveLength(0); // duplicate deleted

    const { rows: leftovers } = await db.query<{ tbl: string; n: string }>(`
      SELECT 'exams' AS tbl, count(*)::text AS n FROM public.exams WHERE "studentId"=$1
      UNION ALL SELECT 'attendance', count(*)::text FROM public.attendance WHERE "studentId"=$1
      UNION ALL SELECT 'homework', count(*)::text FROM public.homework WHERE "studentId"=$1
      UNION ALL SELECT 'promotions', count(*)::text FROM public.student_promotions WHERE "studentId"=$1
      UNION ALL SELECT 'quiz', count(*)::text FROM public.quiz_attempts WHERE "studentId"=$1
      UNION ALL SELECT 'pickups', count(*)::text FROM public.authorized_pickup_students WHERE "studentId"=$1
      UNION ALL SELECT 'release', count(*)::text FROM public.release_log WHERE "studentId"=$1
      UNION ALL SELECT 'reports', count(*)::text FROM public.report_comments WHERE "studentId"=$1
      UNION ALL SELECT 'enrollments', count(*)::text FROM public.student_enrollments WHERE "studentId"=$1`, [removedId]);
    for (const row of leftovers) expect(row.n, `${row.tbl} rows left on the removed student`).toBe('0');

    // History moved to the keeper, nothing lost
    const { rows: moved } = await db.query<{ n: string }>(
      'SELECT count(*)::text AS n FROM public.exams WHERE "studentId"=$1', [keeperId]);
    expect(Number(moved[0].n)).toBe(24); // 23 keeper + 1 removed
    expect(await countStudents()).toBe(before - 1);
  });

  it('keeps the NEWER Student ID when that record is the parent-assigned one', async () => {
    if (!db) return;
    const { keeperId, removedId } = await seedSafePair({ keeperIsNewer: true });
    const p = await preview();
    expect(p.rows[0].keeperId).toBe(keeperId);
    const res = await runBatch({ pairs: reviewedList(p), batchId: p.batchId });
    expect(res.merged[0].preservedStudentId).toBe(keeperId);
    const { rows } = await db.query('SELECT id, "createdAt" FROM public.students WHERE id = $1', [keeperId]);
    expect(rows).toHaveLength(1);
    const { rows: gone } = await db.query('SELECT id FROM public.students WHERE id = $1', [removedId]);
    expect(gone).toHaveLength(0);
  });

  it('never rewrites the keeper profile bytes it promised to keep (gov id + phone stay as stored)', async () => {
    if (!db) return;
    // Lowercase Gov ID and a 252-prefixed phone: the shared merge RPC stores them
    // normalized, the batch policy must leave the keeper's own values untouched.
    const { keeperId } = await seedSafePair({ aGov: 'gb-0042', aPhone: '252634572257' });
    const p = await preview();
    const res = await runBatch({ pairs: reviewedList(p), batchId: p.batchId });
    expect(res.totals.merged).toBe(1);
    const { rows } = await db.query<{ govId: string | null; parentPhone: string | null; name: string; className: string; transport: string | null; parentId: string | null }>(
      'SELECT "govId", "parentPhone", name, "className", transport, "parentId" FROM public.students WHERE id=$1', [keeperId]);
    expect(rows[0].govId).toBe('gb-0042');
    expect(rows[0].parentPhone).toBe('252634572257');
    expect(rows[0].transport).toBe('25');
    expect(rows[0].parentId).toBe('parent-1');
  });

  it('moves a Gov ID that only existed on the unassigned record onto the keeper', async () => {
    if (!db) return;
    const { keeperId } = await seedSafePair({ aGov: null, bGov: 'gb-only-on-b' });
    const p = await preview();
    expect(p.rows[0].fingerprint).toBeTruthy();
    const res = await runBatch({ pairs: reviewedList(p), batchId: p.batchId });
    expect(res.totals.merged).toBe(1);
    const { rows } = await db.query<{ govId: string | null }>('SELECT "govId" FROM public.students WHERE id=$1', [keeperId]);
    expect(rows[0].govId).toBe('gb-only-on-b'); // preserved byte-for-byte, not discarded
  });

  it('leaves third-party history rows untouched', async () => {
    if (!db) return;
    const { keeperId, removedId } = await seedSafePair({ withHistory: true });
    await seedStudent(db, { id: 'stu-bystander', name: 'Bystander Pupil', className: 'Grade 9-Z', parentId: 'parent-1', govId: 'BY-1', createdAt: '2025-01-01T08:00:00Z' });
    await db.exec(`
      INSERT INTO public.exams (id,"studentId","subjectId",subject,score,total,"examType","assessmentLabel","termId",month,status,date)
      VALUES ('ex-bystander','stu-bystander','sub-math','Math',19,20,'CA','HW1','term-1','September','approved', DATE '2026-09-01');
      INSERT INTO public.attendance (id,"studentId","className",date,status) VALUES ('at-bystander','stu-bystander','Grade 9-Z', DATE '2026-09-02','present');
    `);
    const p = await preview();
    await runBatch({ pairs: reviewedList(p), batchId: p.batchId });
    const { rows } = await db.query<{ n: string }>(`
      SELECT ((SELECT count(*) FROM public.exams WHERE "studentId"='stu-bystander')
            + (SELECT count(*) FROM public.attendance WHERE "studentId"='stu-bystander'))::text AS n`);
    expect(Number(rows[0].n)).toBe(2);
    const { rows: exams } = await db.query<{ n: string }>('SELECT count(*)::text AS n FROM public.exams WHERE "studentId"=$1', [removedId]);
    expect(Number(exams[0].n)).toBe(0);
    const { rows: keeperExams } = await db.query<{ n: string }>('SELECT count(*)::text AS n FROM public.exams WHERE "studentId"=$1', [keeperId]);
    expect(Number(keeperExams[0].n)).toBe(24);
  });

  it('runs the existing guided workflow on a pair the batch excluded (individual review intact)', async () => {
    if (!db) return;
    // Phone conflict → excluded from the batch, still mergeable individually.
    const { keeperId, removedId } = await seedSafePair({ bPhone: '634453468' });
    const p = await preview();
    expect(p.summary.safeCount).toBe(0);
    expect(p.summary.excludedCount).toBe(1);

    const conflicts = await db.rpc<Record<string, any>>('get_merge_conflicts', { p_canonical_id: keeperId, p_duplicate_id: removedId });
    expect(conflicts.profile.phoneConflict).toBe(true);

    const merged = await db.rpc<Record<string, any>>('merge_duplicate_students_resolved', {
      p_canonical_id: keeperId,
      p_duplicate_id: removedId,
      p_resolution: {
        profile_resolution: { name: 'canonical', class_name: 'canonical', gov_id: 'canonical', parent_id: 'canonical', parent_phone: 'canonical', transport: 'canonical' },
        exam_resolution: [], attendance_resolution: [], quiz_resolution: [], release_resolution: [], report_comment_resolution: [],
        enrollment_resolution: { action: 'consolidate', keep: 'canonical' },
      },
      p_reason: 'Individual review: phone conflict resolved by administrator',
    });
    expect(merged.auditId).toBeTruthy();
    const { rows } = await db.query('SELECT id FROM public.students WHERE id=$1', [removedId]);
    expect(rows).toHaveLength(0);
    const { rows: audits } = await db.query<{ merge_kind: string; batch_id: string | null }>(
      'SELECT merge_kind, batch_id FROM public.student_merge_audits WHERE id=$1', [merged.auditId]);
    expect(audits[0].merge_kind).toBe('individual'); // batch columns untouched
    expect(audits[0].batch_id).toBeNull();
  });
});

describe('safe batch execution — audit trail', () => {
  it('writes one detailed audit row per merged student, stamped with batch metadata', async () => {
    if (!db) return;
    const pairs = await seedManySafePairs(3, 'Audit');
    const p = await preview();
    const res = await runBatch({ pairs: reviewedList(p), batchId: p.batchId, reason: 'September duplicate cleanup' });
    expect(res.totals.merged).toBe(3);

    const { rows: audits } = await db.query<Record<string, any>>(
      `SELECT id, canonical_id, duplicate_id, admin_id, reason, before_counts, after_counts,
              enrollment_action, exam_conflicts, batch_id, batch_policy, batch_size, merge_kind, created_at
       FROM public.student_merge_audits ORDER BY canonical_id`);
    expect(audits).toHaveLength(3); // NOT one vague "3 students merged" record
    for (const a of audits) {
      expect(pairs.some((x) => x.keeperId === a.canonical_id)).toBe(true);
      expect(pairs.some((x) => x.removedId === a.duplicate_id)).toBe(true);
      expect(a.admin_id).toBe('admin-1');
      expect(a.merge_kind).toBe('safe_batch');
      expect(a.batch_id).toBe(p.batchId);
      expect(a.batch_policy).toBe('safe_batch_parent_assigned_keeper');
      expect(a.batch_size).toBe(25);
      expect(a.reason).toContain('Safe batch merge');
      expect(a.reason).toContain('September duplicate cleanup');
      expect(a.before_counts).toBeTruthy();
      expect(a.after_counts).toBeTruthy();
      expect(a.enrollment_action).toBeTruthy();
      expect(a.exam_conflicts).toBeTruthy();
      expect(a.created_at).toBeTruthy();
    }

    // Per-merge + per-chunk entries in the general audit log
    const { rows: logs } = await db.query<{ action: string; n: string }>(
      'SELECT action, count(*)::text AS n FROM public.audit_logs GROUP BY action ORDER BY action');
    const asMap = Object.fromEntries(logs.map((l) => [l.action, Number(l.n)]));
    expect(asMap['students.merge']).toBe(3);
    expect(asMap['students.merge_batch']).toBe(1);

    const { rows: batchLog } = await db.query<{ details: any }>(
      `SELECT details FROM public.audit_logs WHERE action='students.merge_batch' ORDER BY id DESC LIMIT 1`);
    expect(batchLog[0].details.batchId).toBe(p.batchId);
    expect(batchLog[0].details.actor).toBe('admin-1');
    expect(batchLog[0].details.policy).toBe('safe_batch_parent_assigned_keeper');
    expect(batchLog[0].details.preservedStudentIds).toHaveLength(3);
    expect(batchLog[0].details.removedStudentIds).toHaveLength(3);
    expect(batchLog[0].details.auditIds).toHaveLength(3);

    // Batch metadata row answers "which students, who, what rule, when"
    const { rows: batches } = await db.query<Record<string, any>>('SELECT * FROM public.student_merge_batches');
    expect(batches).toHaveLength(1);
    expect(batches[0]).toMatchObject({
      id: p.batchId, admin_id: 'admin-1', policy: 'safe_batch_parent_assigned_keeper',
      chunk_size: 25, chunks_run: 1, merged_count: 3, skipped_count: 0, blocked_count: 0, failed_count: 0,
    });
    expect(batches[0].chunk_results).toHaveLength(1);
  });

  it('answers "which students did this batch merge?" from the audit tables alone', async () => {
    if (!db) return;
    const pairs = await seedManySafePairs(2, 'Trace');
    const p = await preview();
    await runBatch({ pairs: reviewedList(p), batchId: p.batchId });
    const { rows } = await db.query<{ canonical_id: string; duplicate_id: string }>(
      'SELECT canonical_id, duplicate_id FROM public.student_merge_audits WHERE batch_id=$1 ORDER BY canonical_id', [p.batchId]);
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.duplicate_id).sort()).toEqual(pairs.map((x) => x.removedId).sort());
  });
});

describe('safe batch execution — chunked transactions', () => {
  it('commits 25 + 25 + 10 merges across three atomic chunks', async () => {
    if (!db) return;
    await seedManySafePairs(60, 'Chunk');
    const p = await preview();
    expect(p.summary.safeCount).toBe(60);
    expect(p.chunkPlan).toMatchObject({ chunkSize: 25, chunks: 3 });

    const list = reviewedList(p);
    const timings: number[] = [];
    const t0 = Date.now();
    const c1 = await runBatch({ pairs: list, chunkSize: 25, batchId: p.batchId });
    timings.push(Date.now() - t0);
    expect(c1.totals).toMatchObject({ merged: 25, remaining: 35, failed: 0 });

    const t1 = Date.now();
    const c2 = await runBatch({ pairs: list, chunkSize: 25, batchId: p.batchId });
    timings.push(Date.now() - t1);
    expect(c2.totals).toMatchObject({ merged: 25, remaining: 10, failed: 0 });

    const t2 = Date.now();
    const c3 = await runBatch({ pairs: list, chunkSize: 25, batchId: p.batchId });
    timings.push(Date.now() - t2);
    expect(c3.totals).toMatchObject({ merged: 10, remaining: 0, failed: 0 });

    // A fourth call is a safe no-op: everything was already resolved.
    const c4 = await runBatch({ pairs: list, chunkSize: 25, batchId: p.batchId });
    expect(c4.totals.merged).toBe(0);
    expect(c4.totals.remaining).toBe(0);

    const { rows } = await db.query<{ n: string }>('SELECT count(*)::text AS n FROM public.students');
    expect(Number(rows[0].n)).toBe(60); // 120 seeded − 60 removed
    const { rows: audits } = await db.query<{ n: string }>('SELECT count(*)::text AS n FROM public.student_merge_audits');
    expect(Number(audits[0].n)).toBe(60); // one audit per merge
    const { rows: batch } = await db.query<{ chunks_run: number; merged_count: number }>(
      'SELECT chunks_run, merged_count FROM public.student_merge_batches WHERE id=$1', [p.batchId]);
    expect(batch[0].chunks_run).toBeGreaterThanOrEqual(3);
    expect(batch[0].merged_count).toBe(60);
    // eslint-disable-next-line no-console
    console.log(`[perf] chunk timings (25/25/10 merges): ${timings.map((t) => `${t}ms`).join(', ')}`);
  }, 240_000);

  it('clamps the chunk size into the documented 1..50 window', async () => {
    if (!db) return;
    await seedManySafePairs(3, 'Clamp');
    const p = await preview();
    const list = reviewedList(p);
    const huge = await runBatch({ pairs: list, chunkSize: 5000, batchId: p.batchId });
    expect(huge.chunkSize).toBe(50);
    expect(huge.totals.merged).toBe(3);

    await seedManySafePairs(2, 'Tiny');
    const p2 = await preview();
    const tiny = await runBatch({ pairs: reviewedList(p2), chunkSize: 0, batchId: p2.batchId });
    expect(tiny.chunkSize).toBe(1);
    expect(tiny.totals.merged).toBe(1);
    expect(tiny.totals.remaining).toBe(1);
  });

  it('rolls the WHOLE chunk back when one merge fails after writes', async () => {
    if (!db) return;
    const pairs: Array<{ keeperId: string; removedId: string; name: string }> = [];
    for (let i = 0; i < 5; i += 1) {
      pairs.push(await seedSafePair({ name: `Poison${i} Batch Student`, withHistory: true }));
    }
    const p = await preview();
    expect(p.summary.safeCount).toBe(5);
    const list = reviewedList(p);

    // Poison the THIRD pair's history transfer, i.e. make it fail AFTER pairs 1
    // and 2 already moved rows and wrote their audit records in the same
    // transaction. (Row-level DELETE triggers are ignored by PGlite, so the
    // failure is injected on the exam transfer UPDATE the merge performs.)
    const poisonKeeper = pairs[2].keeperId;
    const poisonDup = pairs[2].removedId;
    await db.exec(`
      CREATE OR REPLACE FUNCTION public.test_poison_exam_transfer() RETURNS trigger
      LANGUAGE plpgsql AS $fn$
      BEGIN
        IF NEW."studentId" = '${poisonKeeper}' AND OLD."studentId" = '${poisonDup}' THEN
          RAISE EXCEPTION 'poisoned exam transfer % -> %', OLD."studentId", NEW."studentId";
        END IF;
        RETURN NEW;
      END;
      $fn$;
      DROP TRIGGER IF EXISTS poison_exam_transfer ON public.exams;
      CREATE TRIGGER poison_exam_transfer BEFORE UPDATE ON public.exams
        FOR EACH ROW EXECUTE FUNCTION public.test_poison_exam_transfer();
    `);

    let message = '';
    try {
      await runBatch({ pairs: list, chunkSize: 25, batchId: p.batchId });
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message).toMatch(/SAFE BATCH CHUNK ABORTED/i);
    expect(message, message).toContain(pairs[2].removedId);
    expect(message).toMatch(/entire chunk rolled back/i);

    // Nothing in the chunk survived: no merges, no audits, no batch row.
    const students = await countStudents();
    expect(students).toBe(10);
    const { rows: audits } = await db.query<{ n: string }>('SELECT count(*)::text AS n FROM public.student_merge_audits');
    expect(Number(audits[0].n)).toBe(0);
    const { rows: batches } = await db.query<{ n: string }>('SELECT count(*)::text AS n FROM public.student_merge_batches');
    expect(Number(batches[0].n)).toBe(0);
    const { rows: logs } = await db.query<{ n: string }>('SELECT count(*)::text AS n FROM public.audit_logs');
    expect(Number(logs[0].n)).toBe(0);
    // Pairs 1 and 2 were fully rolled back: every history row is still on the
    // record it belonged to before the chunk started.
    const { rows: examsOfPair1Dup } = await db.query<{ n: string }>(
      'SELECT count(*)::text AS n FROM public.exams WHERE "studentId"=$1', [pairs[0].removedId]);
    expect(Number(examsOfPair1Dup[0].n)).toBe(1);
    const { rows: examsOfPair1Keeper } = await db.query<{ n: string }>(
      'SELECT count(*)::text AS n FROM public.exams WHERE "studentId"=$1', [pairs[0].keeperId]);
    expect(Number(examsOfPair1Keeper[0].n)).toBe(23);
    const { rows: dupStillThere } = await db.query('SELECT id FROM public.students WHERE id=$1', [pairs[0].removedId]);
    expect(dupStillThere).toHaveLength(1);

    // Remove the poison → the same chunk now commits completely.
    await db.exec('DROP TRIGGER IF EXISTS poison_exam_transfer ON public.exams;');
    const retry = await runBatch({ pairs: list, chunkSize: 25, batchId: p.batchId });
    expect(retry.totals).toMatchObject({ merged: 5, failed: 0, remaining: 0 });
    expect(await countStudents()).toBe(5);
  }, 120_000);
});

describe('safe batch execution — stale and race safety', () => {
  it('skips a candidate that changed between preview and execution (never blind-merges)', async () => {
    if (!db) return;
    const { keeperId, removedId } = await seedSafePair();
    const p = await preview();
    expect(p.summary.safeCount).toBe(1);
    const list = reviewedList(p);

    // Another admin edits the duplicate: it now carries a conflicting phone.
    await db.query('UPDATE public.students SET "parentPhone"=$1 WHERE id=$2', ['634453468', removedId]);

    const res = await runBatch({ pairs: list, batchId: p.batchId });
    expect(res.totals.merged).toBe(0);
    // The reviewed pair is no longer safe, so the server refuses it loudly
    // (blocked, with the live reason) instead of merging what was previewed.
    expect(res.blocked).toHaveLength(1);
    expect(res.blocked[0].reason).toBe('not_eligible_server_side');
    expect(res.blocked[0].codes).toContain('parent_phone_conflict');
    expect(res.blocked[0].severity).toBe('blocked');
    expect(res.totals.failed).toBe(0);
    // Both records are still there — nothing was forced.
    expect(await countStudents()).toBe(2);
    const { rows } = await db.query('SELECT id FROM public.students WHERE id=$1', [keeperId]);
    expect(rows).toHaveLength(1);

    // A refreshed preview now reports the pair as excluded (server re-decides).
    const p2 = await preview();
    expect(p2.summary.safeCount).toBe(0);
    expect(p2.exclusionReasons.parent_phone_conflict).toBe(1);
    const res2 = await runBatch({ pairs: reviewedList(p2), batchId: p2.batchId });
    expect(res2.totals.merged).toBe(0);
  });

  it('skips a pair whose fingerprint changed even though it is still eligible', async () => {
    if (!db) return;
    const { removedId } = await seedSafePair();
    const p = await preview();
    const list = reviewedList(p);
    // New homework on the duplicate: still safe, but not what was reviewed.
    await db.exec(`INSERT INTO public.homework (id,"studentId","className",subject,title,"dueDate")
                   VALUES ('hw-late','${removedId}','Foundation A','Math','Late HW', DATE '2026-09-20')`);
    const res = await runBatch({ pairs: list, batchId: p.batchId });
    expect(res.totals.merged).toBe(0);
    expect(res.skipped[0].reason).toBe('candidate_changed_since_preview');
    expect(await countStudents()).toBe(2);

    // Re-previewing accepts the new state and merges it.
    const p2 = await preview();
    const res2 = await runBatch({ pairs: reviewedList(p2), batchId: p2.batchId });
    expect(res2.totals.merged).toBe(1);
    expect(await countStudents()).toBe(1);
  });

  it('reports already-resolved pairs instead of failing when another admin merged first', async () => {
    if (!db) return;
    const { keeperId, removedId } = await seedSafePair();
    const p = await preview();
    const list = reviewedList(p);

    // Simulate another administrator resolving the pair individually first.
    await db.rpc('merge_duplicate_students_resolved', {
      p_canonical_id: keeperId,
      p_duplicate_id: removedId,
      p_resolution: {
        profile_resolution: { name: 'canonical', class_name: 'canonical', gov_id: 'canonical', parent_id: 'canonical', parent_phone: 'canonical', transport: 'canonical' },
        exam_resolution: [], attendance_resolution: [], quiz_resolution: [], release_resolution: [], report_comment_resolution: [],
        enrollment_resolution: { action: 'consolidate', keep: 'canonical' },
      },
      p_reason: 'Merged individually by another admin',
    });

    const res = await runBatch({ pairs: list, batchId: p.batchId });
    expect(res.totals.merged).toBe(0);
    expect(res.totals.failed).toBe(0);
    expect(res.skipped.map((s) => s.reason)).toContain('already_resolved');
    expect(await countStudents()).toBe(1);
  });

  it('re-evaluates live state even when the client sends no fingerprints', async () => {
    if (!db) return;
    const { removedId } = await seedSafePair();
    // Client sends ids only (no fingerprint): eligibility is still recomputed.
    await db.query('UPDATE public.students SET "parentPhone"=$1 WHERE id=$2', ['634111222', removedId]);
    const res = await runBatch({ pairs: [{ keeperId: 'x', removedId: 'y' }], batchId: 'batch-nofp' });
    expect(res.totals.merged).toBe(0);
    // The fabricated pair is refused outright.
    expect(res.blocked.map((b) => b.reason)).toContain('not_a_candidate');
    expect(await countStudents()).toBe(2);
  });
});

describe('safe batch execution — server authority', () => {
  it('cannot be tricked by a client list: ineligible pairs are refused, eligible ones still merge', async () => {
    if (!db) return;
    const safe = await seedSafePair({ name: uniqueName('Listed') });
    // A pair a malicious/naive client would love to batch: two different parents.
    const unsafe = await seedSafePair({ name: uniqueName('Unsafe'), aParent: 'parent-1', bParent: 'admin-1', bPhone: '634572257', bGov: null });

    const res = await runBatch({
      pairs: [
        { keeperId: safe.keeperId, removedId: safe.removedId },
        { keeperId: unsafe.aId, removedId: unsafe.bId },
        { keeperId: 'student-does-not-exist', removedId: 'student-also-missing' },
      ],
      batchId: 'batch-forged',
    });
    expect(res.totals.merged).toBe(1);
    expect(res.merged[0].keeperId).toBe(safe.keeperId);
    const notEligible = res.blocked.filter((b) => b.reason === 'not_eligible_server_side');
    expect(notEligible).toHaveLength(1);
    expect(notEligible[0].codes).toContain('both_parents_assigned');
    expect(res.blocked.filter((b) => b.reason === 'not_a_candidate')).toHaveLength(1);
    // The unsafe pair is completely untouched.
    const { rows } = await db.query('SELECT id FROM public.students WHERE id=$1', [unsafe.bId]);
    expect(rows).toHaveLength(1);
  });

  it('refuses a delete-style request that only names a student id', async () => {
    if (!db) return;
    const { removedId } = await seedSafePair();
    let message = '';
    try {
      await runBatch({ pairs: [{ studentId: removedId, delete: true }], batchId: 'batch-delete-style' });
    } catch (e) {
      message = (e as Error).message;
    }
    // The request is refused outright — and crucially the refusal does NOT fall
    // back to "merge every eligible pair the server can find".
    expect(message).toMatch(/must provide both keeperId and removedId/i);
    const { rows } = await db.query('SELECT id FROM public.students WHERE id=$1', [removedId]);
    expect(rows).toHaveLength(1);
    const { rows: keeperRows } = await db.query('SELECT id FROM public.students');
    expect(keeperRows).toHaveLength(2);
    const { rows: audits } = await db.query<{ n: string }>('SELECT count(*)::text AS n FROM public.student_merge_audits');
    expect(Number(audits[0].n)).toBe(0);
  });

  it('requires the typed confirmation phrase', async () => {
    if (!db) return;
    await seedSafePair();
    const p = await preview();
    for (const phrase of [null, '', 'MERGE', 'merge all', 'MERGE SAFE DUPLICATE']) {
      let message = '';
      try {
        await runBatch({ pairs: reviewedList(p), phrase, batchId: p.batchId });
      } catch (e) {
        message = (e as Error).message;
      }
      expect(message).toMatch(/confirmation phrase required/i);
    }
    expect(await countStudents()).toBe(2);
    // Case/whitespace tolerant, but only for the exact phrase.
    const ok = await runBatch({ pairs: reviewedList(p), phrase: '  merge safe duplicates ', batchId: p.batchId });
    expect(ok.totals.merged).toBe(1);
  });

  it('denies anon, teacher, parent and supervisor for every batch RPC', async () => {
    if (!db) return;
    await seedSafePair();
    const actors: Array<[string, string | null]> = [
      ['anon', null],
      ['teacher', TEACHER_UID],
      ['parent', PARENT_UID],
      ['supervisor', SUPERVISOR_UID],
    ];
    for (const [label, uid] of actors) {
      await db!.setAuthUid(uid);
      for (const call of [
        () => db!.rpc('get_safe_duplicate_batch', { p_limit: 10, p_offset: 0, p_include_excluded: true }),
        () => db!.rpc('preview_safe_duplicate_batch', { p_limit: 10 }),
        () => db!.rpc('merge_safe_duplicate_batch', { p_pairs: null, p_chunk_size: 25, p_confirm_phrase: PHRASE, p_reason: null, p_batch_id: null }),
      ]) {
        let message = '';
        try {
          await call();
        } catch (e) {
          message = (e as Error).message;
        }
        expect(message, `${label} must be denied`).toMatch(/Only administrators/i);
      }
    }
    // Nothing was merged by the denied attempts.
    await db.setAuthUid(ADMIN_UID);
    expect(await countStudents()).toBe(2);
    const { rows } = await db.query<{ n: string }>('SELECT count(*)::text AS n FROM public.student_merge_audits');
    expect(Number(rows[0].n)).toBe(0);
  });

  it('merges nothing when the reviewed list is empty', async () => {
    if (!db) return;
    await seedSafePair();
    const res = await runBatch({ pairs: [], batchId: 'batch-empty' });
    expect(res.totals.merged).toBe(0);
    expect(res.totals.failed).toBe(0);
    expect(res.merged).toEqual([]);
    expect(await countStudents()).toBe(2);
  });

  it('does not execute arbitrary SQL through the batch id', async () => {
    if (!db) return;
    await seedSafePair();
    const p = await preview();
    let message = '';
    try {
      await runBatch({ pairs: reviewedList(p), batchId: 'x'.repeat(500) });
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message).toMatch(/100 characters/i);
    expect(await countStudents()).toBe(2);
  });
});

describe('safe batch execution — dry run guarantees', () => {
  it('preview performs zero writes', async () => {
    if (!db) return;
    await seedManySafePairs(4, 'Dry');
    const before = {
      students: await countStudents(),
      audits: await db.query<{ n: string }>('SELECT count(*)::text AS n FROM public.student_merge_audits'),
      batches: await db.query<{ n: string }>('SELECT count(*)::text AS n FROM public.student_merge_batches'),
      logs: await db.query<{ n: string }>('SELECT count(*)::text AS n FROM public.audit_logs'),
      enrollments: await db.query<{ n: string }>('SELECT count(*)::text AS n FROM public.student_enrollments'),
    };
    const p = await preview();
    const p2 = await preview();
    expect(p.summary.safeCount).toBe(4);
    expect(p2.summary.safeCount).toBe(4);
    expect(p.dryRun).toBe(true);
    expect(p.writesPerformed).toBe(0);
    expect(await countStudents()).toBe(before.students);
    expect((await db.query<{ n: string }>('SELECT count(*)::text AS n FROM public.student_merge_audits')).rows[0].n).toBe(before.audits.rows[0].n);
    expect((await db.query<{ n: string }>('SELECT count(*)::text AS n FROM public.student_merge_batches')).rows[0].n).toBe(before.batches.rows[0].n);
    expect((await db.query<{ n: string }>('SELECT count(*)::text AS n FROM public.audit_logs')).rows[0].n).toBe(before.logs.rows[0].n);
    expect((await db.query<{ n: string }>('SELECT count(*)::text AS n FROM public.student_enrollments')).rows[0].n).toBe(before.enrollments.rows[0].n);
  });

  it('measures execution time for a realistic chunk', async () => {
    if (!db) return;
    await seedManySafePairs(25, 'Timing');
    const t0 = Date.now();
    const p = await preview();
    const previewMs = Date.now() - t0;
    const t1 = Date.now();
    const res = await runBatch({ pairs: reviewedList(p), batchId: p.batchId });
    const execMs = Date.now() - t1;
    expect(res.totals.merged).toBe(25);
    expect(res.durationMs).toBeGreaterThan(0);
    // eslint-disable-next-line no-console
    console.log(`[perf] 25 safe pairs → preview ${previewMs} ms (server ${p.timings.previewMs ?? p.timings.evaluateMs} ms), chunk execution ${execMs} ms (server ${res.durationMs} ms)`);
    expect(previewMs).toBeLessThan(120_000);
    expect(execMs).toBeLessThan(180_000);
  }, 240_000);
});
