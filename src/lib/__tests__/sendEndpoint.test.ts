// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest';
import sendHandler from '../../../api/notifications/send';
import { deviceKeys, createFakeNetwork, makeReqRes, setServerEnv, validVapidEnv, type FakeSubscription } from './helpers/fakeNetwork';

let restoreEnv: (() => void) | null = null;
afterEach(() => {
  restoreEnv?.();
  restoreEnv = null;
  vi.unstubAllGlobals();
});

function setup(subscriptions: FakeSubscription[] = [], overrides: Record<string, string | undefined> = {}) {
  const env = { ...validVapidEnv(), ...overrides };
  restoreEnv = setServerEnv(env);
  const network = createFakeNetwork({ subscriptions });
  vi.stubGlobal('fetch', network.fetchImpl);
  return { network, env };
}

function oneDevice(id = 's1', userId = 'teacher-1', endpoint = 'https://push.example.test/send/registration-secret') {
  return { id, user_id: userId, endpoint, ...deviceKeys(), is_active: true };
}

const sendRequest = {
  audience: 'teachers',
  teacherIds: ['teacher-1'],
  title: 'Staff meeting',
  body: 'Tomorrow at 8 AM.',
  category: 'announcement',
};

async function call(method = 'POST', body: unknown = sendRequest, token: string | null = 'admin-token') {
  const { req, res } = makeReqRes(method, body, token);
  await sendHandler(req, res);
  return res;
}

