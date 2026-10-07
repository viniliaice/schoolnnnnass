// @vitest-environment node
//
// Validates the dependency-free Web Push sender against the RFCs by acting as
// the *receiver*: it generates a real browser-like P-256 subscription, runs the
// shipped encryptPushPayload/sendWebPush, then decrypts the aes128gcm body with
// the subscriber's private key (RFC 8291 reader side) and verifies the VAPID
// Authorization header (RFC 8292). This proves the crypto on the send path is
// actually correct, not a re-implementation of it.

import crypto from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import {
  base64UrlDecode,
  base64UrlEncode,
  classifyPushStatus,
  derivePublicKeyB64,
  describePushFailure,
  encryptPushPayload,
  generateVapidKeys,
  looksLikeTokenProblem,
  sanitizePushResponseText,
  sendWebPush,
  validateVapidConfig,
  validateVapidSubject,
} from '../../../server/lib/webpush';

/** Build a browser-like push subscription (P-256 keypair + 16-byte auth). */
function makeBrowserSubscription() {
  const ecdh = crypto.createECDH('prime256v1');
  ecdh.generateKeys();
  const publicRaw = ecdh.getPublicKey(); // 65-byte uncompressed point
  const auth = crypto.randomBytes(16);
  return {
    privateKey: ecdh.getPrivateKey(),
    p256dh: base64UrlEncode(publicRaw),
    auth: base64UrlEncode(auth),
    endpoint: 'https://push.example.com/sub/abc123',
  };
}

/** RFC 8291 reader side: decrypt an aes128gcm push body. */
function decryptPushBody(body: Buffer, sub: ReturnType<typeof makeBrowserSubscription>): string {
  const salt = body.subarray(0, 16);
  const idlen = body[20];
  const keyid = body.subarray(21, 21 + idlen);
  const ciphertext = body.subarray(21 + idlen);

  const uaPublic = base64UrlDecode(sub.p256dh);
  const authSecret = base64UrlDecode(sub.auth);

  const ecdh = crypto.createECDH('prime256v1');
  ecdh.setPrivateKey(sub.privateKey);
  const shared = ecdh.computeSecret(keyid);

  const info = Buffer.concat([Buffer.from('WebPush: info\0', 'binary'), uaPublic, keyid]);
  const ikm = Buffer.from(crypto.hkdfSync('sha256', shared, authSecret, info, 32));

  const cek = Buffer.from(
    crypto.hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0', 'binary'), 16),
  );
  const nonce = Buffer.from(
    crypto.hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: nonce\0', 'binary'), 12),
  );

  const tagStart = ciphertext.length - 16;
  const decipher = crypto.createDecipheriv('aes-128-gcm', cek, nonce);
  decipher.setAuthTag(ciphertext.subarray(tagStart));
  const plaintext = Buffer.concat([decipher.update(ciphertext.subarray(0, tagStart)), decipher.final()]);

  // Strip the final-record 0x02 delimiter.
  expect(plaintext[plaintext.length - 1]).toBe(0x02);
  return plaintext.subarray(0, plaintext.length - 1).toString('utf8');
}

