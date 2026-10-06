// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { inspectSubscription, summarizeDiagnostics, type DiagnosticAttempt, type SubscriptionInspection } from '../../../server/lib/pushDiagnostics';
import { deviceKeys } from './helpers/fakeNetwork';

function row(overrides: Record<string, unknown> = {}) {
  return {
    id: 'sub-id',
    user_id: 'teacher-1',
    endpoint: 'https://fcm.googleapis.com/fcm/send/registration-secret-path',
    ...deviceKeys(),
    is_active: true,
    device_type: 'mobile',
    browser: 'safari',
    created_at: '2026-10-01T00:00:00Z',
    ...overrides,
  };
}

const vapidOk = { ok: true };
const vapidBad = { ok: false };

function attempt(code: DiagnosticAttempt['failureCode'], status: number, ok = false): DiagnosticAttempt {
  return { subscriptionId: 'sub-id', status, ok, expired: code === 'expired', failureCode: code };
}

describe('push subscription diagnostics', () => {
  it('returns only the endpoint host and key-material lengths', () => {
    const inspected = inspectSubscription(row());
    expect(inspected).toMatchObject({
      id: 'sub-id', userId: 'teacher-1', endpointHost: 'fcm.googleapis.com',
      endpointLooksSynthetic: false, p256dhBytes: 65, p256dhLooksLikePoint: true,
      authBytes: 16, authLooksValid: true,
    });
    expect(JSON.stringify(inspected)).not.toContain('registration-secret-path');
    expect(JSON.stringify(inspected)).not.toContain(row().p256dh);
    expect(JSON.stringify(inspected)).not.toContain(row().auth);
  });

  it('flags preview/local/test/example hosts and malformed key material', () => {
    const synthetic = inspectSubscription(row({ endpoint: 'https://preview.push.local/subscribe/private-path' }));
    expect(synthetic.endpointLooksSynthetic).toBe(true);
    expect(synthetic.problems.join(' ')).toMatch(/synthetic/);
    const malformed = inspectSubscription(row({ p256dh: 'not-a-point', auth: 'short' }));
    expect(malformed.p256dhLooksLikePoint).toBe(false);
    expect(malformed.authLooksValid).toBe(false);
    expect(malformed.problems).toHaveLength(2);
  });

  it('prioritizes invalid VAPID, then no active subscriptions', () => {
    expect(summarizeDiagnostics([], [], vapidBad).hint).toMatch(/VAPID configuration is invalid/);
    expect(summarizeDiagnostics([inspectSubscription(row({ is_active: false }))], [], vapidOk).hint).toMatch(/No active/);
  });

  it('suggests re-registration for synthetic endpoints before key-material hints', () => {
    const inspected = inspectSubscription(row({
      endpoint: 'https://preview.push.local/subscribe/secret',
      p256dh: 'invalid',
    }));
    expect(summarizeDiagnostics([inspected], [], vapidOk).hint).toMatch(/synthetic/);
  });

  it('reports malformed key material after synthetic checks', () => {
    const inspected = inspectSubscription(row({ p256dh: 'invalid', auth: 'invalid' }));
    expect(summarizeDiagnostics([inspected], [], vapidOk).hint).toMatch(/malformed key material/);
  });

  it('reports all-delivered, rotation, expiry, other-failure and dry-run hints', () => {
    const inspected = inspectSubscription(row());
    expect(summarizeDiagnostics([inspected], [attempt('ok', 201, true)], vapidOk).hint).toMatch(/All attempted devices accepted/);
    expect(summarizeDiagnostics([inspected], [attempt('forbidden', 403)], vapidOk).hint).toMatch(/VAPID key rotation or an authorization mismatch/);
    expect(summarizeDiagnostics([inspected], [attempt('expired', 410)], vapidOk).hint).toMatch(/retirement was not confirmed/);
    expect(summarizeDiagnostics([inspected], [{ ...attempt('expired', 410), retired: true }], vapidOk).hint).toMatch(/row was retired/);
    expect(summarizeDiagnostics([inspected], [attempt('network', 0)], vapidOk).hint).toMatch(/delivery failed/);
    expect(summarizeDiagnostics([inspected], [], vapidOk).hint).toMatch(/Dry run/);
  });

  it('counts delivery results by push attempt', () => {
    const inspections: SubscriptionInspection[] = [inspectSubscription(row())];
    const summary = summarizeDiagnostics(inspections, [attempt('ok', 201, true), attempt('expired', 410)], vapidOk);
    expect(summary).toMatchObject({ attempted: 2, delivered: 1, expired: 1, rejected: 0, otherFailures: 0 });
  });
});
