// Authoritative parent-phone registry (migration 20261009, policy v4).
//
// 158 of the 254 production "Excluded" pairs are blocked as
// parent_phone_conflict — two different non-empty numbers and nothing in the
// database says which is right. The registry supplies that answer. These tests
// pin exactly what it may and may not do.

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

// Real rows from the school's list.
const AUTH_A = '633840867';
const AUTH_B = '634450007';
// Not on the list (every listed number starts 63x / 65x / 90x).
const PLAIN_A = '615111222';
const PLAIN_B = '615333444';

interface Row {
  keeperId: string; removedId: string; pairKey: string; fingerprint: string; eligible: boolean;
  exclusionCodes: string[]; eligibilityCodes: string[];
  transfers: Record<string, string | null>;
  fieldStates: Record<string, { state: string; action: string; authority?: string }>;
}
interface Report {
  summary: { safeCount: number; blockedCount: number; needsReviewCount: number };
  rows: Row[];
  excludedRows: Array<{ keeperId: string; severity: string; exclusionCodes: string[] }>;
  policy: { version: number; blockedCodes: string[] };
}

let db: PgDuplicateDb | null = null;
let seq = 0;

async function report(): Promise<Report> {
  if (!db) throw new Error('db not ready');
  return db.rpc<Report>('get_safe_duplicate_batch', { p_limit: 200, p_offset: 0, p_include_excluded: true });
}

async function pair(p: {
  prefix: string;
  aPhone?: string | null; bPhone?: string | null;
  aFamily?: string | null; bFamily?: string | null;
  aName?: string;
}) {
  if (!db) throw new Error('db not ready');
  seq += 1;
  const className = 'Grade 8-A';
  const studentName = p.aName ?? `Reg Test${seq} Warsame`;
  const aId = `rg-a-${seq}-${Math.random().toString(36).slice(2, 7)}`;
  const bId = `rg-b-${seq}-${Math.random().toString(36).slice(2, 7)}`;
  await seedStudent(db, {
    id: aId, name: studentName, className, parentId: 'parent-1',
    parentPhone: p.aPhone ?? null, familyId: p.aFamily ?? null,
    createdAt: '2025-03-01T08:00:00Z',
  });
  await seedStudent(db, {
    id: bId, name: studentName, className, parentId: null,
    parentPhone: p.bPhone ?? null, familyId: p.bFamily ?? null,
    createdAt: '2026-09-01T08:00:00Z',
  });
  for (const id of [aId, bId]) {
    await seedEnrollment(db, { id: `enr-${id}`, studentId: id, className, academicYearId: 'ay-2026' });
  }
  return { aId, bId, studentName };
}

beforeAll(async () => {
  if (!(await pgliteAvailable())) return;
  db = await createDuplicateBatchTestDb();
  await db.exec(`
    INSERT INTO public.academic_years (id, name, "isCurrent") VALUES ('ay-2026','2026/2027', true);
    INSERT INTO public.terms (id, name, "academicYearId") VALUES ('term-1','Term 1','ay-2026');
    INSERT INTO public.subjects (id, name) VALUES ('sub-math','Math');
  `);
  await seedProfile(db, 'admin-1', 'admin', 'Admin One', ADMIN_UID);
  await seedProfile(db, 'parent-1', 'parent', 'ahmed daahir aadan');
  await seedProfile(db, 'parent-2', 'parent', 'Parent Two');
  await db.setAuthUid(ADMIN_UID);
}, 180_000);

beforeEach(async () => {
  if (!db) return;
  await db.exec(`
    DELETE FROM public.students; DELETE FROM public.student_merge_audits;
    DELETE FROM public.student_merge_batches; DELETE FROM public.audit_logs;
  `);
  await db.setAuthUid(ADMIN_UID);
});

afterAll(async () => { if (db) await db.close(); });

