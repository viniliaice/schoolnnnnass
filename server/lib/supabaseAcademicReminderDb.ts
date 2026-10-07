/** Supabase/PostgREST data adapter for the shared academic reminder engine. */

import type {
  AcademicReminderDataSource,
  AcademicTermRecord,
  AcademicYearRecord,
  LessonPlanReminderSnapshot,
  MarksMonitorQuery,
  ReminderSchedule,
  ReminderTeacherProfile,
} from './academicReminderEngine.js';
import { isSyntheticPushEndpoint } from './pushDiagnostics.js';
import { inFilter, SupabaseRest } from './supabaseRest.js';
import type { AcademicReminderType } from './notificationSender.js';

interface RawTeacherProfile {
  id: string;
  name?: string | null;
  role?: string | null;
  assignedClasses?: unknown;
}

interface RawLessonPlan {
  id: string;
  teacher_id: string;
  class_name: string;
  week_label: string;
  status: string;
  period_count: number;
  created_at: string;
  updated_at: string;
  ai_started_at?: string | null;
}

interface RawLessonPlanPeriod {
  id?: string;
  plan_id: string;
  day: string;
  period_number: number;
  topic?: string | null;
  subject?: string | null;
  is_free?: boolean | null;
}

function assignedClasses(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter((item): item is string => typeof item === 'string' && item.trim() !== '')
    .map((item) => item.trim()))];
}

function parseSchedule(row: any): ReminderSchedule {
  return {
    reminder_type: row.reminder_type,
    enabled: row.enabled === true,
    timezone: row.timezone || 'Africa/Mogadishu',
    days_of_week: Array.isArray(row.days_of_week) ? row.days_of_week.map(Number) : [],
    send_time: String(row.send_time ?? '15:00:00').slice(0, 5),
    exam_scope: row.exam_scope ?? 'monthly',
    updated_by: row.updated_by ?? null,
    updated_at: row.updated_at ?? null,
  };
}

