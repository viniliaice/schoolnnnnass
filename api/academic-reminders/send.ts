/** POST /api/academic-reminders/send — admin/supervisor only manual send. */

import { MARKS_EXAM_SCOPES, type MarksExamScope } from '../../src/lib/marksEntryTracking.js';
import {
  DEFAULT_SCHOOL_TIMEZONE,
  manualReminderOccurrence,
  loadAcademicPeriodContext,
  runAcademicReminder,
  ReminderScopeError,
} from '../../server/lib/academicReminderEngine.js';
import {
  authenticateServerProfile,
  isAdminOrSupervisor,
  parseJsonBody,
  resolveAcademicReminderVapid,
  safeInternalError,
} from '../../server/lib/academicReminderHttp.js';
import { createSupabaseNotificationDb } from '../../server/lib/supabaseNotificationDb.js';
import {
  createSupabaseAcademicReminderDataSource,
  getStaffProfileScope,
  isReminderType,
} from '../../server/lib/supabaseAcademicReminderDb.js';
import { validateVapidConfig } from '../../server/lib/webpush.js';

export default async function handler(req: any, res: any) {
  try {
    if (req.method !== 'POST') {
      res.setHeader('Allow', 'POST');
      return res.status(405).json({ error: 'Method Not Allowed' });
    }
    const auth = await authenticateServerProfile(req);
    if (!auth.ok) return res.status(auth.status).json({ error: auth.message });
    const { profileId, role, callerRest, serviceRest } = auth.profile;
    if (!isAdminOrSupervisor(role)) {
      return res.status(403).json({ error: 'Only administrators or supervisors may send academic reminders.' });
    }

    const body = parseJsonBody(req.body);
    if (!body) return res.status(400).json({ error: 'Request body must be a JSON object.' });
    if (!isReminderType(body.reminderType)) {
      return res.status(400).json({ error: 'reminderType must be lesson_plan_reminder or marks_entry_reminder.' });
    }
    const requestedIds = Array.isArray(body.teacherIds)
      ? [...new Set(body.teacherIds.filter((value): value is string => typeof value === 'string' && value.trim().length > 0).map((value) => value.trim()))]
      : [];
    if (requestedIds.length === 0 || requestedIds.length > 500) {
      return res.status(400).json({ error: 'Select between 1 and 500 teachers.' });
    }
    if (typeof body.requestId !== 'string' || body.requestId.trim().length < 8 || body.requestId.trim().length > 120) {
      return res.status(400).json({ error: 'requestId must be 8–120 characters for safe manual-send idempotency.' });
    }

    const source = createSupabaseAcademicReminderDataSource(serviceRest, callerRest);
    const schedules = await source.getSchedules();
    const schedule = schedules.find((item) => item.reminder_type === body.reminderType);
    const timezone = schedule?.timezone || DEFAULT_SCHOOL_TIMEZONE;
    const scopeValue = body.examScope ?? schedule?.exam_scope ?? 'monthly';
    if (body.reminderType === 'marks_entry_reminder'
      && !(MARKS_EXAM_SCOPES as readonly unknown[]).includes(scopeValue)) {
      return res.status(400).json({ error: 'Unsupported marks entry scope.' });
    }
    const examScope = body.reminderType === 'marks_entry_reminder'
      ? scopeValue as MarksExamScope
      : undefined;

    let allowedClasses: string[] | null = null;
    if (role === 'supervisor') {
      const scope = await getStaffProfileScope(serviceRest, profileId);
      if (!scope || scope.role !== 'supervisor') return res.status(403).json({ error: 'Supervisor profile could not be verified.' });
      allowedClasses = scope.assignedClasses;
    }

    const vapid = resolveAcademicReminderVapid();
    const vapidCheck = validateVapidConfig(vapid);
    if (!vapidCheck.ok) {
      return res.status(500).json({
        error: 'Push notifications are not correctly configured. Inspect /api/push/health.',
        code: 'VAPID_CONFIG_INVALID',
        problems: vapidCheck.problems,
      });
    }

    const context = await loadAcademicPeriodContext(source, timezone);
    const reminderOccurrence = manualReminderOccurrence(body.reminderType, body.requestId);
    const result = await runAcademicReminder({
      source,
      notificationDb: createSupabaseNotificationDb(serviceRest),
      vapid,
      reminderType: body.reminderType,
      senderId: profileId,
      reminderOccurrence,
      context,
      timezone,
      examScope,
      teacherIds: requestedIds,
      allowedClasses,
    });

    const summary = result.summary;
    console.info('[academic-reminders/send] result', {
      reminderType: result.reminderType,
      period: result.academicPeriod,
      occurrence: result.reminderOccurrence,
      selected: result.selectedTeacherIds.length,
      eligible: result.eligibleTeacherIds.length,
      sent: summary?.sent ?? 0,
      failed: summary?.failed ?? 0,
      noSubscription: summary?.noSubscription ?? 0,
      alreadyReminded: summary?.alreadyReminded ?? 0,
      deliveryOk: summary?.deliveryOk ?? false,
    });

    res.setHeader('Cache-Control', 'no-store');
    return res.status(200).json({
      ...result,
      eligibleTasks: result.tasks.filter((task) => task.eligible),
      completedCount: result.alreadyCompleteTeacherIds.length,
      noTaskCount: result.noTaskTeacherIds.length,
      deliveryOk: summary?.deliveryOk ?? false,
      message: !summary
        ? 'No selected teacher currently has outstanding work for this reminder type.'
        : summary.alreadyReminded > 0 && summary.sent === 0
          ? 'This reminder event was already claimed; no duplicate push was sent.'
          : summary.deliveryOk
            ? 'All selected eligible teachers accepted the push on every active real device.'
            : summary.devicesDelivered > 0
              ? 'Partial delivery: see recipient and device outcomes.'
              : 'No push was accepted by a teacher device; review the recipient outcomes.',
    });
  } catch (err) {
    if (err instanceof ReminderScopeError) return res.status(403).json({ error: err.message });
    const detail = safeInternalError(err);
    console.error('[academic-reminders/send] failed:', detail || 'unknown error');
    return res.status(502).json({
      error: 'Academic reminder delivery could not be completed. Check server logs for the sanitized failure detail.',
      code: 'REMINDER_SEND_FAILED',
    });
  }
}
