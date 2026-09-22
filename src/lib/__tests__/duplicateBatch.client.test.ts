// @vitest-environment jsdom
// SAFE BATCH MERGE — client wrapper + mock-server (in-memory) integration.
//
// Runs against the real mock Supabase client seeded in src/lib/supabase.ts, so
// it exercises the same request/response contract the production RPCs expose:
// preview → confirm → chunked execution → per-merge audit. The authoritative
// rule-level tests (real PostgreSQL) live in duplicateBatch.*.db.test.ts.
//
// Demo duplicate groups in the mock:
//   Axmed yaasiin ismaaciil (Grade 1-B) — parent-assigned vs unassigned → SAFE
//   Leyla Hassan          (Grade 3-B) — same Gov ID, one unassigned    → SAFE
//   Abshir Cabdi Maxamed  (Grade 2-C) — 55 exam identity conflicts     → BLOCKED
//   Ahmed Mohamed         (Grade 5-A) — two parents + Gov ID conflict   → BLOCKED

import { afterEach, describe, expect, it } from 'vitest';
import { supabase } from '../supabase';
import {
  getMergeAudits,
  getMergeConflicts,
  getSafeDuplicateBatch,
  previewSafeDuplicateBatch,
  previewStudentMerge,
  reviewedPairsFromPreview,
  runSafeDuplicateBatchChunk,
  type SafeBatchPreview,
} from '../db/duplicateStudents';

const PHRASE = 'MERGE SAFE DUPLICATES';

function setRole(role: string) {
  (globalThis as any).__mockRole = role;
}

afterEach(() => {
  setRole('admin');
});

