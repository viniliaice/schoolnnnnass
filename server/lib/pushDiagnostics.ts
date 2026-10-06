import { base64UrlDecode } from './webpush.js';
import type { PushFailureCode, VapidConfigCheck } from './webpush.js';

export interface SubscriptionDiagnosticRow {
  id?: string | null;
  user_id?: string | null;
  endpoint?: string | null;
  p256dh?: string | null;
  auth?: string | null;
  is_active?: boolean | null;
  device_type?: string | null;
  browser?: string | null;
  created_at?: string | null;
}

export interface SubscriptionInspection {
  id: string;
  userId: string;
  /** Hostname only: the path portion of a push endpoint is a registration token. */
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

export interface DiagnosticAttempt {
  subscriptionId: string;
  status: number;
  ok: boolean;
  expired: boolean;
  failureCode: PushFailureCode;
  detail?: string | null;
  networkError?: string | null;
  retired?: boolean;
  retirementFailed?: boolean;
}

export interface PushDiagnosticSummary {
  attempted: number;
  delivered: number;
  expired: number;
  retired: number;
  retirementFailed: number;
  rejected: number;
  otherFailures: number;
  hint: string;
}

function decodeLength(value: unknown): number {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]+$/.test(value)) return 0;
  try {
    return base64UrlDecode(value).length;
  } catch {
    return 0;
  }
}

function syntheticHost(host: string): boolean {
  const normalized = host.toLowerCase().replace(/\.$/, '');
  return (
    /(^|\.)(preview|localhost|test|example)(\.|$)/i.test(normalized) ||
    normalized.endsWith('.local') ||
    normalized === 'local'
  );
}

/** Inspect one stored row while never returning its endpoint path or key bytes. */
export function inspectSubscription(row: SubscriptionDiagnosticRow): SubscriptionInspection {
  const problems: string[] = [];
  let endpointHost: string | null = null;
  try {
    const endpoint = new URL(String(row.endpoint || ''));
    endpointHost = endpoint.hostname.toLowerCase();
    if (endpoint.protocol !== 'https:') problems.push('endpoint must use HTTPS');
  } catch {
    problems.push('endpoint is not a valid URL');
  }

  const endpointLooksSynthetic = endpointHost ? syntheticHost(endpointHost) : false;
  if (endpointLooksSynthetic) problems.push('endpoint host is synthetic or non-routable');

  const p256dhBytes = decodeLength(row.p256dh);
  const p256dhLooksLikePoint = p256dhBytes === 65 && (() => {
    try {
      return base64UrlDecode(String(row.p256dh))[0] === 0x04;
    } catch {
      return false;
    }
  })();
  if (!p256dhLooksLikePoint) problems.push('p256dh is not a 65-byte uncompressed P-256 point');

  const authBytes = decodeLength(row.auth);
  const authLooksValid = authBytes === 16;
  if (!authLooksValid) problems.push('auth secret is not 16 bytes');

  return {
    id: String(row.id || ''),
    userId: String(row.user_id || ''),
    endpointHost,
    endpointLooksSynthetic,
    isActive: row.is_active === true,
    deviceType: row.device_type ? String(row.device_type) : null,
    browser: row.browser ? String(row.browser) : null,
    createdAt: row.created_at ? String(row.created_at) : null,
    p256dhBytes,
    p256dhLooksLikePoint,
    authBytes,
    authLooksValid,
    problems,
  };
}

function rejectedFailure(code: PushFailureCode): boolean {
  return code === 'bad_request' || code === 'unauthorized' || code === 'forbidden' || code === 'payload_too_large';
}

/** Counts diagnostic attempts and emits one ordered, actionable explanation. */
export function summarizeDiagnostics(
  inspections: SubscriptionInspection[],
  attempts: DiagnosticAttempt[],
  vapidCheck: Pick<VapidConfigCheck, 'ok'>,
): PushDiagnosticSummary {
  const active = inspections.filter((row) => row.isActive);
  const delivered = attempts.filter((attempt) => attempt.ok).length;
  const expiredAttempts = attempts.filter((attempt) => attempt.failureCode === 'expired' || attempt.expired);
  const expired = expiredAttempts.length;
  const retired = expiredAttempts.filter((attempt) => attempt.retired).length;
  const retirementFailures = expiredAttempts.filter((attempt) => attempt.retirementFailed).length;
  const rejected = attempts.filter((attempt) => rejectedFailure(attempt.failureCode)).length;
  const otherFailures = attempts.length - delivered - expired - rejected;

  let hint: string;
  if (!vapidCheck.ok) {
    hint = 'VAPID configuration is invalid. Fix VAPID_PRIVATE_KEY and VAPID_SUBJECT before sending; no subscription should be retired for this failure.';
  } else if (active.length === 0) {
    hint = 'No active push subscriptions were found. Enable notifications on the teacher’s device first.';
  } else if (active.some((row) => row.endpointLooksSynthetic)) {
    hint = 'A synthetic/preview endpoint is stored instead of a routable device. Re-register the teacher’s real device; do not send to the placeholder.';
  } else if (active.some((row) => !row.p256dhLooksLikePoint || !row.authLooksValid)) {
    hint = 'One or more subscriptions have malformed key material. Re-enable notifications on the affected device to create a valid subscription.';
  } else if (attempts.length > 0 && delivered === attempts.length) {
    hint = 'All attempted devices accepted the push. Check the device notification settings if it is not visible.';
  } else if (
    attempts.length > 0 &&
    rejected === attempts.length &&
    attempts.every((attempt) => attempt.failureCode === 'unauthorized' || attempt.failureCode === 'forbidden') &&
    vapidCheck.ok
  ) {
    hint = 'All devices were rejected with 401/403 while the server key is structurally valid. This can indicate VAPID key rotation or an authorization mismatch; verify server VAPID config, then use Fix notifications on affected devices.';
  } else if (expired > 0 && retired === expired) {
    hint = 'The push service reports an expired subscription and the row was retired. Re-enable notifications on that device to subscribe again.';
  } else if (expired > 0 && (retirementFailures > 0 || retired < expired)) {
    hint = 'The push service reports an expired subscription, but automatic retirement was not confirmed for every affected row. Do not retry those rows until cleanup is verified; re-enable notifications afterward.';
  } else if (attempts.length > 0 && otherFailures + rejected > 0) {
    hint = 'Push delivery failed for one or more devices. Review each sanitized status/detail below and retry after correcting the reported cause.';
  } else {
    hint = 'Dry run only: no push was sent. Use “Test push to each device” to perform a real delivery attempt.';
  }

  return { attempted: attempts.length, delivered, expired, retired, retirementFailed: retirementFailures, rejected, otherFailures, hint };
}
