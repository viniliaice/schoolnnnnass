// The eight reason combinations that appear in the real production "Excluded —
// individual review only" list (254 pairs), reproduced as fixtures and checked
// against the ACTUAL shipped policy v3. This is what turns a hand-classification
// of that list into something the database has confirmed.
//
//   v1 code                                  -> v3 verdict
//   parent_phone_conflict                    -> blocked  (unchanged)
//   transport_conflict                       -> blocked  (unchanged)
//   family_id_conflict                       -> blocked  (unchanged)
//   parent_phone_only_on_unassigned          -> SAFE, phone transferred
//   transport_only_on_unassigned             -> SAFE, transport transferred
//
// Production shapes and their counts, for reference:
//   158  phone conflict
//    69  only-duplicate phone                        -> newly safe
//     8  phone conflict + family ID conflict
//     7  only-duplicate phone + only-duplicate transport -> newly safe
//     6  only-duplicate phone + transport conflict
//     3  only-duplicate phone + family ID conflict
//     2  only-duplicate phone + only-duplicate transport + family ID conflict
//     1  phone conflict + transport conflict

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

interface Row {
  keeperId: string; eligible: boolean; severity: string | null;
  exclusionCodes: string[]; eligibilityCodes: string[];
  transfers: Record<string, string | null>;
}
interface Report {
  summary: { safeCount: number; blockedCount: number; needsReviewCount: number };
  rows: Row[];
  excludedRows: Array<{ keeperId: string; severity: string; exclusionCodes: string[] }>;
}

let db: PgDuplicateDb | null = null;
let seq = 0;

function name(p: string) { seq += 1; return `${p} Prod${seq} Xaaji`; }

async function report(): Promise<Report> {
  if (!db) throw new Error('db not ready');
  return db.rpc<Report>('get_safe_duplicate_batch', { p_limit: 200, p_offset: 0, p_include_excluded: true });
}