describe('Web Push sender (RFC 8291/8292)', () => {
  it('encrypts a payload the subscriber can decrypt (round-trip)', () => {
    const sub = makeBrowserSubscription();
    const payload = { title: 'Staff Meeting', body: 'Staff meeting tomorrow at 8:00 AM.' };

    const body = encryptPushPayload(Buffer.from(JSON.stringify(payload)), {
      p256dh: sub.p256dh,
      auth: sub.auth,
    });

    const decrypted = decryptPushBody(body, sub);
    expect(JSON.parse(decrypted)).toEqual(payload);
  });

  it('derives a stable public key from the VAPID private key', () => {
    const keys = generateVapidKeys();
    const derived = derivePublicKeyB64({ privateKey: keys.privateKey, subject: 'mailto:a@b.c' });
    expect(derived).toBe(keys.publicKey);
    expect(base64UrlDecode(keys.publicKey).length).toBe(65);
  });

  it('sends with a VAPID Authorization header and reports 410 as expired', async () => {
    const sub = makeBrowserSubscription();
    const vapid = generateVapidKeys();
    let captured: { url: string; headers: Record<string, string> } | null = null;

    const fetchImpl = (async (url: any, init: any) => {
      captured = { url: String(url), headers: init.headers };
      return { status: 410, text: async () => 'Gone' } as Response;
    }) as unknown as typeof fetch;

    const result = await sendWebPush({
      endpoint: sub.endpoint,
      keys: { p256dh: sub.p256dh, auth: sub.auth },
      payload: { title: 'x', body: 'y' },
      vapid: { privateKey: vapid.privateKey, subject: 'mailto:admin@school.example' },
      fetchImpl,
    });

    expect(captured).not.toBeNull();
    expect(captured!.url).toBe(sub.endpoint);
    const auth = captured!.headers.Authorization;
    expect(auth.startsWith('vapid t=')).toBe(true);
    // RFC 8292 §4.1 — auth-info = "vapid" 1*SP t-param [ 1*SP "," 1*SP k-param ].
    // The public key travels as `k=`, never the pre-RFC `p=` alias, so assert on
    // the parsed parameter names rather than on a substring that base64 could
    // happen to contain.
    const [tPart, kPart] = auth.slice('vapid '.length).split(',').map((part) => part.trim());
    expect(tPart.startsWith('t=')).toBe(true);
    expect(kPart).toBe(`k=${vapid.publicKey}`);
    // JWT structure: header.claims.signature
    const jwt = tPart.slice('t='.length);
    expect(jwt.split('.').length).toBe(3);
    const claims = JSON.parse(Buffer.from(jwt.split('.')[1], 'base64url').toString());
    expect(claims.aud).toBe('https://push.example.com');
    expect(claims.sub).toBe('mailto:admin@school.example');

    expect(result.status).toBe(410);
    expect(result.ok).toBe(false);
    expect(result.expired).toBe(true);
  });

  it('reports 201 as delivered and not expired', async () => {
    const sub = makeBrowserSubscription();
    const vapid = generateVapidKeys();
    const fetchImpl = (async () => ({ status: 201, text: async () => '' }) as Response) as unknown as typeof fetch;
    const result = await sendWebPush({
      endpoint: sub.endpoint,
      keys: { p256dh: sub.p256dh, auth: sub.auth },
      payload: { t: 1 },
      vapid: { privateKey: vapid.privateKey, subject: 'mailto:a@b.c' },
      fetchImpl,
    });
    expect(result.ok).toBe(true);
    expect(result.expired).toBe(false);
  });
});

