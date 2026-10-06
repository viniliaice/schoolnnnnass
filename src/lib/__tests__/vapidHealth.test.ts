// @vitest-environment node
import { afterEach, describe, expect, it } from 'vitest';
import crypto from 'node:crypto';
import health, { assessVapidConfig } from '../../../api/push/health';
import publicKeyEndpoint from '../../../api/push/vapid-public-key';
import { base64UrlDecode, base64UrlEncode, derivePublicKeyB64, generateVapidKeys, validateVapidConfig } from '../../../server/lib/webpush';
import { makeReqRes } from './helpers/fakeNetwork';

const saved = new Map<string, string | undefined>();
const names = ['NODE_ENV', 'VAPID_PRIVATE_KEY', 'VAPID_SUBJECT', 'SUPABASE_SERVICE_ROLE_KEY', 'SUPABASE_URL', 'SUPABASE_ANON_KEY'];
function setEnv(values: Record<string, string | undefined>) {
  for (const name of names) if (!saved.has(name)) saved.set(name, process.env[name]);
  for (const [name, value] of Object.entries(values)) {
    if (value === undefined) delete process.env[name]; else process.env[name] = value;
  }
}
afterEach(() => {
  for (const [name, value] of saved) {
    if (value === undefined) delete process.env[name]; else process.env[name] = value;
  }
  saved.clear();
});

describe('/api/push/health VAPID checks', () => {
  it('reports valid config and keeps environment values private', async () => {
    const keys = generateVapidKeys();
    setEnv({ VAPID_PRIVATE_KEY: keys.privateKey, VAPID_SUBJECT: 'mailto:admin@school.example' });
    const result = await assessVapidConfig();
    expect(result).toMatchObject({ ok: true, privateKeyPresent: true, subjectPresent: true, privateKeyBytes: 32, publicKeyBytes: 65, subjectScheme: 'mailto', subjectValid: true });
    expect(JSON.stringify(result)).not.toContain(keys.privateKey);
  });

  it.each([
    { privateKey: undefined, subject: 'mailto:admin@school.example' },
    { privateKey: 'short', subject: 'mailto:admin@school.example' },
    { privateKey: '!', subject: 'mailto:admin@school.example' },
    { privateKey: base64UrlEncode(Buffer.alloc(32)), subject: 'mailto:admin@school.example' },
    { privateKey: generateVapidKeys().privateKey, subject: '[mailto:admin@school.example](mailto:admin@school.example)' },
  ])('rejects bad key/subject content without exposing it', async ({ privateKey, subject }) => {
    setEnv({ VAPID_PRIVATE_KEY: privateKey, VAPID_SUBJECT: subject });
    const result = await assessVapidConfig();
    expect(result.ok).toBe(false);
    if (privateKey) expect(JSON.stringify(result)).not.toContain(privateKey);
    if (subject.startsWith('[')) expect(result.problems.join(' ')).toMatch(/Markdown/);
  });

  it('inline health validation agrees with validateVapidConfig for each content case', async () => {
    const key = generateVapidKeys().privateKey;
    const cases = [
      { privateKey: key, subject: 'mailto:admin@school.example' },
      { privateKey: key, subject: 'https://school.example/contact' },
      { privateKey: key, subject: '[mailto:admin@school.example](mailto:admin@school.example)' },
      { privateKey: 'too-short', subject: 'mailto:admin@school.example' },
      { privateKey: base64UrlEncode(crypto.randomBytes(31)), subject: '' },
      { privateKey: base64UrlEncode(Buffer.alloc(32)), subject: 'mailto:a@b' },
    ];
    for (const config of cases) {
      setEnv({ VAPID_PRIVATE_KEY: config.privateKey, VAPID_SUBJECT: config.subject });
      const inline = await assessVapidConfig();
      const shared = validateVapidConfig(config);
      expect(inline.ok).toBe(shared.ok);
      expect(inline.subjectValid).toBe(shared.subjectValid);
      expect(inline.subjectScheme).toBe(shared.subjectScheme);
      expect(inline.privateKeyBytes).toBe(shared.privateKeyBytes);
      expect(inline.publicKeyBytes).toBe(shared.publicKeyBytes);
      expect(inline.problems).toEqual(shared.problems);
    }
  });

  it('always answers health as JSON and reports invalid VAPID in the verdict', async () => {
    setEnv({ VAPID_PRIVATE_KEY: generateVapidKeys().privateKey, VAPID_SUBJECT: '[mailto:a@b](mailto:a@b)', SUPABASE_SERVICE_ROLE_KEY: 'service', SUPABASE_URL: 'https://db.example', SUPABASE_ANON_KEY: 'anon' });
    const { req, res } = makeReqRes({ method: 'GET' });
    await health(req, res);
    expect(res.statusCode).toBe(200);
    expect(res.body.ok).toBe(false);
    expect(res.body.verdict).toContain('VAPID-config-invalid');
    expect(res.body.vapid.subjectValid).toBe(false);
  });
});

describe('/api/push/vapid-public-key config gate', () => {
  it('serves the public point derived from valid production VAPID config', async () => {
    const keys = generateVapidKeys();
    setEnv({ NODE_ENV: 'production', VAPID_PRIVATE_KEY: keys.privateKey, VAPID_SUBJECT: 'mailto:admin@school.example' });
    const { req, res } = makeReqRes({ method: 'GET' });
    await publicKeyEndpoint(req, res);
    expect(res.statusCode).toBe(200);
    expect(res.body.publicKey).toBe(derivePublicKeyB64({ privateKey: keys.privateKey, subject: 'mailto:admin@school.example' }));
    expect(base64UrlDecode(res.body.publicKey)).toMatchObject({ length: 65 });
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.body).not.toHaveProperty('privateKey');
  });

  it('refuses to serve a key when the VAPID subject is invalid or absent in production', async () => {
    const keys = generateVapidKeys();
    for (const subject of ['[mailto:admin@school.example](mailto:admin@school.example)', undefined]) {
      setEnv({ NODE_ENV: 'production', VAPID_PRIVATE_KEY: keys.privateKey, VAPID_SUBJECT: subject });
      const { req, res } = makeReqRes({ method: 'GET' });
      await publicKeyEndpoint(req, res);
      expect(res.statusCode).toBe(500);
      expect(res.body.code).toBe('INVALID_VAPID_CONFIG');
      expect(JSON.stringify(res.body)).not.toContain(keys.privateKey);
      expect(res.body).not.toHaveProperty('publicKey');
    }
  });

  it('rejects invalid base64url key characters without echoing key material', async () => {
    setEnv({ NODE_ENV: 'production', VAPID_PRIVATE_KEY: 'secret/invalid', VAPID_SUBJECT: 'mailto:admin@school.example' });
    const { req, res } = makeReqRes({ method: 'GET' });
    await publicKeyEndpoint(req, res);
    expect(res.statusCode).toBe(500);
    expect(res.body.code).toBe('INVALID_VAPID_PRIVATE_KEY');
    expect(JSON.stringify(res.body)).not.toContain('secret/invalid');
  });
});
