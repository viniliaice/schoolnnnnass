// The "High Confidence" number on the Duplicate Students page is produced by a
// CLIENT-SIDE classifier (evaluatePair in src/lib/db/duplicateStudents.ts).
// The "Merge All Safe Duplicates" batch is decided by the DATABASE
// (_safe_batch_evaluate_pair in supabase/migrations/20260925).
//
// These are two different contracts and they are ALLOWED to disagree. This file
// pins down exactly where and why, so nobody silently "fixes" one side and
// changes which students get merged:
//
//   * The page's flag is ADVISORY. It is a hint for a human reading a list.
//   * The database's verdict is AUTHORITATIVE. It is the only thing that can
//     authorise a merge, and it is recomputed from live rows at execution time.
//
// Agreement:           plain parent-assigned vs unassigned, nothing conflicting,
//                      and conflicting Gov IDs, which both refuse.
// Page too optimistic: the page cannot see attendance/exam/quiz history or the
//                      size of the candidate group, so it labels pairs "High
//                      Confidence" that the database refuses.
// Page too pessimistic: when only the UNASSIGNED record carries a Gov ID the
//                      page drops the pair to "Needs Review", but the database
//                      proves it safe because the batch MOVES that Gov ID onto
//                      the keeper instead of discarding it.
//
// Net effect for the operator: the number printed on the page is a hint. The
// number that matters is preview_safe_duplicate_batch().summary.safeCount, and
// it is never assumed to equal the page's High Confidence counter.
//
// These tests run against real PostgreSQL (PGlite) with the shipped migrations.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { evaluatePair } from '../db/duplicateStudents';
import {
  createDuplicateBatchTestDb,
  seedEnrollment,
  seedProfile,
  seedStudent,
  type PgDuplicateDb,
} from './pgDuplicateBatchHarness';

const ADMIN_UID = '3f1d0f7a-9b21-4c6e-8f04-7b5c1a2d3e40';

let db: PgDuplicateDb;

/** Reads the live rows and asks BOTH classifiers about the same pair. */
async function compare(idA: string, idB: string) {
  const a = (await db.query(`SELECT * FROM public.students WHERE id = $1`, [idA])).rows[0] as never;
  const b = (await db.query(`SELECT * FROM public.students WHERE id = $1`, [idB])).rows[0] as never;
  const page = evaluatePair(a, b);
  const groupSize = (await db.query(
    `SELECT count(*)::INT AS n FROM public.students
      WHERE public.name_match_key(name) = public.name_match_key((SELECT name FROM public.students WHERE id = $1))
        AND "className" = (SELECT "className" FROM public.students WHERE id = $1)`,
    [idA],
  )).rows[0] as { n: number };
  const server = await db.rpc<{
    eligible: boolean;
    severity: string | null;
    exclusionCodes: string[];
    eligibilityCodes: string[];
    keeperId: string;
    removedId: string;
  }>('_safe_batch_evaluate_pair', { p_a_id: idA, p_b_id: idB, p_group_size: groupSize.n, p_deep: true });
  return { page, server };
}

beforeAll(async () => {
  db = await createDuplicateBatchTestDb();
  await seedProfile(db, 'admin-1', 'admin', 'Batch Administrator', ADMIN_UID);
  await seedProfile(db, 'parent-1', 'parent', 'Parent One');
  await seedProfile(db, 'parent-2', 'parent', 'Parent Two');
  await db.setAuthUid(ADMIN_UID);

  // 1. Both agree: parent-assigned vs unassigned, nothing conflicting.
  await seedStudent(db, { id: 'agree-k', name: 'Agree Case', className: 'G1', parentId: 'parent-1', createdAt: '2026-05-01' });
  await seedStudent(db, { id: 'agree-r', name: 'Agree Case', className: 'G1', createdAt: '2026-06-01' });
  await seedEnrollment(db, { id: 'enr-agree-k', studentId: 'agree-k', className: 'G1' });

  // 2. The page cannot see history: identical attendance date on both records.
  await seedStudent(db, { id: 'att-k', name: 'History Case', className: 'G1', parentId: 'parent-1', createdAt: '2026-05-01' });
  await seedStudent(db, { id: 'att-r', name: 'History Case', className: 'G1', createdAt: '2026-06-01' });
  await seedEnrollment(db, { id: 'enr-att-k', studentId: 'att-k', className: 'G1' });
  for (const [suffix, id] of [['k', 'att-k'], ['r', 'att-r']] as const) {
    await db.query(
      `INSERT INTO public.attendance (id,"studentId","className",date,status) VALUES ($1,$2,'G1','2026-04-01','present')`,
      [`att-${suffix}`, id],
    );
  }

  // 3. The page cannot count the group: a THIRD record shares name + class.
  await seedStudent(db, { id: 'tri-a', name: 'Triple Case', className: 'G1', parentId: 'parent-1', createdAt: '2026-05-01' });
  await seedStudent(db, { id: 'tri-b', name: 'Triple Case', className: 'G1', createdAt: '2026-06-01' });
  await seedStudent(db, { id: 'tri-c', name: 'Triple Case', className: 'G1', createdAt: '2026-06-02' });
  await seedEnrollment(db, { id: 'enr-tri-a', studentId: 'tri-a', className: 'G1' });

  // 4. The page is too pessimistic: the only Gov ID sits on the unassigned record.
  await seedStudent(db, { id: 'gov-k', name: 'Gov Case', className: 'G1', parentId: 'parent-1', createdAt: '2026-05-01' });
  await seedStudent(db, { id: 'gov-r', name: 'Gov Case', className: 'G1', govId: 'AA-777', createdAt: '2026-06-01' });
  await seedEnrollment(db, { id: 'enr-gov-k', studentId: 'gov-k', className: 'G1' });

  // 5. Both agree again: two different Gov IDs can never be batched.
  await seedStudent(db, { id: 'clash-a', name: 'Clash Case', className: 'G1', parentId: 'parent-1', govId: 'AA-111', createdAt: '2026-05-01' });
  await seedStudent(db, { id: 'clash-b', name: 'Clash Case', className: 'G1', parentId: 'parent-2', govId: 'BB-222', createdAt: '2026-06-01' });
});

