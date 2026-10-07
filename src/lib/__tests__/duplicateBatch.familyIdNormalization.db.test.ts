// SAFE BATCH — FAMILY ID NORMALIZATION GUARD (policy v3).
//
// Real PostgreSQL (PGlite), actual shipped migrations, no mocks.
//
// THE BUG THIS GUARDS. normalize_family_id() is regexp_replace(raw,'\D','','g'),
// so a raw family ID with no digit at all — 'HOUSE-RED', 'FAM-ABC' — normalizes
// to ''. The eligibility policy used to compare only the NORMALIZED values, so it
// saw '' on that side, classified the pair "both_blank", marked it SAFE,
// transferred nothing, and the merge then DELETED the duplicate — destroying the
// value without it ever appearing in transferred_fields. The naive
// "transferred values missing from keeper = 0" check passed vacuously, because it
// only ever looked at values the policy knew it was transferring.
//
// Every assertion below is read back from the students table or the audit row
// after a real RPC call.

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
const PHRASE = 'MERGE SAFE DUPLICATES';

interface BatchRow {
  pairKey: string;
  keeperId: string;
  removedId: string;
  eligible: boolean;
  severity: string | null;
  exclusionCodes: string[];
  eligibilityCodes: string[];
  fieldStates: Record<string, { state: string; action: string; value?: string | null; proof?: string;
    keeperRaw?: string | null; removedRaw?: string | null }>;
  transfers: Record<string, string | null>;
  fingerprint: string | null;
}

interface BatchReport {
  summary: { candidatePairs: number; safeCount: number; blockedCount: number; needsReviewCount: number };
  rows: BatchRow[];
  excludedRows: Array<{
    pairKey: string; keeperId: string; removedId: string; severity: string;
    exclusionCodes: string[]; fieldStates?: Record<string, { state: string; action: string }>;
  }>;
}

interface ChunkResult {
  merged: Array<{ keeperId: string; removedId: string; transfers?: Record<string, string | null> }>;
  skipped: unknown[];
  blocked: unknown[];
  totals: { merged: number; remaining: number };
}

interface VerifyResult {
  dataPreservation?: {
    lostFamilyIds: number;
    lostFamilyDetail: unknown[];
    familyIdsChecked: number;
    auditsUnverifiable: number;
  };
  audits?: { safeBatch: number; individual: number };
}

let db: PgDuplicateDb | null = null;
let seq = 0;

function scenarioName(prefix: string) {
  seq += 1;
  return `${prefix} Norm${seq} Xaaji`;
}

async function report(): Promise<BatchReport> {
  if (!db) throw new Error('db not ready');
  return db.rpc<BatchReport>('get_safe_duplicate_batch', { p_limit: 200, p_offset: 0, p_include_excluded: true });
}

async function runBatch(): Promise<ChunkResult> {
  if (!db) throw new Error('db not ready');
  return db.rpc<ChunkResult>('merge_safe_duplicate_batch', {
    p_pairs: null, p_chunk_size: 25, p_confirm_phrase: PHRASE,
    p_reason: 'family id normalization guard test', p_batch_id: null,
  });
}

async function verify(): Promise<VerifyResult> {
  if (!db) throw new Error('db not ready');
  return db.rpc<VerifyResult>('verify_safe_duplicate_batch_state', {});
}

function findRow(rows: BatchRow[], keeperId: string) {
  return rows.find((r) => r.keeperId === keeperId);
}

function findExcluded(res: BatchReport, keeperId: string) {
  return res.excludedRows.find((r) => r.keeperId === keeperId);
}

/** One two-record candidate group. All other profile fields are blank so the
 *  family ID under test is the only thing driving the verdict. */
async function seedPair(p: {
  name: string; className?: string;
  aFamily?: string | null; bFamily?: string | null;
  aPhone?: string | null; bPhone?: string | null;
  /** Distinct parents keep two pairs' family IDs from legitimately conflicting. */
  aParent?: string;
}) {
  if (!db) throw new Error('db not ready');
  const className = p.className ?? 'Foundation A';
  const aId = `fn-a-${seq}-${Math.random().toString(36).slice(2, 7)}`;
  const bId = `fn-b-${seq}-${Math.random().toString(36).slice(2, 7)}`;
  await seedStudent(db, {
    id: aId, name: p.name, className, parentId: p.aParent ?? 'parent-1',
    familyId: p.aFamily ?? null, parentPhone: p.aPhone ?? null,
    createdAt: '2025-03-01T08:00:00Z',
  });
  await seedStudent(db, {
    id: bId, name: p.name, className, parentId: null,
    familyId: p.bFamily ?? null, parentPhone: p.bPhone ?? null,
    createdAt: '2026-09-01T08:00:00Z',
  });
  for (const id of [aId, bId]) {
    await seedEnrollment(db, { id: `enr-${id}-open`, studentId: id, className, academicYearId: 'ay-2026' });
  }
  return { aId, bId, className };
}