describe('push failure taxonomy and safe VAPID checks', () => {
  it.each([
    [200, 'ok'], [201, 'ok'], [400, 'bad_request'], [401, 'unauthorized'], [403, 'forbidden'],
    [404, 'expired'], [410, 'expired'], [413, 'payload_too_large'], [429, 'rate_limited'], [503, 'server_error'], [0, 'network'],
  ] as const)('classifies HTTP %i as %s', (status, expected) => {
    expect(classifyPushStatus(status)).toBe(expected);
  });

  it('creates actionable descriptions and only marks 404/410 subscriptions unusable', () => {
    expect(describePushFailure({ status: 410, ok: false, expired: true, responseText: 'Gone' })).toMatchObject({
      code: 'expired', subscriptionUnusable: true, retryable: false,
      message: 'subscription expired (HTTP 410) — Gone',
    });
    expect(describePushFailure({ status: 403, ok: false, expired: false, responseText: 'Denied' })).toMatchObject({
      code: 'forbidden', subscriptionUnusable: false, retryable: false,
    });
    expect(describePushFailure({ status: 429, ok: false, expired: false, responseText: 'busy' }).retryable).toBe(true);
  });

  it('redacts JWTs, long base64url values, controls and endpoint paths', () => {
    const secret = 'A'.repeat(64);
    const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJtYWlsdG86YUBiLmMifQ.signaturevalue';
    const text = sanitizePushResponseText(`BadJwtToken\n${jwt}\u0000${secret} https://push.example.test/send/device-registration-token`);
    expect(text).toContain('<redacted-jwt>');
    expect(text).toContain('<redacted>');
    expect(text).toContain('https://push.example.test/<redacted-path>');
    expect(text).not.toContain(jwt);
    expect(text).not.toContain('device-registration-token');
    expect(sanitizePushResponseText('hello '.repeat(100))).toHaveLength(200);
    const endpoint = 'https://push.example.test/send/secret-registration-token-123456';
    const bodyWithPath = sanitizePushResponseText('Rejected endpoint /send/secret-registration-token-123456', 200, [endpoint]);
    expect(bodyWithPath).not.toContain('secret-registration-token-123456');
    expect(bodyWithPath).toContain('<redacted-endpoint>');
  });

  it('recognizes push-service VAPID/JWT problems', () => {
    expect(looksLikeTokenProblem('BadJwtToken')).toBe(true);
    expect(looksLikeTokenProblem('Unauthorized token signature')).toBe(true);
    expect(looksLikeTokenProblem('subscription expired')).toBe(false);
  });

  it('accepts bare mailto/https subjects but rejects Markdown and bracketed values', () => {
    expect(validateVapidSubject('mailto:admin@school.example')).toEqual({ valid: true, scheme: 'mailto' });
    expect(validateVapidSubject('https://school.example/contact')).toEqual({ valid: true, scheme: 'https' });
    expect(validateVapidSubject('[mailto:admin@school.example](mailto:admin@school.example)').valid).toBe(false);
    expect(validateVapidSubject('"mailto:admin@school.example"').valid).toBe(false);
    expect(validateVapidSubject('admin@school.example').valid).toBe(false);
  });

  it('validates key shape/scalar and never includes key bytes in the check', () => {
    const keys = generateVapidKeys();
    const valid = validateVapidConfig({ privateKey: keys.privateKey, subject: 'mailto:admin@example.test' });
    expect(valid).toMatchObject({ ok: true, privateKeyBytes: 32, publicKeyBytes: 65, subjectScheme: 'mailto' });
    expect(JSON.stringify(valid)).not.toContain(keys.privateKey);

    const markdown = validateVapidConfig({ privateKey: keys.privateKey, subject: '[mailto:admin@example.test](mailto:admin@example.test)' });
    expect(markdown.ok).toBe(false);
    expect(markdown.subjectValid).toBe(false);

    const zero = validateVapidConfig({ privateKey: base64UrlEncode(Buffer.alloc(32)), subject: 'mailto:admin@example.test' });
    expect(zero.ok).toBe(false);
    expect(zero.privateKeyBytes).toBe(32);
    expect(zero.publicKeyBytes).toBeNull();
  });

  it('returns a network failure without calling it expired when fetch rejects', async () => {
    const sub = makeBrowserSubscription();
    const vapid = generateVapidKeys();
    const fetchImpl = (async () => { throw new Error('getaddrinfo ENOTFOUND fake.push.local'); }) as unknown as typeof fetch;
    const result = await sendWebPush({
      endpoint: sub.endpoint,
      keys: { p256dh: sub.p256dh, auth: sub.auth },
      payload: { t: 1 },
      vapid: { privateKey: vapid.privateKey, subject: 'mailto:a@b.c' },
      fetchImpl,
    });
    expect(result).toMatchObject({ status: 0, ok: false, expired: false, networkError: 'getaddrinfo ENOTFOUND fake.push.local' });
    expect(describePushFailure(result).code).toBe('network');
  });

  it('fails on malformed stored keys before making a network request', async () => {
    const vapid = generateVapidKeys();
    const fetchImpl = vi.fn(async () => ({ status: 201, text: async () => '' }) as Response) as unknown as typeof fetch;
    await expect(sendWebPush({
      endpoint: 'https://push.example.test/secret-path',
      keys: { p256dh: 'not-a-point', auth: 'also-invalid' },
      payload: { t: 1 },
      vapid: { privateKey: vapid.privateKey, subject: 'mailto:a@b.c' },
      fetchImpl,
    })).rejects.toThrow(/p256dh/);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it.each([[400, 'InvalidSubscription'], [401, 'Unauthorized'], [403, 'BadJwtToken'], [429, 'TooManyRequests'], [503, 'Unavailable']])(
    'preserves status and body for HTTP %i', async (status, body) => {
      const sub = makeBrowserSubscription();
      const vapid = generateVapidKeys();
      const fetchImpl = (async () => ({ status, text: async () => body }) as Response) as unknown as typeof fetch;
      const result = await sendWebPush({
        endpoint: sub.endpoint,
        keys: { p256dh: sub.p256dh, auth: sub.auth },
        payload: { t: 1 },
        vapid: { privateKey: vapid.privateKey, subject: 'mailto:a@b.c' },
        fetchImpl,
      });
      expect(result.status).toBe(status);
      expect(result.responseText).toBe(body);
      expect(result.ok).toBe(false);
    },
  );
});