describe('POST /api/notifications/send end-to-end', () => {
  it('rejects a missing bearer token', async () => {
    setup();
    const res = await call('POST', sendRequest, null);
    expect(res.statusCode).toBe(401);
    expect(res.body.error).toMatch(/bearer token/);
  });

  it('rejects an expired refresh/access token with 401', async () => {
    setup();
    const res = await call('POST', sendRequest, 'expired-token');
    expect(res.statusCode).toBe(401);
    expect(res.body.error).toMatch(/Invalid or expired/);
  });

  it('rejects teacher role but allows supervisor role', async () => {
    setup([oneDevice()]);
    const denied = await call('POST', sendRequest, 'teacher-token');
    expect(denied.statusCode).toBe(403);
    const allowed = await call('POST', { ...sendRequest, teacherIds: ['teacher-1'] }, 'supervisor-token');
    expect(allowed.statusCode).toBe(200);
    expect(allowed.body.deliveryOk).toBe(true);
  });

  it('rejects academic reminder categories outside the eligibility-enforcing endpoint', async () => {
    const { network } = setup([oneDevice()]);
    const res = await call('POST', {
      audience: 'teachers',
      teacherIds: ['teacher-1'],
      title: 'Lesson plan reminder',
      body: 'Complete a lesson plan.',
      category: 'lesson_plan_reminder',
      reminder: { reminderType: 'lesson_plan_reminder' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.body.error).toContain('/api/academic-reminders/send');
    expect(network.state.pushes).toHaveLength(0);
    expect(network.state.inserts).toHaveLength(0);
  });

  it('returns 405 for GET without touching subscriptions', async () => {
    const { network } = setup([oneDevice()]);
    const res = await call('GET');
    expect(res.statusCode).toBe(405);
    expect(res.headers.allow).toBe('POST');
    expect(network.state.pushes).toHaveLength(0);
  });

  it('fails closed on Markdown VAPID subject before auth/database/push work', async () => {
    const { network, env } = setup([oneDevice()], {
      VAPID_SUBJECT: '[mailto:admin@example.test](mailto:admin@example.test)',
    });
    const res = await call('POST', sendRequest, 'admin-token');
    expect(res.statusCode).toBe(500);
    expect(res.body.code).toBe('VAPID_CONFIG_INVALID');
    expect(res.body.vapid.subjectValid).toBe(false);
    expect(network.state.pushes).toHaveLength(0);
    expect(network.state.inserts).toHaveLength(0);
    expect(network.state.selects).toHaveLength(0);
    expect(JSON.stringify(res.body)).not.toContain(env.VAPID_PRIVATE_KEY);
    expect(JSON.stringify(res.body)).not.toContain(env.SUPABASE_SERVICE_ROLE_KEY);
  });

  it('delivers to one device and returns counts without key material', async () => {
    const sub = oneDevice();
    const { network, env } = setup([sub]);
    const res = await call();
    expect(res.statusCode).toBe(200);
    expect(res.body).toMatchObject({
      totalRecipients: 1,
      sent: 1,
      devicesDelivered: 1,
      devicesFailed: 0,
      deliveryOk: true,
      outcome: { recipients: 1, devices: 1, sent: 1, failed: 0 },
    });
    expect(network.state.pushes).toHaveLength(1);
    expect(network.state.pushes[0].url).toBe(sub.endpoint);
    expect(network.state.recipients[0]).toMatchObject({ status: 'sent', delivered_devices: 1, failed_devices: 0 });
    expect(JSON.stringify(res.body)).not.toContain(env.VAPID_PRIVATE_KEY);
    expect(JSON.stringify(res.body)).not.toContain(sub.endpoint);
  });

  it('keeps a 400 subscription row active and records the push-service detail', async () => {
    const env = { ...validVapidEnv() };
    restoreEnv = setServerEnv(env);
    const network = createFakeNetwork({ subscriptions: [oneDevice()], pushReplies: [{ status: 400, body: 'InvalidSubscription' }] });
    vi.stubGlobal('fetch', network.fetchImpl);
    const res = await call();
    expect(res.statusCode).toBe(200);
    expect(res.body).toMatchObject({ deliveryOk: false, devicesFailed: 1, failed: 1 });
    expect(res.body.recipients[0].failureCode).toBe('bad_request');
    expect(res.body.recipients[0].lastError).toContain('HTTP 400');
    expect(network.state.subscriptions[0].is_active).toBe(true);
  });

  it('auto-retires 410 endpoints and records them as expired, not delivered', async () => {
    restoreEnv = setServerEnv(validVapidEnv());
    const network = createFakeNetwork({ subscriptions: [oneDevice()], pushReplies: [{ status: 410, body: 'Gone' }] });
    vi.stubGlobal('fetch', network.fetchImpl);
    const res = await call();
    expect(res.body).toMatchObject({ deliveryOk: false, devicesDelivered: 0, devicesExpired: 1, deactivatedSubscriptions: 1 });
    expect(res.body.recipients[0].lastError).toContain('subscription expired (HTTP 410)');
    expect(network.state.subscriptions[0].is_active).toBe(false);
  });

  it('does not retire subscriptions for BadJwtToken or invalid VAPID authentication', async () => {
    restoreEnv = setServerEnv(validVapidEnv());
    const network = createFakeNetwork({ subscriptions: [oneDevice()], pushReplies: [{ status: 403, body: 'BadJwtToken' }] });
    vi.stubGlobal('fetch', network.fetchImpl);
    const res = await call();
    expect(res.body.devicesRejected).toBe(1);
    expect(res.body.deactivatedSubscriptions).toBe(0);
    expect(res.body.recipients[0].lastError).toContain('check VAPID_PRIVATE_KEY/VAPID_SUBJECT');
    expect(network.state.subscriptions[0].is_active).toBe(true);
  });

  it('preserves a rejected row for a 403 even with syntactically valid VAPID configuration', async () => {
    restoreEnv = setServerEnv(validVapidEnv());
    const network = createFakeNetwork({ subscriptions: [oneDevice()], pushReplies: [{ status: 403, body: 'subscription rejected' }] });
    vi.stubGlobal('fetch', network.fetchImpl);
    const res = await call();
    expect(res.body.vapid.ok).toBe(true);
    expect(res.body.devicesRejected).toBe(1);
    expect(res.body.deactivatedSubscriptions).toBe(0);
    expect(network.state.subscriptions[0].is_active).toBe(true);
    expect(res.body.recipients[0].lastError).toContain('check VAPID_PRIVATE_KEY/VAPID_SUBJECT');
  });

  it.each([429, 503])('keeps subscriptions for retryable HTTP %i failures', async (status) => {
    restoreEnv = setServerEnv(validVapidEnv());
    const network = createFakeNetwork({ subscriptions: [oneDevice()], pushReplies: [{ status, body: 'retry later' }] });
    vi.stubGlobal('fetch', network.fetchImpl);
    const res = await call();
    expect(res.body.deliveryOk).toBe(false);
    expect(network.state.subscriptions[0].is_active).toBe(true);
  });

  it('treats DNS failure as network, never expired', async () => {
    restoreEnv = setServerEnv(validVapidEnv());
    const network = createFakeNetwork({ subscriptions: [oneDevice()], pushReplies: [new Error('getaddrinfo ENOTFOUND push.example.test')] });
    vi.stubGlobal('fetch', network.fetchImpl);
    const res = await call();
    expect(res.body.recipients[0].failureCode).toBe('network');
    expect(res.body.devicesExpired).toBe(0);
    expect(res.body.deactivatedSubscriptions).toBe(0);
    expect(network.state.subscriptions[0].is_active).toBe(true);
  });

  it('handles malformed stored key material before the network call', async () => {
    restoreEnv = setServerEnv(validVapidEnv());
    const network = createFakeNetwork({ subscriptions: [{ ...oneDevice(), p256dh: 'bad', auth: 'bad' }] });
    vi.stubGlobal('fetch', network.fetchImpl);
    const res = await call();
    expect(res.body.deliveryOk).toBe(false);
    expect(res.body.recipients[0].failureCode).toBe('bad_request');
    expect(network.state.pushes).toHaveLength(0);
    expect(network.state.subscriptions[0].is_active).toBe(true);
  });

  it('reports partial multi-device success in persisted recipient counts', async () => {
    restoreEnv = setServerEnv(validVapidEnv());
    const network = createFakeNetwork({
      subscriptions: [oneDevice('s1', 'teacher-1', 'https://push.example.test/device/one'), oneDevice('s2', 'teacher-1', 'https://push.example.test/device/two')],
      pushReplies: [{ status: 201 }, { status: 503, body: 'temporarily unavailable' }],
    });
    vi.stubGlobal('fetch', network.fetchImpl);
    const res = await call();
    expect(res.body).toMatchObject({ deliveryOk: false, devicesDelivered: 1, devicesFailed: 1, sent: 1, failed: 0 });
    expect(network.state.recipients[0]).toMatchObject({ status: 'sent', delivered_devices: 1, failed_devices: 1 });
  });

  it('returns honest no-device and empty-audience counts', async () => {
    restoreEnv = setServerEnv(validVapidEnv());
    const network = createFakeNetwork({ subscriptions: [] });
    vi.stubGlobal('fetch', network.fetchImpl);
    const noDevices = await call();
    expect(noDevices.body).toMatchObject({ deliveryOk: false, noDevices: 1, devicesDelivered: 0, devicesFailed: 0 });
    expect(network.state.pushes).toHaveLength(0);

    const empty = createFakeNetwork({ profiles: [], subscriptions: [] });
    vi.stubGlobal('fetch', empty.fetchImpl);
    const noRecipients = await call();
    expect(noRecipients.body.outcome).toEqual({ recipients: 0, devices: 0, sent: 0, failed: 0, expired: 0, expiredRecipients: 0, rejected: 0, skipped: 0, noDevices: 0, noSubscription: 0, alreadyReminded: 0, taskAlreadyCompleted: 0 });
  });
});
