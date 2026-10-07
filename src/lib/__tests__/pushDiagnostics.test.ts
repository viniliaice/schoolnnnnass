// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { inspectSubscription, summarizeDiagnostics, type DiagnosticPushAttempt } from '../../../server/lib/pushDiagnostics';
import { validateVapidConfig, generateVapidKeys } from '../../../server/lib/webpush';
import { deviceKeys } from './helpers/fakeNetwork';

const vapidKeys = generateVapidKeys();
const validVapid = validateVapidConfig({ privateKey: vapidKeys.privateKey, subject: 'mailto:admin@example.test' });

function row(overrides: Record<string, unknown> = {}) {
  return {
    id: 'sub-1',
    user_id: 'teacher-1',
    endpoint: 'https://fcm.googleapis.com/fcm/send/registration-secret-path',
    ...deviceKeys(),
    is_active: true,
    device_type: 'mobile',
    browser: 'safari',
    created_at: '2026-10-06T12:00:00Z',
    ...overrides,
  };
}

function attempt(failureCode: DiagnosticPushAttempt['failureCode'], status: number, ok = false): DiagnosticPushAttempt {
  return { status, ok, expired: failureCode === 'expired', failureCode };
}

describe('push subscription inspection', () => {
  it('reports host and valid key shape without returning endpoint path or key material', () => {
    const source = row();
    const inspection = inspectSubscription(source);
    expect(inspection).toMatchObject({
      id: 'sub-1', userId: 'teacher-1', endpointHost: 'fcm.googleapis.com',
      endpointLooksSynthetic: false, isActive: true, deviceType: 'mobile', browser: 'safari',
      p256dhLooksLikePoint: true, p256dhBytes: 65, authLooksValid: true, authBytes: 16,
    });
    const serialized = JSON.stringify(inspection);
    expect(serialized).not.toContain('registration-secret-path');
    expect(serialized).not.toContain(source.p256dh);
    expect(serialized).not.toContain(source.auth);
  });

  it('flags fake preview hosts and malformed key material', () => {
    const inspection = inspectSubscription(row({ endpoint: 'https://preview.push.local/subscribe/fake-token', p256dh: 'bad', auth: 'short' }));
    expect(inspection.endpointLooksSynthetic).toBe(true);
    expect(inspection.p256dhLooksLikePoint).toBe(false);
    expect(inspection.authLooksValid).toBe(false);
    expect(inspection.problems.join(' ')).toMatch(/synthetic|p256dh|auth/);
  });
});

describe('diagnostic hint priority', () => {
  it('prioritizes invalid VAPID configuration', () => {
    const invalid = validateVapidConfig({ privateKey: '', subject: '[mailto:x](mailto:x)' });
    const summary = summarizeDiagnostics([inspectSubscription(row())], [], invalid);
    expect(summary.hint).toMatch(/VAPID configuration is invalid/);
  });

  it('reports no active subscriptions before inspecting outcomes', () => {
    const summary = summarizeDiagnostics([inspectSubscription(row({ is_active: false }))], [], validVapid);
    expect(summary.hint).toMatch(/No active device subscriptions/);
  });

  it('flags synthetic endpoints before malformed keys', () => {
    const inspection = inspectSubscription(row({ endpoint: 'https://preview.push.local/a', p256dh: 'bad' }));
    const summary = summarizeDiagnostics([inspection], [], validVapid);
    expect(summary.hint).toMatch(/synthetic/);
  });

  it('flags malformed keys before attempting a test push', () => {
    const inspection = inspectSubscription(row({ auth: 'bad' }));
    const summary = summarizeDiagnostics([inspection], [], validVapid);
    expect(summary.hint).toMatch(/malformed/);
  });

  it('reports all-success results as accepted and asks the admin to confirm on-device display', () => {
    const summary = summarizeDiagnostics([inspectSubscription(row())], [attempt('ok', 201, true)], validVapid);
    expect(summary).toMatchObject({ attempted: 1, delivered: 1, expired: 0, rejected: 0, otherFailures: 0 });
    expect(summary.hint).toMatch(/accepted by their push services/);
  });

  it('detects a likely VAPID rotation when every otherwise-valid device rejects authorization', () => {
    const summary = summarizeDiagnostics(
      [inspectSubscription(row()), inspectSubscription(row({ id: 'sub-2' }))],
      [attempt('forbidden', 403), attempt('unauthorized', 401)],
      validVapid,
    );
    expect(summary).toMatchObject({ attempted: 2, rejected: 2, delivered: 0 });
    expect(summary.hint).toMatch(/older public key/);
    expect(summary.hint).toMatch(/Fix notifications/);
  });

  it('reports expired devices, other failures and dry-run hints', () => {
    const inspection = inspectSubscription(row());
    expect(summarizeDiagnostics([inspection], [attempt('expired', 410)], validVapid).hint).toMatch(/expired/);
    expect(summarizeDiagnostics([inspection], [attempt('network', 0)], validVapid).hint).toMatch(/network failed/);
    expect(summarizeDiagnostics([inspection], [], validVapid).hint).toMatch(/dry-run inspection/);
  });
});
