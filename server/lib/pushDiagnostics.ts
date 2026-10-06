/**
 * Pure, network-free inspection helpers for push subscription diagnostics.
 * All output is deliberately redacted: endpoint paths and subscription key
 * material are inspected, but never returned.
 */

import type { PushFailureCode, VapidConfigCheck } from './webpush.js';

export interface SubscriptionDiagnosticRow {
  id?: unknown;
  user_id?: unknown;
  endpoint?: unknown;
  p256dh?: unknown;
  auth?: unknown;
  is_active?: unknown;
  device_type?: unknown;
  browser?: unknown;
  created_at?: unknown;
}

export interface SubscriptionInspection {
  id: string;
  userId: string;
  /** Hostname only. Endpoint path is a per-device registration secret. */
  endpointHost: string | null;
  endpointLooksSynthetic: boolean;
  isActive: boolean;
  deviceType: string | null;
  browser: string | null;
  createdAt: string | null;
  p256dhBytes: number;
  p256dhLooksLikePoint: boolean;
  authBytes: number;
  authLooksValid: boolean;
  problems: string[];
}

export interface DiagnosticPushAttempt {
  subscriptionId?: string;
  userId?: string;
  status: number;
  ok: boolean;
  expired: boolean;
  failureCode: PushFailureCode;
  networkError?: string | null;
}

export interface DiagnosticSummary {
  attempted: number;
  delivered: number;
  expired: number;
  rejected: number;
  otherFailures: number;
  hint: string;
}

function decodeBase64Url(input: unknown): Buffer | null {
  if (typeof input !== 'string' || !/^[A-Za-z0-9_-]*={0,2}$/.test(input)) return null;
  const unpadded = input.replace(/=+$/, '');
  if (unpadded.length === 0 && input.length > 0) return null;
  const normalized = unpadded.replace(/-/g, '+').replace(/_/g, '/');
  const padded = normalized + '='.repeat((4 - (normalized.length % 4)) % 4);
  return Buffer.from(padded, 'base64');
}

function textOrNull(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function syntheticHost(host: string | null): boolean {
  if (!host) return false;
  const normalized = host.toLowerCase().replace(/\.$/, '');
  return (
    normalized.startsWith('preview.') ||
    normalized.startsWith('localhost.') ||
    normalized === 'localhost' ||
    normalized.startsWith('test.') ||
    normalized === 'test' ||
    normalized.startsWith('example.') ||
    normalized === 'example' ||
    normalized.endsWith('.local')
  );
}

export function inspectSubscription(row: SubscriptionDiagnosticRow): SubscriptionInspection {
  const problems: string[] = [];
  const endpoint = textOrNull(row.endpoint);
  let endpointHost: string | null = null;
  if (endpoint) {
    try {
      const parsed = new URL(endpoint);
      endpointHost = parsed.hostname || null;
      if (parsed.protocol !== 'https:') problems.push('endpoint is not HTTPS');
      if (!parsed.hostname) problems.push('endpoint has no host');
    } catch {
      problems.push('endpoint is not a valid URL');
    }
  } else {
    problems.push('endpoint is missing');
  }
  const endpointLooksSynthetic = syntheticHost(endpointHost);
  if (endpointLooksSynthetic) problems.push('endpoint host looks synthetic or preview-only');

  const p256dh = decodeBase64Url(row.p256dh);
  const p256dhBytes = p256dh?.length ?? 0;
  const p256dhLooksLikePoint = Boolean(p256dh && p256dh.length === 65 && p256dh[0] === 0x04);
  if (!p256dhLooksLikePoint) problems.push('p256dh is not a 65-byte uncompressed P-256 point');

  const auth = decodeBase64Url(row.auth);
  const authBytes = auth?.length ?? 0;
  const authLooksValid = authBytes === 16;
  if (!authLooksValid) problems.push('auth secret is not 16 bytes');

  return {
    id: textOrNull(row.id) ?? 'unknown',
    userId: textOrNull(row.user_id) ?? 'unknown',
    endpointHost,
    endpointLooksSynthetic,
    isActive: row.is_active === true,
    deviceType: textOrNull(row.device_type),
    browser: textOrNull(row.browser),
    createdAt: textOrNull(row.created_at),
    p256dhBytes,
    p256dhLooksLikePoint,
    authBytes,
    authLooksValid,
    problems,
  };
}

function isRejected(attempt: DiagnosticPushAttempt): boolean {
  return attempt.failureCode === 'unauthorized' || attempt.failureCode === 'forbidden';
}

/** Count diagnostic pushes and emit a single highest-priority actionable hint. */
export function summarizeDiagnostics(
  inspections: SubscriptionInspection[],
  attempts: DiagnosticPushAttempt[],
  vapidCheck: Pick<VapidConfigCheck, 'ok' | 'problems'>,
): DiagnosticSummary {
  const attempted = attempts.length;
  const delivered = attempts.filter((a) => a.ok || a.failureCode === 'ok').length;
  const expired = attempts.filter((a) => a.expired || a.failureCode === 'expired').length;
  const rejected = attempts.filter(isRejected).length;
  const otherFailures = attempted - delivered - expired - rejected;
  const active = inspections.filter((item) => item.isActive);
  const activeSynthetic = active.some((item) => item.endpointLooksSynthetic);
  const activeMalformed = active.some((item) => !item.p256dhLooksLikePoint || !item.authLooksValid);

  let hint: string;
  if (!vapidCheck.ok) {
    hint = `VAPID configuration is invalid. Correct VAPID_PRIVATE_KEY/VAPID_SUBJECT first (${vapidCheck.problems.join('; ') || 'see /api/push/health'}). No real test push should be sent.`;
  } else if (active.length === 0) {
    hint = 'No active device subscriptions were found for this audience. Ask the teacher to enable notifications on the device.';
  } else if (activeSynthetic) {
    hint = 'An active endpoint is synthetic or preview-only; it cannot receive a real push. Re-register notifications on the teacher’s real device.';
  } else if (activeMalformed) {
    hint = 'One or more stored subscription keys are malformed. Re-enable notifications on the affected device to replace the row.';
  } else if (attempted > 0 && delivered === attempted) {
    hint = 'All tested devices were accepted by their push services. Confirm the notification appears on the device.';
  } else if (attempted > 0 && vapidCheck.ok && rejected === attempted) {
    hint = 'All devices rejected VAPID authorization. These subscriptions may use an older public key; ask the teacher to tap “Fix notifications” or re-enable notifications to register with the current key.';
  } else if (expired > 0) {
    hint = 'The push service marked one or more subscriptions expired (404/410). They should be retired; re-enable notifications on those devices.';
  } else if (otherFailures > 0) {
    hint = 'The push service or network failed for one or more devices. Review each sanitized status/detail and retry after fixing the reported issue.';
  } else {
    hint = 'This was a dry-run inspection; no push was sent. Use “Test push to each device” to verify delivery.';
  }

  return { attempted, delivered, expired, rejected, otherFailures, hint };
}
