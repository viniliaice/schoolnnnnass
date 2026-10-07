/**
 * Server-side fan-out for teacher push notifications.
 *
 * Pure orchestration: all I/O is injected (db + push transport) so the same
 * code that runs in the Vercel function is executed by the test-suite against
 * an in-memory database and a local fake push service. Authorization of the
 * caller happens in api/notifications/send.ts before this runs; this module
 * trusts `senderId`.
 */

import { isSyntheticPushEndpoint } from './pushDiagnostics.js';
import {
  describePushFailure,
  sanitizePushResponseText,
  sendWebPush,
  validateVapidConfig,
  type PushFailureCode,
  type VapidConfig,
  type VapidConfigCheck,
  type WebPushResult,
} from './webpush.js';

export type NotificationCategory =
  | 'announcement'
  | 'message'
  | 'lesson_plan'
  | 'lesson_plan_reminder'
  | 'marks_entry_reminder'
  | 'attendance'
  | 'admin_alert'
  | 'general';

export type AcademicReminderType = 'lesson_plan_reminder' | 'marks_entry_reminder';
export type AcademicReminderStage = 'reminder' | 'penalty';

export interface ReminderRecipientMetadata {
  deduplicationKey: string;
  academicPeriod: string;
  relevantEntity: string;
  reminderOccurrence: string;
}

export interface ReminderSendMetadata {
  reminderType: AcademicReminderType;
  reminderStage?: AcademicReminderStage;
  academicPeriod: string;
  reminderOccurrence: string;
  entries: Record<string, ReminderRecipientMetadata>;
  /** Selected teachers whose current task is already complete; never pushed. */
  taskAlreadyCompletedTeacherIds?: string[];
}

export const NOTIFICATION_CATEGORIES: NotificationCategory[] = [
  'announcement',
  'message',
  'lesson_plan',
  'lesson_plan_reminder',
  'marks_entry_reminder',
  'attendance',
  'admin_alert',
  'general',
];

export interface SendNotificationRequest {
  audience: 'all_teachers' | 'class_group' | 'teachers';
  /** Required when audience === 'class_group'. */
  className?: string;
  /** Required (non-empty) when audience === 'teachers'. */
  teacherIds?: string[];
  title: string;
  body: string;
  category: NotificationCategory;
  /** In-app destination opened when the teacher taps the notification. */
  url?: string;
  /** Internal metadata only; browser send APIs cannot choose eligibility or keys. */
  reminder?: ReminderSendMetadata;
}

export interface TeacherProfile {
  id: string;
  name: string;
  assignedClasses?: string[] | null;
}

export interface PushSubRow {
  id: string;
  user_id: string;
  endpoint: string;
  p256dh: string;
  auth: string;
  is_active: boolean;
  device_type?: string | null;
  browser?: string | null;
  created_at?: string | null;
}

export interface PreferenceRow {
  user_id: string;
  push_enabled: boolean;
  announcements: boolean;
  messages: boolean;
  lesson_plan_reminders: boolean;
  /** Missing on older deployments means enabled, like the other default-on preferences. */
  marks_entry_reminders?: boolean;
  admin_alerts: boolean;
}

export type RecipientStatus =
  | 'pending'
  | 'sent'
  | 'failed'
  | 'no_devices'
  | 'skipped'
  | 'no_subscription'
  | 'expired'
  | 'already_reminded'
  | 'task_already_completed';

export interface ReminderRecipientInsert {
  id: string;
  notification_id: string;
  user_id: string;
  status: RecipientStatus;
  reminder_type?: AcademicReminderType;
  academic_period?: string;
  relevant_entity?: string;
  reminder_stage?: AcademicReminderStage | null;
  reminder_occurrence?: string;
  deduplication_key?: string | null;
}

export interface NotificationDb {
  listTeachers(filter: { audience: SendNotificationRequest['audience']; className?: string; teacherIds?: string[] }): Promise<TeacherProfile[]>;
  getActiveSubscriptions(userIds: string[]): Promise<PushSubRow[]>;
  getPreferences(userIds: string[]): Promise<PreferenceRow[]>;
  insertNotification(row: { id: string; title: string; body: string; url: string | null; category: string; sender_id: string | null }): Promise<void>;
  insertRecipients(rows: ReminderRecipientInsert[]): Promise<void>;
  /** Atomic database uniqueness claim; returns only recipient rows inserted for this event. */
  claimReminderRecipients?(rows: ReminderRecipientInsert[]): Promise<Array<Pick<ReminderRecipientInsert, 'id' | 'user_id' | 'deduplication_key'>>>;
  updateRecipient(notificationId: string, userId: string, patch: {
    status: RecipientStatus;
    delivered_devices?: number;
    failed_devices?: number;
    expired_devices?: number;
    last_error?: string | null;
  }): Promise<void>;
  deactivateSubscription(endpoint: string): Promise<void>;
  deleteNotification?(notificationId: string): Promise<void>;
}

