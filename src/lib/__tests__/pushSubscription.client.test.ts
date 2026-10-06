// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { generateVapidKeys } from '../../../server/lib/webpush';
import { deviceKeys } from './helpers/fakeNetwork';

const { supabaseMock } = vi.hoisted(() => ({ supabaseMock: { from: vi.fn() } }));
vi.mock('../supabase', () => ({ supabase: supabaseMock, isPlaceholderEnv: false }));

import {
  getPushSubscriptionState,
  resyncPushSubscription,
  storeSubscription,
  unsubscribeCurrentDevice,
  urlBase64ToUint8Array,
} from '../pwa/pushClient';

const currentKey = generateVapidKeys().publicKey;
const rotatedKey = generateVapidKeys().publicKey;
let rows: any[] = [];
let operations: { inserts: any[]; updates: any[]; deletes: any[] };
let activeSubscription: PushSubscription | null;
let pushManager: any;
let serverKey: string;
let idCounter = 0;

function match(row: any, filters: Record<string, unknown>) {
  return Object.entries(filters).every(([key, value]) => row[key] === value);
}

function setupMockDb() {
  supabaseMock.from.mockImplementation(() => {
    let operation = 'select';
    let filters: Record<string, unknown> = {};
    let payload: any;
    const query: any = {
      select: vi.fn(() => { operation = 'select'; return query; }),
      eq: vi.fn((key: string, value: unknown) => { filters[key] = value; return query; }),
      maybeSingle: vi.fn(async () => {
        const row = rows.find((candidate) => match(candidate, filters));
        return { data: row ? { id: row.id, user_id: row.user_id } : null, error: null };
      }),
      update: vi.fn((value: any) => { operation = 'update'; payload = value; return query; }),
      insert: vi.fn(async (value: any) => {
        operation = 'insert'; payload = value; operations.inserts.push(value); rows.push(value); return { error: null };
      }),
      delete: vi.fn(() => { operation = 'delete'; return query; }),
      then(resolve: (value: any) => unknown, reject: (reason: unknown) => unknown) {
        let result: any;
        if (operation === 'update') {
          operations.updates.push({ filters: { ...filters }, payload });
          rows = rows.map((row) => match(row, filters) ? { ...row, ...payload } : row);
          result = { error: null };
        } else if (operation === 'delete') {
          operations.deletes.push({ filters: { ...filters } });
          rows = rows.filter((row) => !match(row, filters));
          result = { error: null };
        } else if (operation === 'select') {
          result = { data: rows.filter((row) => match(row, filters)), error: null };
        } else {
          result = { error: null };
        }
        return Promise.resolve(result).then(resolve, reject);
      },
    };
    return query;
  });
}

function makeSubscription(key: string, endpoint: string): PushSubscription {
  const keys = deviceKeys();
  const serverKeyBytes = urlBase64ToUint8Array(key);
  return {
    endpoint,
    options: { applicationServerKey: serverKeyBytes.slice().buffer, userVisibleOnly: true },
    getKey(name: string) {
      const bytes = name === 'p256dh' ? urlBase64ToUint8Array(keys.p256dh) : urlBase64ToUint8Array(keys.auth);
      return bytes.slice().buffer;
    },
    unsubscribe: vi.fn(async () => true),
  } as unknown as PushSubscription;
}

function installBrowser(subscription: PushSubscription | null) {
  activeSubscription = subscription;
  pushManager = {
    getSubscription: vi.fn(async () => activeSubscription),
    subscribe: vi.fn(async (options: PushSubscriptionOptionsInit) => {
      activeSubscription = makeSubscription(currentKey, 'https://push.example.test/new-device-secret');
      return activeSubscription;
    }),
  };
  const registration = { pushManager };
  Object.defineProperty(navigator, 'serviceWorker', {
    configurable: true,
    value: { ready: Promise.resolve(registration) },
  });
  Object.defineProperty(window, 'PushManager', { configurable: true, value: class PushManager {} });
  vi.stubGlobal('Notification', { permission: 'granted', requestPermission: vi.fn(async () => 'granted') });
}

beforeEach(() => {
  rows = [];
  operations = { inserts: [], updates: [], deletes: [] };
  idCounter = 0;
  serverKey = currentKey;
  setupMockDb();
  vi.stubGlobal('crypto', { ...globalThis.crypto, randomUUID: () => `row-${++idCounter}` });
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ publicKey: serverKey }) })));
  installBrowser(null);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  delete (navigator as any).serviceWorker;
  delete (window as any).PushManager;
});

