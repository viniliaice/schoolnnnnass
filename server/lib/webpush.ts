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
  /** Present only when the push service could not be reached. */
  networkError?: string;
}

export type PushFailureCode =
  | 'ok'
  | 'bad_request'
  | 'unauthorized'
  | 'forbidden'
  | 'expired'
  | 'payload_too_large'
  | 'rate_limited'
  | 'server_error'
  | 'network';

export interface PushFailureDescription {
  code: PushFailureCode;
  message: string;
  retryable: boolean;
  subscriptionUnusable: boolean;
}

export interface VapidSubjectCheck {
  valid: boolean;
  scheme: 'mailto' | 'https' | 'invalid';
  reason?: string;
}

/** Safe to return in health/diagnostic responses: contains counts, never keys. */
export interface VapidConfigCheck {
  ok: boolean;
  subjectValid: boolean;
  subjectScheme: 'mailto' | 'https' | 'invalid';
  privateKeyBytes: number;
  publicKeyBytes: number;
  problems: string[];
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
  if (d.length !== 32) throw new Error('VAPID_PRIVATE_KEY must be a 32-byte P-256 scalar.');
  const ecdh = crypto.createECDH('prime256v1');
  ecdh.setPrivateKey(d);
  return base64UrlEncode(ecdh.getPublicKey());
}

/**
 * RFC 8292 requires the `sub` claim to be a bare URI. Keep mailbox syntax
 * deliberately permissive, but reject Markdown links, quoted strings,
 * whitespace and non-contact URI schemes (the production misconfiguration
 * was a Markdown link rather than a mailto URI).
 */
export function validateVapidSubject(subject: unknown): VapidSubjectCheck {
  if (typeof subject !== 'string' || subject.length === 0) {
    return { valid: false, scheme: 'invalid', reason: 'VAPID_SUBJECT is empty.' };
  }
  if (subject !== subject.trim() || /[\s\u0000-\u001f\u007f]/.test(subject)) {
    return { valid: false, scheme: 'invalid', reason: 'VAPID_SUBJECT must be a bare URI without whitespace.' };
  }
  if (/[\[\]{}<>"'`]/.test(subject) || /\]\s*\(/.test(subject)) {
    return { valid: false, scheme: 'invalid', reason: 'VAPID_SUBJECT must not be a Markdown link or quoted value.' };
  }

  if (/^mailto:/i.test(subject)) {
    const mailbox = subject.slice(subject.indexOf(':') + 1);
    if (!mailbox || mailbox.startsWith('//')) {
      return { valid: false, scheme: 'invalid', reason: 'VAPID_SUBJECT mailto URI must include a contact.' };
    }
    return { valid: true, scheme: 'mailto' };
  }

  if (/^https:/i.test(subject)) {
    try {
      const parsed = new URL(subject);
      if (parsed.protocol !== 'https:' || !parsed.hostname || parsed.username || parsed.password) {
        return { valid: false, scheme: 'invalid', reason: 'VAPID_SUBJECT must be a valid https URI.' };
      }
      return { valid: true, scheme: 'https' };
    } catch {
      return { valid: false, scheme: 'invalid', reason: 'VAPID_SUBJECT must be a valid https URI.' };
    }
  }

  return { valid: false, scheme: 'invalid', reason: 'VAPID_SUBJECT must use mailto: or https:.' };
}

/** Validate the server's VAPID credentials without returning any key material. */
export function validateVapidConfig(config: Partial<VapidConfig> | null | undefined): VapidConfigCheck {
  const problems: string[] = [];
  const subjectCheck = validateVapidSubject(config?.subject);
  if (!subjectCheck.valid && subjectCheck.reason) problems.push(subjectCheck.reason);

  let privateKeyBytes = 0;
  let publicKeyBytes = 0;
  let privateKeyEncodingValid = false;
  const privateKey = typeof config?.privateKey === 'string' ? config.privateKey : '';
  try {
    if (!/^[A-Za-z0-9_-]+$/.test(privateKey)) throw new Error('invalid base64url alphabet');
    const raw = base64UrlDecode(privateKey);
    privateKeyBytes = raw.length;
    privateKeyEncodingValid = raw.length === 32;
  } catch {
    privateKeyBytes = 0;
  }

  if (!privateKeyEncodingValid) {
    problems.push(`VAPID_PRIVATE_KEY must decode to 32 bytes (got ${privateKeyBytes}).`);
  } else {
    try {
      const publicKey = base64UrlDecode(derivePublicKeyB64({ privateKey, subject: config?.subject || '' }));
      publicKeyBytes = publicKey.length;
      if (publicKey.length !== 65 || publicKey[0] !== 0x04) {
        problems.push('VAPID_PRIVATE_KEY did not derive a valid uncompressed P-256 public key.');
      }
    } catch {
      // Never forward a crypto-library exception: it may include key details.
      problems.push('VAPID_PRIVATE_KEY is not a valid P-256 scalar.');
    }
  }

  return {
    ok: problems.length === 0,
    subjectValid: subjectCheck.valid,
    subjectScheme: subjectCheck.scheme,
    privateKeyBytes,
    publicKeyBytes,
    problems,
  };
}

/** Map a push service HTTP status (or 0 for transport failure) to a stable category. */
export function classifyPushStatus(status: number): PushFailureCode {
  if (status >= 200 && status < 300) return 'ok';
  if (status === 0) return 'network';
  if (status === 400) return 'bad_request';
  if (status === 401) return 'unauthorized';
  if (status === 403) return 'forbidden';
  if (status === 404 || status === 410) return 'expired';
  if (status === 413) return 'payload_too_large';
  if (status === 429) return 'rate_limited';
  if (status >= 500 && status <= 599) return 'server_error';
  return 'server_error';
}

/** Redact token-like material before a push-service detail is persisted or shown. */
export function sanitizePushResponseText(text: unknown, maxLen = 200): string {
  const limit = Math.max(0, Math.floor(maxLen));
  if (limit === 0) return '';
  let safe = String(text ?? '')
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ')
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, '<redacted-jwt>')
    .replace(/\b[A-Za-z0-9_-]{40,}\b/g, '<redacted>')
    .replace(/https?:\/\/[^\s/]+\/[^\s]*/gi, (url) => {
      try {
        return `${new URL(url).origin}/<redacted-path>`;
      } catch {
        return '<redacted-url>';
      }
    })
    .replace(/\s+/g, ' ')
    .trim();
  if (safe.length > limit) safe = `${safe.slice(0, Math.max(0, limit - 1))}…`;
  return safe;
}

