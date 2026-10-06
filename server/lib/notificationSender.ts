/**
 * Server-side fan-out for teacher push notifications.
 *
 * Pure orchestration: all I/O is injected (db + push transport) so the same
 * code that runs in the Vercel function is executed by the test-suite against
 * an in-memory database and a local fake push service. Authorization of the
 * caller happens in api/notifications/send.ts before this runs; this module
 * trusts `senderId`.
 */

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
  | 'attendance'
  | 'admin_alert'
  | 'general';

export const NOTIFICATION_CATEGORIES: NotificationCategory[] = [
  'announcement',
  'message',
  'lesson_plan',
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
  admin_alerts: boolean;
}

export type RecipientStatus = 'pending' | 'sent' | 'failed' | 'no_devices' | 'skipped';

export interface NotificationDb {
  listTeachers(filter: { audience: SendNotificationRequest['audience']; className?: string; teacherIds?: string[] }): Promise<TeacherProfile[]>;
  getActiveSubscriptions(userIds: string[]): Promise<PushSubRow[]>;
  getPreferences(userIds: string[]): Promise<PreferenceRow[]>;
  insertNotification(row: { id: string; title: string; body: string; url: string | null; category: string; sender_id: string }): Promise<void>;
  insertRecipients(rows: { id: string; notification_id: string; user_id: string; status: RecipientStatus }[]): Promise<void>;
  updateRecipient(notificationId: string, userId: string, patch: { status: RecipientStatus; delivered_devices?: number; failed_devices?: number; last_error?: string | null }): Promise<void>;
  deactivateSubscription(endpoint: string): Promise<void>;
}

export const DEFAULT_PREFERENCES: Omit<PreferenceRow, 'user_id'> = {
  push_enabled: true,
  announcements: true,
  messages: true,
  lesson_plan_reminders: true,
  admin_alerts: true,
};

const PREFERENCE_FLAG_BY_CATEGORY: Record<NotificationCategory, keyof Omit<PreferenceRow, 'user_id'>> = {
  announcement: 'announcements',
  message: 'messages',
  lesson_plan: 'lesson_plan_reminders',
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
    if (!sub.is_active) continue;
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
  rejected: number;
  skipped: number;
  noDevices: number;
}

export interface SendSummary {
  notificationId: string;
  totalRecipients: number;
  sent: number;
  skipped: number;
  noDevices: number;
  failed: number;
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
  senderId: string;
  db: NotificationDb;
  vapid: VapidConfig;
  makeId?: (prefix: string) => string;
  fetchImpl?: typeof fetch;
}): Promise<SendSummary> {
  const { request, db } = opts;
  const vapidCheck = validateVapidConfig(opts.vapid);
  const makeId =
    opts.makeId ??
    ((prefix: string) => `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`);

  const teachers = await db.listTeachers({
    audience: request.audience,
    className: request.className,
    teacherIds: request.teacherIds,
  });

  const userIds = teachers.map((t) => t.id);
  let subscriptions: PushSubRow[] = [];
  let preferences: PreferenceRow[] = [];
  if (userIds.length > 0) {
    [subscriptions, preferences] = await Promise.all([
      db.getActiveSubscriptions(userIds),
      db.getPreferences(userIds),
    ]);
  }

  const plans = planDelivery(teachers, preferences, subscriptions, request.category);

  const notificationId = makeId('ntf');
  await db.insertNotification({
    id: notificationId,
    title: request.title.trim(),
    body: request.body.trim(),
    url: request.url ?? null,
    category: request.category,
    sender_id: opts.senderId,
  });

  // Seed history rows so the admin UI and teacher history always reflect the
  // attempt, even for teachers we never deliver to.
  await db.insertRecipients(
    plans.map((plan) => ({
      id: makeId('ntr'),
      notification_id: notificationId,
      user_id: plan.userId,
      status: plan.status === 'deliver' ? 'pending' : plan.status === 'skipped' ? 'skipped' : 'no_devices',
    })),
  );

  const payload = {
    title: request.title.trim(),
    body: request.body.trim(),
    url: request.url || '/teacher/notifications',
    category: request.category,
    tag: notificationId,
  };

  const results: RecipientResult[] = [];
  let devicesDelivered = 0;
  let devicesFailed = 0;
  let devicesExpired = 0;
  let devicesRejected = 0;
  let deactivatedSubscriptions = 0;

  for (const plan of plans) {
    if (plan.status !== 'deliver') {
      results.push({
        userId: plan.userId,
        teacherName: plan.teacherName,
        status: plan.status === 'skipped' ? 'skipped' : 'no_devices',
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
        // Invalid stored p256dh/auth material is a pre-flight problem; it must
        // not be mislabeled as an expired endpoint or trigger retirement.
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
        // 401/403 can reflect a server-side VAPID key/subject problem even
        // when the values are syntactically valid. Preserve the row so a bad
        // deployment cannot wipe otherwise-recoverable device subscriptions.
        failureMessage = explainVapidRejection(outcome.status, outcome.responseText, sub.endpoint);
      }

      lastError ??= sanitizePushResponseText(failureMessage, 200);
    }

    devicesDelivered += delivered;
    devicesFailed += failed;
    const status: RecipientStatus = delivered > 0 ? 'sent' : 'failed';
    await db.updateRecipient(notificationId, plan.userId, {
      status,
      delivered_devices: delivered,
      failed_devices: failed,
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

  const sent = results.filter((r) => r.status === 'sent').length;
  const skipped = results.filter((r) => r.status === 'skipped').length;
  const noDevices = results.filter((r) => r.status === 'no_devices').length;
  const failed = results.filter((r) => r.status === 'failed').length;
  const deliveryOk = devicesDelivered > 0;

  return {
    notificationId,
    totalRecipients: plans.length,
    sent,
    skipped,
    noDevices,
    failed,
    devicesDelivered,
    devicesFailed,
    devicesExpired,
    devicesRejected,
    deactivatedSubscriptions,
    deliveryOk,
    vapid: vapidCheck,
    outcome: {
      recipients: plans.length,
      devices: devicesDelivered + devicesFailed,
      sent,
      failed,
      expired: devicesExpired,
      rejected: devicesRejected,
      skipped,
      noDevices,
    },
    recipients: results,
  };
}