export const DEFAULT_PREFERENCES: Omit<PreferenceRow, 'user_id'> = {
  push_enabled: true,
  announcements: true,
  messages: true,
  lesson_plan_reminders: true,
  marks_entry_reminders: true,
  admin_alerts: true,
};

const PREFERENCE_FLAG_BY_CATEGORY: Record<NotificationCategory, keyof Omit<PreferenceRow, 'user_id'>> = {
  announcement: 'announcements',
  message: 'messages',
  lesson_plan: 'lesson_plan_reminders',
  lesson_plan_reminder: 'lesson_plan_reminders',
  marks_entry_reminder: 'marks_entry_reminders',
  attendance: 'admin_alerts',
  admin_alert: 'admin_alerts',
  general: 'push_enabled',
};

/** Whether a teacher's stored preferences allow a category through. */
export function categoryAllowedByPreferences(prefs: PreferenceRow | undefined, category: NotificationCategory): boolean {
  if (!prefs) return true; // no stored row ⇒ everything on by default
  if (!prefs.push_enabled) return false;
  return prefs[PREFERENCE_FLAG_BY_CATEGORY[category]] !== false;
}

export interface RecipientPlan {
  userId: string;
  teacherName: string;
  status: 'deliver' | 'skipped' | 'no_devices';
  subscriptions: PushSubRow[];
}

/** Pure planning step: who gets delivered to, who is skipped, who has no devices. */
export function planDelivery(
  teachers: TeacherProfile[],
  preferences: PreferenceRow[],
  subscriptions: PushSubRow[],
  category: NotificationCategory,
): RecipientPlan[] {
  const prefsByUser = new Map(preferences.map((p) => [p.user_id, p]));
  const subsByUser = new Map<string, PushSubRow[]>();
  for (const sub of subscriptions) {
    if (!sub.is_active || isSyntheticPushEndpoint(sub.endpoint)) continue;
    const list = subsByUser.get(sub.user_id) ?? [];
    list.push(sub);
    subsByUser.set(sub.user_id, list);
  }

  return teachers.map((teacher) => {
    const prefs = prefsByUser.get(teacher.id);
    const subs = subsByUser.get(teacher.id) ?? [];
    if (!categoryAllowedByPreferences(prefs, category)) {
      return { userId: teacher.id, teacherName: teacher.name, status: 'skipped' as const, subscriptions: [] };
    }
    if (subs.length === 0) {
      return { userId: teacher.id, teacherName: teacher.name, status: 'no_devices' as const, subscriptions: [] };
    }
    return { userId: teacher.id, teacherName: teacher.name, status: 'deliver' as const, subscriptions: subs };
  });
}

export interface RecipientResult {
  userId: string;
  teacherName: string;
  status: RecipientStatus;
  deliveredDevices: number;
  failedDevices: number;
  expiredDevices: number;
  rejectedDevices: number;
  failureCode: PushFailureCode | null;
  lastError: string | null;
}

export interface SendOutcomeCounts {
  recipients: number;
  devices: number;
  sent: number;
  failed: number;
  expired: number;
  expiredRecipients: number;
  rejected: number;
  skipped: number;
  noDevices: number;
  noSubscription: number;
  alreadyReminded: number;
  taskAlreadyCompleted: number;
}

export interface SendSummary {
  notificationId: string;
  totalRecipients: number;
  sent: number;
  skipped: number;
  noDevices: number;
  noSubscription: number;
  alreadyReminded: number;
  taskAlreadyCompleted: number;
  failed: number;
  expired: number;
  devicesDelivered: number;
  devicesFailed: number;
  devicesExpired: number;
  devicesRejected: number;
  deactivatedSubscriptions: number;
  deliveryOk: boolean;
  vapid: VapidConfigCheck;
  outcome: SendOutcomeCounts;
  recipients: RecipientResult[];
}

