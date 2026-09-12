// Preview-mode (mock Supabase) client test — deliberately NOT mocking
// '../supabase'. Without VITE_SUPABASE_* env vars that module builds the
// in-browser demo client, which is what the deployed preview runs on. This
// file pins the lesson-plan paths the submission tracker uses:
//
//   * list_lesson_plan_submitters / list_lesson_plan_weeks mock RPCs,
//   * the dual `.in(status).in(week_label)` week fetch (the mock chain used
//     to keep only ONE in-filter, silently dropping the other),
//   * the embedded teacher-name join shape.
//
// Assertions are tolerant of demo-data churn: they check the teachers and
// weeks the demo seed is known to contain, not an exact roster.

import { describe, expect, it } from 'vitest';
import { fetchLessonPlanSubmitters, fetchSubmissionTrackingPlans } from '../db/lessonPlanSubmissions';

const SUBMISSION_STATUSES = ['submitted', 'in_review', 'approved', 'rejected', 'ai_failed', 'revision_requested'];

describe('preview client — lesson plan submission tracking', () => {
  it('serves the expected-submitter roster through the RPC path', async () => {
    const submitters = await fetchLessonPlanSubmitters();
    // Demo teachers with assigned classes; supervisor/admin/parents excluded.
    const ids = submitters.map((s) => s.teacherId).sort();
    expect(ids).toContain('teacher-1');
    expect(ids).toContain('teacher-4');
    expect(ids.every((id) => id.startsWith('teacher-'))).toBe(true);
    expect(submitters.find((s) => s.teacherId === 'teacher-4')?.classes).toEqual(['Grade 4-A']);
  });

  it('applies BOTH .in filters — status and week — to the week fetch', async () => {
    // The demo seed stores 8 plans under 2026-W07 across mixed statuses.
    const week = await fetchSubmissionTrackingPlans(['2026-W07']);
    expect(week.length).toBeGreaterThan(0);
    expect(week.every((p) => p.week_label === '2026-W07')).toBe(true);
    expect(week.every((p) => SUBMISSION_STATUSES.includes(p.status))).toBe(true);
    // Teacher names resolve through the embedded profiles join.
    expect(week.every((p) => typeof p.teacher_name === 'string')).toBe(true);
  });

  it('keeps the submit-time stamp on the rows the tracker displays', async () => {
    const week = await fetchSubmissionTrackingPlans(['2026-W15']);
    expect(week.length).toBeGreaterThan(0);
    for (const plan of week) {
      expect(typeof plan.ai_started_at === 'string' || typeof plan.updated_at === 'string').toBe(true);
    }
  });
});
