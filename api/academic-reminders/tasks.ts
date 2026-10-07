/**
 * GET /api/academic-reminders/tasks
 * Teacher: own tasks only. Admin/supervisor: authorized teacher task/status overview.
 */

import {
  ACADEMIC_REMINDER_TYPES,
  DEFAULT_SCHOOL_TIMEZONE,
  evaluateAcademicReminderTasks,
  loadAcademicPeriodContext,
} from '../../server/lib/academicReminderEngine.js';
import {
  authenticateServerProfile,
  isAdminOrSupervisor,
  safeInternalError,
} from '../../server/lib/academicReminderHttp.js';
import {
  createSupabaseAcademicReminderDataSource,
  getReminderDeliveryHistory,
  getStaffProfileScope,
  getTeacherSubscriptionSummaries,
} from '../../server/lib/supabaseAcademicReminderDb.js';
import { sanitizePushResponseText } from '../../server/lib/webpush.js';

export default async function handler(req: any, res: any) {
  try {
    if (req.method !== 'GET') {
      res.setHeader('Allow', 'GET');
      return res.status(405).json({ error: 'Method Not Allowed' });
    }
    const auth = await authenticateServerProfile(req);
    if (!auth.ok) return res.status(auth.status).json({ error: auth.message });
    const { profileId, role, callerRest, serviceRest } = auth.profile;
    if (role !== 'teacher' && !isAdminOrSupervisor(role)) {
      return res.status(403).json({ error: 'Academic reminder tasks are available to teachers and school staff only.' });
    }

    const source = createSupabaseAcademicReminderDataSource(
      serviceRest,
      isAdminOrSupervisor(role) ? callerRest : undefined,
    );
    let allowedClasses: string[] | null = null;
    if (role === 'supervisor') {
      const scope = await getStaffProfileScope(serviceRest, profileId);
      if (!scope || scope.role !== 'supervisor') return res.status(403).json({ error: 'Supervisor profile could not be verified.' });
      allowedClasses = scope.assignedClasses;
    }

    const schedules = await source.getSchedules();
    const scheduleByType = new Map(schedules.map((schedule) => [schedule.reminder_type, schedule]));
    const contextByTimezone = new Map<string, Awaited<ReturnType<typeof loadAcademicPeriodContext>>>();
    const snapshots = new Map<string, any>();
    const teacherId = role === 'teacher' ? profileId : undefined;

    for (const reminderType of ACADEMIC_REMINDER_TYPES) {
      const schedule = scheduleByType.get(reminderType);
      const timezone = schedule?.timezone || DEFAULT_SCHOOL_TIMEZONE;
      try {
        let context = contextByTimezone.get(timezone);
        if (!context) {
          context = await loadAcademicPeriodContext(source, timezone);
          contextByTimezone.set(timezone, context);
        }
        snapshots.set(reminderType, await evaluateAcademicReminderTasks({
          source,
          context,
          reminderType,
          timezone,
          examScope: schedule?.exam_scope ?? 'monthly',
          teacherId,
          allowedClasses,
        }));
      } catch (err) {
        snapshots.set(reminderType, { error: safeInternalError(err) || 'Could not calculate reminder tasks.' });
      }
    }

    const allTasks = [...snapshots.values()]
      .flatMap((snapshot) => Array.isArray(snapshot?.tasks) ? snapshot.tasks : []);
    const userIds = [...new Set(allTasks.map((task) => task.teacherId))];
    const [history, subscriptions] = await Promise.all([
      getReminderDeliveryHistory(serviceRest, userIds),
      isAdminOrSupervisor(role)
        ? getTeacherSubscriptionSummaries(serviceRest, userIds)
        : Promise.resolve(new Map()),
    ]);

    const latestByTypePeriodTeacher = new Map<string, (typeof history)[number]>();
    for (const row of history) {
      if (!row.reminder_type || !row.academic_period) continue;
      const key = `${row.reminder_type}\u0000${row.academic_period}\u0000${row.user_id}`;
      if (!latestByTypePeriodTeacher.has(key)) latestByTypePeriodTeacher.set(key, row);
    }

    const enrich = (task: any) => {
      const key = `${task.reminderType}\u0000${task.academicPeriod}\u0000${task.teacherId}`;
      const last = latestByTypePeriodTeacher.get(key);
      const subscription = subscriptions.get(task.teacherId);
      return {
        ...task,
        lastReminder: last ? {
          status: last.status,
          attemptedAt: last.created_at,
          deliveredDevices: Number(last.delivered_devices) || 0,
          failedDevices: Number(last.failed_devices) || 0,
          expiredDevices: Number(last.expired_devices) || 0,
          lastError: last.last_error ? sanitizePushResponseText(last.last_error, 200) : null,
          occurrence: last.reminder_occurrence,
          title: last.notifications?.title ?? null,
        } : null,
        ...(isAdminOrSupervisor(role) ? {
          subscription: subscription ?? { activeSubscriptions: 0, realActiveSubscriptions: 0, hasRealDevice: false },
        } : {}),
      };
    };

    const result: Record<string, unknown> = {
      ...(isAdminOrSupervisor(role) ? { timezone: DEFAULT_SCHOOL_TIMEZONE } : {}),
      schedules: isAdminOrSupervisor(role) ? schedules.map((schedule) => ({
        reminderType: schedule.reminder_type,
        enabled: schedule.enabled,
        timezone: schedule.timezone,
        daysOfWeek: schedule.days_of_week,
        sendTime: schedule.send_time,
        examScope: schedule.exam_scope,
      })) : [],
    };
    for (const reminderType of ACADEMIC_REMINDER_TYPES) {
      const snapshot = snapshots.get(reminderType);
      result[reminderType] = snapshot?.error
        ? { error: snapshot.error, tasks: [] }
        : {
          academicPeriod: snapshot.academicPeriod,
          periodLabel: snapshot.periodLabel,
          tasks: (snapshot.tasks ?? []).map(enrich),
        };
    }

    res.setHeader('Cache-Control', 'no-store');
    return res.status(200).json(result);
  } catch (err) {
    console.error('[academic-reminders/tasks] failed:', safeInternalError(err) || 'unknown error');
    return res.status(500).json({ error: 'Academic reminder tasks could not be loaded.' });
  }
}
