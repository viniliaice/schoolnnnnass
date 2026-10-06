// @vitest-environment node
import { afterEach, describe, expect, it } from 'vitest';
import healthHandler, { assessVapidConfig } from '../../../api/push/health';
import { generateVapidKeys, validateVapidConfig, base64UrlEncode } from '../../../server/lib/webpush';
import { makeReqRes, setServerEnv, validVapidEnv } from './helpers/fakeNetwork';

let restore: (() => void) | null = null;
afterEach(() => { restore?.(); restore = null; });

function configure(overrides: Record<string, string | undefined> = {}) {
  restore?.();
  restore = setServerEnv(overrides);
}

describe('push health VAPID validation', () => {
  it('reports valid key/subject and ends its verdict with vapid-valid', async () => {
    configure();
    const check = await assessVapidConfig();
    expect(check).toMatchObject({ ok: true, privateKeyBytes: 32, publicKeyBytes: 65, subjectScheme: 'mailto', subjectValid: true });
    const { req, res } = makeReqRes('GET');
    await healthHandler(req, res);
    expect(res.statusCode).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.verdict.endsWith('vapid-valid')).toBe(true);
  });

  it('rejects the Markdown-link subject content while reporting the problem safely', async () => {
    configure({ VAPID_SUBJECT: '[mailto:admin@example.test](mailto:admin@example.test)' });
    const check = await assessVapidConfig();
    expect(check.ok).toBe(false);
    expect(check.subjectValid).toBe(false);
    expect(check.problems.join(' ')).toMatch(/bare URI/);
    const { req, res } = makeReqRes('GET');
    await healthHandler(req, res);
    expect(res.body.verdict).toContain('VAPID-config-invalid');
    expect(JSON.stringify(res.body)).not.toContain(process.env.VAPID_PRIVATE_KEY);
  });

  it.each([
    ['missing private key', { VAPID_PRIVATE_KEY: '' }],
    ['wrong key length', { VAPID_PRIVATE_KEY: base64UrlEncode(Buffer.alloc(16)) }],
    ['all-zero scalar', { VAPID_PRIVATE_KEY: base64UrlEncode(Buffer.alloc(32)) }],
    ['garbage key', { VAPID_PRIVATE_KEY: 'not+base64/key=' }],
  ])('matches the shared validator for %s', async (_name, overrides) => {
    configure(overrides as Record<string, string>);
    const inline = await assessVapidConfig();
    const shared = validateVapidConfig({
      privateKey: process.env.VAPID_PRIVATE_KEY || '',
      subject: process.env.VAPID_SUBJECT || '',
    });
    expect(inline).toMatchObject({
      ok: shared.ok,
      subjectValid: shared.subjectValid,
      subjectScheme: shared.subjectScheme,
      privateKeyBytes: shared.privateKeyBytes,
      publicKeyBytes: shared.publicKeyBytes,
      problems: shared.problems,
    });
  });

  it('does not expose any VAPID key bytes in health JSON', async () => {
    const keys = generateVapidKeys();
    configure({ VAPID_PRIVATE_KEY: keys.privateKey });
    const { req, res } = makeReqRes('GET');
    await healthHandler(req, res);
    expect(JSON.stringify(res.body)).not.toContain(keys.privateKey);
    expect(res.body.vapid.privateKeyBytes).toBe(32);
  });
});
