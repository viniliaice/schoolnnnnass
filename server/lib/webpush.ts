/**
 * Minimal, dependency-free Web Push sender (RFC 8030 delivery, RFC 8291
 * message encryption with the aes128gcm content coding, RFC 8292 VAPID
 * authorization) built on Node's `crypto` module. Runs in Vercel serverless
 * functions and in the vitest (node) environment.
 *
 * Only the VAPID *private* key ever touches this module; it is read from
 * process.env on the server and is never shipped to the browser (the browser
 * receives the public key from /api/push/vapid-public-key).
 */

import crypto from 'node:crypto';

export interface PushSubscriptionKeys {
  /** base64url-encoded uncompressed P-256 public key (65 bytes). */
  p256dh: string;
  /** base64url-encoded 16-byte auth secret. */
  auth: string;
}

export interface VapidConfig {
  /** base64url-encoded 32-byte P-256 private key. */
  privateKey: string;
  /** Contact URL, e.g. mailto:admin@school.example */
  subject: string;
}

export interface WebPushResult {
  status: number;
  ok: boolean;
  /** 404/410 from the push service — the subscription is dead. */
  expired: boolean;
  responseText: string;
}

/* ── base64url helpers ────────────────────────────────────────────────────── */

export function base64UrlEncode(buf: Buffer): string {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

export function base64UrlDecode(input: string): Buffer {
  const normalized = input.replace(/-/g, '+').replace(/_/g, '/');
  const padded = normalized + '='.repeat((4 - (normalized.length % 4)) % 4);
  return Buffer.from(padded, 'base64');
}

/* ── VAPID keys ───────────────────────────────────────────────────────────── */

export interface VapidKeyPair {
  privateKey: string; // base64url raw 32 bytes
  publicKey: string; // base64url raw 65 bytes uncompressed
}

/** Generate a fresh VAPID P-256 keypair (used by scripts/generate-vapid-keys.mjs). */
export function generateVapidKeys(): VapidKeyPair {
  const { privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const privJwk = privateKey.export({ format: 'jwk' }) as { d: string };
  const pubJwk = crypto.createPublicKey(privateKey).export({ format: 'jwk' }) as { x: string; y: string };
  const rawPublic = Buffer.concat([Buffer.from([0x04]), base64UrlDecode(pubJwk.x), base64UrlDecode(pubJwk.y)]);
  return { privateKey: privJwk.d, publicKey: base64UrlEncode(rawPublic) };
}

function privateKeyObject(vapid: VapidConfig): crypto.KeyObject {
  const d = base64UrlDecode(vapid.privateKey);
  if (d.length !== 32) {
    throw new Error('VAPID_PRIVATE_KEY must be a base64url-encoded 32-byte P-256 private key.');
  }
  // Re-derive the public point so the JWK is complete (Node requires x/y).
  const ecdh = crypto.createECDH('prime256v1');
  ecdh.setPrivateKey(d);
  const rawPublic = ecdh.getPublicKey(); // 65 bytes: 0x04 ‖ X  Y
  const x = rawPublic.subarray(1, 33);
  const y = rawPublic.subarray(33, 65);
  return crypto.createPrivateKey({
    format: 'jwk',
    key: { kty: 'EC', crv: 'P-256', d: base64UrlEncode(d), x: base64UrlEncode(x), y: base64UrlEncode(y) } as any,
  });
}

export function derivePublicKeyB64(vapid: VapidConfig): string {
  const d = base64UrlDecode(vapid.privateKey);
  const ecdh = crypto.createECDH('prime256v1');
  ecdh.setPrivateKey(d);
  return base64UrlEncode(ecdh.getPublicKey());
}

function vapidAuthorizationHeader(endpoint: string, vapid: VapidConfig): string {
  const aud = new URL(endpoint).origin;
  const header = base64UrlEncode(Buffer.from(JSON.stringify({ typ: 'JWT', alg: 'ES256' })));
  const claims = base64UrlEncode(
    Buffer.from(
      JSON.stringify({
        aud,
        exp: Math.floor(Date.now() / 1000) + 12 * 60 * 60,
        sub: vapid.subject,
      }),
    ),
  );
  const signingInput = `${header}.${claims}`;
  const priv = privateKeyObject(vapid);
  const signature = crypto.sign('sha256', Buffer.from(signingInput), {
    key: priv,
    dsaEncoding: 'ieee-p1363',
  });
  const jwt = `${signingInput}.${base64UrlEncode(signature)}`;
  return `vapid t=${jwt}, p=${derivePublicKeyB64(vapid)}`;
}

/* ── RFC 8291 payload encryption (aes128gcm) ──────────────────────────────── */

export function encryptPushPayload(
  payload: Buffer,
  keys: PushSubscriptionKeys,
  salt: Buffer = crypto.randomBytes(16),
  ephemeralPrivateKey?: Buffer,
): Buffer {
  const uaPublic = base64UrlDecode(keys.p256dh);
  const authSecret = base64UrlDecode(keys.auth);
  if (uaPublic.length !== 65 || uaPublic[0] !== 0x04) {
    throw new Error('Subscription p256dh key must be a 65-byte uncompressed P-256 point.');
  }
  if (authSecret.length !== 16) {
    throw new Error('Subscription auth secret must be 16 bytes.');
  }
  if (payload.length > 3993) {
    throw new Error('Push payload too large (max 3993 bytes after encryption overhead).');
  }

  // Ephemeral sender keypair (as = application server / sender key).
  // getPublicKey() already returns the 65-byte uncompressed point (0x04‖X‖Y).
  const ecdh = crypto.createECDH('prime256v1');
  if (ephemeralPrivateKey) ecdh.setPrivateKey(ephemeralPrivateKey);
  else ecdh.generateKeys();
  const asPublic = ecdh.getPublicKey();
  const sharedSecret = ecdh.computeSecret(uaPublic);

  // ikm = HKDF(salt=authSecret, ikm=ecdhSecret, info="WebPush: info\0"+uaPub+asPub, 32)
  const info = Buffer.concat([Buffer.from('WebPush: info\0', 'binary'), uaPublic, asPublic]);
  const ikm = Buffer.from(crypto.hkdfSync('sha256', sharedSecret, authSecret, info, 32));

  // content encryption key + nonce
  const cek = Buffer.from(
    crypto.hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0', 'binary'), 16),
  );
  const nonce = Buffer.from(
    crypto.hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: nonce\0', 'binary'), 12),
  );

  // Single record, final-delimiter 0x02 (no trailing padding).
  const plaintext = Buffer.concat([payload, Buffer.from([0x02])]);
  const cipher = crypto.createCipheriv('aes-128-gcm', cek, nonce);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final(), cipher.getAuthTag()]);

  // aes128gcm header: salt(16) | rs(4) | idlen(1) | keyid(idlen)
  const header = Buffer.concat([
    salt,
    Buffer.from([0, 0, 16, 0]), // rs = 4096
    Buffer.from([asPublic.length]),
    asPublic,
  ]);
  return Buffer.concat([header, ciphertext]);
}

/* ── Delivery ─────────────────────────────────────────────────────────────── */

export async function sendWebPush(opts: {
  endpoint: string;
  keys: PushSubscriptionKeys;
  payload: object;
  vapid: VapidConfig;
  ttlSeconds?: number;
  fetchImpl?: typeof fetch;
}): Promise<WebPushResult> {
  const doFetch = opts.fetchImpl ?? fetch;
  const body = encryptPushPayload(Buffer.from(JSON.stringify(opts.payload), 'utf8'), opts.keys);

  const response = await doFetch(opts.endpoint, {
    method: 'POST',
    headers: {
      TTL: String(opts.ttlSeconds ?? 24 * 60 * 60),
      'Content-Type': 'application/octet-stream',
      'Content-Encoding': 'aes128gcm',
      Authorization: vapidAuthorizationHeader(opts.endpoint, opts.vapid),
    },
    body: new Uint8Array(body),
  });

  const text = await response.text().catch(() => '');
  return {
    status: response.status,
    ok: response.status >= 200 && response.status < 300,
    expired: response.status === 404 || response.status === 410,
    responseText: text,
  };
}
