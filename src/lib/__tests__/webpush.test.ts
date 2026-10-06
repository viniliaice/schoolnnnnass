// @vitest-environment node
//
// Validates the dependency-free Web Push sender against the RFCs by acting as
// the *receiver*: it generates a real browser-like P-256 subscription, runs the
// shipped encryptPushPayload/sendWebPush, then decrypts the aes128gcm body with
// the subscriber's private key (RFC 8291 reader side) and verifies the VAPID
// Authorization header (RFC 8292). This proves the crypto on the send path is
// actually correct, not a re-implementation of it.

import crypto from 'node:crypto';
import { describe, expect, it } from 'vitest';
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
    expect(auth).toContain(`p=${vapid.publicKey}`);
    // JWT structure: header.claims.signature
    const jwt = auth.slice('vapid t='.length).split(',')[0];
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

describe('push result classification and VAPID validation', () => {
  it.each([
    [201, 'ok'], [204, 'ok'], [400, 'bad_request'], [401, 'unauthorized'], [403, 'forbidden'],
    [404, 'expired'], [410, 'expired'], [413, 'payload_too_large'], [429, 'rate_limited'],
    [500, 'server_error'], [503, 'server_error'], [0, 'network'],
  ] as const)('classifies HTTP %i as %s', (status, expected) => {
    expect(classifyPushStatus(status)).toBe(expected);
  });

  it('describes failures with a sanitized service detail and retry policy', () => {
    expect(describePushFailure({ status: 410, ok: false, expired: true, responseText: 'Gone' })).toMatchObject({
      code: 'expired', retryable: false, subscriptionUnusable: true,
    });
    expect(describePushFailure({ status: 429, ok: false, expired: false, responseText: 'retry later' }).retryable).toBe(true);
    expect(describePushFailure({ status: 400, ok: false, expired: false, responseText: 'Invalid request' }).message).toContain('HTTP 400');
    expect(describePushFailure({ status: 0, ok: false, expired: false, responseText: '', networkError: 'getaddrinfo ENOTFOUND fcm.googleapis.com' }).message).toContain('ENOTFOUND');
  });

  it('redacts JWTs, long base64url material, control characters and endpoint paths', () => {
    const jwt = `eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJzZWNyZXQifQ.${'a'.repeat(48)}`;
    const sanitized = sanitizePushResponseText(`Bad ${jwt}\n${'A'.repeat(64)} https://push.example/subscription-registration-token`);
    expect(sanitized).toContain('<redacted-jwt>');
    expect(sanitized).toContain('<redacted>');
    expect(sanitized).not.toContain(jwt);
    expect(sanitized).not.toContain('subscription-registration-token');
    expect(sanitizePushResponseText('detail '.repeat(100))).toHaveLength(200);
  });

  it('detects push-service JWT/VAPID token problems', () => {
    expect(looksLikeTokenProblem('BadJwtToken')).toBe(true);
    expect(looksLikeTokenProblem('Unauthorized')).toBe(true);
    expect(looksLikeTokenProblem('invalid token signature')).toBe(true);
    expect(looksLikeTokenProblem('sender key mismatch')).toBe(false);
  });

  it('accepts bare mailto/https subjects and rejects the production Markdown value', () => {
    expect(validateVapidSubject('mailto:admin@school.example')).toMatchObject({ valid: true, scheme: 'mailto' });
    expect(validateVapidSubject('https://school.example/contact')).toMatchObject({ valid: true, scheme: 'https' });
    expect(validateVapidSubject('[mailto:admin@school.example](mailto:admin@school.example)').valid).toBe(false);
    expect(validateVapidSubject('admin@school.example').valid).toBe(false);
    expect(validateVapidSubject('"mailto:admin@school.example"').valid).toBe(false);
  });

  it('validates raw private-key length and a derivable P-256 point without exposing key bytes', () => {
    const keys = generateVapidKeys();
    expect(validateVapidConfig({ privateKey: keys.privateKey, subject: 'mailto:admin@school.example' })).toMatchObject({
      ok: true, subjectValid: true, subjectScheme: 'mailto', privateKeyBytes: 32, publicKeyBytes: 65,
    });
    const badSubject = validateVapidConfig({ privateKey: keys.privateKey, subject: '[mailto:a@b](mailto:a@b)' });
    expect(badSubject.ok).toBe(false);
    expect(badSubject.problems.join(' ')).toMatch(/Markdown/);
    const zeroScalar = base64UrlEncode(Buffer.alloc(32));
    expect(validateVapidConfig({ privateKey: zeroScalar, subject: 'mailto:a@b' }).ok).toBe(false);
    expect(JSON.stringify(badSubject)).not.toContain(keys.privateKey);
  });

  it('returns a network classification for fetch failures, never expired', async () => {
    const sub = makeBrowserSubscription();
    const vapid = generateVapidKeys();
    const dns = Object.assign(new Error('fetch failed'), {
      cause: Object.assign(new Error('getaddrinfo ENOTFOUND push.example.com'), { code: 'ENOTFOUND', hostname: 'push.example.com' }),
    });
    const result = await sendWebPush({
      endpoint: sub.endpoint,
      keys: { p256dh: sub.p256dh, auth: sub.auth },
      payload: { title: 'x' },
      vapid: { privateKey: vapid.privateKey, subject: 'mailto:a@b.c' },
      fetchImpl: (async () => { throw dns; }) as unknown as typeof fetch,
    });
    expect(result).toMatchObject({ status: 0, ok: false, expired: false });
    expect(result.networkError).toContain('ENOTFOUND');
    expect(classifyPushStatus(result.status)).toBe('network');
  });

  it('keeps malformed subscription encryption material in pre-flight (no fetch call)', async () => {
    const vapid = generateVapidKeys();
    let calls = 0;
    await expect(sendWebPush({
      endpoint: 'https://fcm.googleapis.com/send/device',
      keys: { p256dh: 'bad', auth: 'bad' },
      payload: { title: 'x' },
      vapid: { privateKey: vapid.privateKey, subject: 'mailto:a@b.c' },
      fetchImpl: (async () => { calls += 1; return new Response(null, { status: 201 }); }) as typeof fetch,
    })).rejects.toThrow(/p256dh/);
    expect(calls).toBe(0);
  });
});
