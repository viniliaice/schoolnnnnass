// Runtime behavior tests for public/sw.js under the hashed-asset
// architecture. The worker script is executed inside a VM sandbox with the
// build-time placeholders stamped exactly like vite.config.ts stamps them,
// and with in-memory CacheStorage/fetch fakes, so we can verify:
//
//  - install precaches the shell AND the stamped entry JS/CSS;
//  - /assets/* is served cache-first and runtime-cached on miss;
//  - /api/*, cross-origin and non-GET requests are never intercepted;
//  - navigations stay network-first and fall back to the cached shell
//    offline (the offline cold-start gate, at unit level);
//  - activate deletes obsolete mbk-* caches and claims clients.

import { beforeEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import vm from 'node:vm';

const ORIGIN = 'https://app.test';
const ENTRY_JS = '/assets/index-TESTHASH1.js';
const ENTRY_CSS = '/assets/index-TESTHASH2.css';
const BUILD_ID = 'testbuild0000001';

type Listener = (event: unknown) => void;

interface FakeResponse {
  ok: boolean;
  status: number;
  body: string;
  clone(): FakeResponse;
}

const response = (body: string, ok = true): FakeResponse => ({
  ok,
  status: ok ? 200 : 500,
  body,
  clone() { return response(this.body, this.ok); },
});

// Real CacheStorage resolves relative keys against the worker origin, so
// cache.add('/x') and caches.match('https://origin/x') hit the same entry.
const normalize = (url: string) => (url.startsWith(ORIGIN) ? url.slice(ORIGIN.length) || '/' : url);

class FakeCache {
  store = new Map<string, FakeResponse>();
  constructor(private readonly onNetwork: (url: string) => Promise<FakeResponse>) {}
  async add(url: string) { this.store.set(normalize(url), await this.onNetwork(url)); }
  async put(url: string, res: FakeResponse) { this.store.set(normalize(url), res); }
  async match(url: string) { return this.store.get(normalize(url)); }
}

function createHarness() {
  const listeners = new Map<string, Listener[]>();
  const networkLog: string[] = [];
  let online = true;

  const networkFetch = async (input: string | { url: string }): Promise<FakeResponse> => {
    const url = normalize(typeof input === 'string' ? input : input.url);
    networkLog.push(url);
    if (!online) throw new TypeError('network unreachable');
    return response(`network:${url}`);
  };

  const cachesMap = new Map<string, FakeCache>();
  const cacheStorage = {
    async open(name: string) {
      if (!cachesMap.has(name)) cachesMap.set(name, new FakeCache(networkFetch));
      return cachesMap.get(name)!;
    },
    async keys() { return [...cachesMap.keys()]; },
    async delete(name: string) { return cachesMap.delete(name); },
    async match(url: string) {
      for (const cache of cachesMap.values()) {
        const hit = await cache.match(url);
        if (hit) return hit;
      }
      return undefined;
    },
  };

  let claimed = false;
  const self = {
    location: { origin: ORIGIN },
    addEventListener(type: string, fn: Listener) {
      listeners.set(type, [...(listeners.get(type) ?? []), fn]);
    },
    clients: {
      async claim() { claimed = true; },
      async matchAll() { return []; },
      async openWindow() { return null; },
    },
    registration: { async showNotification() {} },
    skipWaiting() {},
  };

  let sw = readFileSync(resolve(__dirname, '../../../public/sw.js'), 'utf8');
  sw = sw.replace(/__SW_BUILD_ID__/g, BUILD_ID);
  sw = sw.replace(/__SW_PRECACHE_ASSETS__/g, `${ENTRY_JS},${ENTRY_CSS}`);
  expect(sw).not.toContain('__SW_');

  const context = vm.createContext({
    self,
    caches: cacheStorage,
    fetch: networkFetch,
    URL,
    console,
    BroadcastChannel: class { postMessage() {} close() {} },
  });
  new vm.Script(sw, { filename: 'sw.js' }).runInContext(context);

  const dispatch = async (type: string, event: Record<string, unknown>) => {
    const pending: Promise<unknown>[] = [];
    const full = {
      ...event,
      waitUntil(p: Promise<unknown>) { pending.push(p); },
    };
    for (const fn of listeners.get(type) ?? []) fn(full);
    await Promise.all(pending);
    return full as { respondWith?: unknown };
  };

  const fetchEvent = async (request: Record<string, unknown>) => {
    let responded: Promise<FakeResponse> | null = null;
    const pending: Promise<unknown>[] = [];
    const event = {
      request,
      respondWith(p: Promise<FakeResponse>) { responded = p; },
      waitUntil(p: Promise<unknown>) { pending.push(p); },
    };
    for (const fn of listeners.get('fetch') ?? []) fn(event);
    const result = responded ? await responded : null;
    await Promise.all(pending);
    // Let fire-and-forget cache writes settle.
    await new Promise((r) => setTimeout(r, 0));
    return { result: result as FakeResponse | null, intercepted: responded !== null };
  };

  const request = (url: string, init: Partial<{ method: string; mode: string; accept: string }> = {}) => ({
    url: url.startsWith('http') ? url : ORIGIN + url,
    method: init.method ?? 'GET',
    mode: init.mode ?? 'no-cors',
    headers: { get: (name: string) => (name.toLowerCase() === 'accept' ? init.accept ?? '' : '') },
  });

  return {
    cachesMap,
    networkLog,
    setOnline(value: boolean) { online = value; },
    install: () => dispatch('install', {}),
    activate: () => dispatch('activate', {}),
    fetchEvent,
    request,
    get claimed() { return claimed; },
  };
}

const STATIC_CACHE = `mbk-static-${BUILD_ID}`;
const RUNTIME_CACHE = `mbk-runtime-${BUILD_ID}`;

describe('service worker runtime (hashed-asset architecture)', () => {
  let h: ReturnType<typeof createHarness>;
  beforeEach(() => { h = createHarness(); });

  it('install precaches the shell AND the stamped entry JS/CSS', async () => {
    await h.install();
    const cache = h.cachesMap.get(STATIC_CACHE)!;
    for (const url of ['/', '/manifest.webmanifest', '/logo.png', '/icons/icon-192.png', '/icons/icon-512.png', '/icons/icon-maskable-512.png', ENTRY_JS, ENTRY_CSS]) {
      expect(cache.store.has(url), `${url} must be precached`).toBe(true);
    }
    expect(cache.store.size).toBe(8);
  });

  it('serves cached /assets/ requests cache-first (no network)', async () => {
    await h.install();
    h.networkLog.length = 0;
    const { result, intercepted } = await h.fetchEvent(h.request(ENTRY_JS));
    expect(intercepted).toBe(true);
    expect(result!.body).toBe(`network:${ENTRY_JS}`); // precached copy
    expect(h.networkLog).toEqual([]); // not re-fetched
  });

  it('fetches uncached /assets/ chunks once and runtime-caches them', async () => {
    await h.install();
    const lazy = '/assets/LessonPlans-FUTUREHASH.js';
    const first = await h.fetchEvent(h.request(lazy));
    expect(first.result!.body).toBe(`network:${lazy}`);
    expect(h.cachesMap.get(RUNTIME_CACHE)!.store.has(lazy)).toBe(true);
    h.networkLog.length = 0;
    const second = await h.fetchEvent(h.request(lazy));
    expect(second.result!.body).toBe(`network:${lazy}`);
    expect(h.networkLog).toEqual([]); // served from runtime cache
  });

  it('keeps cached /assets/ available offline', async () => {
    await h.install();
    h.setOnline(false);
    const { result } = await h.fetchEvent(h.request(ENTRY_JS));
    expect(result!.body).toBe(`network:${ENTRY_JS}`);
  });

  it('never intercepts /api/, cross-origin, or non-GET requests', async () => {
    await h.install();
    expect((await h.fetchEvent(h.request('/api/push/health'))).intercepted).toBe(false);
    expect((await h.fetchEvent(h.request('https://example.supabase.co/rest/v1/profiles'))).intercepted).toBe(false);
    expect((await h.fetchEvent(h.request('/assets/x.js', { method: 'POST' }))).intercepted).toBe(false);
  });

  it('navigations stay network-first while online', async () => {
    await h.install();
    h.networkLog.length = 0;
    const { result } = await h.fetchEvent(h.request('/teacher/lesson-plans', { mode: 'navigate', accept: 'text/html' }));
    expect(result!.body).toBe('network:/teacher/lesson-plans');
    expect(h.networkLog.length).toBe(1);
  });

  it('OFFLINE GATE: offline navigation falls back to the cached shell, whose entry assets are cached too', async () => {
    await h.install();
    h.setOnline(false);
    const nav = await h.fetchEvent(h.request('/teacher/lesson-plans', { mode: 'navigate', accept: 'text/html' }));
    expect(nav.intercepted).toBe(true);
    expect(nav.result, 'offline navigation must serve the cached shell').toBeTruthy();
    expect(nav.result!.body).toBe('network:/'); // the precached '/' document
    // The shell's entry JS and CSS must also be servable offline, otherwise
    // the document renders blank.
    expect((await h.fetchEvent(h.request(ENTRY_JS))).result!.body).toBe(`network:${ENTRY_JS}`);
    expect((await h.fetchEvent(h.request(ENTRY_CSS))).result!.body).toBe(`network:${ENTRY_CSS}`);
  });

  it('activate deletes obsolete mbk-* caches, keeps current + foreign caches, and claims clients', async () => {
    await h.install();
    await (await import('node:util')).promisify(setTimeout)(0);
    // Seed an old deploy's caches and an unrelated cache.
    h.cachesMap.set('mbk-static-oldbuild', new FakeCache(async (u) => response(u)));
    h.cachesMap.set('mbk-runtime-oldbuild', new FakeCache(async (u) => response(u)));
    h.cachesMap.set('unrelated-cache', new FakeCache(async (u) => response(u)));
    await h.activate();
    expect(h.cachesMap.has('mbk-static-oldbuild')).toBe(false);
    expect(h.cachesMap.has('mbk-runtime-oldbuild')).toBe(false);
    expect(h.cachesMap.has('unrelated-cache')).toBe(true);
    expect(h.cachesMap.has(STATIC_CACHE)).toBe(true);
    expect(h.claimed).toBe(true);
  });
});
