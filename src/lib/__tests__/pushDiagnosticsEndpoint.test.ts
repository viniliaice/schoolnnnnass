// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import handler from '../../../api/push/diagnostics';
import { createFakeNetwork, deviceKeys, makeReqRes, setServerEnv, validVapidEnv } from './helpers/fakeNetwork';

const supabaseEnv = {
  SUPABASE_URL: 'https://school-test.supabase.co',
  SUPABASE_ANON_KEY: 'anon-test-key',
  SUPABASE_SERVICE_ROLE_KEY: 'service-role-secret-for-test',
};
let restoreEnv: (() => void) | null = null;
const endpointPath = '/fcm/send/very-secret-registration-token-123';
function sub(id = 'subscription-1', userId = 'teacher-1', active = true) {
  return {
    id,
    user_id: userId,
    endpoint: `https://fcm.googleapis.com${endpointPath}`,
    ...deviceKeys(),
    is_active: active,
    device_type: 'mobile',
    browser: 'safari',
    created_at: '2026-10-01T00:00:00Z',
  };
}
async function invoke(fake: ReturnType<typeof createFakeNetwork>, body: any = { dryRun: true }, token = 'valid-token') {
  vi.stubGlobal('fetch', fake.fetchImpl);
  const { req, res } = makeReqRes({ method: 'POST', authorization: token ? `Bearer ${token}` : undefined, body });
  await handler(req, res);
  return res;
}

beforeEach(() => {
  restoreEnv = setServerEnv({ ...supabaseEnv, ...(() => {
    const env = validVapidEnv();
    return { VAPID_PRIVATE_KEY: env.VAPID_PRIVATE_KEY, VAPID_SUBJECT: env.VAPID_SUBJECT };
  })(), NODE_ENV: 'production' });
});
afterEach(() => {
  vi.unstubAllGlobals();
  restoreEnv?.();
  restoreEnv = null;
});

describe('POST /api/push/diagnostics', () => {
  it('requires an admin/supervisor bearer session and rejects expired sessions', async () => {
    const noAuth = createFakeNetwork();
    expect((await invoke(noAuth, {}, '')).statusCode).toBe(401);
    const teacher = createFakeNetwork({ role: 'teacher' });
    expect((await invoke(teacher)).statusCode).toBe(403);
    const expired = createFakeNetwork({ invalidSession: true });
    expect((await invoke(expired)).statusCode).toBe(401);
  });

  it('dry run reads rows but contacts no push service', async () => {
    const fake = createFakeNetwork({ subscriptions: [sub()] });
    const res = await invoke(fake, { dryRun: true });
    expect(res.statusCode).toBe(200);
    expect(res.body.dryRun).toBe(true);
    expect(res.body.summary.attempted).toBe(0);
    expect(fake.state.pushes).toHaveLength(0);
    expect(fake.state.selects.some((entry) => entry.table === 'push_subscriptions')).toBe(true);
  });

  it('performs a real test push and reports expired status', async () => {
    const fake = createFakeNetwork({ subscriptions: [sub()], pushReplies: [{ status: 410, body: 'Gone' }] });
    const res = await invoke(fake, { dryRun: false });
    expect(res.statusCode).toBe(200);
    expect(res.body.dryRun).toBe(false);
    expect(res.body.deliveryOk).toBe(false);
    expect(res.body.summary).toMatchObject({ attempted: 1, delivered: 0, expired: 1, retired: 1, retirementFailed: 0 });
    expect(res.body.subscriptions[0]).toMatchObject({ status: 410, expired: true, retired: true, failureCode: 'expired' });
    expect(fake.subscriptions[0].is_active).toBe(false);
    expect(fake.state.pushes).toHaveLength(1);
  });

  it('requires at least one accepted device before reporting diagnostic delivery success', async () => {
    const noDevices = createFakeNetwork();
    const empty = await invoke(noDevices, { dryRun: false });
    expect(empty.body).toMatchObject({ ok: false, deliveryOk: false, dryRun: false });
    expect(empty.body.summary.attempted).toBe(0);

    const accepted = createFakeNetwork({ subscriptions: [sub()], pushReplies: [{ status: 201, body: '' }] });
    const sent = await invoke(accepted, { dryRun: false });
    expect(sent.body).toMatchObject({ ok: true, deliveryOk: true });
    expect(sent.body.summary).toMatchObject({ attempted: 1, delivered: 1 });
  });

  it('forces dry run and gives the VAPID hint when configuration is unusable', async () => {
    const valid = validVapidEnv();
    restoreEnv?.();
    restoreEnv = setServerEnv({ ...supabaseEnv, VAPID_PRIVATE_KEY: valid.VAPID_PRIVATE_KEY, VAPID_SUBJECT: `[${valid.VAPID_SUBJECT}](${valid.VAPID_SUBJECT})`, NODE_ENV: 'production' });
    const fake = createFakeNetwork({ subscriptions: [sub()] });
    const res = await invoke(fake, { dryRun: false });
    expect(res.statusCode).toBe(200);
    expect(res.body.dryRun).toBe(true);
    expect(res.body.vapid.ok).toBe(false);
    expect(res.body.summary.hint).toMatch(/VAPID configuration is invalid/);
    expect(fake.state.pushes).toHaveLength(0);
  });

  it('supports teacherId scoping and diagnoses synthetic endpoints', async () => {
    const first = sub('one', 'teacher-1');
    first.endpoint = 'https://preview.push.local/subscribe/private-token';
    const second = sub('two', 'teacher-2');
    const fake = createFakeNetwork({ subscriptions: [first, second] });
    const res = await invoke(fake, { dryRun: true, teacherId: 'teacher-1' });
    expect(res.body.subscriptions).toHaveLength(1);
    expect(res.body.subscriptions[0].endpointHost).toBe('preview.push.local');
    expect(res.body.subscriptions[0].endpointLooksSynthetic).toBe(true);
    expect(res.body.summary.hint).toMatch(/synthetic/);
    expect(fake.state.selects.find((entry) => entry.table === 'push_subscriptions')?.query).toContain('teacher-1');
  });

  it('never returns endpoint paths, keys, VAPID private key, service role key, or bearer token', async () => {
    const env = validVapidEnv();
    const row = sub();
    const fake = createFakeNetwork({ subscriptions: [row] });
    const res = await invoke(fake, { dryRun: true }, 'top-secret-valid-token');
    const serialized = JSON.stringify(res.body);
    expect(serialized).not.toContain(endpointPath.slice(1));
    expect(serialized).not.toContain(row.p256dh);
    expect(serialized).not.toContain(row.auth);
    expect(serialized).not.toContain(env.VAPID_PRIVATE_KEY);
    expect(serialized).not.toContain(supabaseEnv.SUPABASE_SERVICE_ROLE_KEY);
    expect(serialized).not.toContain('top-secret-valid-token');
    expect(res.body.subscriptions[0].endpointHost).toBe('fcm.googleapis.com');
  });
});