/** A sibling already assigned to the keeper's parent — the family proof. */
async function seedSibling(familyId: string | null) {
  if (!db) throw new Error('db not ready');
  const id = `fn-sib-${seq}-${Math.random().toString(36).slice(2, 7)}`;
  await seedStudent(db, {
    id, name: `${scenarioName('Sibling')} Walaal`, className: 'Grade 8-Z',
    parentId: 'parent-1', familyId,
  });
  return id;
}

async function readFamilyId(id: string) {
  if (!db) throw new Error('db not ready');
  const { rows } = await db.query<{ familyId: string | null }>(
    `SELECT "familyId" FROM public.students WHERE id = $1`, [id]);
  return rows.length ? (rows[0].familyId ?? null) : undefined; // undefined = row gone
}

async function auditFor(keeperId: string) {
  if (!db) throw new Error('db not ready');
  const { rows } = await db.query<{
    id: string; merge_kind: string | null;
    transferred_fields: Record<string, string | null> | null;
    removed_profile: Record<string, string | null> | null;
  }>(
    `SELECT id, merge_kind, transferred_fields, removed_profile
       FROM public.student_merge_audits WHERE canonical_id = $1 ORDER BY id DESC LIMIT 1`,
    [keeperId]);
  return rows[0] ?? null;
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
  await db.exec(`
    DELETE FROM public.students;
    DELETE FROM public.student_merge_audits;
    DELETE FROM public.student_merge_batches;
    DELETE FROM public.audit_logs;
  `);
  await db.setAuthUid(ADMIN_UID);
});

afterAll(async () => { if (db) await db.close(); });

