// SAFE BATCH — FIELD CONSOLIDATION CONTRACT (policy v2, migration 20261008).
//
// Executed against real PostgreSQL (PGlite) with the ACTUAL shipped migrations.
// No mocks: every verdict asserted here is what the DATABASE returns, and every
// "value survived" assertion is read back from the students table after a real
// merge_safe_duplicate_batch() call.
//
// The rule under test — a SAFE UNION, applied field by field:
//   keeper has value                   -> preserve
//   both identical                     -> keep one
//   keeper blank + duplicate has value -> TRANSFER to the keeper
//   both populated and different       -> BLOCK (a true conflict)
//   both blank                         -> nothing to do
//
// Consolidation is never the basis for a merge: the pair must already satisfy
// the strong duplicate-identity conditions from policy v1.

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
const TEACHER_UID = 'aaaaaaaa-0000-4000-8000-000000000002';
const PHRASE = 'MERGE SAFE DUPLICATES';

interface BatchRow {
  pairKey: string;
  keeperId: string;
  removedId: string;
  eligible: boolean;
  severity: string | null;
  exclusionCodes: string[];
  eligibilityCodes: string[];
  fieldStates: Record<string, { state: string; action: string; value?: string | null; proof?: string }>;
  transfers: Record<string, string | null>;
  fingerprint: string | null;
}

interface BatchReport {
  summary: { candidatePairs: number; safeCount: number; blockedCount: number; needsReviewCount: number };
  exclusionReasons: Record<string, number>;
  rows: BatchRow[];
  excludedRows: Array<{
    pairKey: string; keeperId: string; removedId: string; severity: string;
    exclusionCodes: string[]; fieldStates?: Record<string, { state: string; action: string }>;
  }>;
}

interface PreviewResult {
  rows: Array<{ pairKey: string; keeperId: string; removedId: string; fingerprint: string }>;
  summary: Record<string, number>;
}

interface MergedEntry {
  pairKey: string;
  keeperId: string;
  removedId: string;
  auditId: string;
  transfers?: Record<string, string | null>;
  fieldStates?: Record<string, unknown>;
}

interface ChunkResult {
  batchId: string;
  merged: MergedEntry[];
  skipped: Array<{ pairKey: string; reason: string; codes: string[] }>;
  blocked: Array<{ pairKey: string; reason: string; codes: string[] }>;
  failed: unknown[];
  totals: { merged: number; skipped: number; blocked: number; failed: number; remaining: number };
}

let db: PgDuplicateDb | null = null;
let seq = 0;

function scenarioName(prefix: string) {
  seq += 1;
  return `${prefix} Consol${seq} Xaaji`;
}

async function report(): Promise<BatchReport> {
  if (!db) throw new Error('db not ready');
  return db.rpc<BatchReport>('get_safe_duplicate_batch', { p_limit: 200, p_offset: 0, p_include_excluded: true });
}

async function preview(): Promise<PreviewResult> {
  if (!db) throw new Error('db not ready');
  return db.rpc<PreviewResult>('preview_safe_duplicate_batch', { p_limit: 500 });
}

async function runBatch(opts: { pairs?: unknown; phrase?: string | null; batchId?: string } = {}): Promise<ChunkResult> {
  if (!db) throw new Error('db not ready');
  return db.rpc<ChunkResult>('merge_safe_duplicate_batch', {
    p_pairs: opts.pairs === undefined ? null : opts.pairs,
    p_chunk_size: 25,
    p_confirm_phrase: opts.phrase === undefined ? PHRASE : opts.phrase,
    p_reason: 'field consolidation test',
    p_batch_id: opts.batchId ?? null,
  });
}

function findRow(rows: BatchRow[], keeperId: string) {
  return rows.find((r) => r.keeperId === keeperId);
}

function findExcluded(res: BatchReport, keeperId: string) {
  return res.excludedRows.find((r) => r.keeperId === keeperId);
}

interface PairSeed {
  name: string;
  className?: string;
  aParent?: string | null;
  aGov?: string | null;
  aPhone?: string | null;
  aTransport?: string | null;
  aFamily?: string | null;
  bParent?: string | null;
  bGov?: string | null;
  bPhone?: string | null;
  bTransport?: string | null;
  bFamily?: string | null;
}

