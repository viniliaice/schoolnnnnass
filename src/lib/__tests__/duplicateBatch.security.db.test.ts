// SAFE BATCH MERGE — SECURITY REGRESSIONS for the two MEDIUM audit findings.
//
// Finding 1: `_safe_batch_evaluate_pair`, `_safe_batch_candidate_pairs` and
//   `_safe_batch_unhandled_child_rows` are SECURITY DEFINER, so they run as the
//   function owner and read EVERY student. They were granted to `authenticated`,
//   which let any signed-in teacher/parent/supervisor call them directly and
//   pull Gov IDs, parent phones, family ids and parent profiles for students
//   their own RLS policy hides. They now carry the project's standard admin
//   guard AND are no longer executable by a JWT role.
//
// Finding 2: `p_batch_id` is client-chosen and `student_merge_batches` was
//   upserted with `ON CONFLICT (id) DO UPDATE`, so administrator B could append
//   to (or overwrite) administrator A's aggregate batch row. An existing batch
//   id is now accepted only from the administrator who created it
//   (`batch_id_not_owned`), the check runs before any merge, and an advisory
//   lock closes the two-concurrent-chunks creation race.
//
// Everything here executes on REAL PostgreSQL (PGlite, in-process WASM) against
// the ACTUAL shipped migrations (20260922 → 20260926). No production database
// is contacted and no production student is touched: the instance is created
// and destroyed inside this file and seeded only with synthetic students.

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  createDuplicateBatchTestDb,
  pgliteAvailable,
  seedEnrollment,
  seedProfile,
  seedStudent,
  type PgDuplicateDb,
} from './pgDuplicateBatchHarness';

const ADMIN_A_UID = 'cccccccc-0000-4000-8000-0000000000a1';
const ADMIN_B_UID = 'cccccccc-0000-4000-8000-0000000000b2';
const TEACHER_UID = 'cccccccc-0000-4000-8000-0000000000c3';
const PARENT_UID = 'cccccccc-0000-4000-8000-0000000000c4';
const SUPERVISOR_UID = 'cccccccc-0000-4000-8000-0000000000c5';
const PHRASE = 'MERGE SAFE DUPLICATES';

// Deliberately distinctive: if any of these bytes ever surface in an error for
// a non-admin caller, PII leaked. The Gov ID is generated per pair because the
// shipped schema enforces a unique index on the normalized Gov ID.
const PII = { phone: '615559999', familyId: '0077' };
function piiGovId(n: number) {
  return `GB-77${String(n).padStart(4, '0')}99`;
}

const NON_ADMIN_ACTORS: Array<{ label: string; uid: string | null }> = [
  { label: 'teacher', uid: TEACHER_UID },
  { label: 'parent', uid: PARENT_UID },
  { label: 'supervisor', uid: SUPERVISOR_UID },
  { label: 'anonymous (no JWT)', uid: null },
];

interface ChunkResult {
  batchId: string;
  adminId: string;
  merged: Array<{ pairKey: string; keeperId: string; removedId: string; auditId: string }>;
  skipped: Array<{ pairKey: string; reason: string; codes?: string[] }>;
  blocked: Array<{ pairKey: string; reason: string; codes?: string[] }>;
  failed: unknown[];
  totals: {
    eligibleAtStart: number;
    examined: number;
    merged: number;
    skipped: number;
    blocked: number;
    failed: number;
    remaining: number;
  };
}

interface PreviewResult {
  batchId: string;
  rows: Array<{ pairKey: string; keeperId: string; removedId: string; fingerprint: string }>;
}

let db: PgDuplicateDb | null = null;
let seq = 0;

function requireDb(): PgDuplicateDb {
  if (!db) throw new Error('PGlite database not ready');
  return db;
}

// ── Session helpers ────────────────────────────────────────────────────────
// `asClaimsOnly` is what the SECURITY DEFINER RPCs see: JWT claims present, the
// caller is the PostgREST role. `asJwtRole` additionally does SET ROLE
// authenticated, so PostgreSQL itself enforces function ACLs — the only way to
// observe a REVOKE inside PGlite (which otherwise runs as the superuser).
async function asClaimsOnly(uid: string | null) {
  const d = requireDb();
  await d.exec('RESET ROLE');
  await d.setAuthUid(uid);
}

async function asJwtRole(uid: string | null) {
  const d = requireDb();
  await d.exec('RESET ROLE');
  await d.setAuthUid(uid);
  await d.exec('SET ROLE authenticated');
}

async function asOwner() {
  const d = requireDb();
  await d.exec('RESET ROLE');
  await d.setAuthUid(ADMIN_A_UID);
}

