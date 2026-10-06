// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import handler from '../../../api/notifications/send';
import { deviceKeys, createFakeNetwork, makeReqRes, setServerEnv, validVapidEnv } from './helpers/fakeNetwork';

const requestBody = {
  audience: 'teachers',
  teacherIds: ['teacher-1'],
  title: 'Staff meeting',
  body: 'Tomorrow at 8.',
  category: 'announcement',
};
const supabaseEnv = {
  SUPABASE_URL: 'https://school-test.supabase.co',
  SUPABASE_ANON_KEY: 'anon-test-key',
  SUPABASE_SERVICE_ROLE_KEY: 'service-role-test-key',
};
let restoreEnv: (() => void) | null = null;

function sub(userId = 'teacher-1', id = 'sub-1', endpoint = 'https://fcm.googleapis.com/fcm/send/device-token-123') {
  return { id, user_id: userId, endpoint, ...deviceKeys(), is_active: true };
}

async function invoke(options: { token?: string; body?: any; method?: string } = {}) {
  const { req, res } = makeReqRes({
    method: options.method ?? 'POST',
    authorization: options.token ? `Bearer ${options.token}` : undefined,
    body: options.body ?? requestBody,
  });
  await handler(req, res);
  return res;
}

beforeEach(() => {
  restoreEnv = setServerEnv({ ...supabaseEnv, ...validVapidEnv(), NODE_ENV: 'production' });
});
afterEach(() => {
  vi.unstubAllGlobals();
  restoreEnv?.();
  restoreEnv = null;
});