/**
 * Seeds one two-record candidate group. Record A is the keeper (parent
 * assigned); record B is the unassigned duplicate. Every profile field defaults
 * to BLANK on both sides so a test only has to name the one field it cares
 * about — otherwise the other fields would drive the verdict.
 */
async function seedPair(p: PairSeed) {
  if (!db) throw new Error('db not ready');
  const className = p.className ?? 'Foundation A';
  const aId = `fc-a-${seq}-${Math.random().toString(36).slice(2, 7)}`;
  const bId = `fc-b-${seq}-${Math.random().toString(36).slice(2, 7)}`;
  await seedStudent(db, {
    id: aId, name: p.name, className,
    parentId: p.aParent === undefined ? 'parent-1' : p.aParent,
    govId: p.aGov ?? null,
    parentPhone: p.aPhone ?? null,
    transport: p.aTransport ?? null,
    familyId: p.aFamily ?? null,
    createdAt: '2025-03-01T08:00:00Z',
  });
  await seedStudent(db, {
    id: bId, name: p.name, className,
    parentId: p.bParent ?? null,
    govId: p.bGov ?? null,
    parentPhone: p.bPhone ?? null,
    transport: p.bTransport ?? null,
    familyId: p.bFamily ?? null,
    createdAt: '2026-09-01T08:00:00Z',
  });
  for (const id of [aId, bId]) {
    await seedEnrollment(db, {
      id: `enr-${id}-open`, studentId: id, className, academicYearId: 'ay-2026',
    });
  }
  return { aId, bId, className };
}

/** A third student, deliberately OUTSIDE the candidate group (different name). */
async function seedUnrelated(opts: {
  parentId?: string | null; govId?: string | null; parentPhone?: string | null;
  familyId?: string | null; className?: string;
}) {
  if (!db) throw new Error('db not ready');
  const id = `fc-x-${seq}-${Math.random().toString(36).slice(2, 7)}`;
  const name = `${scenarioName('Other')} Sibling`;
  await seedStudent(db, {
    id, name, className: opts.className ?? 'Grade 5B',
    parentId: opts.parentId ?? null, govId: opts.govId ?? null,
    parentPhone: opts.parentPhone ?? null, familyId: opts.familyId ?? null,
  });
  return id;
}

async function readStudent(id: string) {
  if (!db) throw new Error('db not ready');
  const { rows } = await db.query<{
    id: string; name: string; className: string; parentId: string | null;
    govId: string | null; parentPhone: string | null; transport: string | null; familyId: string | null;
  }>(`SELECT id, name, "className", "parentId", "govId", "parentPhone", transport, "familyId"
        FROM public.students WHERE id = $1`, [id]);
  return rows[0] ?? null;
}

async function studentExists(id: string) {
  if (!db) throw new Error('db not ready');
  const { rows } = await db.query<{ n: string }>(
    `SELECT count(*)::text AS n FROM public.students WHERE id = $1`, [id]);
  return Number(rows[0]?.n ?? 0) > 0;
}

async function auditFor(keeperId: string) {
  if (!db) throw new Error('db not ready');
  const { rows } = await db.query<{
    id: string; canonical_id: string; duplicate_id: string;
    merge_kind: string | null; batch_id: string | null;
    transferred_fields: Record<string, string | null> | null;
    field_states: Record<string, unknown> | null;
  }>(
    `SELECT id, canonical_id, duplicate_id, merge_kind, batch_id,
            transferred_fields, field_states
       FROM public.student_merge_audits
      WHERE canonical_id = $1
      ORDER BY id DESC LIMIT 1`,
    [keeperId],
  );
  return rows[0] ?? null;
}