/** Captures the Postgres error (message + SQLSTATE) instead of failing the test. */
async function captureError(run: () => Promise<unknown>): Promise<{ message: string; code: string }> {
  try {
    await run();
    return { message: '', code: '' };
  } catch (e) {
    const err = e as Error & { code?: string };
    return { message: err.message ?? String(e), code: err.code ?? '' };
  }
}

// ── Fixture helpers ────────────────────────────────────────────────────────
async function seedSafePair(prefix = 'Sec') {
  const d = requireDb();
  seq += 1;
  const name = `${prefix}${seq} Batch Student`;
  const className = 'Foundation A';
  const keeperId = `stu-seca-${seq}-${Math.random().toString(36).slice(2, 7)}`;
  const removedId = `stu-secb-${seq}-${Math.random().toString(36).slice(2, 7)}`;

  // The parent-assigned record is the keeper (batch policy), and it is the older
  // record here so the test also proves age is not what decides.
  await seedStudent(d, {
    id: keeperId, name, className,
    parentId: 'parent-1', govId: null, parentPhone: PII.phone,
    transport: '25', familyId: PII.familyId, createdAt: '2025-02-01T08:00:00Z',
  });
  // The unassigned duplicate carries the Gov ID that must be preserved.
  const govId = piiGovId(seq);
  await seedStudent(d, {
    id: removedId, name, className,
    parentId: null, govId, parentPhone: null,
    transport: '25', familyId: null, createdAt: '2026-09-10T08:00:00Z',
  });
  await seedEnrollment(d, { id: `enr-${keeperId}`, studentId: keeperId, className, academicYearId: 'ay-2026', effectiveFrom: '2026-06-01' });
  await seedEnrollment(d, { id: `enr-${removedId}`, studentId: removedId, className, academicYearId: 'ay-2026', effectiveFrom: '2026-09-01' });
  return { keeperId, removedId, name, className, govId };
}

async function seedSafePairs(n: number, prefix = 'Sec') {
  const out: Array<{ keeperId: string; removedId: string }> = [];
  for (let i = 0; i < n; i += 1) out.push(await seedSafePair(`${prefix}${i}`));
  return out;
}

async function preview(limit = 500): Promise<PreviewResult> {
  return requireDb().rpc<PreviewResult>('preview_safe_duplicate_batch', { p_limit: limit });
}

function reviewedList(p: PreviewResult) {
  return p.rows.map((r) => ({ keeperId: r.keeperId, removedId: r.removedId, fingerprint: r.fingerprint, pairKey: r.pairKey }));
}

async function runChunk(opts: {
  pairs?: unknown;
  chunkSize?: number;
  batchId?: string | null;
  phrase?: string | null;
  reason?: string | null;
}): Promise<ChunkResult> {
  return requireDb().rpc<ChunkResult>('merge_safe_duplicate_batch', {
    p_pairs: opts.pairs === undefined ? null : opts.pairs,
    p_chunk_size: opts.chunkSize ?? 25,
    p_confirm_phrase: opts.phrase === undefined ? PHRASE : opts.phrase,
    p_reason: opts.reason ?? 'security regression run',
    p_batch_id: opts.batchId ?? null,
  });
}

/** Full aggregate batch row, as text, so every column can be compared. */
async function batchRow(id: string) {
  const { rows } = await requireDb().query<Record<string, string | null>>(
    `SELECT id, admin_id, policy, reason,
            chunk_size::TEXT AS chunk_size, chunks_run::TEXT AS chunks_run,
            requested_pairs::TEXT AS requested_pairs,
            merged_count::TEXT AS merged_count, skipped_count::TEXT AS skipped_count,
            blocked_count::TEXT AS blocked_count, failed_count::TEXT AS failed_count,
            remaining_eligible::TEXT AS remaining_eligible,
            chunk_results::TEXT AS chunk_results,
            created_at::TEXT AS created_at, updated_at::TEXT AS updated_at
       FROM public.student_merge_batches WHERE id = $1`,
    [id],
  );
  return rows[0] ?? null;
}

async function countStudents() {
  const { rows } = await requireDb().query<{ n: string }>('SELECT count(*)::text AS n FROM public.students');
  return Number(rows[0].n);
}

async function countAudits(batchId?: string) {
  const { rows } = batchId
    ? await requireDb().query<{ n: string }>('SELECT count(*)::text AS n FROM public.student_merge_audits WHERE batch_id = $1', [batchId])
    : await requireDb().query<{ n: string }>('SELECT count(*)::text AS n FROM public.student_merge_audits');
  return Number(rows[0].n);
}