describe('safe batch — preview (server decides, client only renders)', () => {
  it('returns the policy, the confirmation phrase and the chunk plan', async () => {
    const preview = await previewSafeDuplicateBatch();
    expect(preview.dryRun).toBe(true);
    expect(preview.writesPerformed).toBe(0);
    expect(preview.confirmPhrase).toBe(PHRASE);
    expect(preview.policy.policyId).toBe('safe_batch_parent_assigned_keeper');
    expect(preview.policy.nameEn).toBe('Merge All Safe Duplicates');
    expect(preview.policy.chunkSize).toMatchObject({ default: 25, min: 1, max: 50, atomicPerChunk: true });
    expect(preview.chunkPlan).toMatchObject({ chunkSize: 25, chunks: 1, atomicPerChunk: true });
    expect(preview.policy.invariants.length).toBeGreaterThan(0);
    expect(preview.batchId).toMatch(/^batch-/);
    expect(preview.previewToken).toBeTruthy();
  });

  it('reports the demo batch as 2 safe / 2 excluded with per-reason counts', async () => {
    const preview = await previewSafeDuplicateBatch();
    expect(preview.summary.safeCount).toBe(2);
    expect(preview.summary.excludedCount).toBe(2);
    expect(preview.summary.blockedCount).toBe(2);
    expect(preview.summary.needsReviewCount).toBe(0);
    expect(preview.summary.studentsToMerge).toBe(2);
    expect(preview.summary.recordsToRemove).toBe(2);
    expect(preview.summary.studentIdsPreserved).toBe(2);
    expect(preview.ready).toEqual({ studentsToMerge: 2, recordsToBeRemoved: 2, studentIdsPreserved: 2 });
    expect(preview.exclusionReasons.exam_conflict).toBe(1);
    expect(preview.exclusionReasons.gov_id_conflict).toBe(1);
    expect(preview.exclusionReasons.both_parents_assigned).toBe(1);
  });

  it('names the parent-assigned record as the keeper in every safe row', async () => {
    const preview = await previewSafeDuplicateBatch();
    expect(preview.rows).toHaveLength(2);
    const names = preview.rows.map((r) => r.studentName).sort();
    expect(names).toEqual(['Axmed yaasiin ismaaciil', 'Leyla Hassan']);
    for (const row of preview.rows) {
      expect(row.eligible).toBe(true);
      expect(row.keeperIsParentAssigned).toBe(true);
      expect(row.keeper.parentId).toBeTruthy();
      expect(row.removed.parentId).toBeNull();
      expect(row.keeperId).toBe(row.keeper.id);
      expect(row.removedId).toBe(row.removed.id);
      expect(row.fingerprint).toBeTruthy();
      expect(row.enrollmentAction).toBeTruthy();
      // History counts are reported per pair for the confirmation screen.
      expect(row.history.enrollments.keeperOpen).toBe(1);
      expect(row.history.enrollments.removedOpen).toBe(1);
      expect(row.history.exams.conflicts).toBe(0);
      expect(row.resolution.mergeResolution.profile_resolution).toBeTruthy();
    }
    const axmed = preview.rows.find((r) => r.studentName === 'Axmed yaasiin ismaaciil')!;
    expect(axmed.keeperId).toBe('stu-axmed-a');
    expect(axmed.removedId).toBe('stu-axmed-b');
    expect(axmed.className).toBe('Grade 1-B');
    expect(axmed.keeper.parentName).toBe('Maxamed Heeban');
    expect(axmed.enrollmentAction).toBe('consolidate');
    expect(axmed.eligibilityCodes).toContain('exactly_one_parent_assigned');
    const leyla = preview.rows.find((r) => r.studentName === 'Leyla Hassan')!;
    expect(leyla.keeperId).toBe('stu-samegov-a');
    expect(leyla.resolution.summary.govId).toBe('canonical');
  });

  it('lists the excluded pairs with the reason each one needs individual review', async () => {
    const preview = await previewSafeDuplicateBatch();
    const excluded = preview.excludedRows;
    expect(excluded).toHaveLength(2);
    const abshir = excluded.find((r) => r.studentName === 'Abshir Cabdi Maxamed')!;
    expect(abshir.severity).toBe('blocked');
    expect(abshir.exclusionCodes).toContain('exam_conflict');
    const ahmed = excluded.find((r) => r.studentName === 'Ahmed Mohamed')!;
    expect(ahmed.severity).toBe('blocked');
    expect(ahmed.exclusionCodes).toContain('gov_id_conflict');
    expect(ahmed.exclusionCodes).toContain('both_parents_assigned');
    expect(ahmed.exclusionCodes).toContain('parent_phone_conflict');
    // Human readable explanations come from the server policy, not the client.
    expect((abshir as any).exclusionReasons?.[0]).toBeTruthy();
  });

  it('verifies its own safety assertions before enabling the button', async () => {
    const preview = await previewSafeDuplicateBatch();
    const assertions = preview.assertions;
    expect(Object.keys(assertions).length).toBeGreaterThanOrEqual(12);
    for (const [key, value] of Object.entries(assertions)) expect(value, key).toBe(true);
    expect(preview.confirmations?.length).toBe(3);
  });

  it('get_safe_duplicate_batch paginates and can hide excluded rows', async () => {
    const full = await getSafeDuplicateBatch({ limit: 200, offset: 0, includeExcluded: true });
    expect(full.rows).toHaveLength(2);
    expect(full.excludedRows).toHaveLength(2);
    expect(full.paging).toEqual({ limit: 200, offset: 0, includeExcluded: true });
    const page = await getSafeDuplicateBatch({ limit: 1, offset: 0, includeExcluded: false });
    expect(page.rows).toHaveLength(1);
    expect(page.excludedRows).toHaveLength(0);
    const second = await getSafeDuplicateBatch({ limit: 1, offset: 1, includeExcluded: false });
    expect(second.rows).toHaveLength(1);
    expect(second.rows[0].pairKey).not.toBe(page.rows[0].pairKey);
  });

  it('maps the preview into the advisory reviewed list without re-deciding anything', async () => {
    const preview = await previewSafeDuplicateBatch();
    const list = reviewedPairsFromPreview(preview);
    expect(list).toHaveLength(2);
    expect(list[0]).toEqual({
      keeperId: preview.rows[0].keeperId,
      removedId: preview.rows[0].removedId,
      fingerprint: preview.rows[0].fingerprint,
      pairKey: preview.rows[0].pairKey,
    });
    expect(reviewedPairsFromPreview(null)).toEqual([]);
  });

  it('performs no writes at all during preview', async () => {
    const before = await getMergeAudits(200);
    await previewSafeDuplicateBatch();
    await getSafeDuplicateBatch({ limit: 50 });
    const after = await getMergeAudits(200);
    expect(after.length).toBe(before.length);
    const { data: students } = await supabase.from('students').select('id');
    expect((students as any[]).length).toBeGreaterThan(0);
    expect((students as any[]).some((s) => s.id === 'stu-axmed-b')).toBe(true);
  });
});