export function createSupabaseAcademicReminderDataSource(
  serviceRest: SupabaseRest,
  authorizedRest?: SupabaseRest,
): AcademicReminderDataSource {
  let teacherRosterPromise: Promise<ReminderTeacherProfile[]> | null = null;

  const loadTeacherRoster = async (): Promise<ReminderTeacherProfile[]> => {
    if (teacherRosterPromise) return teacherRosterPromise;
    teacherRosterPromise = (async () => {
      const { data, error } = await serviceRest.select<RawTeacherProfile[]>(
        'profiles',
        'select=id,name,role,"assignedClasses"&role=eq.teacher&limit=2000',
      );
      if (error) throw new Error(`getTeacherRoster: ${error.message}`);
      return (data ?? [])
        .filter((teacher) => String(teacher.role ?? '').trim().toLowerCase() === 'teacher')
        .map((teacher) => ({
          id: teacher.id,
          name: teacher.name?.trim() || 'Unknown teacher',
          role: teacher.role,
          assignedClasses: assignedClasses(teacher.assignedClasses),
        }));
    })();
    return teacherRosterPromise;
  };

  return {
    async getCurrentAcademicYear() {
      const { data, error } = await serviceRest.select<AcademicYearRecord[]>(
        'academic_years',
        'select=id,name,startDate,endDate,isCurrent&isCurrent=eq.true&order=startDate.desc&limit=1',
      );
      if (error) throw new Error(`getCurrentAcademicYear: ${error.message}`);
      return data?.[0] ?? null;
    },

    async getCurrentTerm(academicYearId) {
      const { data, error } = await serviceRest.select<AcademicTermRecord[]>(
        'terms',
        `select=id,name,academicYearId,startDate,endDate,months,isCurrent&academicYearId=eq.${encodeURIComponent(academicYearId)}&isCurrent=eq.true&order=startDate.desc&limit=1`,
      );
      if (error) throw new Error(`getCurrentTerm: ${error.message}`);
      const term = data?.[0];
      if (!term) return null;
      return {
        ...term,
        months: Array.isArray(term.months) ? term.months : [],
      };
    },

    getTeacherRoster: loadTeacherRoster,

    async getLessonPlanSnapshot(weekLabel): Promise<LessonPlanReminderSnapshot> {
      const [roster, planResult] = await Promise.all([
        loadTeacherRoster(),
        serviceRest.select<RawLessonPlan[]>(
          'lesson_plans',
          `select=id,teacher_id,class_name,week_label,status,period_count,created_at,updated_at,ai_started_at&week_label=eq.${encodeURIComponent(weekLabel)}&order=created_at.desc&limit=5000`,
        ),
      ]);
      if (planResult.error) throw new Error(`getLessonPlanSnapshot plans: ${planResult.error.message}`);
      const teacherIds = new Set(roster.map((teacher) => teacher.id));
      const rawPlans = (planResult.data ?? []).filter((plan) => teacherIds.has(plan.teacher_id));
      const planIds = rawPlans.map((plan) => plan.id);
      let periods: RawLessonPlanPeriod[] = [];
      if (planIds.length > 0) {
        const { data, error } = await serviceRest.select<RawLessonPlanPeriod[]>(
          'lesson_plan_periods',
          `select=id,plan_id,day,period_number,topic,subject,is_free&plan_id=${encodeURIComponent(`in.${inFilter(planIds)}`)}&order=day.asc,period_number.asc&limit=30000`,
        );
        if (error) throw new Error(`getLessonPlanSnapshot periods: ${error.message}`);
        periods = data ?? [];
      }
      const periodsByPlan = new Map<string, RawLessonPlanPeriod[]>();
      for (const period of periods) {
        const group = periodsByPlan.get(period.plan_id) ?? [];
        group.push(period);
        periodsByPlan.set(period.plan_id, group);
      }
      const names = new Map(roster.map((teacher) => [teacher.id, teacher.name]));
      const plans = rawPlans.map((plan) => ({
        ...plan,
        teacher_name: names.get(plan.teacher_id) ?? null,
        periods: periodsByPlan.get(plan.id) ?? [],
      }));
      const submitters = roster.flatMap((teacher) =>
        (teacher.assignedClasses ?? []).map((className) => ({
          teacherId: teacher.id,
          teacherName: teacher.name,
          classes: [className],
        })),
      ).reduce((result, row) => {
        const existing = result.find((teacher) => teacher.teacherId === row.teacherId);
        if (existing) existing.classes.push(...row.classes);
        else result.push({ ...row, classes: [...row.classes] });
        return result;
      }, [] as Array<{ teacherId: string; teacherName: string; classes: string[] }>);
      return {
        submitters: submitters.map((teacher) => ({
          ...teacher,
          classes: [...new Set(teacher.classes)],
        })),
        plans,
      };
    },

    async getMarksMonitorRows(query: MarksMonitorQuery) {
      const rest = authorizedRest ?? serviceRest;
      const rpcName = authorizedRest
        ? 'monitor_marks_entries'
        : 'monitor_marks_entries_for_reminders';
      const { data, error } = await rest.rpc(rpcName, {
        p_academic_year_id: query.academicYearId,
        p_term_id: query.termId,
        p_exam_scope: query.examScope,
        p_month: query.month,
        p_teacher_id: query.teacherId ?? null,
        p_class_name: null,
        p_subject_id: null,
      });
      if (error) throw new Error(`getMarksMonitorRows: ${error.message}`);
      return data;
    },

    async getSchedules() {
      const { data, error } = await serviceRest.select<any[]>(
        'academic_reminder_schedules',
        'select=reminder_type,enabled,timezone,days_of_week,send_time,exam_scope,updated_by,updated_at&order=reminder_type.asc',
      );
      if (error) throw new Error(`getSchedules: ${error.message}`);
      return (data ?? []).map(parseSchedule);
    },

    async updateSchedule(reminderType, patch, updatedBy) {
      const { error } = await serviceRest.update(
        'academic_reminder_schedules',
        `reminder_type=eq.${encodeURIComponent(reminderType)}`,
        { ...patch, updated_by: updatedBy, updated_at: new Date().toISOString() },
      );
      if (error) throw new Error(`updateSchedule: ${error.message}`);
      const { data, error: readError } = await serviceRest.select<any[]>(
        'academic_reminder_schedules',
        `select=reminder_type,enabled,timezone,days_of_week,send_time,exam_scope,updated_by,updated_at&reminder_type=eq.${encodeURIComponent(reminderType)}&limit=1`,
      );
      if (readError) throw new Error(`updateSchedule reload: ${readError.message}`);
      if (!data?.[0]) throw new Error('Reminder schedule does not exist.');
      return parseSchedule(data[0]);
    },
  };
}