/** True when the named function is executable by the given JWT role. */
async function jwtRoleCanExecute(role: 'anon' | 'authenticated', fnSignature: string) {
  const { rows } = await requireDb().query<{ role_exists: boolean }>(
    `SELECT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = $1) AS role_exists`,
    [role],
  );
  if (!rows[0]?.role_exists) return null; // role absent in this instance — nothing to prove
  const { rows: priv } = await requireDb().query<{ allowed: boolean }>(
    `SELECT has_function_privilege($1, $2::regprocedure, 'EXECUTE') AS allowed`,
    [role, fnSignature],
  );
  return priv[0].allowed;
}

beforeAll(async () => {
  if (!(await pgliteAvailable())) return;
  db = await createDuplicateBatchTestDb();
  await db.exec(`
    INSERT INTO public.academic_years (id, name, "isCurrent") VALUES
      ('ay-2026','2026/2027', true), ('ay-2025','2025/2026', false);
    INSERT INTO public.terms (id, name, "academicYearId") VALUES ('term-1','Term 1','ay-2026');
    INSERT INTO public.subjects (id, name) VALUES ('sub-math','Math');
    -- What PostgREST grants a JWT role, so SET ROLE authenticated behaves like
    -- a real Supabase request (same pattern as the lesson-plan roster tests).
    GRANT USAGE ON SCHEMA public, auth TO authenticated;
    GRANT EXECUTE ON FUNCTION auth.uid(), public.current_profile_id(), public.current_profile_role() TO authenticated;
  `);
  await seedProfile(db, 'admin-a', 'admin', 'Admin A', ADMIN_A_UID);
  await seedProfile(db, 'admin-b', 'admin', 'Admin B', ADMIN_B_UID);
  await seedProfile(db, 'teacher-1', 'teacher', 'Teacher One', TEACHER_UID);
  await seedProfile(db, 'parent-1', 'parent', 'ahmed daahir aadan', PARENT_UID);
  await seedProfile(db, 'supervisor-1', 'supervisor', 'Supervisor One', SUPERVISOR_UID);
  await asOwner();
}, 180_000);

beforeEach(async () => {
  if (!db) return;
  await db.exec(`
    RESET ROLE;
    DELETE FROM public.students;
    DELETE FROM public.student_merge_audits;
    DELETE FROM public.student_merge_batches;
    DELETE FROM public.audit_logs;
  `);
  await asOwner();
});

afterAll(async () => {
  if (db) {
    await db.exec('RESET ROLE').catch(() => undefined);
    await db.close();
  }
});

