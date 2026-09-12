/**
 * Database access for the supervisor's Lesson Plan Submission page.
 *
 * Two focused queries back the page — never the whole plan history:
 *   1. the roster of teachers expected to submit (see the
 *      list_lesson_plan_submitters RPC), and
 *   2. the selected week's plans only (status + week_label filtering happen
 *      in the database, served by idx_lesson_plans_status_week_label).
 */

import { supabase } from '../supabase';
import {
  SUBMISSION_TRACKING_STATUSES,
  type ExpectedSubmitter,
  type SubmissionTrackingPlan,
} from '../lessonPlanSubmissionTracking';

function toClasses(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is string => typeof entry === 'string' && entry.trim() !== '');
}

/** Group one-row-per-class RPC rows (or profile rows) into submitters. */
function groupSubmitters(rows: Array<{ teacherId: string; teacherName: string; className: string }>): ExpectedSubmitter[] {
  const byTeacher = new Map<string, ExpectedSubmitter>();
  for (const row of rows) {
    if (!row.teacherId) continue;
    const existing = byTeacher.get(row.teacherId);
    if (existing) {
      if (row.className && !existing.classes.includes(row.className)) existing.classes.push(row.className);
      continue;
    }
    byTeacher.set(row.teacherId, {
      teacherId: row.teacherId,
      teacherName: row.teacherName || 'Unknown teacher',
      classes: row.className ? [row.className] : [],
    });
  }
  return [...byTeacher.values()];
}

/**
 * Every teacher who is expected to submit lesson plans: role 'teacher' with
 * at least one assigned class — the same contract the teacher's own planner
 * uses, so a teacher this list omits genuinely cannot submit (and must not
 * be flagged "Not Submitted").
 *
 * Primary source is the list_lesson_plan_submitters RPC
 * (20260915_lesson_plan_submission_tracking.sql): profiles is
 * SELECT-restricted under RLS (own profile + admin), so a supervisor cannot
 * read the roster with a direct query. Until that migration is applied, fall
 * back to a direct profiles read — which works wherever the caller's RLS
 * allows it (admin always; supervisors on permissive deployments) — the same
 * RPC-then-fallback shape fetchSupervisorPlanWeeks uses.
 */
export async function fetchLessonPlanSubmitters(): Promise<ExpectedSubmitter[]> {
  const { data: rpcRows, error: rpcError } = await supabase.rpc('list_lesson_plan_submitters');
  if (!rpcError && Array.isArray(rpcRows)) {
    return groupSubmitters(
      (rpcRows as Array<{ teacher_id: string; teacher_name: string | null; class_name: string | null }>).map((row) => ({
        teacherId: row.teacher_id,
        teacherName: row.teacher_name ?? '',
        className: row.class_name ?? '',
      }))
    );
  }

  const { data: profiles, error: profileError } = await supabase
    .from('profiles')
    .select('id, name, role, assignedClasses')
    .ilike('role', 'teacher');
  if (profileError) throw profileError;

  // Mirror getUsersByRole's defensive normalisation: legacy rows can carry
  // padded or oddly-cased roles that ilike matched loosely.
  const teachers = ((profiles ?? []) as Array<{ id: string; name: string | null; role: string | null; assignedClasses: unknown }>)
    .filter((profile) => String(profile.role ?? '').toLowerCase().trim() === 'teacher');

  return groupSubmitters(
    teachers.flatMap((profile) =>
      toClasses(profile.assignedClasses).map((className) => ({
        teacherId: profile.id,
        teacherName: profile.name ?? '',
        className,
      }))
    )
  );
}

/**
 * The plans stored under the selected week — every status a submission can
 * be in (drafts excluded; revision_requested included because the teacher
 * did hand the plan in). Only the columns the submission page renders leave
 * the database.
 *
 * No stuck-AI sweep here on purpose: a plan waiting on its AI review counts
 * as submitted either way, so the tracker never needs that write.
 */
export async function fetchSubmissionTrackingPlans(weekLabels: string[]): Promise<SubmissionTrackingPlan[]> {
  if (!weekLabels?.length) return [];
  const { data, error } = await supabase
    .from('lesson_plans')
    .select(
      'id, teacher_id, class_name, week_label, status, ai_started_at, created_at, updated_at,'
        + ' profiles!lesson_plans_teacher_id_fkey(name)'
    )
    .in('status', SUBMISSION_TRACKING_STATUSES)
    .in('week_label', weekLabels)
    .order('created_at', { ascending: false });
  if (error) throw error;
  // The generic (non-codegen) client cannot type the embedded profile join;
  // read it the same way fetchPlansBySupervisorForWeek does.
  return ((data ?? []) as any[]).map((row) => {
    const embedded = Array.isArray(row?.profiles) ? row.profiles[0] : row?.profiles;
    const plan: SubmissionTrackingPlan = {
      id: row.id,
      teacher_id: row.teacher_id,
      class_name: row.class_name,
      week_label: row.week_label,
      status: row.status,
      ai_started_at: row.ai_started_at ?? null,
      created_at: row.created_at,
      updated_at: row.updated_at,
      teacher_name: embedded?.name ?? null,
    };
    return plan;
  });
}
