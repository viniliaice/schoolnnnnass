// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mock = vi.hoisted(() => ({
  rows: [] as any[],
  from: vi.fn(),
  inserts: [] as any[],
  updates: [] as any[],
  deletes: [] as any[],
}));
vi.mock('../supabase', () => ({
  isPlaceholderEnv: false,
  supabase: { from: mock.from },
}));

import {
  enablePush,
  getPushSubscriptionState,
  resyncPushSubscription,
  unsubscribeCurrentDevice,
} from '../pwa/pushClient';

let serverKey = new Uint8Array(65);
let currentSubscription: any;
let registration: any;
let subscribeCalls: any[];
let unsubscribeCalls: string[];
let endpointCounter: number;

function encode(bytes: Uint8Array): string {
  let raw = '';
  bytes.forEach((byte) => { raw += String.fromCharCode(byte); });
  return btoa(raw).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function makeSubscription(endpoint: string, key: Uint8Array) {
  const p256dh = new Uint8Array(65); p256dh[0] = 4;
  const auth = new Uint8Array(16); auth.fill(9);
  return {
    endpoint,
    options: { applicationServerKey: key.buffer.slice(key.byteOffset, key.byteOffset + key.byteLength) },
    getKey(name: string) {
      const value = name === 'p256dh' ? p256dh : auth;
      return value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength);
    },
    unsubscribe: vi.fn(async () => {
      unsubscribeCalls.push(endpoint);
      if (currentSubscription?.endpoint === endpoint) currentSubscription = null;
      return true;
    }),
  };
}

function configureDb() {
  mock.from.mockImplementation((table: string) => {
    const state: any = { table, filters: {}, operation: 'select', values: null };
    const query: any = {
      select() { state.operation = 'select'; return query; },
      eq(column: string, value: unknown) { state.filters[column] = value; return query; },
      update(values: any) { state.operation = 'update'; state.values = values; return query; },
      insert(values: any) {
        mock.inserts.push(values);
        mock.rows.push(values);
        return Promise.resolve({ data: values, error: null });
      },
      delete() { state.operation = 'delete'; return query; },
      maybeSingle() {
        const row = mock.rows.find((candidate) => Object.entries(state.filters).every(([key, value]) => candidate[key] === value));
        return Promise.resolve({ data: row ? { id: row.id, user_id: row.user_id, is_active: row.is_active } : null, error: null });
      },
      then(resolve: any, reject: any) {
        try {
          if (state.operation === 'update') {
            mock.updates.push({ table, filters: { ...state.filters }, values: state.values });
            for (const row of mock.rows) if (Object.entries(state.filters).every(([key, value]) => row[key] === value)) Object.assign(row, state.values);
          }
          if (state.operation === 'delete') {
            mock.deletes.push({ table, filters: { ...state.filters } });
            mock.rows = mock.rows.filter((row) => !Object.entries(state.filters).every(([key, value]) => row[key] === value));
          }
          return Promise.resolve({ data: null, error: null }).then(resolve, reject);
        } catch (error) { return Promise.reject(error).then(resolve, reject); }
      },
    };
    return query;
  });
}

beforeEach(() => {
  mock.rows = [];
  mock.inserts = [];
  mock.updates = [];
  mock.deletes = [];
  mock.from.mockReset();
  configureDb();
  serverKey = new Uint8Array(65);
  serverKey[0] = 4;
  serverKey.fill(6, 1);
  currentSubscription = null;
  subscribeCalls = [];
  unsubscribeCalls = [];
  endpointCounter = 0;
  registration = {
    pushManager: {
      getSubscription: vi.fn(async () => currentSubscription),
      subscribe: vi.fn(async (options: any) => {
        subscribeCalls.push(options);
        endpointCounter += 1;
        currentSubscription = makeSubscription(`https://fcm.googleapis.com/fcm/send/new-device-${endpointCounter}`, new Uint8Array(options.applicationServerKey));
        return currentSubscription;
      }),
    },
  };
  Object.defineProperty(navigator, 'serviceWorker', { configurable: true, value: { ready: Promise.resolve(registration) } });
  Object.defineProperty(window, 'PushManager', { configurable: true, value: class PushManager {} });
  class NotificationStub {
    static permission: NotificationPermission = 'granted';
    static requestPermission = vi.fn(async () => 'granted' as NotificationPermission);
  }
  Object.defineProperty(window, 'Notification', { configurable: true, value: NotificationStub });
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ publicKey: encode(serverKey) }), { status: 200 })));
});