// ════════════════════════════════════════════════════════════════════════════
// FINDING 1 — the internal helpers are admin-only
// ════════════════════════════════════════════════════════════════════════════
describe('Finding 1 — _safe_batch_* helpers refuse every non-admin caller', () => {
  for (const actor of NON_ADMIN_ACTORS) {
    it(`${actor.label} cannot evaluate a pair: refused with insufficient_privilege and no PII`, async () => {
      if (!db) return;
      const { keeperId, removedId, govId } = await seedSafePair();
      await asClaimsOnly(actor.uid);

      const err = await captureError(() =>
        db!.rpc('_safe_batch_evaluate_pair', { p_a_id: keeperId, p_b_id: removedId, p_group_size: 2, p_deep: true }),
      );

      expect(err.message).toMatch(/Only administrators may evaluate safe batch duplicate pairs/);
      expect(err.code).toBe('42501'); // insufficient_privilege
      // The refusal itself must not carry the student data it protected.
      expect(err.message).not.toContain(govId);
      expect(err.message).not.toContain(PII.phone);
      expect(err.message).not.toContain(PII.familyId);
      expect(err.message).not.toContain('parent-1');
    });

    it(`${actor.label} cannot list candidate pairs school-wide`, async () => {
      if (!db) return;
      const { govId } = await seedSafePair();
      await asClaimsOnly(actor.uid);

      const err = await captureError(() => db!.rpc('_safe_batch_candidate_pairs', { p_deep: false }));

      expect(err.message).toMatch(/Only administrators may list safe batch duplicate candidates/);
      expect(err.code).toBe('42501');
      expect(err.message).not.toContain(govId);
    });

    it(`${actor.label} cannot probe child-row dependencies for an arbitrary student id`, async () => {
      if (!db) return;
      const { keeperId } = await seedSafePair();
      await asClaimsOnly(actor.uid);

      const err = await captureError(() => db!.rpc('_safe_batch_unhandled_child_rows', { p_student_id: keeperId }));

      expect(err.message).toMatch(/Only administrators may inspect safe batch duplicate dependencies/);
      expect(err.code).toBe('42501');
    });
  }

  it('an administrator CAN still call all three helpers directly (the guard did not lock out the admin)', async () => {
    if (!db) return;
    const { keeperId, removedId, govId } = await seedSafePair();
    await asClaimsOnly(ADMIN_A_UID);

    const evaluation = await db.rpc<Record<string, any>>('_safe_batch_evaluate_pair', {
      p_a_id: keeperId, p_b_id: removedId, p_group_size: 2, p_deep: true,
    });
    expect(evaluation.eligible).toBe(true);
    expect(evaluation.keeperId).toBe(keeperId);
    expect(evaluation.removedId).toBe(removedId);
    // PII is available to the administrator — that is the legitimate use.
    expect(JSON.stringify(evaluation)).toContain(govId);

    const pairs = await db.query('SELECT * FROM public._safe_batch_candidate_pairs(false)');
    expect(pairs.rows.length).toBeGreaterThan(0);

    const childRows = await db.query('SELECT * FROM public._safe_batch_unhandled_child_rows($1)', [keeperId]);
    expect(Array.isArray(childRows.rows)).toBe(true);
  });

  it('the helpers are no longer executable by anon/authenticated, while the four client RPCs still are', async () => {
    if (!db) return;
    await asOwner();

    for (const signature of [
      'public._safe_batch_evaluate_pair(TEXT,TEXT,INTEGER,BOOLEAN)',
      'public._safe_batch_candidate_pairs(BOOLEAN)',
      'public._safe_batch_unhandled_child_rows(TEXT)',
    ]) {
      for (const role of ['anon', 'authenticated'] as const) {
        const allowed = await jwtRoleCanExecute(role, signature);
        if (allowed === null) continue; // role not present in this PGlite instance
        expect(allowed, `${role} must not execute ${signature}`).toBe(false);
      }
    }

    for (const signature of [
      'public.safe_duplicate_batch_policy()',
      'public.get_safe_duplicate_batch(INTEGER,INTEGER,BOOLEAN)',
      'public.preview_safe_duplicate_batch(INTEGER)',
      'public.merge_safe_duplicate_batch(JSONB,INTEGER,TEXT,TEXT,TEXT)',
    ]) {
      const allowed = await jwtRoleCanExecute('authenticated', signature);
      if (allowed === null) continue;
      expect(allowed, `authenticated must still execute ${signature}`).toBe(true);
    }
  });

  it('a real JWT-role session is denied the helper by PostgreSQL itself (REVOKE, not just the guard)', async () => {
    if (!db) return;
    const { keeperId, removedId } = await seedSafePair();
    await asJwtRole(TEACHER_UID);

    const err = await captureError(() =>
      db!.rpc('_safe_batch_evaluate_pair', { p_a_id: keeperId, p_b_id: removedId, p_group_size: 2, p_deep: true }),
    );
    expect(err.message).toMatch(/permission denied for function/i);
    expect(err.code).toBe('42501');

    // Even an ADMIN cannot call the helper directly any more: administrators go
    // through the RPCs, which is the only supported path.
    await asJwtRole(ADMIN_A_UID);
    const adminErr = await captureError(() =>
      db!.rpc('_safe_batch_candidate_pairs', { p_deep: false }),
    );
    expect(adminErr.message).toMatch(/permission denied for function/i);

    await asOwner();
  });

  it('the same JWT-role session still runs the shipped admin flow: get → preview → merge', async () => {
    if (!db) return;
    const { keeperId, removedId } = await seedSafePair();
    await asJwtRole(ADMIN_A_UID);

    const report = await db!.rpc<Record<string, any>>('get_safe_duplicate_batch', {
      p_limit: 50, p_offset: 0, p_include_excluded: true,
    });
    expect(report.summary.candidatePairs).toBeGreaterThan(0);

    const p = await db!.rpc<PreviewResult>('preview_safe_duplicate_batch', { p_limit: 500 });
    expect(p.rows.some((r) => r.keeperId === keeperId)).toBe(true);

    const res = await db!.rpc<ChunkResult>('merge_safe_duplicate_batch', {
      p_pairs: reviewedList(p),
      p_chunk_size: 25,
      p_confirm_phrase: PHRASE,
      p_reason: 'JWT-role session check',
      p_batch_id: p.batchId,
    });
    expect(res.totals.merged).toBe(1);
    expect(res.merged[0].keeperId).toBe(keeperId);
    expect(res.merged[0].removedId).toBe(removedId);

    await asOwner();
    const { rows } = await db.query('SELECT id FROM public.students WHERE id = $1', [removedId]);
    expect(rows).toHaveLength(0); // the duplicate is gone, the keeper survived
  });

  it('a non-admin JWT-role session is refused by the top-level RPCs too (defence in depth unchanged)', async () => {
    if (!db) return;
    await seedSafePair();
    await asJwtRole(SUPERVISOR_UID);

    const err = await captureError(() => db!.rpc('preview_safe_duplicate_batch', { p_limit: 500 }));
    expect(err.message).toMatch(/Only administrators may preview the safe duplicate batch/);
    expect(err.code).toBe('42501');

    await asOwner();
  });

  it('the evaluator still refuses a pair of missing students for an administrator (never eligible, severity blocked)', async () => {
    if (!db) return;
    await asClaimsOnly(ADMIN_A_UID);
    const evaluation = await db.rpc<Record<string, any>>('_safe_batch_evaluate_pair', {
      p_a_id: 'safe-batch-assertion-missing-a',
      p_b_id: 'safe-batch-assertion-missing-b',
      p_group_size: 2,
      p_deep: false,
    });
    expect(evaluation.eligible).toBe(false);
    expect(evaluation.severity).toBe('blocked');
    expect(evaluation.exclusionCodes).toContain('student_missing');
  });

  it('the shipped admin flow is unchanged for a non-admin-free screen: teacher/parent/supervisor get the same refusal from the RPCs', async () => {
    if (!db) return;
    await seedSafePair();
    for (const actor of NON_ADMIN_ACTORS.slice(0, 3)) {
      await asClaimsOnly(actor.uid);
      const reportErr = await captureError(() =>
        db!.rpc('get_safe_duplicate_batch', { p_limit: 50, p_offset: 0, p_include_excluded: true }),
      );
      expect(reportErr.message).toMatch(/Only administrators may view the safe duplicate batch/);
      const mergeErr = await captureError(() =>
        db!.rpc('merge_safe_duplicate_batch', {
          p_pairs: null, p_chunk_size: 25, p_confirm_phrase: PHRASE, p_reason: null, p_batch_id: null,
        }),
      );
      expect(mergeErr.message).toMatch(/Only administrators may run the safe duplicate batch merge/);
    }
    await asOwner();
    // Nothing was merged by any of those refused calls.
    expect(await countStudents()).toBe(2);
    expect(await countAudits()).toBe(0);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// FINDING 2 — batch id ownership
// ════════════════════════════════════════════════════════════════════════════
describe('Finding 2 — a batch id belongs to the administrator who created it', () => {
  it('admin A creates batch X on the first chunk and owns the aggregate row', async () => {
    if (!db) return;
    await seedSafePairs(2, 'Own');
    await asClaimsOnly(ADMIN_A_UID);
    const p = await preview();
    const res = await runChunk({ pairs: reviewedList(p), chunkSize: 1, batchId: 'batch-X' });

    expect(res.batchId).toBe('batch-X');
    expect(res.adminId).toBe('admin-a');
    expect(res.totals.merged).toBe(1);

    const row = await batchRow('batch-X');
    expect(row).toBeTruthy();
    expect(row!.admin_id).toBe('admin-a');
    expect(row!.chunks_run).toBe('1');
    expect(row!.merged_count).toBe('1');
  });

  it('admin A accumulates a second chunk into the same batch X', async () => {
    if (!db) return;
    await seedSafePairs(3, 'Acc');
    await asClaimsOnly(ADMIN_A_UID);
    const p = await preview();
    const reviewed = reviewedList(p);

    const first = await runChunk({ pairs: reviewed, chunkSize: 1, batchId: 'batch-X' });
    expect(first.totals.merged).toBe(1);
    expect(first.totals.remaining).toBe(2);

    const second = await runChunk({ pairs: reviewed, chunkSize: 1, batchId: 'batch-X' });
    expect(second.totals.merged).toBe(1);

    const row = await batchRow('batch-X');
    expect(row!.admin_id).toBe('admin-a');
    expect(row!.chunks_run).toBe('2');
    expect(row!.merged_count).toBe('2');
    expect(JSON.parse(row!.chunk_results as string)).toHaveLength(2);
    expect(await countAudits('batch-X')).toBe(2);
  });

  it('admin B is refused on batch X with batch_id_not_owned (insufficient_privilege)', async () => {
    if (!db) return;
    await seedSafePairs(2, 'Hijack');
    await asClaimsOnly(ADMIN_A_UID);
    const pA = await preview();
    await runChunk({ pairs: reviewedList(pA), chunkSize: 1, batchId: 'batch-X' });

    await asClaimsOnly(ADMIN_B_UID);
    const pB = await preview();
    const err = await captureError(() =>
      runChunk({ pairs: reviewedList(pB), chunkSize: 25, batchId: 'batch-X' }),
    );

    expect(err.message).toMatch(/batch_id_not_owned/);
    expect(err.message).toMatch(/another administrator/i);
    expect(err.code).toBe('42501');
  });

  it('batch X is untouched by the refused call: every aggregate column is identical', async () => {
    if (!db) return;
    await seedSafePairs(2, 'Untouched');
    await asClaimsOnly(ADMIN_A_UID);
    const pA = await preview();
    await runChunk({ pairs: reviewedList(pA), chunkSize: 1, batchId: 'batch-X' });
    const before = await batchRow('batch-X');

    await asClaimsOnly(ADMIN_B_UID);
    const pB = await preview();
    await captureError(() => runChunk({ pairs: reviewedList(pB), chunkSize: 25, batchId: 'batch-X' }));

    await asOwner();
    const after = await batchRow('batch-X');
    expect(after).toEqual(before); // admin_id, counts, chunk_results, created_at, updated_at
    expect(after!.admin_id).toBe('admin-a');
    expect(after!.chunks_run).toBe('1');
  });

  it("admin B's refused chunk merged nothing and wrote no audit rows", async () => {
    if (!db) return;
    await seedSafePairs(2, 'NoWrites');
    await asClaimsOnly(ADMIN_A_UID);
    const pA = await preview();
    await runChunk({ pairs: reviewedList(pA), chunkSize: 1, batchId: 'batch-X' });
    const studentsBefore = await countStudents();
    const auditsBefore = await countAudits();
    const logsBefore = await db.query<{ n: string }>('SELECT count(*)::text AS n FROM public.audit_logs');

    await asClaimsOnly(ADMIN_B_UID);
    const pB = await preview();
    await captureError(() => runChunk({ pairs: reviewedList(pB), chunkSize: 25, batchId: 'batch-X' }));

    await asOwner();
    expect(await countStudents()).toBe(studentsBefore);
    expect(await countAudits()).toBe(auditsBefore);
    const logsAfter = await db.query<{ n: string }>('SELECT count(*)::text AS n FROM public.audit_logs');
    expect(Number(logsAfter.rows[0].n)).toBe(Number(logsBefore.rows[0].n));
    // A's per-merge audits are still exactly A's.
    const { rows } = await db.query(
      `SELECT DISTINCT admin_id FROM public.student_merge_audits WHERE batch_id = 'batch-X'`,
    );
    expect(rows.map((r) => r.admin_id)).toEqual(['admin-a']);
  });

  it("admin B can run their own batch id while X stays A's", async () => {
    if (!db) return;
    await seedSafePairs(4, 'TwoAdmins');
    await asClaimsOnly(ADMIN_A_UID);
    const pA = await preview();
    await runChunk({ pairs: reviewedList(pA), chunkSize: 2, batchId: 'batch-X' });

    await asClaimsOnly(ADMIN_B_UID);
    const pB = await preview();
    const resB = await runChunk({ pairs: reviewedList(pB), chunkSize: 2, batchId: 'batch-Y' });
    expect(resB.adminId).toBe('admin-b');
    expect(resB.totals.merged).toBeGreaterThan(0);

    await asOwner();
    const rowX = await batchRow('batch-X');
    const rowY = await batchRow('batch-Y');
    expect(rowX!.admin_id).toBe('admin-a');
    expect(rowY!.admin_id).toBe('admin-b');
    expect(rowX!.chunks_run).toBe('1');
    // Each batch's audits carry only their own batch id.
    const { rows } = await db.query(
      `SELECT batch_id, admin_id, count(*)::text AS n FROM public.student_merge_audits
        WHERE batch_id IN ('batch-X','batch-Y') GROUP BY 1,2 ORDER BY 1`,
    );
    expect(rows).toEqual([
      { batch_id: 'batch-X', admin_id: 'admin-a', n: rowX!.merged_count },
      { batch_id: 'batch-Y', admin_id: 'admin-b', n: rowY!.merged_count },
    ]);
  });

  it('the same admin retrying the same batch id is idempotent: no duplicate merges, no duplicate audits', async () => {
    if (!db) return;
    await seedSafePairs(2, 'Retry');
    await asClaimsOnly(ADMIN_A_UID);
    const p = await preview();
    const reviewed = reviewedList(p);

    const first = await runChunk({ pairs: reviewed, chunkSize: 25, batchId: 'batch-X' });
    expect(first.totals.merged).toBe(2);
    const auditsAfterFirst = await countAudits('batch-X');

    const retry = await runChunk({ pairs: reviewed, chunkSize: 25, batchId: 'batch-X' });
    expect(retry.totals.merged).toBe(0);
    expect(retry.skipped.every((s) => s.reason === 'already_resolved')).toBe(true);

    const row = await batchRow('batch-X');
    expect(row!.admin_id).toBe('admin-a');
    expect(row!.chunks_run).toBe('2');
    expect(row!.merged_count).toBe('2'); // unchanged — the retry merged nothing
    expect(await countAudits('batch-X')).toBe(auditsAfterFirst);
    expect(await countStudents()).toBe(2);
  });

  it('aggregate totals equal the chunk results and the per-merge audit rows', async () => {
    if (!db) return;
    await seedSafePairs(4, 'Totals');
    await asClaimsOnly(ADMIN_A_UID);
    const p = await preview();
    const reviewed = reviewedList(p);

    const merged: string[] = [];
    let remaining = reviewed.length;
    let guard = 0;
    while (remaining > 0 && guard < 6) {
      guard += 1;
      const res = await runChunk({ pairs: reviewed, chunkSize: 1, batchId: 'batch-X' });
      merged.push(...res.merged.map((m) => m.auditId));
      remaining = res.totals.remaining;
      if (res.totals.merged === 0) break;
    }
    expect(merged).toHaveLength(4);

    const row = await batchRow('batch-X');
    const chunkResults = JSON.parse(row!.chunk_results as string) as Array<{ merged: unknown[]; skipped: unknown[]; blocked: unknown[] }>;
    expect(chunkResults).toHaveLength(4);
    const summedMerged = chunkResults.reduce((n, c) => n + c.merged.length, 0);
    const summedSkipped = chunkResults.reduce((n, c) => n + c.skipped.length, 0);
    const summedBlocked = chunkResults.reduce((n, c) => n + c.blocked.length, 0);

    expect(Number(row!.merged_count)).toBe(summedMerged);
    expect(Number(row!.skipped_count)).toBe(summedSkipped);
    expect(Number(row!.blocked_count)).toBe(summedBlocked);
    expect(Number(row!.merged_count)).toBe(4);
    expect(Number(row!.chunks_run)).toBe(4);
    expect(await countAudits('batch-X')).toBe(4);
    // Every audit id the chunks reported exists exactly once.
    const { rows } = await db.query(
      `SELECT id FROM public.student_merge_audits WHERE batch_id = 'batch-X' ORDER BY id`,
    );
    expect(rows.map((r) => r.id).sort()).toEqual([...merged].sort());
  });

  it('per-merge audits keep their own detail and are not corrupted by chunking', async () => {
    if (!db) return;
    const pairs = await seedSafePairs(3, 'Detail');
    await asClaimsOnly(ADMIN_A_UID);
    const p = await preview();
    const reviewed = reviewedList(p);

    await runChunk({ pairs: reviewed, chunkSize: 1, batchId: 'batch-X' });
    await runChunk({ pairs: reviewed, chunkSize: 1, batchId: 'batch-X' });

    const { rows } = await db.query<Record<string, any>>(
      `SELECT id, canonical_id, duplicate_id, admin_id, reason, merge_kind, batch_id, batch_policy, batch_size,
              before_counts, after_counts, enrollment_action
         FROM public.student_merge_audits WHERE batch_id = 'batch-X' ORDER BY id`,
    );
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(row.merge_kind).toBe('safe_batch');
      expect(row.batch_policy).toBe('safe_batch_parent_assigned_keeper');
      expect(Number(row.batch_size)).toBe(1);
      expect(row.admin_id).toBe('admin-a');
      expect(row.canonical_id).toBeTruthy();
      expect(row.duplicate_id).toBeTruthy();
      expect(row.canonical_id).not.toBe(row.duplicate_id);
      // The keeper is always the parent-assigned record of its own pair.
      const pair = pairs.find((x) => x.keeperId === row.canonical_id);
      expect(pair, `audit ${row.id} names a keeper the batch never paired`).toBeTruthy();
      expect(pair!.removedId).toBe(row.duplicate_id);
      expect(row.before_counts).toBeTruthy();
      expect(row.after_counts).toBeTruthy();
      expect(String(row.reason)).toContain('Safe batch merge (batch-X)');
      expect(row.enrollment_action).toBeTruthy();
    }
    // No audit row was rewritten by the second chunk.
    const { rows: distinct } = await db.query(
      `SELECT count(DISTINCT id)::text AS n, count(*)::text AS total
         FROM public.student_merge_audits WHERE batch_id = 'batch-X'`,
    );
    expect(distinct[0].n).toBe(distinct[0].total);
  });

  it('a legacy batch row with a NULL admin_id can never be adopted', async () => {
    if (!db) return;
    await seedSafePair('Legacy');
    await asOwner();
    await db.query(
      `INSERT INTO public.student_merge_batches (id, admin_id, chunk_size) VALUES ('batch-legacy', NULL, 25)`,
    );

    await asClaimsOnly(ADMIN_A_UID);
    const p = await preview();
    const err = await captureError(() => runChunk({ pairs: reviewedList(p), chunkSize: 25, batchId: 'batch-legacy' }));
    expect(err.message).toMatch(/batch_id_not_owned/);
    expect(err.code).toBe('42501');

    await asOwner();
    const row = await batchRow('batch-legacy');
    expect(row!.admin_id).toBeNull(); // never claimed
    expect(row!.chunks_run).toBe('1'); // never accumulated
    expect(await countStudents()).toBe(2);
  });

  it('server-generated batch ids still work and never collide between two administrators', async () => {
    if (!db) return;
    await seedSafePairs(2, 'Generated');
    await asClaimsOnly(ADMIN_A_UID);
    const pA = await preview();
    const resA = await runChunk({ pairs: reviewedList(pA), chunkSize: 25, batchId: null });
    expect(resA.batchId).toMatch(/^batch-/);
    expect(resA.adminId).toBe('admin-a');

    await asClaimsOnly(ADMIN_B_UID);
    const pB = await preview();
    const resB = await runChunk({ pairs: reviewedList(pB), chunkSize: 25, batchId: null });
    expect(resB.batchId).toMatch(/^batch-/);
    expect(resB.batchId).not.toBe(resA.batchId);
    expect(resB.adminId).toBe('admin-b');

    await asOwner();
    expect((await batchRow(resA.batchId))!.admin_id).toBe('admin-a');
    expect((await batchRow(resB.batchId))!.admin_id).toBe('admin-b');
    const { rows } = await db.query<{ n: string }>('SELECT count(*)::text AS n FROM public.student_merge_batches');
    expect(Number(rows[0].n)).toBe(2);
  });

  it('the batch id stays a bound value: 101 characters refused, SQL metacharacters stored verbatim', async () => {
    if (!db) return;
    await seedSafePairs(2, 'Bound');
    await asClaimsOnly(ADMIN_A_UID);
    const p = await preview();
    const reviewed = reviewedList(p);

    const tooLong = 'b'.repeat(101);
    const longErr = await captureError(() => runChunk({ pairs: reviewed, chunkSize: 25, batchId: tooLong }));
    expect(longErr.message).toMatch(/100 characters or fewer/);
    expect(longErr.code).toBe('22023'); // invalid_parameter_value

    // A hostile id is an opaque value, never SQL: nothing is injected, the row
    // is stored exactly as sent, and the merge still behaves.
    const hostile = "'; DROP TABLE public.students; --";
    const res = await runChunk({ pairs: reviewed, chunkSize: 1, batchId: hostile });
    expect(res.batchId).toBe(hostile);
    expect(res.totals.merged).toBe(1);

    await asOwner();
    const row = await batchRow(hostile);
    expect(row!.id).toBe(hostile);
    expect(row!.admin_id).toBe('admin-a');
    expect(await countStudents()).toBe(3); // 4 seeded − 1 merged; the table survived
    expect(await countAudits(hostile)).toBe(1);

    // And a second administrator cannot adopt that id either.
    await asClaimsOnly(ADMIN_B_UID);
    const pB = await preview();
    const hijack = await captureError(() => runChunk({ pairs: reviewedList(pB), chunkSize: 25, batchId: hostile }));
    expect(hijack.message).toMatch(/batch_id_not_owned/);
    await asOwner();
  });

  it('the ownership guard runs before the role guard is bypassed: a supervisor never reaches the batch row', async () => {
    if (!db) return;
    await seedSafePair('Supervisor');
    await asClaimsOnly(ADMIN_A_UID);
    const pA = await preview();
    await runChunk({ pairs: reviewedList(pA), chunkSize: 25, batchId: 'batch-X' });

    await asClaimsOnly(SUPERVISOR_UID);
    const err = await captureError(() =>
      runChunk({ pairs: null, chunkSize: 25, batchId: 'batch-X' }),
    );
    // Role first: the refusal is the admin gate, and no batch write happened.
    expect(err.message).toMatch(/Only administrators may run the safe duplicate batch merge/);
    expect(err.code).toBe('42501');

    await asOwner();
    const row = await batchRow('batch-X');
    expect(row!.admin_id).toBe('admin-a');
    expect(row!.chunks_run).toBe('1');
  });
});