export function validateSendRequest(request: SendNotificationRequest): string | null {
  if (!request.title || !request.title.trim()) return 'title is required';
  if (!request.body || !request.body.trim()) return 'body is required';
  if (request.title.length > 200) return 'title is too long';
  if (request.body.length > 1000) return 'body is too long';
  if (!NOTIFICATION_CATEGORIES.includes(request.category)) return 'unknown category';
  const isReminderCategory = request.category === 'lesson_plan_reminder' || request.category === 'marks_entry_reminder';
  if (isReminderCategory && !request.reminder) return 'academic reminder metadata is required';
  if (request.reminder && request.reminder.reminderType !== request.category) return 'reminder type must match notification category';
  if (request.reminder?.reminderStage !== undefined
    && request.reminder.reminderStage !== 'reminder'
    && request.reminder.reminderStage !== 'penalty') return 'academic reminder stage is invalid';
  if (request.reminder?.reminderStage === 'penalty' && request.category !== 'marks_entry_reminder') {
    return 'penalty stage is only valid for marks entry reminders';
  }
  if (request.reminder && request.audience !== 'teachers') return 'academic reminders may target teachers only';
  if (request.reminder) {
    const { academicPeriod, reminderOccurrence, entries } = request.reminder;
    if (typeof academicPeriod !== 'string' || !academicPeriod.trim()
      || typeof reminderOccurrence !== 'string' || !reminderOccurrence.trim()) {
      return 'academic period and reminder occurrence are required';
    }
    if (!entries || typeof entries !== 'object' || Array.isArray(entries) || Object.keys(entries).length === 0) {
      return 'at least one eligible academic reminder recipient is required';
    }
    const requestedIds = new Set(Array.isArray(request.teacherIds) ? request.teacherIds : []);
    for (const [teacherId, entry] of Object.entries(entries)) {
      if (!requestedIds.has(teacherId)) return 'reminder recipients must be included in teacherIds';
      if (!entry
        || typeof entry.deduplicationKey !== 'string' || !entry.deduplicationKey.trim()
        || typeof entry.academicPeriod !== 'string' || !entry.academicPeriod.trim()
        || typeof entry.relevantEntity !== 'string' || !entry.relevantEntity.trim()
        || typeof entry.reminderOccurrence !== 'string' || !entry.reminderOccurrence.trim()) {
        return 'reminder recipient metadata is incomplete';
      }
    }
  }
  if (request.audience === 'class_group' && !request.className?.trim()) return 'className is required for class_group audience';
  if (request.audience === 'teachers' && (!request.teacherIds || request.teacherIds.length === 0)) {
    return 'teacherIds is required for teachers audience';
  }
  if (request.url && !request.url.startsWith('/')) return 'url must be an in-app path starting with /';
  return null;
}

function preflightFailure(err: unknown) {
  const detail = sanitizePushResponseText(err instanceof Error ? err.message : err, 150);
  return {
    code: 'bad_request' as const,
    message: sanitizePushResponseText(`push pre-flight failed${detail ? `: ${detail}` : ''}`, 200),
    retryable: false,
    subscriptionUnusable: false,
  };
}

function explainVapidRejection(status: number, responseText: string, endpoint: string): string {
  const detail = sanitizePushResponseText(responseText, 200, [endpoint]);
  return sanitizePushResponseText(
    `push service rejected VAPID authentication (HTTP ${status}) — check VAPID_PRIVATE_KEY/VAPID_SUBJECT (see /api/push/health)${detail ? ` — ${detail}` : ''}`,
    200,
  );
}