describe('safe batch — refusal paths (no mutation, loud reporting)', () => {
  it('denies anon, teacher, parent and supervisor', async () => {
    for (const role of ['anon', 'teacher', 'parent', 'supervisor']) {
      setRole(role);
      await expect(previewSafeDuplicateBatch()).rejects.toThrow(/Only administrators/i);
      await expect(getSafeDuplicateBatch()).rejects.toThrow(/Only administrators/i);
      await expect(
        runSafeDuplicateBatchChunk({ reviewedPairs: [], chunkSize: 25, confirmPhrase: PHRASE }),
      ).rejects.toThrow(/Only administrators/i);
    }
    setRole('admin');
    const { data: students } = await supabase.from('students').select('id');
    expect((students as any[]).some((s) => s.id === 'stu-axmed-b')).toBe(true);
    expect((students as any[]).some((s) => s.id === 'stu-samegov-b')).toBe(true);
  });

  it('requires the typed confirmation phrase', async () => {
    const preview = await previewSafeDuplicateBatch();
    for (const phrase of ['', 'MERGE', 'merge all', 'MERGE SAFE DUPLICATE']) {
      await expect(
        runSafeDuplicateBatchChunk({ reviewedPairs: reviewedPairsFromPreview(preview), confirmPhrase: phrase }),
      ).rejects.toThrow(/confirmation phrase required/i);
    }
    const { data: students } = await supabase.from('students').select('id');
    expect((students as any[]).some((s) => s.id === 'stu-axmed-b')).toBe(true);
  });

  it('rejects a bare "delete this student" style request', async () => {
    await expect(
      runSafeDuplicateBatchChunk({
        reviewedPairs: [{ studentId: 'stu-axmed-b', delete: true } as any],
        confirmPhrase: PHRASE,
      }),
    ).rejects.toThrow(/must provide both keeperId and removedId/i);
    const { data: students } = await supabase.from('students').select('id');
    expect((students as any[]).some((s) => s.id === 'stu-axmed-b')).toBe(true);
    expect((students as any[]).some((s) => s.id === 'stu-axmed-a')).toBe(true);
  });

  it('refuses a fabricated pair of unrelated students', async () => {
    const result = await runSafeDuplicateBatchChunk({
      reviewedPairs: [
        { keeperId: 'stu-barwaaqo', removedId: 'stu-aisha' },
        { keeperId: 'student-not-here', removedId: 'student-also-not-here' },
      ],
      confirmPhrase: PHRASE,
      batchId: 'batch-forged',
    });
    expect(result.totals.merged).toBe(0);
    expect(result.blocked.filter((b) => b.reason === 'not_a_candidate')).toHaveLength(2);
    const { data: students } = await supabase.from('students').select('id');
    expect((students as any[]).some((s) => s.id === 'stu-aisha')).toBe(true);
    expect((students as any[]).some((s) => s.id === 'stu-barwaaqo')).toBe(true);
  });

  it('refuses to batch a pair the server excluded, even when the client insists', async () => {
    const result = await runSafeDuplicateBatchChunk({
      reviewedPairs: [
        { keeperId: 'stu-abshir-a', removedId: 'stu-abshir-b' },
        { keeperId: 'stu-ahmed-conf-a', removedId: 'stu-ahmed-conf-b' },
      ],
      confirmPhrase: PHRASE,
      batchId: 'batch-forced',
    });
    expect(result.totals.merged).toBe(0);
    expect(result.blocked).toHaveLength(2);
    for (const b of result.blocked) {
      expect(b.reason).toBe('not_eligible_server_side');
      expect(b.codes).toContain('not_eligible_server_side');
    }
    expect(result.blocked[0].codes).toContain('exam_conflict');
    const { data: students } = await supabase.from('students').select('id');
    const ids = (students as any[]).map((s) => s.id);
    expect(ids).toContain('stu-abshir-b');
    expect(ids).toContain('stu-ahmed-conf-b');
  });

  it('skips a candidate whose fingerprint no longer matches the reviewed preview', async () => {
    const preview = await previewSafeDuplicateBatch();
    const stale = reviewedPairsFromPreview(preview).map((p) => ({ ...p, fingerprint: 'stale-fingerprint-000' }));
    const result = await runSafeDuplicateBatchChunk({ reviewedPairs: stale, confirmPhrase: PHRASE, batchId: 'batch-stale' });
    expect(result.totals.merged).toBe(0);
    expect(result.totals.skipped).toBe(2);
    for (const s of result.skipped) {
      expect(s.reason).toBe('candidate_changed_since_preview');
      expect(s.codes).toContain('candidate_changed_since_preview');
    }
    const { data: students } = await supabase.from('students').select('id');
    expect((students as any[]).some((s) => s.id === 'stu-axmed-b')).toBe(true);
  });

  it('merges nothing when the reviewed list is empty', async () => {
    const result = await runSafeDuplicateBatchChunk({ reviewedPairs: [], confirmPhrase: PHRASE, batchId: 'batch-empty' });
    expect(result.totals.merged).toBe(0);
    expect(result.merged).toEqual([]);
    expect(result.failed).toEqual([]);
  });
});

