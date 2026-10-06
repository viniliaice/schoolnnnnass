// @vitest-environment node
/**
 * Fetch router for server/API tests. It models only the PostgREST operations
 * used by the push routes and scripts push-service responses without ever
 * contacting the network.
 */
import crypto from 'node:crypto';
import { generateVapidKeys, base64UrlEncode } from '../../../../server/lib/webpush.js';

export interface FakeSubscription {
  id: string;
  user_id: string;
  endpoint: string;
  p256dh: string;
  auth: string;
  is_active: boolean;
  device_type?: string | null;
  browser?: string | null;
  created_at?: string;
}

export interface FakeNetworkState {
  profiles: Array<{ id: string; name: string; role: string; assignedClasses?: string[] | null }>;
  subscriptions: FakeSubscription[];
  preferences: any[];
  notifications: any[];
  recipients: any[];
  pushes: Array<{ url: string; headers: Headers; body: BodyInit | null | undefined }>;
  selects: Array<{ table: string; query: string }>;
  inserts: Array<{ table: string; body: unknown }>;
  patches: Array<{ table: string; query: string; body: any }>;
}

export type ScriptedPushReply =
  | { status: number; body?: string }
  | Error
  | ((url: string, init?: RequestInit) => { status: number; body?: string } | Error | Promise<{ status: number; body?: string } | Error>);

export interface FakeNetworkOptions {
  profiles?: FakeNetworkState['profiles'];
  subscriptions?: FakeSubscription[];
  preferences?: any[];
  pushReplies?: ScriptedPushReply[];
  sessions?: Record<string, { profile_id: string | null; role: string | null } | null>;
  expiredTokens?: string[];
}

function jsonResponse(status: number, value: unknown): Response {
  return new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });
}

function parseBody(body: BodyInit | null | undefined): any {
  if (typeof body !== 'string') return body;
  try { return JSON.parse(body); } catch { return body; }
}

function filterUserIds(raw: string | null): string[] | null {
  if (!raw) return null;
  if (raw.startsWith('eq.')) return [raw.slice(3)];
  if (raw.startsWith('in.')) return Array.from(raw.matchAll(/"([^"]+)"/g), (match) => match[1]);
  return null;
}

export function deviceKeys() {
  const ecdh = crypto.createECDH('prime256v1');
  ecdh.generateKeys();
  return {
    p256dh: base64UrlEncode(ecdh.getPublicKey()),
    auth: base64UrlEncode(crypto.randomBytes(16)),
  };
}

export function validVapidEnv() {
  const keys = generateVapidKeys();
  return {
    NODE_ENV: 'production',
    SUPABASE_URL: 'https://db.example.test',
    SUPABASE_ANON_KEY: 'anon-test-key',
    SUPABASE_SERVICE_ROLE_KEY: 'service-role-test-key',
    VAPID_PRIVATE_KEY: keys.privateKey,
    VAPID_SUBJECT: 'mailto:admin@example.test',
  };
}