describe('push client VAPID subscription lifecycle', () => {
  it('detects a subscription using the current server key and exposes hostname only', async () => {
    installBrowser(makeSubscription(currentKey, 'https://push.example.test/secret/device-path'));
    const state = await getPushSubscriptionState();
    expect(state).toMatchObject({ supported: true, hasBrowserSubscription: true, browserKeyMatchesServer: true, endpointHost: 'push.example.test' });
    expect(JSON.stringify(state)).not.toContain('secret/device-path');
  });

  it('detects a browser subscription bound to an older VAPID key', async () => {
    serverKey = currentKey;
    installBrowser(makeSubscription(rotatedKey, 'https://push.example.test/old-device'));
    const state = await getPushSubscriptionState();
    expect(state.browserKeyMatchesServer).toBe(false);
  });

  it('treats synthetic browser endpoints as unhealthy even when their key matches', async () => {
    installBrowser(makeSubscription(currentKey, 'https://preview.push.local/subscribe/synthetic-secret'));
    const state = await getPushSubscriptionState();
    expect(state).toMatchObject({ browserKeyMatchesServer: false, endpointLooksSynthetic: true, endpointHost: 'preview.push.local' });
    expect(JSON.stringify(state)).not.toContain('synthetic-secret');
  });

  it('reuses and refreshes a healthy subscription without creating duplicates', async () => {
    const sub = makeSubscription(currentKey, 'https://push.example.test/phone');
    installBrowser(sub);
    const result = await resyncPushSubscription('teacher-1');
    expect(result).toEqual({ ok: true, action: 'reused' });
    expect(operations.inserts).toHaveLength(1); // first sync stores the previously missing row
    expect(operations.deletes).toHaveLength(0);
  });

  it('deactivates synthetic rows during re-sync without touching real devices', async () => {
    const current = makeSubscription(currentKey, 'https://push.example.test/current-device');
    installBrowser(current);
    rows.push({ id: 'preview-row', user_id: 'teacher-1', endpoint: 'https://preview.push.local/subscribe/synthetic-token', p256dh: 'x', auth: 'y', is_active: true });
    rows.push({ id: 'other-device', user_id: 'teacher-1', endpoint: 'https://push.example.test/other-device', p256dh: 'x', auth: 'y', is_active: true });

    const result = await resyncPushSubscription('teacher-1');
    expect(result).toEqual({ ok: true, action: 'reused' });
    expect(rows.find((row) => row.id === 'preview-row')?.is_active).toBe(false);
    expect(rows.find((row) => row.id === 'other-device')?.is_active).toBe(true);
    expect(rows.some((row) => row.endpoint === current.endpoint && row.is_active)).toBe(true);
    expect(JSON.stringify(result)).not.toContain('synthetic-token');
  });

  it('updates an existing endpoint row instead of inserting a duplicate', async () => {
    const sub = makeSubscription(currentKey, 'https://push.example.test/phone');
    rows.push({ id: 'existing', user_id: 'teacher-1', endpoint: sub.endpoint, p256dh: 'old', auth: 'old' });
    const result = await storeSubscription('teacher-1', sub, 'mobile', 'safari');
    expect(result.ok).toBe(true);
    expect(operations.updates).toHaveLength(1);
    expect(operations.inserts).toHaveLength(0);
  });

  it('retires only the stale endpoint row, unsubscribes, and subscribes with the current key', async () => {
    const stale = makeSubscription(rotatedKey, 'https://push.example.test/old-registration-path');
    installBrowser(stale);
    rows.push({ id: 'stale-row', user_id: 'teacher-1', endpoint: stale.endpoint, p256dh: 'old', auth: 'old' });
    rows.push({ id: 'other-device', user_id: 'teacher-1', endpoint: 'https://push.example.test/other-device', p256dh: 'x', auth: 'y' });

    const result = await resyncPushSubscription('teacher-1');
    expect(result).toEqual({ ok: true, action: 'resubscribed' });
    expect(stale.unsubscribe).toHaveBeenCalledOnce();
    expect(operations.deletes).toEqual([{ filters: { user_id: 'teacher-1', endpoint: stale.endpoint } }]);
    expect(rows.some((row) => row.id === 'other-device')).toBe(true);
    expect(rows.some((row) => row.endpoint === 'https://push.example.test/new-device-secret')).toBe(true);
    expect(pushManager.subscribe).toHaveBeenCalledOnce();
  });

  it('returns a failed/not-configured action when the server key cannot be fetched', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 500, json: async () => ({}) })));
    const result = await resyncPushSubscription('teacher-1');
    expect(result).toMatchObject({ ok: false, action: 'failed', error: 'not-configured' });
    expect(pushManager.subscribe).not.toHaveBeenCalled();
  });

  it('unsubscribes and deletes only this device when requested', async () => {
    const sub = makeSubscription(currentKey, 'https://push.example.test/my-device-secret');
    installBrowser(sub);
    rows.push({ id: 'mine', user_id: 'teacher-1', endpoint: sub.endpoint });
    rows.push({ id: 'other', user_id: 'teacher-1', endpoint: 'https://push.example.test/another-device' });
    await unsubscribeCurrentDevice('teacher-1');
    expect(sub.unsubscribe).toHaveBeenCalledOnce();
    expect(operations.deletes).toEqual([{ filters: { user_id: 'teacher-1', endpoint: sub.endpoint } }]);
    expect(rows.map((row) => row.id)).toEqual(['other']);
  });

  it('creates a fresh subscription when the browser has none', async () => {
    installBrowser(null);
    const result = await resyncPushSubscription('teacher-1');
    expect(result).toEqual({ ok: true, action: 'resubscribed' });
    expect(pushManager.subscribe).toHaveBeenCalledOnce();
    expect(operations.inserts).toHaveLength(1);
  });
});
