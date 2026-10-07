import { summarizeDay } from './lessonPlanCompletion.js';
import {
  buildSubmissionRows,
  SUBMISSION_TRACKING_STATUSES,
  type ExpectedSubmitter,
  type SubmissionTrackingPlan,
} from './lessonPlanSubmissionTracking.js';

export type AcademicReminderType = 'lesson_plan_reminder' | 'marks_entry_reminder';

export const LESSON_PLAN_DAYS = ['Saturday', 'Sunday', 'Monday', 'Tuesday', 'Wednesday'] as const;

export interface LessonPlanReminderPeriod {
  id?: string;
  plan_id?: string;
  day: string;
  period_number: number;
  topic?: string | null;
  subject?: string | null;
  is_free?: boolean | null;
}

export interface LessonPlanReminderPlan {
  id: string;
  teacher_id: string;
  teacher_name?: string | null;
  class_name: string;
  week_label: string;
  status: string;
  period_count: number;
  created_at: string;
  updated_at: string;
  ai_started_at?: string | null;
  periods?: LessonPlanReminderPeriod[] | null;
}

export type LessonPlanCompletionStatus = 'no_task' | 'not_started' | 'incomplete' | 'complete';

export interface LessonPlanOutstandingDetail {
  planId: string | null;
  className: string;
  status: string;
  missingPeriods: number;
  completionPercent: number | null;
}

export interface LessonPlanReminderProgress {
  teacherId: string;
  teacherName: string;
  assignedClasses: string[];
  submitted: boolean;
  submittedAt: string | null;
  reviewStatus: string | null;
  planCount: number;
  completionPercent: number;
  outstandingPlans: number;
  outstandingPeriods: number;
  outstandingDetails: LessonPlanOutstandingDetail[];
  completionStatus: LessonPlanCompletionStatus;
  eligible: boolean;
}

interface PlanCompletion {
  plan: LessonPlanReminderPlan;
  planned: number;
  completed: number;
  missing: number;
  percent: number;
}

function planCompletion(plan: LessonPlanReminderPlan): PlanCompletion {
  const periodCount = Math.max(1, Math.floor(Number(plan.period_count) || 1));
  const bySlot = new Map<string, LessonPlanReminderPeriod>();
  for (const period of plan.periods ?? []) {
    bySlot.set(`${period.day}-${period.period_number}`, period);
  }

  // Mirror PlanReadView: a missing row is a required period with no topic.
  const slots = LESSON_PLAN_DAYS.flatMap((day) => Array.from({ length: periodCount }, (_, index) => {
    const stored = bySlot.get(`${day}-${index + 1}`);
    return {
      is_free: stored?.is_free ?? false,
      subject: stored?.subject ?? null,
      topic: stored?.topic ?? '',
    };
  }));
  const summary = summarizeDay(slots, slots.length);
  return {
    plan,
    planned: summary.planned,
    completed: summary.completed,
    missing: Math.max(0, summary.planned - summary.completed),
    percent: summary.percent,
  };
}

function trackingPlan(plan: LessonPlanReminderPlan): SubmissionTrackingPlan {
  return {
    id: plan.id,
    teacher_id: plan.teacher_id,
    class_name: plan.class_name,
    week_label: plan.week_label,
    status: plan.status as SubmissionTrackingPlan['status'],
    ai_started_at: plan.ai_started_at ?? null,
    created_at: plan.created_at,
    updated_at: plan.updated_at,
    teacher_name: plan.teacher_name ?? null,
  };
}

/**
 * Derive the supervisor and teacher reminder view from one week's teacher
 * roster + plan rows. Submission state deliberately delegates to the existing
 * submission tracker; required-period completion delegates to summarizeDay().
 */
export function buildLessonPlanReminderProgress(
  submitters: ExpectedSubmitter[] | null | undefined,
  plans: LessonPlanReminderPlan[] | null | undefined,
): LessonPlanReminderProgress[] {
  const allPlans = plans ?? [];
  const submittedPlans = allPlans.filter((plan) =>
    (SUBMISSION_TRACKING_STATUSES as readonly string[]).includes(plan.status),
  );
  const trackerRows = buildSubmissionRows(
    submitters,
    submittedPlans.map(trackingPlan),
  );
  const trackerByTeacher = new Map(trackerRows.map((row) => [row.teacherId, row]));
  const submitterByTeacher = new Map((submitters ?? []).map((teacher) => [teacher.teacherId, teacher]));
  const teacherIds = new Set<string>([
    ...trackerRows.map((row) => row.teacherId),
    ...(submitters ?? []).map((teacher) => teacher.teacherId),
  ]);

  return [...teacherIds].map((teacherId) => {
    const tracker = trackerByTeacher.get(teacherId);
    const submitter = submitterByTeacher.get(teacherId);
    const teacherPlans = allPlans.filter((plan) => plan.teacher_id === teacherId);
    const completions = teacherPlans.map(planCompletion);
    const assignedClasses = tracker?.assignedClasses ?? submitter?.classes ?? [];
    // Assignment alone is not a reminder task. A missing lesson_plans row is
    // visible through submission tracking, but reminders require an actual
    // current-week plan whose status/content needs the teacher's attention.
    const incompletePlanDetails: LessonPlanOutstandingDetail[] = completions
      .filter(({ plan, missing }) =>
        plan.status === 'draft' || plan.status === 'revision_requested' || missing > 0,
      )
      .map(({ plan, missing, percent }) => ({
        planId: plan.id,
        className: plan.class_name,
        status: plan.status,
        missingPeriods: missing,
        completionPercent: percent,
      }));
    const outstandingDetails = incompletePlanDetails;
    const outstandingPlans = outstandingDetails.length;
    const outstandingPeriods = incompletePlanDetails.reduce((sum, detail) => sum + detail.missingPeriods, 0);
    const planned = completions.reduce((sum, completion) => sum + completion.planned, 0);
    const completed = completions.reduce((sum, completion) => sum + completion.completed, 0);
    const completionPercent = planned === 0
      ? (teacherPlans.length > 0 ? 100 : 0)
      : Math.round((completed / planned) * 10000) / 100;
    const eligible = outstandingPlans > 0;
    const completionStatus: LessonPlanCompletionStatus = teacherPlans.length === 0
      ? 'no_task'
      : eligible
        ? 'incomplete'
        : 'complete';
    const latest = teacherPlans.slice().sort((a, b) =>
      (b.ai_started_at || b.updated_at || b.created_at).localeCompare(a.ai_started_at || a.updated_at || a.created_at),
    )[0];

    return {
      teacherId,
      teacherName: tracker?.teacherName || submitter?.teacherName || latest?.teacher_name || 'Unknown teacher',
      assignedClasses,
      submitted: tracker?.submitted ?? false,
      submittedAt: tracker?.submittedAt ?? null,
      reviewStatus: latest?.status ?? null,
      planCount: teacherPlans.length,
      completionPercent,
      outstandingPlans,
      outstandingPeriods,
      outstandingDetails,
      completionStatus,
      eligible,
    };
  }).sort((a, b) => a.teacherName.localeCompare(b.teacherName) || a.teacherId.localeCompare(b.teacherId));
}