// ═════════════════════════════════════════════════════════════════════════════
// CASES A–B: a raw family ID the normalizer erases must go to REVIEW
// ═════════════════════════════════════════════════════════════════════════════
describe('family ID normalization guard — unreadable values', () => {
  it('Case A: keeper NULL + duplicate "HOUSE-RED" -> REVIEW, never SAFE', async () => {
    if (!db) return;
    const { aId, bId } = await seedPair({ name: scenarioName('HouseRed'), aFamily: null, bFamily: 'HOUSE-RED' });
    const res = await report();

    expect(res.summary.safeCount).toBe(0);
    const ex = findExcluded(res, aId);
    expect(ex).toBeTruthy();
    expect(ex?.severity).toBe('review');
    expect(ex?.exclusionCodes).toContain('family_id_invalid_normalization');
    expect(ex?.fieldStates?.familyId.action).toBe('review');

    // And it must not be reachable through the merge either.
    const result = await runBatch();
    expect(result.totals.merged).toBe(0);
    expect(await readFamilyId(aId)).toBe(null);      // keeper untouched
    expect(await readFamilyId(bId)).toBe('HOUSE-RED'); // duplicate still exists, value intact
  });

  it('Case B: keeper NULL + duplicate "FAM-ABC" -> REVIEW', async () => {
    if (!db) return;
    const { aId, bId } = await seedPair({ name: scenarioName('FamAbc'), aFamily: null, bFamily: 'FAM-ABC' });
    const res = await report();
    expect(res.summary.safeCount).toBe(0);
    const ex = findExcluded(res, aId);
    expect(ex?.severity).toBe('review');
    expect(ex?.exclusionCodes).toContain('family_id_invalid_normalization');
    expect((await runBatch()).totals.merged).toBe(0);
    expect(await readFamilyId(bId)).toBe('FAM-ABC');
  });

  it('the guard also fires when the KEEPER holds the unreadable value', async () => {
    // Nothing would be lost here (the keeper survives), but the policy still
    // cannot reason about the relationship, so it must not silently merge.
    if (!db) return;
    const { aId } = await seedPair({ name: scenarioName('KeeperBad'), aFamily: 'ALPHA', bFamily: null });
    const res = await report();
    expect(res.summary.safeCount).toBe(0);
    expect(findExcluded(res, aId)?.exclusionCodes).toContain('family_id_invalid_normalization');
  });

  it('the guard does NOT fire for a value that merely loses its letters', async () => {
    // 'FAM-12' still normalizes to '12' — readable, so the normal numeric rules
    // apply and this is a plain one-sided case, not an unreadable one.
    if (!db) return;
    const { aId } = await seedPair({ name: scenarioName('Fam12'), aFamily: null, bFamily: 'FAM-12' });
    const res = await report();
    const ex = findExcluded(res, aId);
    expect(ex?.exclusionCodes ?? []).not.toContain('family_id_invalid_normalization');
    expect(ex?.exclusionCodes).toContain('family_id_transfer_unproven');
  });

  it('the published reason text exists and is classified review, not blocked', async () => {
    if (!db) return;
    const policy = await db.rpc<{ exclusionCodes: Record<string, string>; blockedCodes: string[]; version: number }>(
      'safe_duplicate_batch_policy', {});
    expect(policy.version).toBe(3);
    expect(policy.exclusionCodes.family_id_invalid_normalization).toMatch(/normaliz/i);
    expect(policy.blockedCodes).not.toContain('family_id_invalid_normalization');
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// CASE C: readable one-sided family ID still follows the existing proven rules
// ═════════════════════════════════════════════════════════════════════════════
describe('family ID normalization guard — readable values are unaffected', () => {
  it('Case C1: "FAM-12" with no proof -> REVIEW (existing unprovable rule intact)', async () => {
    if (!db) return;
    const { aId } = await seedPair({ name: scenarioName('C1'), aFamily: null, bFamily: 'FAM-12' });
    const res = await report();
    expect(res.summary.safeCount).toBe(0);
    expect(findExcluded(res, aId)?.exclusionCodes).toContain('family_id_transfer_unproven');
    expect((await runBatch()).totals.merged).toBe(0);
  });

  it('Case C2: "FAM-12" WITH sibling proof -> SAFE and transferred', async () => {
    if (!db) return;
    const { aId, bId } = await seedPair({ name: scenarioName('C2'), aFamily: null, bFamily: 'FAM-12' });
    await seedSibling('FAM-12');
    const res = await report();
    const row = findRow(res.rows, aId);
    expect(row?.eligible).toBe(true);
    expect(row?.eligibilityCodes).toContain('family_id_from_removed_preserved');
    expect(row?.transfers.familyId).toBe('FAM-12');

    expect((await runBatch()).totals.merged).toBe(1);
    expect(await readFamilyId(aId)).toBe('FAM-12'); // raw bytes, not the normalized '12'
    expect(await readFamilyId(bId)).toBe(undefined); // duplicate removed
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// CASES D–E: existing conflict / identity rules unchanged
// ═════════════════════════════════════════════════════════════════════════════
describe('family ID normalization guard — existing rules preserved', () => {
  it('Case D: both records hold legitimate CONFLICTING family IDs -> BLOCKED', async () => {
    if (!db) return;
    const { aId, bId } = await seedPair({ name: scenarioName('D'), aFamily: '0010', bFamily: '0020' });
    const res = await report();
    expect(res.summary.safeCount).toBe(0);
    const ex = findExcluded(res, aId);
    expect(ex?.severity).toBe('blocked');
    expect(ex?.exclusionCodes).toContain('family_id_conflict');
    expect(ex?.exclusionCodes).not.toContain('family_id_invalid_normalization');
    expect((await runBatch()).totals.merged).toBe(0);
    expect(await readFamilyId(aId)).toBe('0010');
    expect(await readFamilyId(bId)).toBe('0020');
  });

  it('Case E: both records hold the SAME legitimate family ID -> SAFE', async () => {
    if (!db) return;
    const { aId, bId } = await seedPair({ name: scenarioName('E'), aFamily: '0010', bFamily: '0010' });
    const res = await report();
    const row = findRow(res.rows, aId);
    expect(row?.eligible).toBe(true);
    expect(row?.eligibilityCodes).toContain('same_family_id');
    expect(row?.fieldStates.familyId.state).toBe('identical');
    expect((await runBatch()).totals.merged).toBe(1);
    expect(await readFamilyId(aId)).toBe('0010');
    expect(await readFamilyId(bId)).toBe(undefined);
  });

  it('an unreadable duplicate value is NOT reclassified as a conflict', async () => {
    // Keeper '0010' (readable) vs duplicate 'HOUSE-RED' (unreadable). The two
    // cannot be compared, so this must be review — never blocked, never safe.
    if (!db) return;
    const { aId } = await seedPair({ name: scenarioName('Mixed'), aFamily: '0010', bFamily: 'HOUSE-RED' });
    const res = await report();
    expect(res.summary.safeCount).toBe(0);
    const ex = findExcluded(res, aId);
    expect(ex?.severity).toBe('review');
    expect(ex?.exclusionCodes).toContain('family_id_invalid_normalization');
    expect(ex?.exclusionCodes).not.toContain('family_id_conflict');
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// CASE F: the individual review path preserves the value
// ═════════════════════════════════════════════════════════════════════════════
describe('family ID normalization guard — individual review preserves the value', () => {
  it('Case F: after review writes the value to the keeper, merging preserves it', async () => {
    if (!db) return;
    const { aId, bId } = await seedPair({ name: scenarioName('F'), aFamily: null, bFamily: 'HOUSE-RED' });

    // 1. The batch refuses it.
    expect((await runBatch()).totals.merged).toBe(0);
    expect(await readFamilyId(bId)).toBe('HOUSE-RED');

    // 2. Review step: an administrator carries the value across explicitly.
    //    (merge_duplicate_students_resolved has no family_id resolution key — it
    //    reads familyId for its snapshot but never writes it — so this write is
    //    what actually preserves the data.)
    await db.query(`UPDATE public.students SET "familyId" = 'HOUSE-RED' WHERE id = $1`, [aId]);

    // 3. The pair is now legitimately safe: identical on both sides.
    const res = await report();
    expect(findRow(res.rows, aId)?.eligible).toBe(true);
    expect((await runBatch()).totals.merged).toBe(1);

    // 4. The value survived on the keeper.
    expect(await readFamilyId(aId)).toBe('HOUSE-RED');
    expect(await readFamilyId(bId)).toBe(undefined);
  });

  it('Case F (negative): skipping the review step would destroy the value', async () => {
    // Documents WHY the guard is mandatory rather than advisory: the individual
    // merge RPC does not write familyId, so merging without the review write
    // loses it. The safe batch must therefore never reach this state on its own.
    if (!db) return;
    const { aId, bId } = await seedPair({ name: scenarioName('FNeg'), aFamily: null, bFamily: 'HOUSE-RED' });
    await db.rpc('merge_duplicate_students_resolved', {
      p_canonical_id: aId, p_duplicate_id: bId, p_reason: 'forced by test',
      p_resolution: {
        profile_resolution: {
          name: 'canonical', class_name: 'canonical', gov_id: 'canonical',
          parent_id: 'canonical', parent_phone: 'canonical', transport: 'canonical',
        },
        exam_resolution: [], attendance_resolution: [], quiz_resolution: [],
        release_resolution: [], report_comment_resolution: [],
      },
    });
    expect(await readFamilyId(bId)).toBe(undefined);      // duplicate gone
    expect(await readFamilyId(aId)).toBe(null);           // value LOST
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 4. HARD SAFETY INVARIANT
// ═════════════════════════════════════════════════════════════════════════════
describe('hard invariant — no safe-batch merge may destroy a raw Family ID', () => {
  it('the invariant reports 0 lost after a normal run, and is not vacuous', async () => {
    if (!db) return;
    // A real transfer plus a real identical pair — both legitimate.
    await seedPair({ name: scenarioName('Inv1'), aFamily: null, bFamily: '0077' });
    await seedSibling('0077');
    // parent-2: a second pair under the same parent would legitimately read as
    // a family conflict against the first pair's family ID.
    await seedPair({ name: scenarioName('Inv2'), aFamily: '0088', bFamily: '0088', aParent: 'parent-2' });
    expect((await runBatch()).totals.merged).toBe(2);

    const v = await verify();
    const dp = v.dataPreservation;
    expect(dp).toBeTruthy();
    expect(dp?.lostFamilyIds).toBe(0);
    expect(dp?.familyIdsChecked).toBe(2);
    expect(dp?.auditsUnverifiable).toBe(0);
  });

  it('NEGATIVE CONTROL: the invariant DETECTS a destroyed Family ID', async () => {
    // This is the test that proves the check can fail. A safe_batch audit row is
    // written by hand describing exactly the old bug: the removed record carried
    // a raw family ID that is now absent from both the keeper and the transfer
    // list. The naive "transferred values missing = 0" check would pass here.
    if (!db) return;
    await seedStudent(db, { id: 'inv-keeper', name: 'Invariant Keeper', className: 'Grade 1-A', parentId: 'parent-1', familyId: null });
    await db.query(
      `INSERT INTO public.student_merge_audits
         (id, canonical_id, duplicate_id, admin_id, reason, before_counts, after_counts,
          merge_kind, transferred_fields, field_states, removed_profile)
       VALUES ('inv-audit','inv-keeper','inv-gone','admin-1','synthetic loss','{}'::jsonb,'{}'::jsonb,
               'safe_batch','{}'::jsonb,'{}'::jsonb,
               jsonb_build_object('familyId','HOUSE-RED','parentPhone',null,'transport',null,'govId',null))`);

    const v = await verify();
    const dp = v.dataPreservation;
    expect(dp?.lostFamilyIds).toBe(1);
    expect(dp?.familyIdsChecked).toBe(1);
    const detail = (dp?.lostFamilyDetail ?? [])[0] as Record<string, unknown>;
    expect(detail.removedRawFamilyId).toBe('HOUSE-RED');
    expect(detail.keeperFamilyIdNow).toBe('');
    expect(detail.auditId).toBe('inv-audit');
  });

  it('the invariant accepts a value that was transferred rather than kept', async () => {
    if (!db) return;
    await seedStudent(db, { id: 'inv-k2', name: 'Invariant Keeper Two', className: 'Grade 1-A', parentId: 'parent-1', familyId: '0055' });
    await db.query(
      `INSERT INTO public.student_merge_audits
         (id, canonical_id, duplicate_id, admin_id, reason, before_counts, after_counts,
          merge_kind, transferred_fields, field_states, removed_profile)
       VALUES ('inv-audit-2','inv-k2','inv-gone-2','admin-1','synthetic transfer','{}'::jsonb,'{}'::jsonb,
               'safe_batch', jsonb_build_object('familyId','0055'), '{}'::jsonb,
               jsonb_build_object('familyId','0055','parentPhone',null,'transport',null,'govId',null))`);
    const dp = (await verify()).dataPreservation;
    expect(dp?.lostFamilyIds).toBe(0);
    expect(dp?.familyIdsChecked).toBe(1);
  });

  it('the invariant distinguishes "verified clean" from "cannot verify"', async () => {
    // An audit written before removed_profile existed has no raw source value.
    // Reporting it as unverifiable is what stops a false "0 lost".
    if (!db) return;
    await seedStudent(db, { id: 'inv-k3', name: 'Invariant Keeper Three', className: 'Grade 1-A', parentId: 'parent-1' });
    await db.query(
      `INSERT INTO public.student_merge_audits
         (id, canonical_id, duplicate_id, admin_id, reason, before_counts, after_counts, merge_kind)
       VALUES ('inv-audit-3','inv-k3','inv-gone-3','admin-1','legacy row','{}'::jsonb,'{}'::jsonb,'safe_batch')`);
    const dp = (await verify()).dataPreservation;
    expect(dp?.lostFamilyIds).toBe(0);
    expect(dp?.familyIdsChecked).toBe(0);
    expect(dp?.auditsUnverifiable).toBe(1);
  });

  it('the merge records the removed record raw profile on every safe-batch audit', async () => {
    if (!db) return;
    const { aId } = await seedPair({
      name: scenarioName('RawProfile'), aFamily: null, bFamily: '0099',
      bPhone: '634453468',
    });
    await seedSibling('0099');
    expect((await runBatch()).totals.merged).toBe(1);
    const audit = await auditFor(aId);
    expect(audit?.merge_kind).toBe('safe_batch');
    expect(audit?.removed_profile?.familyId).toBe('0099');
    expect(audit?.removed_profile?.parentPhone).toBe('634453468');
    expect(audit?.transferred_fields?.familyId).toBe('0099');
  });
});
