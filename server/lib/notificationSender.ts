/**
 * Server-side fan-out for teacher push notifications.
 *
 * Pure orchestration: all I/O is injected (db + push transport) so the same
 * code that runs in the Vercel function is executed by the test-suite against
 * an in-memory database and a local fake push service. Authorization of the
 * *caller* happens in api/notifications/send.ts before this runs; this module
 * trusts `senderId`.
 */

import {
  describePushFailure,
  looksLikeTokenProblem,
  sanitizePushResponseText,
  sendWebPush,
  validateVapidConfig,
  type PushFailureCode,
  type VapidConfig,
  type VapidConfigCheck,
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
  /** Number of individual subscriptions attempted. */
  devices: number;
  /** Number of devices whose push service accepted the notification. */
  sent: number;
  failed: number;
  expired: number;
  rejected: number;
  skipped: number;
  noDevices: number;
}

export interface SendSummary {
  /** Set only by the browser's local placeholder preview, never by the send API. */
  simulated?: boolean;
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
  /** True only if at least one device was attempted and every target was delivered. */
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

export async function sendTeacherNotification(opts: {
  request: SendNotificationRequest;
  senderId: string;
  db: NotificationDb;
  vapid: VapidConfig;
  makeId?: (prefix: string) => string;
  fetchImpl?: typeof fetch;
}): Promise<SendSummary> {
  const { request, db } = opts;
  const makeId =
    opts.makeId ??
    ((prefix: string) => `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`);
  const notificationId = makeId('ntf');
  const vapidCheck = validateVapidConfig(opts.vapid);

  // Keep this module safe when called directly (e.g. from a job or test), even
  // though the HTTP handler also rejects invalid VAPID configuration before
  // authentication or any database work.
  if (!vapidCheck.ok) {
    const outcome: SendOutcomeCounts = {
      recipients: 0,
      devices: 0,
      sent: 0,
      failed: 0,
      expired: 0,
      rejected: 0,
      skipped: 0,
      noDevices: 0,
    };
    return {
      notificationId,
      totalRecipients: 0,
      sent: 0,
      skipped: 0,
      noDevices: 0,
      failed: 0,
      devicesDelivered: 0,
      devicesFailed: 0,
      devicesExpired: 0,
      devicesRejected: 0,
      deactivatedSubscriptions: 0,
      deliveryOk: false,
      vapid: vapidCheck,
      outcome,
      recipients: [],
    };
  }

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
  let devicesAttempted = 0;
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
      devicesAttempted += 1;
      let outcome;
      try {
        outcome = await sendWebPush({
          endpoint: sub.endpoint,
          keys: { p256dh: sub.p256dh, auth: sub.auth },
          payload,
          vapid: opts.vapid,
          fetchImpl: opts.fetchImpl,
        });
      } catch (err) {
        // Encryption/key validation happens before a network call. Record it as
        // a non-retryable per-device error, but never treat it as an expired
        // subscription because the push service did not see the request.
        const detail = sanitizePushResponseText(err instanceof Error ? err.message : String(err));
        const code: PushFailureCode = /too large/i.test(detail) ? 'payload_too_large' : 'bad_request';
        failed += 1;
        devicesFailed += 1;
        rejected += 1;
        devicesRejected += 1;
        failureCode = code;
        lastError = `${code}: push pre-flight validation failed${detail ? ` — ${detail}` : ''}`;
        continue;
      }

      if (outcome.ok) {
        delivered += 1;
        devicesDelivered += 1;
        continue;
      }

      const failure = describePushFailure(outcome);
      failed += 1;
      devicesFailed += 1;
      failureCode = failure.code;
      let message = `${failure.code}: ${failure.message}`;

      if (failure.code === 'expired') {
        expired += 1;
        devicesExpired += 1;
        try {
          await db.deactivateSubscription(sub.endpoint);
          deactivatedSubscriptions += 1;
        } catch {
          // Delivery remains recorded as expired even if the best-effort
          // cleanup fails; do not expose the endpoint or database error.
          message += '; automatic subscription retirement failed';
        }
      } else if (
        failure.code === 'unauthorized' ||
        failure.code === 'forbidden' ||
        failure.code === 'bad_request' ||
        failure.code === 'payload_too_large'
      ) {
        rejected += 1;
        devicesRejected += 1;

        if (failure.code === 'unauthorized' || failure.code === 'forbidden') {
          const tokenProblem = looksLikeTokenProblem(outcome.responseText);
          // 401/403 do not prove that a device subscription is dead. Keep it:
          // service VAPID mistakes can reject every device, while a genuinely
          // old device key can be repaired safely by client-side resubscription.
          message += tokenProblem || !vapidCheck.ok
            ? '; kept subscription — check VAPID_PRIVATE_KEY/VAPID_SUBJECT (see /api/push/health)'
            : '; kept subscription for safety — verify VAPID config and re-register this device if the key was rotated';
        }
      }

      lastError = sanitizePushResponseText(message);
    }

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

  const sentRecipients = results.filter((r) => r.status === 'sent').length;
  const skipped = results.filter((r) => r.status === 'skipped').length;
  const noDevices = results.filter((r) => r.status === 'no_devices').length;
  const failedRecipients = results.filter((r) => r.status === 'failed').length;
  const outcome: SendOutcomeCounts = {
    recipients: plans.length,
    devices: devicesAttempted,
    sent: devicesDelivered,
    failed: devicesFailed,
    expired: devicesExpired,
    rejected: devicesRejected,
    skipped,
    noDevices,
  };

  return {
    notificationId,
    totalRecipients: plans.length,
    sent: sentRecipients,
    skipped,
    noDevices,
    failed: failedRecipients,
    devicesDelivered,
    devicesFailed,
    devicesExpired,
    devicesRejected,
    deactivatedSubscriptions,
      deliveryOk: devicesDelivered > 0 && devicesFailed === 0 && noDevices === 0 && skipped === 0,
    vapid: vapidCheck,
    outcome,
    recipients: results,
  };
}
