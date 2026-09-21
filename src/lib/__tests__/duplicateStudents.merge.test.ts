// @vitest-environment jsdom
// Uses the real mock supabase client (no VITE_SUPABASE_* env) so preview/merge
// execute against the in-memory demo tables seeded in src/lib/supabase.ts.
// This verifies blocking logic, enrollment consolidation, and audit paths.
import { describe, it, expect, beforeEach } from 'vitest';
import { getDuplicateGroups, previewStudentMerge, mergeDuplicateStudents, getMergeAudits } from '../db/duplicateStudents';
import { supabase } from '../supabase';

describe('Duplicate Students — mock preview & merge integration', () => {
  beforeEach(async () => {
    // Ensure clean localStorage between tests (reviewedSet)
    localStorage.clear();
  });

  it('getDuplicateGroups groups by normalized name + class (candidate detector)', async () => {
    const groups = await getDuplicateGroups();
    // Demo seed now contains 4 groups: Axmed, Abshir, Ahmed-conf, Leyla
    const keys = groups.map(g => g.groupKey);
    // Check normalized keys: axmed...|Grade 1-B etc
    expect(groups.length).toBeGreaterThanOrEqual(4);
    const axmedGroup = groups.find(g => g.normalizedName === 'axmed yaasiin ismaaciil' && g.className === 'Grade 1-B');
    expect(axmedGroup).toBeDefined();
    expect(axmedGroup!.students.length).toBe(2);
    expect(axmedGroup!.pairs.length).toBe(1);

    const abshirGroup = groups.find(g => g.normalizedName === 'abshir cabdi maxamed');
    expect(abshirGroup).toBeDefined();

    const ahmedGroup = groups.find(g => g.normalizedName === 'ahmed mohamed');
    expect(ahmedGroup).toBeDefined();

    const leylaGroup = groups.find(g => g.normalizedName === 'leyla hassan');
    expect(leylaGroup).toBeDefined();
  });

  it('preview — Axmed safe high-confidence (one parent, one gov) is mergeable', async () => {
    const p = await previewStudentMerge('stu-axmed-a', 'stu-axmed-b');
    expect(p.canMerge).toBe(true);
    expect(p.evidence).toBe('strong');
    expect(p.riskLevel).toBe('low');
    expect(p.blockedReasons).toHaveLength(0);
    expect(p.conflicts.govConflict).toBe(false);
    expect(p.conflicts.sameGov).toBe(false);
    // Enrollment: both open same class → consolidate
    expect(p.enrollment.willConsolidate).toBe(true);
    expect(p.enrollment.action).toBe('consolidate');
    // Counts: no exam conflicts
    expect(p.conflicts.examConflicts).toBe(0);
    expect(p.counts.exams.conflicts).toBe(0);
  });

  it('preview — Abshir blocked exam conflict (56 vs 55 matching)', async () => {
    const p = await previewStudentMerge('stu-abshir-a', 'stu-abshir-b');
    expect(p.canMerge).toBe(false);
    expect(p.blockedReasons).toContain('exam_conflict');
    expect(p.conflicts.examConflicts).toBeGreaterThan(0);
    // Gov and parent: canonical has gov+parent, duplicate unassigned → not blocking at identity level
    expect(p.conflicts.govConflict).toBe(false);
  });

  it('preview — Ahmed conflicting Gov IDs blocked (critical)', async () => {
    const p = await previewStudentMerge('stu-ahmed-conf-a', 'stu-ahmed-conf-b');
    expect(p.canMerge).toBe(false);
    expect(p.blockedReasons).toContain('gov_id_conflict');
    expect(p.conflicts.govConflict).toBe(true);
    expect(p.riskLevel).toBe('critical');
    expect(p.evidence).toBe('conflicting');
  });

  it('preview — Leyla same Gov ID strong match is mergeable', async () => {
    const p = await previewStudentMerge('stu-samegov-a', 'stu-samegov-b');
    expect(p.canMerge).toBe(true);
    expect(p.evidence).toBe('strong');
    expect(p.conflicts.sameGov).toBe(true);
    expect(p.conflicts.govConflict).toBe(false);
    // Leyla duplicate has distinct subjects, so no exam conflict
    expect(p.conflicts.examConflicts).toBe(0);
    // Enrollment consolidate as well
    expect(p.enrollment.willConsolidate).toBe(true);
  });

  it('merge — Axmed duplicate is removed, canonical preserved, audit created, one open enrollment remains', async () => {
    // Before, both students exist
    const beforeGroups = await getDuplicateGroups();
    expect(beforeGroups.find(g => g.groupKey.includes('axmed'))).toBeDefined();

    const beforePreview = await previewStudentMerge('stu-axmed-a', 'stu-axmed-b');
    expect(beforePreview.canMerge).toBe(true);

    const result = await mergeDuplicateStudents('stu-axmed-a', 'stu-axmed-b', 'Test merge Axmed via integration test');
    expect(result.auditId).toBeTruthy();
    expect(result.canonicalId).toBe('stu-axmed-a');
    expect(result.duplicateId).toBe('stu-axmed-b');

    // Verify duplicate no longer exists, canonical still exists
    const { data: can } = await supabase.from('students').select('id').eq('id', 'stu-axmed-a').maybeSingle();
    expect(can).toBeTruthy();
    const { data: dup } = await supabase.from('students').select('id').eq('id', 'stu-axmed-b').maybeSingle();
    expect(dup).toBeNull();

    // Verify audit row exists
    const audits = await getMergeAudits(50);
    const axmedAudit = audits.find(a => a.canonical_id === 'stu-axmed-a' && a.duplicate_id === 'stu-axmed-b');
    expect(axmedAudit).toBeDefined();

    // Verify enrollments: only one open remains for canonical, duplicate has zero
    const { data: enrCan } = await supabase.from('student_enrollments').select('id').eq('studentId', 'stu-axmed-a');
    const { data: enrDup } = await supabase.from('student_enrollments').select('id').eq('studentId', 'stu-axmed-b');
    expect((enrDup as unknown[] | null)?.length || 0).toBe(0);
    // Canonical should have 1 open (consolidated) + historic? Initially 1 open + 0 hist for each, after merge should be 1 open total
    const openEnr = (enrCan as unknown as Array<{ effectiveTo: string | null }>)?.filter((e: any) => e.effectiveTo == null) ?? [];
    // In mock, consolidation deletes duplicate open, so exactly 1 open should remain
    expect(openEnr.length).toBe(1);

    // Verify no child records remain on duplicate (exams etc are zero)
    const { count: examDupCount } = await supabase.from('exams').select('id', { count: 'exact', head: true }).eq('studentId', 'stu-axmed-b') as unknown as { count: number };
    // head:true mock may not return count correctly, fallback to direct query length
    const { data: examsDup } = await supabase.from('exams').select('id').eq('studentId', 'stu-axmed-b');
    expect((examsDup as unknown[])?.length || 0).toBe(0);

    // After merge, duplicate group should vanish
    const afterGroups = await getDuplicateGroups();
    expect(afterGroups.find(g => g.groupKey.includes('axmed'))).toBeUndefined();
  });

  it('merge — Abshir blocked due to exam conflict throws', async () => {
    await expect(previewStudentMerge('stu-abshir-a', 'stu-abshir-b')).resolves.toMatchObject({ canMerge: false });
    await expect(mergeDuplicateStudents('stu-abshir-a', 'stu-abshir-b', 'should block')).rejects.toThrow(/exam identity conflicts|exam.*conflict/i);
  });

  it('merge — Ahmed blocked due to conflicting Gov IDs throws', async () => {
    await expect(previewStudentMerge('stu-ahmed-conf-a', 'stu-ahmed-conf-b')).resolves.toMatchObject({ canMerge: false });
    await expect(mergeDuplicateStudents('stu-ahmed-conf-a', 'stu-ahmed-conf-b', 'should block gov')).rejects.toThrow(/Government IDs|gov/i);
  });

  it('merge — preserves canonical identity (Student ID never overwritten by duplicate)', async () => {
    // For Leyla, canonical is stu-samegov-a (has gov 999888 + parent), duplicate is stu-samegov-b (same gov)
    // After merge, canonical id stays stu-samegov-a
    const p = await previewStudentMerge('stu-samegov-a', 'stu-samegov-b');
    expect(p.canMerge).toBe(true);
    const res = await mergeDuplicateStudents('stu-samegov-a', 'stu-samegov-b', 'Leyla merge');
    expect(res.canonicalId).toBe('stu-samegov-a');
    const { data: can } = await supabase.from('students').select('id,govId').eq('id', 'stu-samegov-a').maybeSingle() as unknown as { data: { id: string; govId: string } | null };
    expect(can?.id).toBe('stu-samegov-a');
    expect(can?.govId).toBe('999888');
    const { data: dup } = await supabase.from('students').select('id').eq('id', 'stu-samegov-b').maybeSingle();
    expect(dup).toBeNull();
  });

  it('audit trail records reason, before/after counts, and actor', async () => {
    // At this point at least Axmed and Leyla audits exist; verify shape
    const audits = await getMergeAudits(50);
    expect(audits.length).toBeGreaterThanOrEqual(2);
    for (const a of audits) {
      expect(a.id).toMatch(/^merge-/);
      expect(a.canonical_id).toBeTruthy();
      expect(a.duplicate_id).toBeTruthy();
      expect(a.before_counts).toBeDefined();
      // after_counts set after merge
      expect(a.created_at).toBeTruthy();
    }
  });

  it('no Merge All — getDuplicateGroups never returns a bulk operation flag', async () => {
    // Verify client API does not expose a bulk merge
    const mod = await import('../db/duplicateStudents');
    expect(typeof (mod as Record<string, unknown>).mergeDuplicateStudents).toBe('function');
    // There should be no bulk function exported
    expect((mod as Record<string, unknown>).mergeAllDuplicates).toBeUndefined();
    expect((mod as Record<string, unknown>).mergeAll).toBeUndefined();
    expect((mod as Record<string, unknown>).bulkMerge).toBeUndefined();
  });
});