describe('POST /api/notifications/send', () => {
  it('rejects missing or expired bearer sessions before service-role work', async () => {
    const fake = createFakeNetwork();
    vi.stubGlobal('fetch', fake.fetchImpl);
    expect((await invoke()).statusCode).toBe(401);
    expect((await invoke({ token: 'bad-token' })).statusCode).toBe(401);
    expect(fake.state.inserts).toHaveLength(0);
  });

  it('requires the admin/supervisor role', async () => {
    const fake = createFakeNetwork({ role: 'teacher' });
    vi.stubGlobal('fetch', fake.fetchImpl);
    const res = await invoke({ token: 'valid-token' });
    expect(res.statusCode).toBe(403);
    expect(fake.state.inserts).toHaveLength(0);
  });

  it('accepts the supervisor role and rejects the production invalid-refresh-token RPC result', async () => {
    const supervisor = createFakeNetwork({ role: 'supervisor' });
    vi.stubGlobal('fetch', supervisor.fetchImpl);
    expect((await invoke({ token: 'valid-token' })).statusCode).toBe(200);
    const expired = createFakeNetwork({ invalidSession: true });
    vi.stubGlobal('fetch', expired.fetchImpl);
    const expiredRes = await invoke({ token: 'valid-token' });
    expect(expiredRes.statusCode).toBe(401);
    expect(expiredRes.body.error).toMatch(/Invalid or expired/);
  });

  it('returns 400 for an invalid send body without writing notification rows', async () => {
    const fake = createFakeNetwork();
    vi.stubGlobal('fetch', fake.fetchImpl);
    const res = await invoke({ token: 'valid-token', body: { ...requestBody, title: '' } });
    expect(res.statusCode).toBe(400);
    expect(res.body.error).toMatch(/title/);
    expect(fake.state.inserts).toHaveLength(0);
  });

  it('rejects GET with 405', async () => {
    const res = await invoke({ method: 'GET' });
    expect(res.statusCode).toBe(405);
    expect(res.headers.allow).toBe('POST');
  });

  it('rejects Markdown VAPID_SUBJECT before auth, database reads, or pushes', async () => {
    const valid = validVapidEnv();
    restoreEnv?.();
    restoreEnv = setServerEnv({ ...supabaseEnv, ...valid, VAPID_SUBJECT: `[mailto:${'admin@school.example'}](mailto:admin@school.example)`, NODE_ENV: 'production' });
    const fake = createFakeNetwork();
    vi.stubGlobal('fetch', fake.fetchImpl);
    const res = await invoke();
    expect(res.statusCode).toBe(500);
    expect(res.body.code).toBe('VAPID_CONFIG_INVALID');
    expect(res.body.problems.join(' ')).toMatch(/Markdown/);
    expect(JSON.stringify(res.body)).not.toContain(valid.VAPID_PRIVATE_KEY);
    expect(fake.state.requests).toHaveLength(0);
    expect(fake.state.inserts).toHaveLength(0);
  });

  it('records one recipient and one accepted device as delivered', async () => {
    const fake = createFakeNetwork({ subscriptions: [sub()] });
    vi.stubGlobal('fetch', fake.fetchImpl);
    const res = await invoke({ token: 'valid-token' });
    expect(res.statusCode).toBe(200);
    expect(res.body).toMatchObject({ sent: 1, totalRecipients: 1, devicesDelivered: 1, devicesFailed: 0, deliveryOk: true });
    expect(res.body.outcome).toMatchObject({ recipients: 1, devices: 1, sent: 1, failed: 0 });
    expect(fake.state.pushes).toHaveLength(1);
    expect(fake.state.inserts.find((entry) => entry.table === 'notification_recipients')?.body[0].status).toBe('pending');
    expect(fake.state.patches.find((entry) => entry.table === 'notification_recipients')?.body).toMatchObject({ status: 'sent', delivered_devices: 1, failed_devices: 0 });
  });

  it('stores sanitized HTTP 400 details and keeps the subscription active', async () => {
    const row = sub();
    const fake = createFakeNetwork({ subscriptions: [row], pushReplies: [{ status: 400, body: 'InvalidSubscription request rejected' }] });
    vi.stubGlobal('fetch', fake.fetchImpl);
    const res = await invoke({ token: 'valid-token' });
    const recipientPatch = fake.state.patches.find((entry) => entry.table === 'notification_recipients')?.body;
    expect(res.body.deliveryOk).toBe(false);
    expect(res.body.failed).toBe(1);
    expect(recipientPatch.last_error).toContain('bad_request');
    expect(recipientPatch.last_error).toContain('HTTP 400');
    expect(row.is_active).toBe(true);
    expect(fake.state.patches.some((entry) => entry.table === 'push_subscriptions')).toBe(false);
  });

  it.each([404, 410])('retires expired subscription after HTTP %i', async (status) => {
    const row = sub();
    const fake = createFakeNetwork({ subscriptions: [row], pushReplies: [{ status, body: 'Gone' }] });
    vi.stubGlobal('fetch', fake.fetchImpl);
    const res = await invoke({ token: 'valid-token' });
    expect(res.body.devicesExpired).toBe(1);
    expect(res.body.devicesDelivered).toBe(0);
    expect(res.body.deactivatedSubscriptions).toBe(1);
    expect(row.is_active).toBe(false);
    expect(fake.state.patches.find((entry) => entry.table === 'notification_recipients')?.body.last_error).toContain('expired');
  });

  it('keeps a 403 sender-key mismatch for safe device re-registration', async () => {
    const row = sub();
    const fake = createFakeNetwork({ subscriptions: [row], pushReplies: [{ status: 403, body: 'sender key mismatch' }] });
    vi.stubGlobal('fetch', fake.fetchImpl);
    const res = await invoke({ token: 'valid-token' });
    expect(res.body.devicesRejected).toBe(1);
    expect(res.body.deactivatedSubscriptions).toBe(0);
    expect(row.is_active).toBe(true);
    expect(fake.state.patches.find((entry) => entry.table === 'push_subscriptions')).toBeUndefined();
    expect(res.body.recipients[0].lastError).toMatch(/kept subscription for safety/);
  });

  it.each(['Unauthorized', 'BadJwtToken: invalid token'])('keeps a subscription when 401/403 body indicates a VAPID token problem (%s)', async (body) => {
    const row = sub();
    const fake = createFakeNetwork({ subscriptions: [row], pushReplies: [{ status: body === 'Unauthorized' ? 401 : 403, body }] });
    vi.stubGlobal('fetch', fake.fetchImpl);
    const res = await invoke({ token: 'valid-token' });
    expect(res.body.deactivatedSubscriptions).toBe(0);
    expect(row.is_active).toBe(true);
    expect(fake.state.patches.find((entry) => entry.table === 'notification_recipients')?.body.last_error).toContain('check VAPID_PRIVATE_KEY/VAPID_SUBJECT');
  });

  it.each([429, 503])('keeps retryable HTTP %i subscriptions active', async (status) => {
    const row = sub();
    const fake = createFakeNetwork({ subscriptions: [row], pushReplies: [{ status, body: 'retry later' }] });
    vi.stubGlobal('fetch', fake.fetchImpl);
    const res = await invoke({ token: 'valid-token' });
    expect(res.body.devicesFailed).toBe(1);
    expect(res.body.deactivatedSubscriptions).toBe(0);
    expect(row.is_active).toBe(true);
  });

  it('classifies DNS failure as network and never retires the row', async () => {
    const row = sub();
    const dns = Object.assign(new Error('getaddrinfo ENOTFOUND fcm.googleapis.com'), { code: 'ENOTFOUND', hostname: 'fcm.googleapis.com' });
    const fake = createFakeNetwork({ subscriptions: [row], pushReplies: [{ networkError: dns }] });
    vi.stubGlobal('fetch', fake.fetchImpl);
    const res = await invoke({ token: 'valid-token' });
    expect(res.body.recipients[0].failureCode).toBe('network');
    expect(res.body.recipients[0].lastError).toContain('ENOTFOUND');
    expect(res.body.deactivatedSubscriptions).toBe(0);
    expect(row.is_active).toBe(true);
  });

  it('treats malformed stored keys as pre-flight failures without a push call', async () => {
    const row = { ...sub(), p256dh: 'not-a-point', auth: 'bad' };
    const fake = createFakeNetwork({ subscriptions: [row] });
    vi.stubGlobal('fetch', fake.fetchImpl);
    const res = await invoke({ token: 'valid-token' });
    expect(res.body.devicesFailed).toBe(1);
    expect(res.body.recipients[0].failureCode).toBe('bad_request');
    expect(fake.state.pushes).toHaveLength(0);
    expect(row.is_active).toBe(true);
  });

  it('reports independent per-device outcomes for partial success', async () => {
    const rows = [sub('teacher-1', 'a', 'https://fcm.googleapis.com/fcm/send/device-a'), sub('teacher-1', 'b', 'https://fcm.googleapis.com/fcm/send/device-b')];
    const fake = createFakeNetwork({ subscriptions: rows, pushReplies: [{ status: 201 }, { status: 503, body: 'temporarily unavailable' }] });
    vi.stubGlobal('fetch', fake.fetchImpl);
    const res = await invoke({ token: 'valid-token' });
    expect(res.body).toMatchObject({ sent: 1, failed: 0, devicesDelivered: 1, devicesFailed: 1, deliveryOk: false });
    expect(res.body.recipients[0]).toMatchObject({ status: 'sent', deliveredDevices: 1, failedDevices: 1 });
    expect(fake.state.patches.find((entry) => entry.table === 'notification_recipients')?.body).toMatchObject({ delivered_devices: 1, failed_devices: 1 });
  });

  it('returns an all-zero outcome for an empty audience and marks teachers with no devices honestly', async () => {
    const empty = createFakeNetwork({ teachers: [] });
    vi.stubGlobal('fetch', empty.fetchImpl);
    const emptyRes = await invoke({ token: 'valid-token' });
    expect(emptyRes.body.outcome).toMatchObject({ recipients: 0, devices: 0, sent: 0, failed: 0, noDevices: 0 });

    const none = createFakeNetwork({ subscriptions: [] });
    vi.stubGlobal('fetch', none.fetchImpl);
    const noDeviceRes = await invoke({ token: 'valid-token' });
    expect(noDeviceRes.body.noDevices).toBe(1);
    expect(noDeviceRes.body.deliveryOk).toBe(false);
    expect(none.state.pushes).toHaveLength(0);
  });
});