/** True when a service response explicitly points at a VAPID/JWT token issue. */
export function looksLikeTokenProblem(body: unknown): boolean {
  return /badjwt|invalid\s*jwt|\btoken\b|unauthori[sz]ed/i.test(String(body ?? ''));
}

export function describePushFailure(result: WebPushResult): PushFailureDescription {
  const code = classifyPushStatus(result.status);
  if (code === 'ok') {
    return { code, message: 'push service accepted the notification', retryable: false, subscriptionUnusable: false };
  }

  const detail = sanitizePushResponseText(result.networkError || result.responseText);
  const suffix = detail ? ` — ${detail}` : '';
  let message: string;
  switch (code) {
    case 'expired':
      message = `subscription expired (HTTP ${result.status})${suffix}`;
      break;
    case 'unauthorized':
      message = `push service rejected VAPID authorization (HTTP ${result.status})${suffix}`;
      break;
    case 'forbidden':
      message = `push service rejected the subscription (HTTP ${result.status})${suffix}`;
      break;
    case 'bad_request':
      message = `push service rejected the request (HTTP ${result.status})${suffix}`;
      break;
    case 'payload_too_large':
      message = `push payload was too large (HTTP ${result.status})${suffix}`;
      break;
    case 'rate_limited':
      message = `push service rate limited the request (HTTP ${result.status})${suffix}`;
      break;
    case 'network':
      message = `could not reach the push service${suffix}`;
      break;
    default:
      message = `push service failed (HTTP ${result.status})${suffix}`;
  }
  return {
    code,
    message,
    retryable: code === 'network' || code === 'rate_limited' || code === 'server_error',
    subscriptionUnusable: code === 'expired',
  };
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
  // Encryption, endpoint parsing and VAPID signing are intentionally outside
  // the transport try/catch. Invalid stored keys/config are a pre-flight error,
  // not a DNS/network failure and must never retire a subscription.
  const body = encryptPushPayload(Buffer.from(JSON.stringify(opts.payload), 'utf8'), opts.keys);
  const headers = {
    TTL: String(opts.ttlSeconds ?? 24 * 60 * 60),
    'Content-Type': 'application/octet-stream',
    'Content-Encoding': 'aes128gcm',
    Authorization: vapidAuthorizationHeader(opts.endpoint, opts.vapid),
  };

  let response: Response;
  try {
    response = await doFetch(opts.endpoint, {
      method: 'POST',
      headers,
      body: new Uint8Array(body),
    });
  } catch (err) {
    const cause = err as (Error & { code?: string; hostname?: string; cause?: unknown }) | null;
    const nested = cause?.cause && typeof cause.cause === 'object'
      ? cause.cause as { code?: unknown; hostname?: unknown; message?: unknown }
      : null;
    const code = typeof cause?.code === 'string'
      ? cause.code
      : typeof nested?.code === 'string' ? nested.code : '';
    const host = typeof cause?.hostname === 'string'
      ? cause.hostname
      : typeof nested?.hostname === 'string' ? nested.hostname : '';
    const fallback = cause instanceof Error ? cause.message : String(err);
    const safeMessage = sanitizePushResponseText(
      [code, host, fallback].filter(Boolean).join(' '),
      300,
    );
    return { status: 0, ok: false, expired: false, responseText: '', networkError: safeMessage };
  }

  const text = await response.text().catch(() => '');
  return {
    status: response.status,
    ok: response.status >= 200 && response.status < 300,
    expired: response.status === 404 || response.status === 410,
    responseText: text,
  };
}