export async function sendTeacherNotification(opts: {
  request: SendNotificationRequest;
  senderId: string | null;
  db: NotificationDb;
  vapid: VapidConfig;
  makeId?: (prefix: string) => string;
  fetchImpl?: typeof fetch;
}): Promise<SendSummary> {
  const { request, db } = opts;
  const invalid = validateSendRequest(request);
  if (invalid) throw new Error(invalid);

  const reminder = request.reminder;
  const vapidCheck = validateVapidConfig(opts.vapid);
  const makeId = opts.makeId
    ?? ((prefix: string) => `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`);

  const teachers = await db.listTeachers({
    audience: request.audience,
    className: request.className,
    teacherIds: request.teacherIds,
  });
  const reminderEntries = reminder?.entries ?? {};
  const eligibleTeacherIds = new Set(Object.keys(reminderEntries));
  const deliveryTeachers = reminder
    ? teachers.filter((teacher) => eligibleTeacherIds.has(teacher.id))
    : teachers;
  const userIds = deliveryTeachers.map((teacher) => teacher.id);

  let subscriptions: PushSubRow[] = [];
  let preferences: PreferenceRow[] = [];
  if (userIds.length > 0) {
    [subscriptions, preferences] = await Promise.all([
      db.getActiveSubscriptions(userIds),
      db.getPreferences(userIds),
    ]);
  }
  const plans = planDelivery(deliveryTeachers, preferences, subscriptions, request.category);

  const notificationId = makeId('ntf');
  await db.insertNotification({
    id: notificationId,
    title: request.title.trim(),
    body: request.body.trim(),
    url: request.url ?? null,
    category: request.category,
    sender_id: opts.senderId,
  });

  const results: RecipientResult[] = [];
  let plansToSend = plans;
  if (reminder) {
    const claimRows: ReminderRecipientInsert[] = plans.map((plan) => {
      const entry = reminder.entries[plan.userId];
      if (!entry?.deduplicationKey || !entry.academicPeriod || !entry.relevantEntity || !entry.reminderOccurrence) {
        throw new Error(`Reminder metadata is incomplete for teacher ${plan.userId}.`);
      }
      return {
        id: makeId('ntr'),
        notification_id: notificationId,
        user_id: plan.userId,
        status: 'pending',
        reminder_type: reminder.reminderType,
        academic_period: entry.academicPeriod,
        relevant_entity: entry.relevantEntity,
        reminder_occurrence: entry.reminderOccurrence,
        reminder_stage: reminder.reminderStage ?? 'reminder',
        deduplication_key: entry.deduplicationKey,
      };
    });

    let claimed: Array<Pick<ReminderRecipientInsert, 'id' | 'user_id' | 'deduplication_key'>> = [];
    try {
      if (claimRows.length > 0 && !db.claimReminderRecipients) {
        throw new Error('Notification database does not support atomic academic reminder deduplication.');
      }
      claimed = claimRows.length > 0
        ? await db.claimReminderRecipients!(claimRows)
        : [];
    } catch (error) {
      // Clean up rows for definite RPC/configuration failures, but preserve
      // the notification if transport status is ambiguous: the claim may have
      // committed even if its response never reached this function.
      const status = Number((error as { status?: unknown } | null)?.status);
      const definiteFailure = (Number.isInteger(status) && status >= 400 && status <= 500)
        || (error instanceof Error && error.message.includes('does not support atomic academic reminder deduplication'));
      if (definiteFailure && db.deleteNotification) {
        try {
          await db.deleteNotification(notificationId);
        } catch (cleanupError) {
          console.error('[notification sender] failed to remove unclaimed reminder notification:', sanitizePushResponseText(cleanupError, 200));
        }
      }
      throw error;
    }
    const claimedTeacherIds = new Set(claimed.map((row) => row.user_id));
    const alreadyRemindedPlans = plans.filter((plan) => !claimedTeacherIds.has(plan.userId));
    plansToSend = plans.filter((plan) => claimedTeacherIds.has(plan.userId));

    for (const plan of alreadyRemindedPlans) {
      results.push({
        userId: plan.userId,
        teacherName: plan.teacherName,
        status: 'already_reminded',
        deliveredDevices: 0,
        failedDevices: 0,
        expiredDevices: 0,
        rejectedDevices: 0,
        failureCode: null,
        lastError: null,
      });
    }

    const taskCompleteIds = new Set(reminder.taskAlreadyCompletedTeacherIds ?? []);
    for (const teacher of teachers) {
      if (!taskCompleteIds.has(teacher.id) || eligibleTeacherIds.has(teacher.id)) continue;
      results.push({
        userId: teacher.id,
        teacherName: teacher.name,
        status: 'task_already_completed',
        deliveredDevices: 0,
        failedDevices: 0,
        expiredDevices: 0,
        rejectedDevices: 0,
        failureCode: null,
        lastError: null,
      });
    }

    // A repeated event with no newly claimed recipient must not leave an empty
    // notification in history. The first event's recipient row is the history.
    if (plansToSend.length === 0 && db.deleteNotification) {
      await db.deleteNotification(notificationId);
    }
  } else {
    // Seed history before fan-out so every generic attempt is inspectable.
    await db.insertRecipients(
      plans.map((plan) => ({
        id: makeId('ntr'),
        notification_id: notificationId,
        user_id: plan.userId,
        status: plan.status === 'deliver' ? 'pending' : plan.status === 'skipped' ? 'skipped' : 'no_devices',
      })),
    );
  }

  const payload = {
    title: request.title.trim(),
    body: request.body.trim(),
    url: request.url || '/teacher/notifications',
    category: request.category,
    tag: notificationId,
  };

  let devicesDelivered = 0;
  let devicesFailed = 0;
  let devicesExpired = 0;
  let devicesRejected = 0;
  let deactivatedSubscriptions = 0;

  for (const plan of plansToSend) {
    if (plan.status !== 'deliver') {
      const status: RecipientStatus = plan.status === 'skipped'
        ? 'skipped'
        : reminder ? 'no_subscription' : 'no_devices';
      if (reminder) {
        await db.updateRecipient(notificationId, plan.userId, {
          status,
          delivered_devices: 0,
          failed_devices: 0,
          expired_devices: 0,
          last_error: null,
        });
      }
      results.push({
        userId: plan.userId,
        teacherName: plan.teacherName,
        status,
        deliveredDevices: 0,
        failedDevices: 0,
        expiredDevices: 0,
        rejectedDevices: 0,
        failureCode: null,
        lastError: null,
      });
      continue;
    }

    let delivered = 0;
    let failed = 0;
    let expired = 0;
    let rejected = 0;
    let failureCode: PushFailureCode | null = null;
    let lastError: string | null = null;

    for (const sub of plan.subscriptions) {
      let outcome: WebPushResult;
      try {
        outcome = await sendWebPush({
          endpoint: sub.endpoint,
          keys: { p256dh: sub.p256dh, auth: sub.auth },
          payload,
          vapid: opts.vapid,
          fetchImpl: opts.fetchImpl,
        });
      } catch (err) {
        // Invalid key material is a preflight failure, never an expired device.
        const failure = preflightFailure(err);
        failed += 1;
        failureCode ??= failure.code;
        lastError ??= failure.message;
        continue;
      }

      if (outcome.ok) {
        delivered += 1;
        continue;
      }

      const failure = describePushFailure(outcome, sub.endpoint);
      let failureMessage = failure.message;
      failed += 1;
      failureCode ??= failure.code;

      if (failure.code === 'expired') {
        await db.deactivateSubscription(sub.endpoint);
        deactivatedSubscriptions += 1;
        expired += 1;
        devicesExpired += 1;
      } else if (failure.code === 'unauthorized' || failure.code === 'forbidden') {
        rejected += 1;
        devicesRejected += 1;
        // 401/403 often indicate a VAPID key/subject mismatch. Preserve rows
        // so a server config issue cannot retire recoverable teacher devices.
        failureMessage = explainVapidRejection(outcome.status, outcome.responseText, sub.endpoint);
      }
      // Network/recoverable failures are retained for diagnostics and retry.
      lastError ??= sanitizePushResponseText(failureMessage, 200);
    }

    devicesDelivered += delivered;
    devicesFailed += failed;
    const status: RecipientStatus = delivered > 0
      ? 'sent'
      : expired === plan.subscriptions.length ? 'expired' : 'failed';
    await db.updateRecipient(notificationId, plan.userId, {
      status,
      delivered_devices: delivered,
      failed_devices: failed,
      expired_devices: expired,
      last_error: lastError,
    });
    results.push({
      userId: plan.userId,
      teacherName: plan.teacherName,
      status,
      deliveredDevices: delivered,
      failedDevices: failed,
      expiredDevices: expired,
      rejectedDevices: rejected,
      failureCode,
      lastError,
    });
  }

  const sent = results.filter((result) => result.status === 'sent').length;
  const skipped = results.filter((result) => result.status === 'skipped').length;
  const noDevices = results.filter((result) => result.status === 'no_devices').length;
  const noSubscription = results.filter((result) => result.status === 'no_subscription').length;
  const alreadyReminded = results.filter((result) => result.status === 'already_reminded').length;
  const taskAlreadyCompleted = results.filter((result) => result.status === 'task_already_completed').length;
  const failed = results.filter((result) => result.status === 'failed').length;
  const expiredRecipients = results.filter((result) => result.status === 'expired').length;
  const deliveryTargets = results.filter((result) => result.status !== 'task_already_completed');
  const deliveryOk = deliveryTargets.length > 0
    && sent === deliveryTargets.length
    && devicesFailed === 0;

  return {
    notificationId,
    totalRecipients: results.length,
    sent,
    skipped,
    noDevices,
    noSubscription,
    alreadyReminded,
    taskAlreadyCompleted,
    failed,
    expired: expiredRecipients,
    devicesDelivered,
    devicesFailed,
    devicesExpired,
    devicesRejected,
    deactivatedSubscriptions,
    deliveryOk,
    vapid: vapidCheck,
    outcome: {
      recipients: results.length,
      devices: devicesDelivered + devicesFailed,
      sent,
      failed,
      expired: devicesExpired,
      expiredRecipients,
      rejected: devicesRejected,
      skipped,
      noDevices,
      noSubscription,
      alreadyReminded,
      taskAlreadyCompleted,
    },
    recipients: results,
  };
}
