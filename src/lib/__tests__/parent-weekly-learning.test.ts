import fs from 'node:fs';
import path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../supabase', () => ({ supabase: { rpc: vi.fn(), from: vi.fn() } }));

import { supabase } from '../supabase';
import { getParentWeeklyLearning } from '../db/parentWeeklyLearning';

const rpc = supabase.rpc as unknown as ReturnType<typeof vi.fn>;
const from = supabase.from as unknown as ReturnType<typeof vi.fn>;

beforeEach(() => {
  rpc.mockReset();
  from.mockReset();
});

describe('parent weekly learning client boundary', () => {
  it('uses only the parent-safe RPC and never raw lesson tables', async () => {
    rpc.mockResolvedValue({ data: [], error: null });
    await getParentWeeklyLearning('student-A', '2026-W07');
    expect(rpc).toHaveBeenCalledWith('get_parent_weekly_learning', {
      p_student_id: 'student-A', p_week_label: '2026-W07',
    });
    expect(from).not.toHaveBeenCalled();
  });

  it('maps only allowlisted presentation fields', async () => {
    rpc.mockResolvedValue({
      data: [{
        student_id: 's1', student_name: 'Amina', class_name: 'Grade 5-A',
        week_label: '2026-W07', week_start: '2026-09-12', week_end: '2026-09-16',
        lesson_id: 'period-1', day: 'Tuesday', subject: 'English', topic: 'Reading',
        learning_objective: 'Find the main idea', what_we_are_learning: 'Read and discuss clues',
        resources: [{ label: 'Student book', url: null }], practice_title: 'Read pages 12–14',
        practice_description: null, practice_due_date: '2026-09-16',
        teacher_id: 'must-not-map', status: 'approved', ai_score: 99,
      }], error: null,
    });
    const [lesson] = await getParentWeeklyLearning('s1', '2026-W07');
    expect(lesson).toMatchObject({ studentName: 'Amina', subject: 'English', topic: 'Reading' });
    expect(lesson).not.toHaveProperty('teacher_id');
    expect(lesson).not.toHaveProperty('status');
    expect(lesson).not.toHaveProperty('ai_score');
  });

  it('does not hide network errors as an empty unpublished week', async () => {
    rpc.mockResolvedValue({ data: null, error: { message: 'network unavailable' } });
    await expect(getParentWeeklyLearning('s1', '2026-W07')).rejects.toThrow(/network unavailable/);
  });
});

describe('parent weekly learning migration security contract', () => {
  const migration = fs.readFileSync(
    path.resolve(process.cwd(), 'supabase/migrations/20260916_parent_weekly_learning.sql'), 'utf8',
  );

  it('removes role-blind lesson and AI policies', () => {
    expect(migration).toContain('DROP POLICY IF EXISTS "admin_all_plans"');
    expect(migration).toContain('DROP POLICY IF EXISTS "admin_all_periods"');
    expect(migration).toContain('DROP POLICY IF EXISTS "admin_all_reviews"');
    expect(migration).not.toMatch(/CREATE POLICY[^;]+USING \(true\)/s);
  });

  it('authorizes parent, student ownership, effective enrollment and approved plans in SQL', () => {
    expect(migration).toContain("v_role IS DISTINCT FROM 'parent'");
    expect(migration).toContain('s."parentId" = v_actor');
    expect(migration).toContain('public.student_enrollments');
    expect(migration).toContain("lp.status = 'approved'");
    expect(migration).toContain('lp.class_name = v_class');
  });

  it('links homework only by the authoritative period foreign key', () => {
    expect(migration).toContain('ADD COLUMN IF NOT EXISTS lesson_plan_period_id');
    expect(migration).toContain('hw.lesson_plan_period_id = e.period_id');
    expect(migration).not.toMatch(/hw\.subject\s*=|hw\."className"\s*=/);
  });

  it('grants parents no raw lesson-table policy', () => {
    const policyStatements = migration.match(/CREATE POLICY[\s\S]*?;/g) || [];
    const rawParentPolicy = policyStatements.some(statement =>
      /lesson_plans|lesson_plan_periods/.test(statement) && /parent/.test(statement),
    );
    expect(rawParentPolicy).toBe(false);
    expect(migration).toContain('REVOKE ALL ON FUNCTION public.get_parent_weekly_learning(TEXT, TEXT) FROM PUBLIC');
  });
});