/** Byte-level digest of every table the batch can touch. */
async function snapshotAll() {
  if (!db) throw new Error('db not ready');
  const { rows } = await db.query<{ d: string }>(`
    SELECT md5(string_agg(t, '|' ORDER BY t))::text AS d FROM (
      SELECT id || ':' || coalesce(name,'') || ':' || coalesce("className",'') || ':'
             || coalesce("parentId",'') || ':' || coalesce("govId",'') || ':'
             || coalesce("parentPhone",'') || ':' || coalesce(transport,'') || ':'
             || coalesce("familyId",'') AS t FROM public.students
      UNION ALL SELECT 'aud:' || id FROM public.student_merge_audits
      UNION ALL SELECT 'bat:' || id FROM public.student_merge_batches
      UNION ALL SELECT 'log:' || id FROM public.audit_logs
      UNION ALL SELECT 'enr:' || id || coalesce("studentId",'') FROM public.student_enrollments
    ) z`);
  return rows[0]?.d ?? null;
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
// 1-5  PARENT PHONE
// ═════════════════════════════════════════════════════════════════════════════
describe('field consolidation — parent phone', () => {
  it('1. both records blank -> SAFE (nothing to consolidate)', async () => {
    if (!db) return;
    const { aId } = await seedPair({ name: scenarioName('PhoneBothBlank'), aPhone: null, bPhone: null });
    const res = await report();
    const row = findRow(res.rows, aId);
    expect(row?.eligible).toBe(true);
    expect(row?.fieldStates.parentPhone.state).toBe('both_blank');
    expect(row?.fieldStates.parentPhone.action).toBe('keep');
    expect(row?.transfers ?? {}).not.toHaveProperty('parentPhone');
  });

  it('2. only the keeper has a phone -> SAFE (keeper value preserved)', async () => {
    if (!db) return;
    const { aId } = await seedPair({ name: scenarioName('PhoneKeeperOnly'), aPhone: '634572257', bPhone: null });
    const res = await report();
    const row = findRow(res.rows, aId);
    expect(row?.eligible).toBe(true);
    expect(row?.fieldStates.parentPhone.state).toBe('keeper_only');
    expect(row?.transfers ?? {}).not.toHaveProperty('parentPhone');
  });

  it('3. only the duplicate has a phone -> SAFE and transferable', async () => {
    if (!db) return;
    const { aId } = await seedPair({ name: scenarioName('PhoneDupOnly'), aPhone: null, bPhone: '634453468' });
    const res = await report();
    const row = findRow(res.rows, aId);
    expect(row?.eligible).toBe(true);
    expect(row?.eligibilityCodes).toContain('parent_phone_from_removed_preserved');
    expect(row?.fieldStates.parentPhone).toMatchObject({ state: 'duplicate_only', action: 'transfer', value: '634453468' });
    expect(row?.transfers.parentPhone).toBe('634453468');
  });

  it('3b. the same phone on a SIBLING of the keeper parent corroborates -> still SAFE', async () => {
    if (!db) return;
    const { aId } = await seedPair({ name: scenarioName('PhoneSibling'), aPhone: null, bPhone: '634453468' });
    await seedUnrelated({ parentId: 'parent-1', parentPhone: '634453468' });
    const res = await report();
    expect(findRow(res.rows, aId)?.eligible).toBe(true);
    expect(findRow(res.rows, aId)?.transfers.parentPhone).toBe('634453468');
  });

  it('3c. a phone already used by a DIFFERENT parent -> BLOCKED (would fuse two families)', async () => {
    if (!db) return;
    const { aId } = await seedPair({ name: scenarioName('PhoneOtherFam'), aPhone: null, bPhone: '634453468' });
    await seedUnrelated({ parentId: 'parent-2', parentPhone: '634453468' });
    const res = await report();
    expect(res.summary.safeCount).toBe(0);
    const ex = findExcluded(res, aId);
    expect(ex?.exclusionCodes).toContain('parent_phone_belongs_to_other_family');
    expect(ex?.severity).toBe('blocked');
    expect(ex?.fieldStates?.parentPhone.action).toBe('block');
  });

  it('4. both populated and identical after normalization -> SAFE', async () => {
    if (!db) return;
    // International and local spellings of the same number.
    const { aId } = await seedPair({ name: scenarioName('PhoneSame'), aPhone: '252634572257', bPhone: '634572257' });
    const res = await report();
    const row = findRow(res.rows, aId);
    expect(row?.eligible).toBe(true);
    expect(row?.eligibilityCodes).toContain('same_parent_phone');
    expect(row?.fieldStates.parentPhone.state).toBe('identical');
  });

  it('5. both populated and different -> BLOCKED (a true conflict, not missing data)', async () => {
    if (!db) return;
    const { aId } = await seedPair({ name: scenarioName('PhoneClash'), aPhone: '634572257', bPhone: '639900112' });
    const res = await report();
    expect(res.summary.safeCount).toBe(0);
    const ex = findExcluded(res, aId);
    expect(ex?.exclusionCodes).toContain('parent_phone_conflict');
    expect(ex?.severity).toBe('blocked');
    expect(ex?.fieldStates?.parentPhone.state).toBe('conflict');
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 6-7  TRANSPORT
// ═════════════════════════════════════════════════════════════════════════════
describe('field consolidation — transport', () => {
  it('6. only the duplicate has a transport -> SAFE and transferable', async () => {
    if (!db) return;
    const { aId } = await seedPair({ name: scenarioName('TransportDupOnly'), aTransport: null, bTransport: '25' });
    const res = await report();
    const row = findRow(res.rows, aId);
    expect(row?.eligible).toBe(true);
    expect(row?.eligibilityCodes).toContain('transport_from_removed_preserved');
    expect(row?.transfers.transport).toBe('25');
  });

  it('7. incompatible non-empty transports -> BLOCKED', async () => {
    if (!db) return;
    const { aId } = await seedPair({ name: scenarioName('TransportClash'), aTransport: 'WALKER', bTransport: '9' });
    const res = await report();
    expect(res.summary.safeCount).toBe(0);
    const ex = findExcluded(res, aId);
    expect(ex?.exclusionCodes).toContain('transport_conflict');
    expect(ex?.severity).toBe('blocked');
    expect(ex?.fieldStates?.transport.state).toBe('conflict');
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 8-9  FAMILY ID (the deliberately conservative field)
// ═════════════════════════════════════════════════════════════════════════════
describe('field consolidation — family ID', () => {
  it('8. only the duplicate has a family ID -> SAFE only when the DB proves same family', async () => {
    if (!db) return;
    const { aId } = await seedPair({ name: scenarioName('FamilyProven'), aFamily: null, bFamily: '0077' });
    // PROOF: a sibling already assigned to the KEEPER'S OWN parent holds 0077.
    await seedUnrelated({ parentId: 'parent-1', familyId: '0077' });
    const res = await report();
    const row = findRow(res.rows, aId);
    expect(row?.eligible).toBe(true);
    expect(row?.eligibilityCodes).toContain('family_id_from_removed_preserved');
    expect(row?.fieldStates.familyId.proof).toBe('keeper_parent_sibling_holds_same_family_id');
    expect(row?.transfers.familyId).toBe('0077');
  });

  it('8b. only the duplicate has a family ID but the DB CANNOT prove it -> individual review, never guessed', async () => {
    if (!db) return;
    const { aId } = await seedPair({ name: scenarioName('FamilyUnproven'), aFamily: null, bFamily: '0088' });
    const res = await report();
    expect(res.summary.safeCount).toBe(0);
    const ex = findExcluded(res, aId);
    expect(ex?.exclusionCodes).toContain('family_id_transfer_unproven');
    expect(ex?.severity).toBe('review');
    expect(ex?.fieldStates?.familyId.action).toBe('review');
  });

  it('8c. the keeper parent already belongs to a DIFFERENT family -> BLOCKED', async () => {
    if (!db) return;
    const { aId } = await seedPair({ name: scenarioName('FamilyOther'), aFamily: null, bFamily: '0099' });
    // A sibling of the keeper's parent is already in family 0050.
    await seedUnrelated({ parentId: 'parent-1', familyId: '0050' });
    const res = await report();
    expect(res.summary.safeCount).toBe(0);
    const ex = findExcluded(res, aId);
    expect(ex?.exclusionCodes).toContain('family_id_conflict');
    expect(ex?.severity).toBe('blocked');
  });

  it('9. both records carry different family IDs -> BLOCKED', async () => {
    if (!db) return;
    const { aId } = await seedPair({ name: scenarioName('FamilyClash'), aFamily: '0010', bFamily: '0020' });
    const res = await report();
    expect(res.summary.safeCount).toBe(0);
    const ex = findExcluded(res, aId);
    expect(ex?.exclusionCodes).toContain('family_id_conflict');
    expect(ex?.severity).toBe('blocked');
    expect(ex?.fieldStates?.familyId.state).toBe('conflict');
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 10-11  GOV ID
// ═════════════════════════════════════════════════════════════════════════════
describe('field consolidation — Gov ID', () => {
  it('10. only the duplicate has a Gov ID, unique + identity passes -> SAFE and recorded as a transfer', async () => {
    if (!db) return;
    const { aId } = await seedPair({ name: scenarioName('GovDupOnly'), aGov: null, bGov: 'SH-114455' });
    const res = await report();
    const row = findRow(res.rows, aId);
    expect(row?.eligible).toBe(true);
    expect(row?.eligibilityCodes).toContain('gov_id_from_removed_preserved');
    expect(row?.transfers.govId).toBe('SH-114455');
  });

  it('10b. a Gov ID owned by a THIRD student -> BLOCKED (still enforced under v2)', async () => {
    if (!db) return;
    // 'THIRD 77' and 'THIRD-77' differ under the STRICT unique index but share
    // the loose gov_id_match_key — exactly the case the guard exists for.
    const { aId } = await seedPair({ name: scenarioName('GovThird'), aGov: null, bGov: 'THIRD-77' });
    await seedUnrelated({ govId: 'THIRD 77', parentId: 'parent-2' });
    const res = await report();
    expect(res.summary.safeCount).toBe(0);
    expect(findExcluded(res, aId)?.exclusionCodes).toContain('gov_id_belongs_to_third_student');
  });

  it('11. both records carry different Gov IDs -> BLOCKED', async () => {
    if (!db) return;
    const { aId } = await seedPair({ name: scenarioName('GovClash'), aGov: 'SH-114455', bGov: 'SH-998877' });
    const res = await report();
    expect(res.summary.safeCount).toBe(0);
    expect(findExcluded(res, aId)?.exclusionCodes).toContain('gov_id_conflict');
    expect(findExcluded(res, aId)?.severity).toBe('blocked');
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 12-14  THE MERGE ITSELF: transferred values survive, nothing is lost, audited
// ═════════════════════════════════════════════════════════════════════════════
describe('field consolidation — the merge preserves and audits the transferred data', () => {
  it('12. every one-sided value appears on the keeper after the merge', async () => {
    if (!db) return;
    const { aId, bId } = await seedPair({
      name: scenarioName('TransferAll'),
      aPhone: null, bPhone: '634453468',
      aTransport: null, bTransport: '14',
      aGov: null, bGov: 'SH-220011',
    });
    const result = await runBatch();
    expect(result.totals.merged).toBe(1);

    const keeper = await readStudent(aId);
    expect(keeper).not.toBeNull();
    expect(keeper?.parentPhone).toBe('634453468');
    expect(keeper?.transport).toBe('14');
    expect(keeper?.govId).toBe('SH-220011');
    expect(await studentExists(bId)).toBe(false);
  });

  it('12b. a PROVEN family ID is transferred too (the merge RPC never writes familyId)', async () => {
    if (!db) return;
    const { aId, bId } = await seedPair({
      name: scenarioName('TransferFamily'), aFamily: null, bFamily: '0077',
    });
    await seedUnrelated({ parentId: 'parent-1', familyId: '0077' });
    const result = await runBatch();
    expect(result.totals.merged).toBe(1);
    expect((await readStudent(aId))?.familyId).toBe('0077');
    expect(await studentExists(bId)).toBe(false);
  });

  it('13. no transferred data is lost: the keeper is the safe union of both records', async () => {
    if (!db) return;
    const { aId, bId } = await seedPair({
      name: scenarioName('SafeUnion'),
      aPhone: null, bPhone: '634453468',
      aTransport: '25', bTransport: '25',        // identical -> keep one
      aGov: 'SH-114455', bGov: null,             // keeper wins
    });
    await seedUnrelated({ parentId: 'parent-1', familyId: '0077' });
    const before = { keeper: await readStudent(aId), removed: await readStudent(bId) };
    const result = await runBatch();
    expect(result.totals.merged).toBe(1);

    const after = await readStudent(aId);
    // Every non-blank value that existed on EITHER record still exists.
    expect(after?.parentPhone).toBe(before.removed?.parentPhone);   // transferred
    expect(after?.transport).toBe('25');                            // preserved (identical)
    expect(after?.govId).toBe(before.keeper?.govId);                // keeper value wins
    expect(after?.name).toBe(before.keeper?.name);
    expect(after?.className).toBe(before.keeper?.className);
    expect(after?.parentId).toBe('parent-1');                       // keeper keeps its parent
    // The keeper's Student ID is the one that survived.
    expect(result.merged[0]?.keeperId).toBe(aId);
  });

  it('14. the audit row names every transferred field and its value', async () => {
    if (!db) return;
    const { aId } = await seedPair({
      name: scenarioName('AuditTransfer'),
      aPhone: null, bPhone: '634453468',
      aTransport: null, bTransport: '14',
      aGov: null, bGov: 'SH-330044',
    });
    await seedUnrelated({ parentId: 'parent-1', familyId: '0077' });
    const result = await runBatch();
    expect(result.totals.merged).toBe(1);

    const audit = await auditFor(aId);
    expect(audit).not.toBeNull();
    expect(audit?.merge_kind).toBe('safe_batch');
    expect(audit?.batch_id).toBeTruthy();
    expect(audit?.transferred_fields).toEqual({
      parentPhone: '634453468',
      transport: '14',
      govId: 'SH-330044',
    });
    // The full classification is retained too, so a later reader can see WHY.
    expect(audit?.field_states?.parentPhone).toMatchObject({ state: 'duplicate_only', action: 'transfer' });
    // The batch response carries the same record inline.
    expect(result.merged[0]?.transfers).toEqual(audit?.transferred_fields);
  });

  it('14b. a merge that transfers NOTHING records an empty transfer set (no phantom audit)', async () => {
    if (!db) return;
    const { aId } = await seedPair({ name: scenarioName('AuditEmpty'), aPhone: null, bPhone: null });
    const result = await runBatch();
    expect(result.totals.merged).toBe(1);
    const audit = await auditFor(aId);
    expect(audit?.transferred_fields).toEqual({});
    expect(result.merged[0]?.transfers).toEqual({});
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 15-18  SAFETY: idempotence, zero-write preview, re-check, authorisation
// ═════════════════════════════════════════════════════════════════════════════
describe('field consolidation — safety properties', () => {
  it('15. re-running the batch is idempotent (nothing merges twice)', async () => {
    if (!db) return;
    await seedPair({
      name: scenarioName('Idempotent'),
      aPhone: null, bPhone: '634453468', aTransport: null, bTransport: '14',
    });
    const first = await runBatch();
    expect(first.totals.merged).toBe(1);

    const second = await runBatch();
    expect(second.totals.merged).toBe(0);
    expect(second.totals.remaining).toBe(0);

    const { rows } = await db.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM public.student_merge_audits`);
    expect(Number(rows[0]?.n)).toBe(1);
  });

  it('16. preview performs zero writes', async () => {
    if (!db) return;
    await seedPair({
      name: scenarioName('PreviewZero'),
      aPhone: null, bPhone: '634453468', aFamily: null, bFamily: '0077',
    });
    // Prove the family transfer so the pair is genuinely SAFE (an unprovable
    // family ID would leave safeCount at 0 and make the digest check vacuous).
    await seedUnrelated({ parentId: 'parent-1', familyId: '0077' });
    const before = await snapshotAll();
    const p = await preview();
    const after = await snapshotAll();
    expect(p.summary.safeCount).toBeGreaterThan(0);
    expect(after).toBe(before);
  });

  it('17. execution re-checks eligibility server-side and refuses a stale list', async () => {
    if (!db) return;
    const { aId, bId } = await seedPair({
      name: scenarioName('Stale'), aPhone: null, bPhone: '634453468',
    });
    const p = await preview();
    const list = p.rows.map((r) => ({ keeperId: r.keeperId, removedId: r.removedId, fingerprint: r.fingerprint, pairKey: r.pairKey }));
    expect(list.length).toBe(1);

    // Another administrator fills in the keeper's phone with a DIFFERENT number
    // between preview and execution. The pair becomes a true conflict.
    await db.query(`UPDATE public.students SET "parentPhone" = '639900112' WHERE id = $1`, [aId]);

    const result = await runBatch({ pairs: list });
    expect(result.totals.merged).toBe(0);
    expect(result.skipped.length + result.blocked.length).toBe(1);
    // Both records still exist: nothing was merged on a stale fingerprint.
    expect(await studentExists(aId)).toBe(true);
    expect(await studentExists(bId)).toBe(true);
  });

  it('18. a non-administrator is still refused, transfers or not', async () => {
    if (!db) return;
    await seedPair({
      name: scenarioName('Teacher'), aPhone: null, bPhone: '634453468',
    });
    await db.setAuthUid(TEACHER_UID);
    await expect(preview()).rejects.toThrow();
    await expect(runBatch()).rejects.toThrow();
    const { rows } = await db.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM public.student_merge_audits`);
    expect(Number(rows[0]?.n)).toBe(0);
  });
});
