// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest';
import diagnosticsHandler from '../../../api/push/diagnostics';
import { createFakeNetwork, deviceKeys, makeReqRes, setServerEnv, validVapidEnv, type FakeSubscription } from './helpers/fakeNetwork';

let restoreEnv: (() => void) | null = null;
afterEach(() => {
  restoreEnv?.();
  restoreEnv = null;
  vi.unstubAllGlobals();
});

function subscription(id = 's1', userId = 'teacher-1', host = 'push.example.test'): FakeSubscription {
  return {
    id,
    user_id: userId,
    endpoint: `https://${host}/subscribe/registration-secret-${id}`,
    ...deviceKeys(),
    is_active: true,
    device_type: 'mobile',
    browser: 'safari',
    created_at: '2026-10-06T12:00:00Z',
  };
}

function setup(subscriptions: FakeSubscription[] = [], overrides: Record<string, string | undefined> = {}, options: Parameters<typeof createFakeNetwork>[0] = {}) {
  restoreEnv = setServerEnv({ ...validVapidEnv(), ...overrides });
  const network = createFakeNetwork({ ...options, subscriptions });
  vi.stubGlobal('fetch', network.fetchImpl);
  return network;
}

async function call(body: unknown, token: string | null = 'admin-token', method = 'POST') {
  const { req, res } = makeReqRes(method, body, token);
  await diagnosticsHandler(req, res);
  return res;
}

describe('POST /api/push/diagnostics', () => {
  it('requires admin/supervisor bearer authentication', async () => {
    setup([subscription()]);
    expect((await call({}, null)).statusCode).toBe(401);
    expect((await call({}, 'expired-token')).statusCode).toBe(401);
    expect((await call({}, 'teacher-token')).statusCode).toBe(403);
  });

  it('supports GET rejection and defaults to a no-network dry run', async () => {
    const network = setup([subscription()]);
    const wrongMethod = await call({}, 'admin-token', 'GET');
    expect(wrongMethod.statusCode).toBe(405);
    expect(wrongMethod.headers.allow).toBe('POST');

    const res = await call({ dryRun: true });
    expect(res.statusCode).toBe(200);
    expect(res.body.dryRun).toBe(true);
    expect(res.body.summary.attempted).toBe(0);
    expect(res.body.subscriptions[0].push).toBeNull();
    expect(network.state.pushes).toHaveLength(0);
  });

  it('sends a requested real test push and reports the push-service status', async () => {
    restoreEnv = setServerEnv(validVapidEnv());
    const network = createFakeNetwork({ subscriptions: [subscription()], pushReplies: [{ status: 201, body: '' }] });
    vi.stubGlobal('fetch', network.fetchImpl);
    const res = await call({ dryRun: false });
    expect(res.body.dryRun).toBe(false);
    expect(res.body.summary).toMatchObject({ attempted: 1, delivered: 1, expired: 0, rejected: 0 });
    expect(res.body.subscriptions[0].push).toMatchObject({ status: 201, ok: true, failureCode: 'ok' });
    expect(network.state.pushes).toHaveLength(1);
  });

  it('reports 410 as expired without exposing or persisting secrets in the response', async () => {
    const sub = subscription();
    const env = validVapidEnv();
    restoreEnv = setServerEnv(env);
    const network = createFakeNetwork({ subscriptions: [sub], pushReplies: [{ status: 410, body: 'Gone' }] });
    vi.stubGlobal('fetch', network.fetchImpl);
    const res = await call({ dryRun: false });
    expect(res.body.summary).toMatchObject({ attempted: 1, expired: 1, delivered: 0 });
    expect(res.body.subscriptions[0].push).toMatchObject({ status: 410, expired: true, failureCode: 'expired' });
    const serialized = JSON.stringify(res.body);
    expect(serialized).not.toContain('/subscribe/registration-secret');
    expect(serialized).not.toContain(sub.p256dh);
    expect(serialized).not.toContain(sub.auth);
    expect(serialized).not.toContain(env.VAPID_PRIVATE_KEY);
    expect(serialized).not.toContain(env.SUPABASE_SERVICE_ROLE_KEY);
    expect(serialized).not.toContain('admin-token');
  });

  it('forces dry-run when VAPID configuration is invalid', async () => {
    const network = setup([subscription()], { VAPID_SUBJECT: '[mailto:admin@example.test](mailto:admin@example.test)' });
    const res = await call({ dryRun: false });
    expect(res.statusCode).toBe(200);
    expect(res.body.dryRun).toBe(true);
    expect(res.body.vapid.ok).toBe(false);
    expect(res.body.note).toMatch(/disabled because VAPID/);
    expect(res.body.summary.hint).toMatch(/VAPID configuration is invalid/);
    expect(network.state.pushes).toHaveLength(0);
  });

  it('reports likely key-rotation rejection and synthetic endpoints', async () => {
    restoreEnv = setServerEnv(validVapidEnv());
    const network = createFakeNetwork({ subscriptions: [subscription('s1')], pushReplies: [{ status: 403, body: 'Forbidden' }] });
    vi.stubGlobal('fetch', network.fetchImpl);
    const rejected = await call({ dryRun: false });
    expect(rejected.body.summary.hint).toMatch(/older public key/);

    restoreEnv?.();
    restoreEnv = null;
    const syntheticNetwork = setup([subscription('fake', 'teacher-1', 'preview.push.local')]);
    const synthetic = await call({ dryRun: true });
    expect(synthetic.body.subscriptions[0].endpointLooksSynthetic).toBe(true);
    expect(synthetic.body.summary.hint).toMatch(/synthetic/);
    expect(syntheticNetwork.state.pushes).toHaveLength(0);
  });

  it('scopes subscriptions by teacherId and caps the query to 50 rows', async () => {
    const network = setup([subscription('s1', 'teacher-1'), subscription('s2', 'teacher-2')]);
    const res = await call({ teacherId: 'teacher-2', dryRun: true });
    expect(res.body.subscriptions).toHaveLength(1);
    expect(res.body.subscriptions[0].userId).toBe('teacher-2');
    expect(network.state.selects.find((call) => call.table === 'push_subscriptions')?.query).toContain('limit=50');
  });

  it('returns 405 for an unsupported method and 400 for invalid body', async () => {
    setup();
    expect((await call({ teacherId: [] })).statusCode).toBe(400);
  });
});
