import { describe, expect, it } from 'vitest';
import {
  buildLessonPlanReminderProgress,
  type LessonPlanReminderPeriod,
  type LessonPlanReminderPlan,
} from '../academicReminders';

const DAYS = ['Saturday', 'Sunday', 'Monday', 'Tuesday', 'Wednesday'];

function periods(options: { missing?: number[]; free?: number[] } = {}): LessonPlanReminderPeriod[] {
  const rows: LessonPlanReminderPeriod[] = [];
  let index = 0;
  for (const day of DAYS) {
    for (let period_number = 1; period_number <= 4; period_number += 1) {
      rows.push({
        id: `period-${index}`,
        day,
        period_number,
        topic: options.missing?.includes(index) ? '' : `Topic ${index + 1}`,
        subject: options.free?.includes(index) ? null : 'English',
        is_free: options.free?.includes(index) ?? false,
      });
      index += 1;
    }
  }
  return rows;
}

function plan(overrides: Partial<LessonPlanReminderPlan> = {}): LessonPlanReminderPlan {
  return {
    id: 'plan-1',
    teacher_id: 'teacher-1',
    teacher_name: 'Teacher One',
    class_name: 'Grade 10-A',
    week_label: '2026-W07',
    status: 'submitted',
    period_count: 4,
    created_at: '2026-09-01T10:00:00Z',
    updated_at: '2026-09-01T10:00:00Z',
    periods: periods(),
    ...overrides,
  };
}

const submitters = [
  { teacherId: 'teacher-1', teacherName: 'Teacher One', classes: ['Grade 10-A'] },
  { teacherId: 'teacher-2', teacherName: 'Teacher Two', classes: ['Foundation A'] },
  { teacherId: 'teacher-3', teacherName: 'Teacher Three', classes: ['Grade 5-A'] },
];

describe('lesson-plan academic reminder eligibility', () => {
  it('does not remind a completed 100% Grade 7–12 plan', () => {
    const [teacher] = buildLessonPlanReminderProgress([submitters[0]], [plan()]);
    expect(teacher).toMatchObject({
      teacherId: 'teacher-1',
      submitted: true,
      completionPercent: 100,
      outstandingPlans: 0,
      outstandingPeriods: 0,
      completionStatus: 'complete',
      eligible: false,
    });
  });

  it('uses the existing free-period-excluded formula and counts missing required periods', () => {
    const incomplete = plan({
      teacher_id: 'teacher-2',
      teacher_name: 'Teacher Two',
      class_name: 'Foundation A',
      status: 'draft',
      periods: periods({ missing: [0, 7], free: [1] }),
    });
    const rows = buildLessonPlanReminderProgress([submitters[1]], [incomplete]);
    expect(rows[0]).toMatchObject({
      submitted: false,
      completionPercent: 89.47,
      outstandingPlans: 1,
      outstandingPeriods: 2,
      completionStatus: 'incomplete',
      eligible: true,
    });
  });

  it('does not create a reminder task merely from an assigned class with no lesson-plan row', () => {
    const [teacher] = buildLessonPlanReminderProgress([submitters[2]], []);
    expect(teacher).toMatchObject({
      submitted: false,
      planCount: 0,
      completionPercent: 0,
      outstandingPlans: 0,
      outstandingPeriods: 0,
      completionStatus: 'no_task',
      eligible: false,
    });
  });

  it('does not treat a missing second-class plan as outstanding when the only actual plan is complete', () => {
    const submitter = { teacherId: 'teacher-multi', teacherName: 'Teacher Multi', classes: ['Grade 5-A', 'Grade 5-B'] };
    const completePlan = plan({
      id: 'plan-a',
      teacher_id: 'teacher-multi',
      teacher_name: 'Teacher Multi',
      class_name: 'Grade 5-A',
    });
    const [teacher] = buildLessonPlanReminderProgress([submitter], [completePlan]);
    expect(teacher).toMatchObject({
      submitted: true,
      outstandingPlans: 0,
      outstandingDetails: [],
      completionStatus: 'complete',
      eligible: false,
    });
  });

  it('reminds for a real incomplete plan but does not count an unplanned assigned class', () => {
    const submitter = { teacherId: 'teacher-multi', teacherName: 'Teacher Multi', classes: ['Grade 5-A', 'Grade 5-B'] };
    const incompletePlan = plan({
      id: 'plan-a',
      teacher_id: 'teacher-multi',
      teacher_name: 'Teacher Multi',
      class_name: 'Grade 5-A',
      periods: periods({ missing: [0] }),
    });
    const [teacher] = buildLessonPlanReminderProgress([submitter], [incompletePlan]);
    expect(teacher).toMatchObject({
      outstandingPlans: 1,
      outstandingPeriods: 1,
      outstandingDetails: [{ planId: 'plan-a', className: 'Grade 5-A', missingPeriods: 1 }],
      eligible: true,
    });
  });

  it('treats a revision request as outstanding even when its period topics are filled', () => {
    const revision = plan({ status: 'revision_requested' });
    const [teacher] = buildLessonPlanReminderProgress([submitters[0]], [revision]);
    expect(teacher).toMatchObject({
      submitted: true,
      reviewStatus: 'revision_requested',
      completionPercent: 100,
      outstandingPlans: 1,
      eligible: true,
    });
  });
});
