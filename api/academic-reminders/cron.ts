/** Vercel Cron entrypoint; CRON_SECRET bearer auth is mandatory. */

import {
  getMarksEntryReminderStage,
  isLessonPlanDailyCronDue,
  loadAcademicPeriodContext,
  loadPreviousMonthAcademicPeriodContext,
  runAcademicReminder,
  scheduledReminderOccurrence,
} from '../../server/lib/academicReminderEngine.js';
import {
  cronAuthorizationMatches,
  readServerSupabaseServiceConfig,
  resolveAcademicReminderVapid,
  safeInternalError,
} from '../../server/lib/academicReminderHttp.js';
import { createSupabaseNotificationDb } from '../../server/lib/supabaseNotificationDb.js';
import { createSupabaseAcademicReminderDataSource } from '../../server/lib/supabaseAcademicReminderDb.js';
import { SupabaseRest } from '../../server/lib/supabaseRest.js';
import { validateVapidConfig } from '../../server/lib/webpush.js';

export default async function handler(req: any, res: any) {
  try {
    if (req.method !== 'GET') {
      res.setHeader('Allow', 'GET');
      return res.status(405).json({ error: 'Method Not Allowed' });
    }
    if (!cronAuthorizationMatches(req)) {
      return res.status(401).json({ error: 'Unauthorized cron request.' });
    }
    const config = readServerSupabaseServiceConfig();
    if (!config) return res.status(500).json({ error: 'Supabase server environment is incomplete.' });

    const now = new Date();
    const serviceRest = new SupabaseRest(config.url, config.serviceKey, config.serviceKey);
    const source = createSupabaseAcademicReminderDataSource(serviceRest);
    const schedules = await source.getSchedules();
    const due: Array<{ schedule: (typeof schedules)[number]; stage: 'reminder' | 'penalty' }> = [];
    const results: Array<Record<string, unknown>> = [];
    const failures: string[] = [];
    for (const schedule of schedules) {
      try {
        if (schedule.reminder_type === 'lesson_plan_reminder') {
          if (isLessonPlanDailyCronDue(schedule, now)) due.push({ schedule, stage: 'reminder' });
        } else {
          const stage = getMarksEntryReminderStage(schedule, now);
          if (stage) due.push({ schedule, stage });
        }
      } catch (err) {
        const detail = safeInternalError(err) || 'invalid schedule';
        console.error(`[academic-reminders/cron] ${schedule.reminder_type} schedule invalid:`, detail);
        failures.push(schedule.reminder_type);
        results.push({ reminderType: schedule.reminder_type, error: 'Reminder schedule is invalid.' });
      }
    }
    if (due.length === 0) {
      res.setHeader('Cache-Control', 'no-store');
      if (failures.length > 0) return res.status(502).json({ ok: false, due: [], results, failures });
      return res.status(200).json({ ok: true, due: [], results: [], checkedAt: now.toISOString() });
    }

    const vapid = resolveAcademicReminderVapid();
    const vapidCheck = validateVapidConfig(vapid);
    if (!vapidCheck.ok) {
      console.error('[academic-reminders/cron] VAPID config invalid:', vapidCheck.problems);
      return res.status(500).json({ error: 'Push configuration is invalid. Inspect /api/push/health.', code: 'VAPID_CONFIG_INVALID' });
    }

    const notificationDb = createSupabaseNotificationDb(serviceRest);
    for (const dueReminder of due) {
      const { schedule, stage } = dueReminder;
      try {
        const context = schedule.reminder_type === 'marks_entry_reminder'
          ? await loadPreviousMonthAcademicPeriodContext(source, schedule.timezone, now)
          : await loadAcademicPeriodContext(source, schedule.timezone, now);
        const result = await runAcademicReminder({
          source,
          notificationDb,
          vapid,
          reminderType: schedule.reminder_type,
          reminderStage: stage,
          senderId: null,
          reminderOccurrence: scheduledReminderOccurrence(schedule, now, stage),
          now,
          timezone: schedule.timezone,
          context,
          examScope: schedule.reminder_type === 'marks_entry_reminder' ? 'monthly' : schedule.exam_scope,
        });
        results.push({
          reminderType: result.reminderType,
          reminderStage: result.reminderStage,
          academicPeriod: result.academicPeriod,
          reminderOccurrence: result.reminderOccurrence,
          eligible: result.eligibleTeacherIds.length,
          sent: result.summary?.sent ?? 0,
          failed: result.summary?.failed ?? 0,
          noSubscription: result.summary?.noSubscription ?? 0,
          skipped: result.summary?.skipped ?? 0,
          alreadyReminded: result.summary?.alreadyReminded ?? 0,
          deliveryOk: result.summary?.deliveryOk ?? false,
          summary: result.summary,
        });
      } catch (err) {
        const detail = safeInternalError(err) || 'unknown error';
        console.error(`[academic-reminders/cron] ${schedule.reminder_type} failed:`, detail);
        failures.push(schedule.reminder_type);
        results.push({ reminderType: schedule.reminder_type, error: 'Reminder execution failed.' });
      }
    }

    res.setHeader('Cache-Control', 'no-store');
    if (failures.length > 0) {
      return res.status(502).json({ ok: false, due: due.map((item) => item.schedule.reminder_type), results, failures });
    }
    return res.status(200).json({ ok: true, due: due.map((item) => item.schedule.reminder_type), results, checkedAt: now.toISOString() });
  } catch (err) {
    console.error('[academic-reminders/cron] failed:', safeInternalError(err) || 'unknown error');
    return res.status(500).json({ error: 'Scheduled academic reminders could not be run.' });
  }
}