export interface ReminderDeliveryHistoryRow {
  id: string;
  user_id: string;
  reminder_type: AcademicReminderType | null;
  academic_period: string | null;
  relevant_entity: string | null;
  reminder_occurrence: string | null;
  status: string;
  delivered_devices: number;
  failed_devices: number;
  expired_devices: number;
  last_error: string | null;
  created_at: string;
  notifications?: { title?: string | null; body?: string | null; url?: string | null } | null;
}

/** One batched history lookup; callers select the newest matching period in memory. */
export async function getReminderDeliveryHistory(
  rest: SupabaseRest,
  userIds: string[],
): Promise<ReminderDeliveryHistoryRow[]> {
  if (userIds.length === 0) return [];
  const { data, error } = await rest.select<ReminderDeliveryHistoryRow[]>(
    'notification_recipients',
    `select=id,user_id,reminder_type,academic_period,relevant_entity,reminder_occurrence,status,delivered_devices,failed_devices,expired_devices,last_error,created_at,notifications(title,body,url)&user_id=${encodeURIComponent(`in.${inFilter(userIds)}`)}&reminder_type=in.(${encodeURIComponent('"lesson_plan_reminder","marks_entry_reminder"')})&order=created_at.desc&limit=10000`,
  );
  if (error) throw new Error(`getReminderDeliveryHistory: ${error.message}`);
  return data ?? [];
}

export interface TeacherSubscriptionSummary {
  activeSubscriptions: number;
  realActiveSubscriptions: number;
  hasRealDevice: boolean;
}

/** Counts only; endpoint and key material never leave the server. */
export async function getTeacherSubscriptionSummaries(
  rest: SupabaseRest,
  userIds: string[],
): Promise<Map<string, TeacherSubscriptionSummary>> {
  const result = new Map<string, TeacherSubscriptionSummary>();
  for (const userId of userIds) result.set(userId, { activeSubscriptions: 0, realActiveSubscriptions: 0, hasRealDevice: false });
  if (userIds.length === 0) return result;
  const { data, error } = await rest.select<Array<{ user_id: string; endpoint: string; is_active: boolean }>>(
    'push_subscriptions',
    `select=user_id,endpoint,is_active&user_id=${encodeURIComponent(`in.${inFilter(userIds)}`)}&is_active=is.true&limit=10000`,
  );
  if (error) throw new Error(`getTeacherSubscriptionSummaries: ${error.message}`);
  for (const row of data ?? []) {
    const summary = result.get(row.user_id) ?? { activeSubscriptions: 0, realActiveSubscriptions: 0, hasRealDevice: false };
    summary.activeSubscriptions += 1;
    if (!isSyntheticPushEndpoint(row.endpoint)) {
      summary.realActiveSubscriptions += 1;
      summary.hasRealDevice = true;
    }
    result.set(row.user_id, summary);
  }
  return result;
}

export interface StaffProfileScope {
  id: string;
  role: string;
  assignedClasses: string[];
}

export async function getStaffProfileScope(rest: SupabaseRest, profileId: string): Promise<StaffProfileScope | null> {
  const { data, error } = await rest.select<any[]>(
    'profiles',
    `select=id,role,"assignedClasses"&id=eq.${encodeURIComponent(profileId)}&limit=1`,
  );
  if (error) throw new Error(`getStaffProfileScope: ${error.message}`);
  const row = data?.[0];
  if (!row) return null;
  return { id: row.id, role: row.role, assignedClasses: assignedClasses(row.assignedClasses) };
}

export function isReminderType(value: unknown): value is AcademicReminderType {
  return value === 'lesson_plan_reminder' || value === 'marks_entry_reminder';
}