describe('authoritative parent phone registry', () => {
  it('is seeded with the 620 numbers, all self-consistently normalized', async () => {
    if (!db) return;
    const n = await db.query<{ n: number }>(
      'SELECT count(*)::int AS n FROM public.authoritative_parent_phones');
    expect(n.rows[0].n).toBe(620);
    const bad = await db.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM public.authoritative_parent_phones
        WHERE phone <> public.normalize_phone(raw_phone)`);
    expect(bad.rows[0].n).toBe(0);
    for (const phone of [AUTH_A, AUTH_B]) {
      const hit = await db.query<{ n: number }>(
        'SELECT count(*)::int AS n FROM public.authoritative_parent_phones WHERE phone = $1', [phone]);
      expect(hit.rows[0].n, phone).toBe(1);
    }
  });

  it('publishes policy version 4 and keeps every existing blocked code', async () => {
    if (!db) return;
    const p = (await report()).policy;
    expect(p.version).toBe(4);
    expect(p.blockedCodes).toContain('parent_phone_registry_ambiguous');
    for (const code of ['parent_phone_conflict', 'parent_phone_belongs_to_other_family',
                        'transport_conflict', 'family_id_conflict', 'gov_id_conflict']) {
      expect(p.blockedCodes, code).toContain(code);
    }
    expect(p.blockedCodes).not.toContain('family_id_invalid_normalization');
  });

  it('neither number listed -> still BLOCKED as parent_phone_conflict', async () => {
    if (!db) return;
    const { aId } = await pair({ prefix: 'Neither', aPhone: PLAIN_A, bPhone: PLAIN_B });
    const ex = (await report()).excludedRows.find((r) => r.keeperId === aId);
    expect(ex?.severity).toBe('blocked');
    expect(ex?.exclusionCodes).toContain('parent_phone_conflict');
  });

  it('keeper number listed -> SAFE, keeper value kept, nothing transferred', async () => {
    if (!db) return;
    const { aId } = await pair({ prefix: 'KeeperAuth', aPhone: AUTH_A, bPhone: PLAIN_B });
    const res = await report();
    const row = res.rows.find((r) => r.keeperId === aId);
    expect(row?.eligible).toBe(true);
    expect(row?.eligibilityCodes).toContain('parent_phone_conflict_resolved_by_registry_keeper');
    expect(row?.fieldStates.parentPhone.authority).toBe('registry_keeper');
    expect(row?.transfers.parentPhone ?? null).toBeNull();
  });

  it('duplicate number listed -> SAFE and the endorsed number is TRANSFERRED onto the keeper', async () => {
    if (!db) return;
    const { aId } = await pair({ prefix: 'DupAuth', aPhone: PLAIN_A, bPhone: AUTH_B });
    const res = await report();
    const row = res.rows.find((r) => r.keeperId === aId);
    expect(row?.eligible).toBe(true);
    expect(row?.eligibilityCodes).toContain('parent_phone_conflict_resolved_by_registry_duplicate');
    expect(row?.fieldStates.parentPhone.authority).toBe('registry_duplicate');
    expect(row?.transfers.parentPhone).toBe(AUTH_B);
  });

  it('both numbers listed -> BLOCKED as parent_phone_registry_ambiguous', async () => {
    if (!db) return;
    const { aId } = await pair({ prefix: 'BothAuth', aPhone: AUTH_A, bPhone: AUTH_B });
    const res = await report();
    expect(res.rows.find((r) => r.keeperId === aId)).toBeUndefined();
    const ex = res.excludedRows.find((r) => r.keeperId === aId);
    expect(ex?.severity).toBe('blocked');
    expect(ex?.exclusionCodes).toContain('parent_phone_registry_ambiguous');
  });

  it('an endorsed number that belongs to another family still BLOCKS', async () => {
    if (!db) return;
    const { aId } = await pair({ prefix: 'AuthThird', aPhone: PLAIN_A, bPhone: AUTH_B });
    await seedStudent(db, {
      id: 'rg-third', name: 'Qof Kale Oo Gebi Ahaan', className: 'Grade 9-Z',
      parentId: 'parent-2', parentPhone: AUTH_B,
    });
    const res = await report();
    expect(res.rows.find((r) => r.keeperId === aId)).toBeUndefined();
    expect(res.excludedRows.find((r) => r.keeperId === aId)?.exclusionCodes)
      .toContain('parent_phone_belongs_to_other_family');
  });

  it('does not rescue a pair that also has a family ID conflict', async () => {
    if (!db) return;
    const { aId } = await pair({
      prefix: 'AuthPlusFamily', aPhone: AUTH_A, bPhone: PLAIN_B,
      aFamily: '0010', bFamily: '0020',
    });
    const ex = (await report()).excludedRows.find((r) => r.keeperId === aId);
    expect(ex?.severity).toBe('blocked');
    expect(ex?.exclusionCodes).toContain('family_id_conflict');
  });

  it('never turns a weak-identity pair into a candidate', async () => {
    // Different names: the registry cannot create duplicate identity.
    if (!db) return;
    seq += 1;
    const className = 'Grade 8-A';
    await seedStudent(db, {
      id: 'rg-weak-a', name: 'Magac Gebi Ahaan Kale', className, parentId: 'parent-1',
      parentPhone: AUTH_A, createdAt: '2025-03-01T08:00:00Z',
    });
    await seedStudent(db, {
      id: 'rg-weak-b', name: 'Qof Aan Marnaba Isku Mid Ahayn', className, parentId: null,
      parentPhone: PLAIN_B, createdAt: '2026-09-01T08:00:00Z',
    });
    for (const id of ['rg-weak-a', 'rg-weak-b']) {
      await seedEnrollment(db, { id: `enr-${id}`, studentId: id, className, academicYearId: 'ay-2026' });
    }
    const res = await report();
    expect(res.rows.find((r) => r.keeperId === 'rg-weak-a')).toBeUndefined();
    expect(res.excludedRows.find((r) => r.keeperId === 'rg-weak-a')).toBeUndefined();
  });

  it('an empty registry behaves exactly like policy v3', async () => {
    if (!db) return;
    await db.exec('CREATE TEMP TABLE IF NOT EXISTS rg_backup AS SELECT * FROM public.authoritative_parent_phones');
    const { aId } = await pair({ prefix: 'Empty', aPhone: AUTH_A, bPhone: PLAIN_B });
    try {
      await db.exec('DELETE FROM public.authoritative_parent_phones');
      const ex = (await report()).excludedRows.find((r) => r.keeperId === aId);
      expect(ex?.severity).toBe('blocked');
      expect(ex?.exclusionCodes).toContain('parent_phone_conflict');
    } finally {
      await db.exec('INSERT INTO public.authoritative_parent_phones SELECT * FROM rg_backup ON CONFLICT (phone) DO NOTHING');
    }
    const back = await db.query<{ n: number }>(
      'SELECT count(*)::int AS n FROM public.authoritative_parent_phones');
    expect(back.rows[0].n).toBe(620);
  });

  it('records the endorsed number in the merge audit after the pair is merged', async () => {
    if (!db) return;
    const { aId, bId } = await pair({ prefix: 'Audit', aPhone: PLAIN_A, bPhone: AUTH_B });
    // The pair must be handed over exactly as the server previewed it, including
    // its fingerprint, or the RPC refuses it.
    const preview = await report();
    const row = preview.rows.find((r) => r.keeperId === aId);
    expect(row?.eligible).toBe(true);
    const res = await db.rpc<{ totals: { merged: number; blocked: number } }>('merge_safe_duplicate_batch', {
      p_pairs: JSON.stringify([{
        keeperId: row!.keeperId, removedId: row!.removedId,
        fingerprint: row!.fingerprint, pairKey: row!.pairKey,
      }]),
      p_chunk_size: 10,
      p_confirm_phrase: 'MERGE SAFE DUPLICATES',
      p_reason: 'registry resolves the phone',
      p_batch_id: null,
    });
    expect(res.totals.blocked).toBe(0);
    expect(res.totals.merged).toBe(1);
    const audit = await db.query<{
      transferred: Record<string, string | null>; authority: string | null;
      wasKeeper: string | null; wasRemoved: string | null; removedPhone: string | null;
    }>(`SELECT transferred_fields AS transferred,
               field_states->'parentPhone'->>'authority' AS authority,
               field_states->'parentPhone'->>'keeper'    AS "wasKeeper",
               field_states->'parentPhone'->>'removed'   AS "wasRemoved",
               removed_profile->>'parentPhone'           AS "removedPhone"
          FROM public.student_merge_audits WHERE canonical_id = $1`, [aId]);
    expect(audit.rows[0].transferred.parentPhone).toBe(AUTH_B);
    expect(audit.rows[0].authority).toBe('registry_duplicate');
    // The audit proves which number was overwritten and which replaced it.
    expect(audit.rows[0].wasKeeper).toBe(PLAIN_A);
    expect(audit.rows[0].wasRemoved).toBe(AUTH_B);
    expect(audit.rows[0].removedPhone).toBe(AUTH_B);
    const keeper = await db.query<{ parentPhone: string | null }>(
      'SELECT "parentPhone" FROM public.students WHERE id = $1', [aId]);
    expect(keeper.rows[0].parentPhone).toBe(AUTH_B);
  });
});