describe('browser push subscription lifecycle', () => {
  it('detects current and stale browser application-server keys', async () => {
    currentSubscription = makeSubscription('https://fcm.googleapis.com/fcm/send/old-token-path', serverKey);
    const current = await getPushSubscriptionState();
    expect(current).toMatchObject({ supported: true, hasBrowserSubscription: true, browserKeyMatchesServer: true, endpointHost: 'fcm.googleapis.com' });

    const oldKey = new Uint8Array(65); oldKey[0] = 4; oldKey.fill(2, 1);
    currentSubscription = makeSubscription('https://fcm.googleapis.com/fcm/send/old-token-path', oldKey);
    const stale = await getPushSubscriptionState();
    expect(stale.browserKeyMatchesServer).toBe(false);
  });

  it('reuses a healthy subscription and updates the same database row', async () => {
    const endpoint = 'https://fcm.googleapis.com/fcm/send/device-token';
    currentSubscription = makeSubscription(endpoint, serverKey);
    mock.rows.push({ id: 'row-1', user_id: 'teacher-1', endpoint, p256dh: 'old', auth: 'old', is_active: true });
    const result = await resyncPushSubscription('teacher-1');
    expect(result).toEqual({ ok: true, action: 'reused' });
    expect(registration.pushManager.subscribe).not.toHaveBeenCalled();
    expect(mock.inserts).toHaveLength(0);
    expect(mock.updates).toHaveLength(1);
    expect(mock.rows[0]).toMatchObject({ is_active: true, user_id: 'teacher-1' });
  });

  it('re-registers instead of reactivating a browser endpoint retired by the push service', async () => {
    const endpoint = 'https://fcm.googleapis.com/fcm/send/dead-registration';
    currentSubscription = makeSubscription(endpoint, serverKey);
    mock.rows.push({ id: 'retired-row', user_id: 'teacher-1', endpoint, is_active: false });

    const result = await resyncPushSubscription('teacher-1');
    expect(result).toEqual({ ok: true, action: 'resubscribed' });
    expect(unsubscribeCalls).toEqual([endpoint]);
    expect(mock.deletes).toEqual([{ table: 'push_subscriptions', filters: { user_id: 'teacher-1', endpoint } }]);
    expect(subscribeCalls).toHaveLength(1);
    expect(mock.inserts).toHaveLength(1);
    expect(mock.rows[0]).toMatchObject({ user_id: 'teacher-1', is_active: true });
  });

  it('retires only a stale endpoint before subscribing with the current server key', async () => {
    const oldKey = new Uint8Array(65); oldKey[0] = 4; oldKey.fill(1, 1);
    const staleEndpoint = 'https://fcm.googleapis.com/fcm/send/old-registration-secret';
    currentSubscription = makeSubscription(staleEndpoint, oldKey);
    mock.rows.push({ id: 'stale-row', user_id: 'teacher-1', endpoint: staleEndpoint, p256dh: 'old', auth: 'old' });
    mock.rows.push({ id: 'other-device', user_id: 'teacher-1', endpoint: 'https://fcm.googleapis.com/fcm/send/other-device' });
    mock.rows.push({ id: 'other-user', user_id: 'teacher-2', endpoint: 'https://fcm.googleapis.com/fcm/send/other-user' });

    const result = await resyncPushSubscription('teacher-1');
    expect(result).toEqual({ ok: true, action: 'resubscribed' });
    expect(unsubscribeCalls).toEqual([staleEndpoint]);
    expect(mock.deletes).toEqual([{ table: 'push_subscriptions', filters: { user_id: 'teacher-1', endpoint: staleEndpoint } }]);
    expect(mock.rows.some((row) => row.id === 'other-device')).toBe(true);
    expect(mock.rows.some((row) => row.id === 'other-user')).toBe(true);
    expect(subscribeCalls).toHaveLength(1);
    expect(new Uint8Array(subscribeCalls[0].applicationServerKey)).toEqual(serverKey);
    expect(mock.inserts).toHaveLength(1);
  });

  it('prevents duplicate rows by updating an existing endpoint when enabling again', async () => {
    const endpoint = 'https://fcm.googleapis.com/fcm/send/same-device';
    currentSubscription = makeSubscription(endpoint, serverKey);
    mock.rows.push({ id: 'existing', user_id: 'teacher-1', endpoint, p256dh: 'old', auth: 'old' });
    const result = await enablePush('teacher-1');
    expect(result.ok).toBe(true);
    expect(mock.inserts).toHaveLength(0);
    expect(mock.updates).toHaveLength(1);
  });

  it('unsubscribes and deletes only the current device row', async () => {
    const endpoint = 'https://fcm.googleapis.com/fcm/send/current-endpoint-token';
    currentSubscription = makeSubscription(endpoint, serverKey);
    mock.rows.push({ id: 'current', user_id: 'teacher-1', endpoint });
    mock.rows.push({ id: 'other', user_id: 'teacher-1', endpoint: 'https://fcm.googleapis.com/fcm/send/other-device' });
    await unsubscribeCurrentDevice('teacher-1');
    expect(unsubscribeCalls).toEqual([endpoint]);
    expect(mock.deletes).toEqual([{ table: 'push_subscriptions', filters: { user_id: 'teacher-1', endpoint } }]);
    expect(mock.rows.map((row) => row.id)).toEqual(['other']);
  });

  it('does not delete all device rows when the browser reports no subscription', async () => {
    mock.rows.push({ id: 'other-device', user_id: 'teacher-1', endpoint: 'https://fcm.googleapis.com/fcm/send/other-device' });
    await unsubscribeCurrentDevice('teacher-1');
    expect(mock.deletes).toHaveLength(0);
    expect(mock.rows).toHaveLength(1);
  });

  it('falls back to user-scoped cleanup only when the browser subscription cannot be read', async () => {
    registration.pushManager.getSubscription.mockRejectedValueOnce(new Error('service worker unavailable'));
    mock.rows.push({ id: 'one', user_id: 'teacher-1' }, { id: 'other-user', user_id: 'teacher-2' });
    await unsubscribeCurrentDevice('teacher-1');
    expect(mock.deletes).toEqual([{ table: 'push_subscriptions', filters: { user_id: 'teacher-1' } }]);
    expect(mock.rows.map((row) => row.id)).toEqual(['other-user']);
  });
});