afterAll(async () => {
  await db?.close();
});

describe('page confidence vs the database batch contract', () => {
  it('agrees on a plain parent-assigned vs unassigned pair', async () => {
    const { page, server } = await compare('agree-k', 'agree-r');
    expect(page.isHighConfidence).toBe(true);
    expect(server.eligible).toBe(true);
    expect(server.keeperId).toBe('agree-k');
    expect(server.removedId).toBe('agree-r');
  });

  it('refuses a pair the page calls High Confidence: identical attendance date', async () => {
    const { page, server } = await compare('att-k', 'att-r');
    // The page's classifier only looks at name / class / parent / gov id, so it
    // cannot see the collision and still labels the pair high confidence.
    expect(page.isHighConfidence).toBe(true);
    expect(server.eligible).toBe(false);
    expect(server.severity).toBe('blocked');
    expect(server.exclusionCodes).toContain('attendance_conflict');
  });

  it('refuses a pair the page calls High Confidence: three records share name + class', async () => {
    const { page, server } = await compare('tri-a', 'tri-b');
    expect(page.isHighConfidence).toBe(true);
    expect(server.eligible).toBe(false);
    expect(server.severity).toBe('review');
    expect(server.exclusionCodes).toContain('group_has_more_than_two_records');
  });

  it('accepts a pair the page drops to Needs Review: the only Gov ID is on the unassigned record', async () => {
    const { page, server } = await compare('gov-k', 'gov-r');
    // Page: "Unassigned record contains a Gov ID — confirm which identity is
    // correct" → evidence 'possible', risk 'high', not high confidence.
    expect(page.isHighConfidence).toBe(false);
    expect(page.risk).toBe('high');
    // Database: safe, because the Gov ID is MOVED onto the keeper, never lost.
    expect(server.eligible).toBe(true);
    expect(server.eligibilityCodes).toContain('gov_id_from_removed_preserved');
    expect(server.keeperId).toBe('gov-k');
  });

  it('agrees that conflicting Gov IDs are blocked', async () => {
    const { page, server } = await compare('clash-a', 'clash-b');
    expect(page.isBlocked).toBe(true);
    expect(server.eligible).toBe(false);
    expect(server.severity).toBe('blocked');
    expect(server.exclusionCodes).toContain('gov_id_conflict');
  });

  it('treats the page label as advisory: only the database verdict carries a fingerprint', async () => {
    const { page, server } = await compare('agree-k', 'agree-r');
    // The client classifier returns a boolean hint. It has no way to prove the
    // rows it looked at are the rows that will be merged, which is exactly why
    // execution re-evaluates from live rows under a row lock.
    expect(typeof page.isHighConfidence).toBe('boolean');
    const full = await db.rpc<{ fingerprint: string | null }>('_safe_batch_evaluate_pair', {
      p_a_id: 'agree-k', p_b_id: 'agree-r', p_group_size: 2, p_deep: true,
    });
    expect(typeof full.fingerprint).toBe('string');
    expect((full.fingerprint ?? '').length).toBe(32); // md5 — compared again after locking
    expect(server.eligible).toBe(true);
  });
});