async function pair(p: {
  prefix: string;
  aPhone?: string | null; bPhone?: string | null;
  aTransport?: string | null; bTransport?: string | null;
  aFamily?: string | null; bFamily?: string | null;
}) {
  if (!db) throw new Error('db not ready');
  const className = 'Foundation A';
  const studentName = name(p.prefix);
  const aId = `ps-a-${seq}-${Math.random().toString(36).slice(2, 7)}`;
  const bId = `ps-b-${seq}-${Math.random().toString(36).slice(2, 7)}`;
  await seedStudent(db, {
    id: aId, name: studentName, className, parentId: 'parent-1',
    parentPhone: p.aPhone ?? null, transport: p.aTransport ?? null,
    familyId: p.aFamily ?? null, createdAt: '2025-03-01T08:00:00Z',
  });
  await seedStudent(db, {
    id: bId, name: studentName, className, parentId: null,
    parentPhone: p.bPhone ?? null, transport: p.bTransport ?? null,
    familyId: p.bFamily ?? null, createdAt: '2026-09-01T08:00:00Z',
  });
  for (const id of [aId, bId]) {
    await seedEnrollment(db, { id: `enr-${id}`, studentId: id, className, academicYearId: 'ay-2026' });
  }
  return { aId, bId };
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

describe('production excluded-list shapes under policy v3', () => {
  it('158× phone conflict -> still BLOCKED', async () => {
    if (!db) return;
    const { aId } = await pair({ prefix: 'PhoneConflict', aPhone: '615111222', bPhone: '615333444' });
    const res = await report();
    expect(res.rows.find((r) => r.keeperId === aId)).toBeUndefined();
    const ex = res.excludedRows.find((r) => r.keeperId === aId);
    expect(ex?.severity).toBe('blocked');
    expect(ex?.exclusionCodes).toContain('parent_phone_conflict');
  });

  it('69× only-duplicate phone -> NEWLY SAFE with the phone transferred', async () => {
    if (!db) return;
    const { aId } = await pair({ prefix: 'OnlyPhone', aPhone: null, bPhone: '615111222' });
    const res = await report();
    const row = res.rows.find((r) => r.keeperId === aId);
    expect(row?.eligible).toBe(true);
    expect(row?.eligibilityCodes).toContain('parent_phone_from_removed_preserved');
    expect(row?.transfers.parentPhone).toBe('615111222');
    expect(res.summary.blockedCount).toBe(0);
  });

  it('7× only-duplicate phone + only-duplicate transport -> NEWLY SAFE, both transferred', async () => {
    if (!db) return;
    const { aId } = await pair({
      prefix: 'OnlyPhoneTransport', aPhone: null, bPhone: '615111222',
      aTransport: null, bTransport: '12',
    });
    const res = await report();
    const row = res.rows.find((r) => r.keeperId === aId);
    expect(row?.eligible).toBe(true);
    expect(row?.transfers.parentPhone).toBe('615111222');
    expect(row?.transfers.transport).toBe('12');
  });

  it('8× phone conflict + family ID conflict -> still BLOCKED', async () => {
    if (!db) return;
    const { aId } = await pair({
      prefix: 'PhoneFamily', aPhone: '615111222', bPhone: '615333444',
      aFamily: '0010', bFamily: '0020',
    });
    const ex = (await report()).excludedRows.find((r) => r.keeperId === aId);
    expect(ex?.severity).toBe('blocked');
    expect(ex?.exclusionCodes).toEqual(expect.arrayContaining(['parent_phone_conflict', 'family_id_conflict']));
  });

  it('6× only-duplicate phone + transport conflict -> still BLOCKED', async () => {
    // The phone WOULD transfer, but the transport conflict overrides: one true
    // conflict anywhere keeps the whole pair out of the batch.
    if (!db) return;
    const { aId } = await pair({
      prefix: 'PhoneTransportConflict', aPhone: null, bPhone: '615111222',
      aTransport: 'WALKER', bTransport: '9',
    });
    const res = await report();
    expect(res.rows.find((r) => r.keeperId === aId)).toBeUndefined();
    const ex = res.excludedRows.find((r) => r.keeperId === aId);
    expect(ex?.severity).toBe('blocked');
    expect(ex?.exclusionCodes).toContain('transport_conflict');
  });

  it('3× only-duplicate phone + family ID conflict -> still BLOCKED', async () => {
    if (!db) return;
    const { aId } = await pair({
      prefix: 'PhoneFamilyConflict', aPhone: null, bPhone: '615111222',
      aFamily: '0010', bFamily: '0020',
    });
    const res = await report();
    expect(res.rows.find((r) => r.keeperId === aId)).toBeUndefined();
    expect(res.excludedRows.find((r) => r.keeperId === aId)?.exclusionCodes).toContain('family_id_conflict');
  });

  it('2× only-duplicate phone + transport + family ID conflict -> still BLOCKED', async () => {
    if (!db) return;
    const { aId } = await pair({
      prefix: 'PhoneTransportFamily', aPhone: null, bPhone: '615111222',
      aTransport: null, bTransport: '12', aFamily: '0010', bFamily: '0020',
    });
    const res = await report();
    expect(res.rows.find((r) => r.keeperId === aId)).toBeUndefined();
    expect(res.excludedRows.find((r) => r.keeperId === aId)?.exclusionCodes).toContain('family_id_conflict');
  });

  it('1× phone conflict + transport conflict -> still BLOCKED', async () => {
    if (!db) return;
    const { aId } = await pair({
      prefix: 'PhoneTransportBoth', aPhone: '615111222', bPhone: '615333444',
      aTransport: 'WALKER', bTransport: '9',
    });
    const ex = (await report()).excludedRows.find((r) => r.keeperId === aId);
    expect(ex?.severity).toBe('blocked');
    expect(ex?.exclusionCodes).toEqual(expect.arrayContaining(['parent_phone_conflict', 'transport_conflict']));
  });

  it('the caveat is real: an only-duplicate phone that belongs to another family stays BLOCKED', async () => {
    // This is why 76 is an UPPER bound. The phone-collision check needs the
    // database, and it cannot be answered from the excluded list alone.
    if (!db) return;
    const { aId } = await pair({ prefix: 'PhoneOtherFamily', aPhone: null, bPhone: '615111222' });
    await seedStudent(db, {
      id: 'ps-other', name: 'Qof Kale Oo Gebi Ahaan', className: 'Grade 9-Z',
      parentId: 'parent-2', parentPhone: '615111222',
    });
    const res = await report();
    expect(res.rows.find((r) => r.keeperId === aId)).toBeUndefined();
    const ex = res.excludedRows.find((r) => r.keeperId === aId);
    expect(ex?.severity).toBe('blocked');
    expect(ex?.exclusionCodes).toContain('parent_phone_belongs_to_other_family');
  });
});
