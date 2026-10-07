// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  authenticateServerProfile,
  bearerTokenFromRequest,
  cronAuthorizationMatches,
  parseJsonBody,
  readServerSupabaseConfig,
  readServerSupabaseServiceConfig,
} from '../../../server/lib/academicReminderHttp.js';

const ENV_NAMES = ['SUPABASE_URL', 'SUPABASE_ANON_KEY', 'SUPABASE_SERVICE_ROLE_KEY', 'CRON_SECRET'] as const;
const before = new Map<string, string | undefined>();

function setEnv(values: Partial<Record<(typeof ENV_NAMES)[number], string>>) {
  for (const name of ENV_NAMES) {
    if (!before.has(name)) before.set(name, process.env[name]);
    if (values[name] === undefined) delete process.env[name];
    else process.env[name] = values[name];
  }
}

afterEach(() => {
  for (const name of ENV_NAMES) {
    const old = before.get(name);
    if (old === undefined) delete process.env[name];
    else process.env[name] = old;
  }
  before.clear();
  vi.unstubAllGlobals();
});

describe('academic reminder server HTTP helpers', () => {
  it('requires a long cron bearer secret and compares it in constant time', () => {
    setEnv({ CRON_SECRET: 'a-long-random-cron-secret-123456' });
    expect(cronAuthorizationMatches({ headers: { authorization: 'Bearer a-long-random-cron-secret-123456' } })).toBe(true);
    expect(cronAuthorizationMatches({ headers: { authorization: 'Bearer a-long-random-cron-secret-123457' } })).toBe(false);
    expect(cronAuthorizationMatches({ headers: { authorization: 'a-long-random-cron-secret-123456' } })).toBe(false);
    setEnv({ CRON_SECRET: 'short' });
    expect(cronAuthorizationMatches({ headers: { authorization: 'Bearer short' } })).toBe(false);
    setEnv({ CRON_SECRET: undefined });
    expect(cronAuthorizationMatches({ headers: { authorization: 'Bearer a-long-random-cron-secret-123456' } })).toBe(false);
  });

  it('parses only bearer tokens and JSON-object request bodies', () => {
    expect(bearerTokenFromRequest({ headers: { authorization: 'Bearer token-123 ' } })).toBe('token-123');
    expect(bearerTokenFromRequest({ headers: { authorization: 'Basic secret' } })).toBeNull();
    expect(parseJsonBody('{"ok":true}')).toEqual({ ok: true });
    expect(parseJsonBody('[1,2]')).toBeNull();
    expect(parseJsonBody(null)).toEqual({});
  });

  it('lets cron use the service-role config without requiring browser authentication keys', async () => {
    setEnv({
      SUPABASE_URL: 'https://db.example.test',
      SUPABASE_SERVICE_ROLE_KEY: 'service-test',
    });
    expect(readServerSupabaseServiceConfig()).toEqual({ url: 'https://db.example.test', serviceKey: 'service-test' });
    expect(readServerSupabaseConfig()).toBeNull();
  });

  it('fails closed on incomplete Supabase server configuration and missing bearer tokens', async () => {
    setEnv({});
    expect(readServerSupabaseConfig()).toBeNull();
    expect(readServerSupabaseServiceConfig()).toBeNull();
    expect(await authenticateServerProfile({ headers: {} })).toMatchObject({ ok: false, status: 500 });

    setEnv({
      SUPABASE_URL: 'https://db.example.test',
      SUPABASE_ANON_KEY: 'anon-test',
      SUPABASE_SERVICE_ROLE_KEY: 'service-test',
    });
    expect(await authenticateServerProfile({ headers: {} })).toMatchObject({ ok: false, status: 401 });
    const fetched = vi.fn(async () => new Response('{"profile_id":null,"role":null}', { status: 200 }));
    vi.stubGlobal('fetch', fetched);
    expect(await authenticateServerProfile({ headers: { authorization: 'Bearer user-token' } })).toMatchObject({ ok: false, status: 401 });
    expect(fetched).toHaveBeenCalledTimes(1);
  });
});
