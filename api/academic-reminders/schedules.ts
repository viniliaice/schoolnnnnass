/** GET/PUT /api/academic-reminders/schedules — staff-only schedule controls. */

import { MARKS_EXAM_SCOPES, type MarksExamScope } from '../../src/lib/marksEntryTracking.js';
import { authenticateServerProfile, isAdminOrSupervisor, parseJsonBody, safeInternalError } from '../../server/lib/academicReminderHttp.js';
import { createSupabaseAcademicReminderDataSource, isReminderType } from '../../server/lib/supabaseAcademicReminderDb.js';

function validTimezone(value: unknown): value is string {
  if (typeof value !== 'string' || !value.trim() || value.length > 80) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value }).format(new Date());
    return true;
  } catch {
    return false;
  }
}

function validSendTime(value: unknown): value is string {
  if (typeof value !== 'string' || !/^([01]\d|2[0-3]):[0-5]\d$/.test(value)) return false;
  return true;
}

function validDays(value: unknown): value is number[] {
  return Array.isArray(value)
    && value.length >= 1
    && value.length <= 7
    && value.every((day) => Number.isInteger(day) && day >= 0 && day <= 6)
    && new Set(value).size === value.length;
}

export default async function handler(req: any, res: any) {
  try {
    if (req.method !== 'GET' && req.method !== 'PUT') {
      res.setHeader('Allow', 'GET, PUT');
      return res.status(405).json({ error: 'Method Not Allowed' });
    }
    const auth = await authenticateServerProfile(req);
    if (!auth.ok) return res.status(auth.status).json({ error: auth.message });
    if (!isAdminOrSupervisor(auth.profile.role)) {
      return res.status(403).json({ error: 'Only administrators or supervisors may inspect or edit reminder schedules.' });
    }

    const source = createSupabaseAcademicReminderDataSource(auth.profile.serviceRest);
    if (req.method === 'GET') {
      const schedules = await source.getSchedules();
      res.setHeader('Cache-Control', 'no-store');
      return res.status(200).json({ schedules });
    }

    const body = parseJsonBody(req.body);
    if (!body) return res.status(400).json({ error: 'Request body must be a JSON object.' });
    if (!isReminderType(body.reminderType)) return res.status(400).json({ error: 'Unknown reminder type.' });
    if (typeof body.enabled !== 'boolean') return res.status(400).json({ error: 'enabled must be boolean.' });
    if (!validTimezone(body.timezone)) return res.status(400).json({ error: 'timezone must be a valid IANA timezone.' });
    if (!validDays(body.daysOfWeek)) return res.status(400).json({ error: 'daysOfWeek must contain unique weekday numbers from 0 to 6.' });
    if (!validSendTime(body.sendTime)) return res.status(400).json({ error: 'sendTime must use HH:mm (24-hour time).' });

    const existing = (await source.getSchedules()).find((item) => item.reminder_type === body.reminderType);
    if (!existing) return res.status(404).json({ error: 'Reminder schedule has not been configured in the database.' });
    const scope = body.reminderType === 'marks_entry_reminder'
      ? body.examScope ?? existing.exam_scope
      : existing.exam_scope;
    if (!(MARKS_EXAM_SCOPES as readonly unknown[]).includes(scope)) {
      return res.status(400).json({ error: 'Unsupported marks entry scope.' });
    }

    const schedule = await source.updateSchedule(body.reminderType, {
      enabled: body.enabled,
      timezone: body.timezone,
      days_of_week: body.daysOfWeek,
      send_time: body.sendTime,
      exam_scope: scope as MarksExamScope,
    }, auth.profile.profileId);
    res.setHeader('Cache-Control', 'no-store');
    return res.status(200).json({ schedule });
  } catch (err) {
    console.error('[academic-reminders/schedules] failed:', safeInternalError(err) || 'unknown error');
    return res.status(500).json({ error: 'Reminder schedules could not be loaded or saved.' });
  }
}