export function setServerEnv(overrides: Record<string, string | undefined> = {}): () => void {
  const initial = validVapidEnv();
  const values: Record<string, string | undefined> = { ...initial, ...overrides };
  const names = new Set([...Object.keys(initial), ...Object.keys(overrides)]);
  const previous = new Map<string, string | undefined>();
  for (const name of names) {
    previous.set(name, process.env[name]);
    const value = values[name];
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  return () => {
    for (const name of names) {
      const value = previous.get(name);
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  };
}

export function makeReqRes(method: string, body?: unknown, token: string | null = 'admin-token') {
  const req = {
    method,
    body,
    headers: { authorization: token ? `Bearer ${token}` : '' },
  };
  const response: any = {
    statusCode: 200,
    headers: {} as Record<string, string>,
    body: undefined as unknown,
    status(code: number) { this.statusCode = code; return this; },
    setHeader(name: string, value: string) { this.headers[name.toLowerCase()] = value; return this; },
    json(value: unknown) { this.body = value; return this; },
    end(value?: string) { this.body = value; return this; },
  };
  return { req, res: response as { statusCode: number; headers: Record<string, string>; body: any; status: (code: number) => any; setHeader: (name: string, value: string) => any; json: (value: unknown) => any; end: (value?: string) => any } };
}

export function createFakeNetwork(options: FakeNetworkOptions = {}) {
  const state: FakeNetworkState = {
    profiles: options.profiles ?? [
      { id: 'teacher-1', name: 'Teacher One', role: 'teacher', assignedClasses: ['Grade 2-C'] },
      { id: 'teacher-2', name: 'Teacher Two', role: 'teacher', assignedClasses: ['Grade 1-A'] },
    ],
    subscriptions: options.subscriptions ?? [],
    preferences: options.preferences ?? [],
    notifications: [],
    recipients: [],
    pushes: [],
    selects: [],
    inserts: [],
    patches: [],
  };
  const replies = [...(options.pushReplies ?? [])];
  const sessions = {
    'admin-token': { profile_id: 'admin-1', role: 'admin' },
    'supervisor-token': { profile_id: 'supervisor-1', role: 'supervisor' },
    'teacher-token': { profile_id: 'teacher-1', role: 'teacher' },
    ...(options.sessions ?? {}),
  } as Record<string, { profile_id: string | null; role: string | null } | null>;
  const expiredTokens = new Set(options.expiredTokens ?? ['expired-token']);

  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const urlString = String(input);
    const url = new URL(urlString);
    const headers = new Headers(init?.headers);
    const authorization = headers.get('authorization') || '';
    const body = parseBody(init?.body);

    if (url.pathname.startsWith('/rest/v1/rpc/current_session_context')) {
      const token = authorization.startsWith('Bearer ') ? authorization.slice('Bearer '.length) : '';
      if (expiredTokens.has(token)) return jsonResponse(401, { message: 'Invalid Refresh Token: Refresh Token Not Found' });
      if (!sessions[token]) return jsonResponse(401, { message: 'Invalid token' });
      return jsonResponse(200, sessions[token]);
    }

    if (url.pathname === '/rest/v1/profiles' && init?.method === 'GET') {
      state.selects.push({ table: 'profiles', query: url.search });
      return jsonResponse(200, state.profiles.filter((profile) => profile.role === 'teacher'));
    }

    if (url.pathname === '/rest/v1/push_subscriptions' && init?.method === 'GET') {
      state.selects.push({ table: 'push_subscriptions', query: url.search });
      let rows = [...state.subscriptions];
      const ids = filterUserIds(url.searchParams.get('user_id'));
      if (ids) rows = rows.filter((row) => ids.includes(row.user_id));
      if (url.searchParams.get('is_active') === 'is.true') rows = rows.filter((row) => row.is_active);
      rows.sort((a, b) => String(b.created_at || '').localeCompare(String(a.created_at || '')));
      const limit = Number(url.searchParams.get('limit'));
      if (Number.isFinite(limit) && limit > 0) rows = rows.slice(0, limit);
      return jsonResponse(200, rows);
    }

    if (url.pathname === '/rest/v1/notification_preferences' && init?.method === 'GET') {
      state.selects.push({ table: 'notification_preferences', query: url.search });
      const ids = filterUserIds(url.searchParams.get('user_id'));
      const rows = ids ? state.preferences.filter((row) => ids.includes(row.user_id)) : state.preferences;
      return jsonResponse(200, rows);
    }

    if (url.pathname === '/rest/v1/notifications' && init?.method === 'POST') {
      state.inserts.push({ table: 'notifications', body });
      state.notifications.push(body);
      return new Response(null, { status: 201 });
    }

    if (url.pathname === '/rest/v1/notification_recipients' && init?.method === 'POST') {
      state.inserts.push({ table: 'notification_recipients', body });
      state.recipients.push(...(Array.isArray(body) ? body : [body]));
      return new Response(null, { status: 201 });
    }

    if (url.pathname === '/rest/v1/notification_recipients' && init?.method === 'PATCH') {
      state.patches.push({ table: 'notification_recipients', query: url.search, body });
      const notificationId = url.searchParams.get('notification_id')?.replace(/^eq\./, '');
      const userId = url.searchParams.get('user_id')?.replace(/^eq\./, '');
      for (const row of state.recipients) {
        if (row.notification_id === notificationId && row.user_id === userId) Object.assign(row, body);
      }
      return new Response(null, { status: 204 });
    }

    if (url.pathname === '/rest/v1/push_subscriptions' && init?.method === 'PATCH') {
      state.patches.push({ table: 'push_subscriptions', query: url.search, body });
      const endpoint = url.searchParams.get('endpoint')?.replace(/^eq\./, '');
      for (const row of state.subscriptions) {
        if (row.endpoint === endpoint) Object.assign(row, body);
      }
      return new Response(null, { status: 204 });
    }

    if (url.pathname.startsWith('/rest/v1/')) return jsonResponse(404, { message: `unexpected PostgREST route ${url.pathname}` });

    state.pushes.push({
      url: urlString,
      headers,
      body: init?.body,
    });
    const scripted = replies.shift();
    if (scripted) {
      const resolved = typeof scripted === 'function' ? await scripted(urlString, init) : scripted;
      if (resolved instanceof Error) throw resolved;
      return new Response(resolved.body ?? '', { status: resolved.status });
    }
    return new Response('', { status: 201 });
  }) as typeof fetch;

  return { state, fetchImpl };
}