describe('safe batch — execution through the client wrappers', () => {
  it('merges the safe pairs in one atomic chunk and audits each merge', async () => {
    const preview: SafeBatchPreview = await previewSafeDuplicateBatch();
    const list = reviewedPairsFromPreview(preview);
    const auditsBefore = await getMergeAudits(200);

    const result = await runSafeDuplicateBatchChunk({
      reviewedPairs: list,
      chunkSize: 25,
      confirmPhrase: PHRASE,
      reason: 'September duplicate cleanup',
      batchId: preview.batchId,
    });

    expect(result.committed).toBe(true);
    expect(result.atomicChunk).toBe(true);
    expect(result.policy).toBe('safe_batch_parent_assigned_keeper');
    expect(result.totals).toMatchObject({ merged: 2, skipped: 0, blocked: 0, failed: 0, remaining: 0 });
    expect(result.merged.map((m) => m.preservedStudentId).sort()).toEqual(['stu-axmed-a', 'stu-samegov-a']);
    expect(result.merged.map((m) => m.removedStudentId).sort()).toEqual(['stu-axmed-b', 'stu-samegov-b']);
    for (const m of result.merged) expect(m.auditId).toBeTruthy();

    // Duplicate records are gone, keepers survive with their own Student ID.
    const { data: students } = await supabase.from('students').select('id, name, "parentId", "govId", "parentPhone"');
    const rows = students as any[];
    const ids = rows.map((r) => r.id);
    expect(ids).not.toContain('stu-axmed-b');
    expect(ids).not.toContain('stu-samegov-b');
    expect(ids).toContain('stu-axmed-a');
    expect(ids).toContain('stu-samegov-a');
    // Excluded pairs are untouched — they stay in individual review.
    expect(ids).toContain('stu-abshir-b');
    expect(ids).toContain('stu-ahmed-conf-b');
    // Keeper profile bytes were not rewritten by the batch policy.
    const axmed = rows.find((r) => r.id === 'stu-axmed-a');
    expect(axmed.govId).toBe('123456');
    expect(axmed.parentPhone).toBe('252634506719');
    expect(axmed.parentId).toBe('parent-1');
    const leyla = rows.find((r) => r.id === 'stu-samegov-a');
    expect(leyla.govId).toBe('999888');

    // Final invariants: keeper has exactly one open enrollment, removed has none.
    const { data: enrollments } = await supabase.from('student_enrollments').select('id, "studentId", "effectiveTo"');
    const enr = enrollments as any[];
    for (const keeperId of ['stu-axmed-a', 'stu-samegov-a']) {
      expect(enr.filter((e) => e.studentId === keeperId && e.effectiveTo == null)).toHaveLength(1);
    }
    expect(enr.filter((e) => e.studentId === 'stu-axmed-b')).toHaveLength(0);
    expect(enr.filter((e) => e.studentId === 'stu-samegov-b')).toHaveLength(0);

    // Per-merge audit rows (same detail as an individual merge) + batch stamp.
    const audits = await getMergeAudits(200);
    expect(audits.length).toBe(auditsBefore.length + 2);
    const batchAudits = audits.filter((a: any) => a.batch_id === preview.batchId);
    expect(batchAudits).toHaveLength(2);
    for (const a of batchAudits as any[]) {
      expect(a.merge_kind).toBe('safe_batch');
      expect(a.batch_policy).toBe('safe_batch_parent_assigned_keeper');
      expect(a.batch_size).toBe(25);
      expect(a.reason).toContain('Safe batch merge');
      expect(a.reason).toContain('September duplicate cleanup');
      expect(a.before_counts).toBeTruthy();
      expect(a.after_counts).toBeTruthy();
      expect(a.enrollment_action).toBeTruthy();
    }

    // Batch metadata answers "which students, which policy, who, when".
    const { data: batches } = await supabase.from('student_merge_batches').select('*');
    const batchRow = (batches as any[]).find((b) => b.id === preview.batchId);
    expect(batchRow).toBeTruthy();
    expect(batchRow).toMatchObject({
      policy: 'safe_batch_parent_assigned_keeper',
      chunk_size: 25,
      chunks_run: 1,
      merged_count: 2,
      failed_count: 0,
    });
    expect(batchRow.chunk_results).toHaveLength(1);

    const { data: logs } = await supabase.from('audit_logs').select('action, details');
    const batchLogs = (logs as any[]).filter((l) => l.action === 'students.merge_batch');
    expect(batchLogs.length).toBeGreaterThanOrEqual(1);
    const last = batchLogs[batchLogs.length - 1];
    expect(last.details.batchId).toBe(preview.batchId);
    expect(last.details.merged).toBe(2);
    expect(last.details.preservedStudentIds).toHaveLength(2);
    expect(last.details.removedStudentIds).toHaveLength(2);
    expect((logs as any[]).filter((l) => l.action === 'students.merge').length).toBeGreaterThanOrEqual(2);
  });

  it('is a safe no-op when run again with the same reviewed list', async () => {
    const preview = await previewSafeDuplicateBatch();
    expect(preview.summary.safeCount).toBe(0);
    const staleList = [
      { keeperId: 'stu-axmed-a', removedId: 'stu-axmed-b' },
      { keeperId: 'stu-samegov-a', removedId: 'stu-samegov-b' },
    ];
    const result = await runSafeDuplicateBatchChunk({
      reviewedPairs: staleList,
      confirmPhrase: PHRASE,
      batchId: 'batch-rerun',
    });
    expect(result.totals.merged).toBe(0);
    expect(result.totals.failed).toBe(0);
    expect(result.skipped.map((s) => s.reason)).toEqual(['already_resolved', 'already_resolved']);
    const { data: students } = await supabase.from('students').select('id');
    expect((students as any[]).some((s) => s.id === 'stu-axmed-a')).toBe(true);
  });

  it('leaves the individual review workflow exactly as it was', async () => {
    // The batch never weakened or replaced the guided single-pair merge.
    const preview = await previewStudentMerge('stu-abshir-a', 'stu-abshir-b');
    expect(preview.canMerge).toBe(false);
    expect(preview.blockedReasons).toContain('exam_conflict');
    const conflicts = await getMergeConflicts('stu-abshir-a', 'stu-abshir-b');
    expect(conflicts.counts.exams).toBeGreaterThan(0);
    expect(conflicts.exams.length).toBeGreaterThan(0);
    expect(conflicts.profile.canonical.id).toBe('stu-abshir-a');
    const ahmed = await previewStudentMerge('stu-ahmed-conf-a', 'stu-ahmed-conf-b');
    expect(ahmed.canMerge).toBe(false);
    expect(ahmed.blockedReasons).toContain('gov_id_conflict');
  });
});
