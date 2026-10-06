import crypto from 'node:crypto';
import { base64UrlEncode, generateVapidKeys } from '../../../../server/lib/webpush';

export interface PushReply {
  status?: number;
  body?: string;
  networkError?: Error;
}

export interface FakeNetworkOptions {
  role?: string;
  invalidSession?: boolean;
  teachers?: any[];
  subscriptions?: any[];
  preferences?: any[];
  pushReplies?: PushReply[];
}

export interface FakeNetworkState {
  requests: Array<{ url: string; method: string; headers: Record<string, string>; body: any }>;
  pushes: Array<{ url: string; headers: Record<string, string>; body: Uint8Array }>;
  inserts: Array<{ table: string; body: any }>;
  patches: Array<{ table: string; query: string; body: any }>;
  selects: Array<{ table: string; query: string }>;
  replyIndex: number;
}

function jsonResponse(status: number, value: unknown): Response {
  return new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });
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
  return { VAPID_PRIVATE_KEY: keys.privateKey, VAPID_SUBJECT: 'mailto:admin@school.example' };
}

export function setServerEnv(values: Record<string, string | undefined>): () => void {
  const previous = new Map<string, string | undefined>();
  for (const [name, value] of Object.entries(values)) {
    previous.set(name, process.env[name]);
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  return () => {
    for (const [name, value] of previous) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  };
}

/**
 * Fetch router for the real server handlers: tiny in-memory PostgREST tables
 * plus deterministic push-service replies. It records all writes and URLs so
 * tests can prove invalid VAPID config performs no database work or push.
 */
export function createFakeNetwork(options: FakeNetworkOptions = {}) {
  const state: FakeNetworkState = {
    requests: [],
    pushes: [],
    inserts: [],
    patches: [],
    selects: [],
    replyIndex: 0,
  };
  const teachers = options.teachers ?? [{ id: 'teacher-1', name: 'Teacher One', assignedClasses: ['Grade 2-C'] }];
  const subscriptions = options.subscriptions ?? [];
  const preferences = options.preferences ?? [];
  const replies = options.pushReplies ?? [];

  const fetchImpl = (async (input: any, init: RequestInit = {}) => {
    const url = String(input);
    const parsed = new URL(url);
    const method = String(init.method || 'GET').toUpperCase();
    const headers = Object.fromEntries(new Headers(init.headers).entries());
    let body: any = init.body;
    if (typeof body === 'string') {
      try { body = JSON.parse(body); } catch { /* binary/text body */ }
    }
    state.requests.push({ url, method, headers, body });

    if (!parsed.pathname.includes('/rest/v1/')) {
      state.pushes.push({ url, headers, body: init.body as Uint8Array });
      const reply = replies[state.replyIndex++] ?? { status: 201, body: '' };
      if (reply.networkError) throw reply.networkError;
      return new Response(reply.body || '', { status: reply.status ?? 201 });
    }

    const route = parsed.pathname.split('/rest/v1/')[1] || '';
    const [table, ...pathSegments] = route.split('/');
    if (table === 'rpc' && pathSegments[0] === 'current_session_context') {
      if (options.invalidSession) return jsonResponse(400, { message: 'Invalid Refresh Token: Refresh Token Not Found' });
      const bearer = headers.authorization || '';
      if (!bearer.includes('valid-token')) return jsonResponse(401, { message: 'Invalid token' });
      return jsonResponse(200, { profile_id: 'admin-1', role: options.role ?? 'admin' });
    }

    if (method === 'GET') {
      state.selects.push({ table, query: parsed.search.slice(1) });
      if (table === 'profiles') return jsonResponse(200, teachers);
      if (table === 'push_subscriptions') {
        const user = parsed.searchParams.get('user_id');
        const filtered = user?.startsWith('eq.')
          ? subscriptions.filter((row) => row.user_id === decodeURIComponent(user.slice(3)))
          : subscriptions;
        return jsonResponse(200, filtered);
      }
      if (table === 'notification_preferences') return jsonResponse(200, preferences);
      return jsonResponse(200, []);
    }

    if (method === 'POST') {
      state.inserts.push({ table, body });
      return new Response('', { status: 201 });
    }
    if (method === 'PATCH') {
      state.patches.push({ table, query: parsed.search.slice(1), body });
      if (table === 'push_subscriptions') {
        const endpointFilter = parsed.searchParams.get('endpoint');
        const idFilter = parsed.searchParams.get('id');
        const endpoint = endpointFilter?.startsWith('eq.') ? decodeURIComponent(endpointFilter.slice(3)) : null;
        const id = idFilter?.startsWith('eq.') ? decodeURIComponent(idFilter.slice(3)) : null;
        const row = subscriptions.find((sub) => (endpoint && sub.endpoint === endpoint) || (id && sub.id === id));
        if (row && body?.is_active === false) row.is_active = false;
      }
      return new Response(null, { status: 204 });
    }
    return jsonResponse(200, []);
  }) as typeof fetch;

  return { fetchImpl, state, teachers, subscriptions, preferences };
}

export function makeReqRes(options: {
  method?: string;
  authorization?: string;
  body?: any;
} = {}) {
  const req: any = {
    method: options.method ?? 'POST',
    headers: options.authorization ? { authorization: options.authorization } : {},
    body: options.body ?? {},
  };
  const res: any = {
    statusCode: 200,
    headers: {} as Record<string, string>,
    body: undefined as any,
    setHeader(name: string, value: string) { this.headers[name.toLowerCase()] = value; return this; },
    status(code: number) { this.statusCode = code; return this; },
    json(value: unknown) { this.body = value; return this; },
    end(value?: string) { this.body = value; return this; },
  };
  return { req, res };
}
