// @vitest-environment node
import { afterEach, describe, expect, it } from 'vitest';
import handler from '../../../api/push/vapid-public-key';
import { base64UrlDecode, generateVapidKeys } from '../../../server/lib/webpush';
import { makeReqRes, setServerEnv, validVapidEnv } from './helpers/fakeNetwork';

let restore: (() => void) | null = null;
afterEach(() => { restore?.(); restore = null; });

function configure(overrides: Record<string, string | undefined> = {}) {
  restore?.();
  restore = setServerEnv(overrides);
}

describe('GET /api/push/vapid-public-key', () => {
  it('returns the valid public point derived from the configured private key only', async () => {
    const keys = generateVapidKeys();
    configure({ VAPID_PRIVATE_KEY: keys.privateKey, VAPID_SUBJECT: 'mailto:admin@example.test' });
    const { req, res } = makeReqRes('GET');
    await handler(req, res);

    expect(res.statusCode).toBe(200);
    const publicPoint = base64UrlDecode(res.body.publicKey);
    expect(publicPoint).toHaveLength(65);
    expect(publicPoint[0]).toBe(0x04);
    expect(res.body.publicKey).toBe(keys.publicKey);
    expect(JSON.stringify(res.body)).not.toContain(keys.privateKey);
    expect(res.body).not.toHaveProperty('subject');
  });

  it('fails safely for invalid private-key material without echoing the value', async () => {
    const invalidKey = 'invalid-private-key-material-that-must-never-be-returned';
    configure({ VAPID_PRIVATE_KEY: invalidKey });
    const { req, res } = makeReqRes('GET');
    await handler(req, res);

    expect(res.statusCode).toBe(500);
    expect(res.body).toMatchObject({ code: 'INVALID_VAPID_PRIVATE_KEY' });
    expect(JSON.stringify(res.body)).not.toContain(invalidKey);
  });

  it('rejects methods other than GET', async () => {
    configure(validVapidEnv());
    const { req, res } = makeReqRes('POST');
    await handler(req, res);
    expect(res.statusCode).toBe(405);
    expect(res.headers.allow).toBe('GET');
  });
});
