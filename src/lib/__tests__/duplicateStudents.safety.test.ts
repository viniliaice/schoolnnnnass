// @vitest-environment jsdom
// Safety fixes: candidate auth, enrollment academicYear, identity prevention
import { describe, it, expect, beforeEach } from 'vitest';
import { supabase } from '../supabase';
import { previewStudentMerge, getDuplicateGroups } from '../db/duplicateStudents';

describe('Duplicate Students — safety fixes', () => {
  beforeEach(() => {
    localStorage.clear();
    // Reset mock role to admin by default
    (globalThis as any).__mockRole = 'admin';
  });

  describe('1. get_duplicate_candidates auth', () => {
    it('anon cannot call duplicate candidate RPC', async () => {
      (globalThis as any).__mockRole = 'anon';
      const { data, error } = await supabase.rpc('get_duplicate_candidates');
      expect(error).toBeTruthy();
      expect(error!.message).toMatch(/Only administrators/);
      expect(data).toBeNull();
    });

    it('authenticated non-admin cannot call duplicate candidate RPC', async () => {
      (globalThis as any).__mockRole = 'teacher';
      const { data, error } = await supabase.rpc('get_duplicate_candidates');
      expect(error).toBeTruthy();
      expect(error!.message).toMatch(/Only administrators/);
      expect(data).toBeNull();
    });

    it('parent cannot call candidate RPC', async () => {
      (globalThis as any).__mockRole = 'parent';
      const { data, error } = await supabase.rpc('get_duplicate_candidates');
      expect(error).toBeTruthy();
    });

    it('admin can call candidate RPC', async () => {
      (globalThis as any).__mockRole = 'admin';
      const { data, error } = await supabase.rpc('get_duplicate_candidates');
      expect(error).toBeNull();
      expect(Array.isArray(data)).toBe(true);
      // Should find at least Axmed group
      expect(data.length).toBeGreaterThanOrEqual(1);
    });

    it('preview and merge also require admin', async () => {
      (globalThis as any).__mockRole = 'teacher';
      const { error: pErr } = await supabase.rpc('preview_student_merge', { p_canonical_id: 'stu-axmed-a', p_duplicate_id: 'stu-axmed-b' });
      expect(pErr).toBeTruthy();
      expect(pErr!.message).toMatch(/Only administrators/);
      const { error: mErr } = await supabase.rpc('merge_duplicate_students', { p_canonical_id: 'stu-axmed-a', p_duplicate_id: 'stu-axmed-b' });
      expect(mErr).toBeTruthy();
    });

    it('getDuplicateGroups fallback still works for admin (client grouping)', async () => {
      (globalThis as any).__mockRole = 'admin';
      const groups = await getDuplicateGroups();
      expect(groups.length).toBeGreaterThanOrEqual(4);
    });
  });

  describe('2. Enrollment academic-year safety', () => {
    it('same class + same academicYearId → consolidate (canMerge true)', async () => {
      (globalThis as any).__mockRole = 'admin';
      // Axmed demo has same class Grade1-B same year ay-2026 → should consolidate
      const p = await previewStudentMerge('stu-axmed-a', 'stu-axmed-b');
      expect(p.canMerge).toBe(true);
      expect(p.enrollment.willConsolidate).toBe(true);
      expect(p.enrollment.action).toBe('consolidate');
      expect(p.blockedReasons).not.toContain('enrollment_conflict');
    });

    it('same class + different academicYearId → blocked', async () => {
      (globalThis as any).__mockRole = 'admin';
      // Create two students with same name/class but different academicYear
      const { data: created } = await supabase.rpc('create_student', { p_name: 'Test Enroll Year', p_class: 'Grade 1-B', p_parent_id: null, p_gov_id: null, p_parent_phone: null });
      // Instead, directly manipulate mock enrollments for existing pair to simulate different year
      // We'll create fresh enrollments with different year for a new pair
      // Use existing Ahmed pair but change one enrollment year
      // For isolation, create two new students via mock directly
      const { supabase: sb } = await import('../supabase');
      // Find a way to create enrollments with different years via direct table access
      // We'll insert students manually via mockTables path
      // Simpler: use preview on a synthetic pair where we set enrollments differing
      // We will directly access mockTables to set up
      const { data: s1 } = await supabase.rpc('create_student', { p_name: 'EnrollTestSameClass', p_class: 'Grade 9-A', p_gov_id: null });
      const id1 = (s1 as any)?.id;
      const { data: s2 } = await supabase.rpc('create_student', { p_name: 'EnrollTestSameClass', p_class: 'Grade 9-A', p_gov_id: null });
      const id2 = (s2 as any)?.id;
      // Now enrollments are both ay-2026 same class → should be consolidate, we will change one to ay-2025
      const { data: enrs } = await supabase.from('student_enrollments').select('*');
      const e1 = (enrs as any[]).find((e:any)=>e.studentId===id1 && e.effectiveTo==null);
      const e2 = (enrs as any[]).find((e:any)=>e.studentId===id2 && e.effectiveTo==null);
      if (e1 && e2) {
        e2.academicYearId = 'ay-2025'; // different year
      }
      const p = await previewStudentMerge(id1, id2);
      expect(p.canMerge).toBe(false);
      expect(p.blockedReasons).toContain('enrollment_conflict');
      expect(p.enrollment.action).toBe('blocked');
      expect(p.enrollment.willConsolidate).toBe(false);
    });

    it('different class → blocked', async () => {
      (globalThis as any).__mockRole = 'admin';
      // Create two students same name different class
      const { data: s1 } = await supabase.rpc('create_student', { p_name: 'DiffClassTest', p_class: 'Grade 1-A', p_gov_id: null });
      const id1 = (s1 as any)?.id;
      const { data: s2 } = await supabase.rpc('create_student', { p_name: 'DiffClassTest', p_class: 'Grade 1-B', p_gov_id: null });
      const id2 = (s2 as any)?.id;
      // Force them to be considered pair by manually setting preview to check enrollment conflict even though candidate detector wouldn't group different class
      // But preview checks enrollment directly, so we need enrollments with different class
      const p = await previewStudentMerge(id1, id2);
      expect(p.canMerge).toBe(false);
      expect(p.blockedReasons).toContain('enrollment_conflict');
    });

    it('multiple open enrollments → blocked', async () => {
      (globalThis as any).__mockRole = 'admin';
      const { data: s1 } = await supabase.rpc('create_student', { p_name: 'MultiEnrollTest', p_class: 'Grade 2-A', p_gov_id: null });
      const id1 = (s1 as any)?.id;
      const { data: s2 } = await supabase.rpc('create_student', { p_name: 'MultiEnrollTest', p_class: 'Grade 2-A', p_gov_id: null });
      const id2 = (s2 as any)?.id;
      // Add second open enrollment for id1
      await supabase.from('student_enrollments').insert({ id: `enr-${id1}-open2`, studentId: id1, className: 'Grade 2-A', academicYearId: 'ay-2026', effectiveFrom: '2026-09-01', effectiveTo: null, reason: 'test' });
      const p = await previewStudentMerge(id1, id2);
      expect(p.canMerge).toBe(false);
      expect(p.blockedReasons).toContain('enrollment_conflict');
      expect(p.blockedReasons).toContain('multiple_open_enrollments');
    });

    it('merge also blocks on same class different year', async () => {
      (globalThis as any).__mockRole = 'admin';
      const { data: s1 } = await supabase.rpc('create_student', { p_name: 'MergeYearBlock', p_class: 'Grade 3-A', p_gov_id: null });
      const id1 = (s1 as any)?.id;
      const { data: s2 } = await supabase.rpc('create_student', { p_name: 'MergeYearBlock', p_class: 'Grade 3-A', p_gov_id: null });
      const id2 = (s2 as any)?.id;
      const { data: enrs } = await supabase.from('student_enrollments').select('*');
      const e2 = (enrs as any[]).find((e:any)=>e.studentId===id2 && e.effectiveTo==null);
      if (e2) e2.academicYearId = 'ay-2025';
      await expect(supabase.rpc('merge_duplicate_students', { p_canonical_id: id1, p_duplicate_id: id2 })).resolves.toMatchObject({ error: expect.objectContaining({ message: expect.stringMatching(/ENROLLMENT_CONFLICT|enrollment histories are contradictory/i) }) });
    });
  });

  describe('3. Identity prevention — Axmed-type', () => {
    it('Axmed-type: existing parent+gov, incoming unassigned same name/class → blocked on create', async () => {
      (globalThis as any).__mockRole = 'admin';
      // Existing is stu-axmed-a (parent assigned gov 123456 Grade1-B)
      // Try to create another Axmed unassigned same class
      const { error } = await supabase.rpc('create_student', { p_name: 'Axmed yaasiin ismaaciil', p_class: 'Grade 1-B', p_parent_id: null, p_gov_id: null, p_parent_phone: null });
      expect(error).toBeTruthy();
      expect(error!.message).toMatch(/Possible duplicate detected|Manual review/);
    });

    it('Axmed-type via bulk create is blocked', async () => {
      (globalThis as any).__mockRole = 'admin';
      const { error } = await supabase.rpc('bulk_create_students', { p_students: [{ name: 'Axmed yaasiin ismaaciil', className: 'Grade 1-B', parentId: null, govId: null }] });
      expect(error).toBeTruthy();
      expect(error!.message).toMatch(/Possible duplicate/);
    });

    it('Axmed-type via import new students is blocked', async () => {
      (globalThis as any).__mockRole = 'admin';
      const { error } = await supabase.rpc('apply_student_class_import', { p_changes: [], p_new_students: [{ name: 'Axmed yaasiin ismaaciil', className: 'Grade 1-B', govId: null }], p_academic_year_id: 'ay-2026' });
      expect(error).toBeTruthy();
      expect(error!.message).toMatch(/Possible duplicate in import/);
    });

    it('genuine same-name students with different Gov and parents are NOT blocked — distinct allowed', async () => {
      (globalThis as any).__mockRole = 'admin';
      // Ahmed Mohamed Grade 4-A Parent A Gov 111 vs Parent B Gov 222 — should be allowed as distinct
      // First ensure one exists
      const { data: s1, error: e1 } = await supabase.rpc('create_student', { p_name: 'Ahmed Mohamed', p_class: 'Grade 4-A', p_parent_id: 'parent-1', p_gov_id: 'GOV-UNIQUE-111', p_parent_phone: '252634506719' });
      expect(e1).toBeNull();
      const id1 = (s1 as any)?.id;
      // Second with different gov and parent should succeed (genuine distinct)
      const { data: s2, error: e2 } = await supabase.rpc('create_student', { p_name: 'Ahmed Mohamed', p_class: 'Grade 4-A', p_parent_id: 'parent-2', p_gov_id: 'GOV-UNIQUE-222', p_parent_phone: '252634511111' });
      expect(e2).toBeNull();
      expect(s2).toBeTruthy();
      // Verify they are two distinct rows
      const { data: all } = await supabase.from('students').select('id').eq('className', 'Grade 4-A');
      const names = (all as any[]).filter((r:any)=>r.name==='Ahmed Mohamed');
      // At least 2 distinct Ahmed in Grade 4-A now (plus previous demo Ahmed in Grade5-A)
      expect(names.length).toBeGreaterThanOrEqual(2);
    });

    it('conflicting Gov IDs same name/class do not collapse via import', async () => {
      (globalThis as any).__mockRole = 'admin';
      const { data: s1 } = await supabase.rpc('create_student', { p_name: 'GovConflictTest', p_class: 'Grade 6-A', p_gov_id: 'GOV-A-001', p_parent_id: 'parent-1' });
      expect(s1).toBeTruthy();
      const { data: s2, error: e2 } = await supabase.rpc('create_student', { p_name: 'GovConflictTest', p_class: 'Grade 6-A', p_gov_id: 'GOV-B-002', p_parent_id: 'parent-2' });
      // Different Gov with different parents → should be allowed as distinct (not strong duplicate)
      expect(e2).toBeNull();
      expect(s2).toBeTruthy();
    });

    it('ambiguous identity (same name+class no Gov no parent) requires manual review — creation allowed but duplicate page will flag', async () => {
      (globalThis as any).__mockRole = 'admin';
      const { data: s1, error: e1 } = await supabase.rpc('create_student', { p_name: 'Ambiguous Student', p_class: 'Grade 2-B', p_gov_id: null, p_parent_id: null });
      expect(e1).toBeNull();
      const { data: s2, error: e2 } = await supabase.rpc('create_student', { p_name: 'Ambiguous Student', p_class: 'Grade 2-B', p_gov_id: null, p_parent_id: null });
      // Both unassigned no Gov → possible, not strong → should allow creation (will be manual review via duplicate page)
      expect(e2).toBeNull();
      // Now duplicate page should show them as possible
      const groups = await getDuplicateGroups();
      const g = groups.find(x=>x.normalizedName==='ambiguous student' && x.className==='Grade 2-B');
      expect(g).toBeDefined();
      expect(g!.students.length).toBe(2);
    });
  });

  describe('4. Stable Student ID authoritative', () => {
    it('same Student ID class change via import — same ID, class updated, no second student', async () => {
      (globalThis as any).__mockRole = 'admin';
      const { data: s } = await supabase.rpc('create_student', { p_name: 'StableIdTest', p_class: 'Grade 7-A', p_gov_id: null });
      const id = (s as any)?.id;
      expect(id).toBeTruthy();
      const before = await supabase.from('students').select('id,className').eq('id', id).maybeSingle();
      expect((before.data as any)?.className).toBe('Grade 7-A');
      // Now class change via import
      const { data, error } = await supabase.rpc('apply_student_class_import', { p_changes: [{ studentId: id, toClass: 'Grade 7-B' }], p_new_students: [], p_academic_year_id: 'ay-2026' });
      expect(error).toBeNull();
      expect((data as any).updatedCount).toBe(1);
      const after = await supabase.from('students').select('id,className').eq('id', id).maybeSingle();
      expect((after.data as any)?.className).toBe('Grade 7-B');
      expect((after.data as any)?.id).toBe(id);
      // No second student
      const { data: all } = await supabase.from('students').select('id').eq('id', id);
      expect((all as any[]).length).toBe(1);
    });

    it('stable ID reuse via bulk/create is blocked — must use class change', async () => {
      (globalThis as any).__mockRole = 'admin';
      const { data: s } = await supabase.rpc('create_student', { p_name: 'StableReuse', p_class: 'Grade 7-A', p_gov_id: null });
      const id = (s as any)?.id;
      // Try to create new student with same ID via import newStudents — should error
      const { error } = await supabase.rpc('apply_student_class_import', { p_changes: [], p_new_students: [{ id, name: 'StableReuse', className: 'Grade 7-B' }], p_academic_year_id: 'ay-2026' });
      expect(error).toBeTruthy();
      expect(error!.message).toMatch(/already exists/);
    });
  });
});
