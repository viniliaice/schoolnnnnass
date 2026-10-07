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
  /** Contact URI, e.g. mailto:admin@school.example */
  subject: string;
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

export interface WebPushResult {
  status: number;
  ok: boolean;
  /** 404/410 from the push service — the subscription is dead. */
  expired: boolean;
  responseText: string;
  /** Present when the push service could not be reached at all. */
  networkError?: string;
}

export type VapidSubjectScheme = 'mailto' | 'https' | 'invalid';

export interface VapidSubjectValidation {
  valid: boolean;
  scheme: VapidSubjectScheme;
  reason?: string;
}

/** Safe-to-return VAPID inspection. Never includes any key material. */
export interface VapidConfigCheck {
  ok: boolean;
  subjectValid: boolean;
  subjectScheme: VapidSubjectScheme;
  privateKeyBytes: number;
  publicKeyBytes: number | null;
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

function decodeBase64UrlStrict(input: unknown): Buffer | null {
  if (typeof input !== 'string' || !/^[A-Za-z0-9_-]*={0,2}$/.test(input)) return null;
  const unpadded = input.replace(/=+$/, '');
  if (unpadded.length === 0 && input.length > 0) return null;
  return base64UrlDecode(unpadded);
}

/* ── VAPID keys and configuration validation ─────────────────────────────── */

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

function publicPointFromPrivateBytes(d: Buffer): Buffer {
  if (d.length !== 32) {
    throw new Error('VAPID_PRIVATE_KEY must be a base64url-encoded 32-byte P-256 private key.');
  }
  const ecdh = crypto.createECDH('prime256v1');
  ecdh.setPrivateKey(d);
  const point = ecdh.getPublicKey();
  if (point.length !== 65 || point[0] !== 0x04) {
    throw new Error('VAPID_PRIVATE_KEY did not derive a valid uncompressed P-256 public point.');
  }
  return point;
}

function privateKeyObject(vapid: VapidConfig): crypto.KeyObject {
  const d = decodeBase64UrlStrict(vapid.privateKey);
  if (!d || d.length !== 32) {
    throw new Error('VAPID_PRIVATE_KEY must be a base64url-encoded 32-byte P-256 private key.');
  }
  // Re-derive the public point so the JWK is complete (Node requires x/y).
  const rawPublic = publicPointFromPrivateBytes(d);
  const x = rawPublic.subarray(1, 33);
  const y = rawPublic.subarray(33, 65);
  return crypto.createPrivateKey({
    format: 'jwk',
    key: { kty: 'EC', crv: 'P-256', d: base64UrlEncode(d), x: base64UrlEncode(x), y: base64UrlEncode(y) } as any,
  });
}

export function derivePublicKeyB64(vapid: VapidConfig): string {
  const d = decodeBase64UrlStrict(vapid.privateKey);
  if (!d || d.length !== 32) {
    throw new Error('VAPID_PRIVATE_KEY must be a base64url-encoded 32-byte P-256 private key.');
  }
  return base64UrlEncode(publicPointFromPrivateBytes(d));
}

/** Validate a VAPID `sub` value as a bare RFC 8292 contact URI. */
export function validateVapidSubject(subject: unknown): VapidSubjectValidation {
  const value = typeof subject === 'string' ? subject.trim() : '';
  const invalid = (reason: string): VapidSubjectValidation => ({ valid: false, scheme: 'invalid', reason });

  if (!value) return invalid('VAPID_SUBJECT is empty. Set it to a bare mailto: or https: URI.');
  // Markdown links, quotes, whitespace and angle-bracket wrappers are not URIs
  // for the VAPID sub claim. In particular, reject
  // [mailto:address](mailto:address), which push services reject.
  if (/[\s\[\]()<>'"`]/.test(value)) {
    return invalid('VAPID_SUBJECT must be a bare URI, not Markdown, bracketed, quoted, or whitespace-padded text.');
  }

  if (/^mailto:/i.test(value)) {
    if (value.slice(value.indexOf(':') + 1).length === 0) {
      return invalid('VAPID_SUBJECT mailto: URI must include a contact address.');
    }
    return { valid: true, scheme: 'mailto' };
  }

  if (/^https:/i.test(value)) {
    try {
      const parsed = new URL(value);
      if (parsed.protocol !== 'https:' || !parsed.hostname || parsed.username || parsed.password) {
        return invalid('VAPID_SUBJECT must be a valid https: contact URI without credentials.');
      }
      return { valid: true, scheme: 'https' };
    } catch {
      return invalid('VAPID_SUBJECT must be a valid https: contact URI.');
    }
  }

  return invalid('VAPID_SUBJECT must use the mailto: or https: URI scheme.');
}

/** Validate the server-side VAPID private key and subject without returning key bytes. */
export function validateVapidConfig(config: Partial<VapidConfig> | null | undefined): VapidConfigCheck {
  const problems: string[] = [];
  const keyBytes = decodeBase64UrlStrict(config?.privateKey);
  const privateKeyBytes = keyBytes?.length ?? 0;
  let publicKeyBytes: number | null = null;

  if (!keyBytes || privateKeyBytes !== 32) {
    problems.push(`VAPID_PRIVATE_KEY must decode to 32 bytes (currently ${privateKeyBytes}).`);
  } else {
    try {
      const publicPoint = publicPointFromPrivateBytes(keyBytes);
      publicKeyBytes = publicPoint.length;
      if (publicPoint.length !== 65 || publicPoint[0] !== 0x04) {
        problems.push('VAPID_PRIVATE_KEY does not derive a valid 65-byte P-256 public point.');
      }
    } catch {
      problems.push('VAPID_PRIVATE_KEY is not a valid P-256 scalar.');
    }
  }

  const subjectCheck = validateVapidSubject(config?.subject);
  if (!subjectCheck.valid && subjectCheck.reason) problems.push(subjectCheck.reason);

  return {
    ok: problems.length === 0,
    subjectValid: subjectCheck.valid,
    subjectScheme: subjectCheck.scheme,
    privateKeyBytes,
    publicKeyBytes,
    problems,
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
  return `vapid t=${jwt}, k=${derivePublicKeyB64(vapid)}`;
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

/* ── Failure classification and safe diagnostics ────────────────────────── */

export function classifyPushStatus(status: number): PushFailureCode {
  if (status >= 200 && status < 300) return 'ok';
  if (status === 0) return 'network';
  if (status === 400) return 'bad_request';
  if (status === 401) return 'unauthorized';
  if (status === 403) return 'forbidden';
  if (status === 404 || status === 410) return 'expired';
  if (status === 413) return 'payload_too_large';
  if (status === 429) return 'rate_limited';
  if (status >= 500) return 'server_error';
  if (status >= 400) return 'bad_request';
  return 'server_error';
}

/** Remove control characters and registration/auth tokens before persistence or display. */
export function sanitizePushResponseText(text: unknown, maxLen = 200, sensitiveEndpoints: string[] = []): string {
  const safeMax = Number.isFinite(maxLen) ? Math.max(0, Math.floor(maxLen)) : 200;
  let value = typeof text === 'string' ? text : String(text ?? '');
  for (const endpoint of sensitiveEndpoints) {
    if (typeof endpoint !== 'string' || endpoint.length === 0) continue;
    try {
      const parsed = new URL(endpoint);
      const tokens = [endpoint, parsed.href, parsed.pathname];
      for (const segment of parsed.pathname.split('/').filter((part) => part.length >= 8)) {
        tokens.push(segment);
        try { tokens.push(decodeURIComponent(segment)); } catch { /* retain encoded segment */ }
      }
      parsed.searchParams.forEach((part) => { if (part.length >= 8) tokens.push(part); });
      for (const token of new Set(tokens.filter(Boolean))) {
        value = value.split(token).join('<redacted-endpoint>');
      }
    } catch {
      value = value.split(endpoint).join('<redacted-endpoint>');
    }
  }
  value = value.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, ' ');
  value = value.replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, '<redacted-jwt>');
  value = value.replace(/[A-Za-z0-9_-]{40,}/g, '<redacted>');
  // Push endpoints contain a per-device registration token in their path.
  // If a provider happens to echo a URL, preserve only its origin.
  value = value.replace(/https?:\/\/[^\s"'<>]+/gi, (match) => {
    try {
      return `${new URL(match).origin}/<redacted-path>`;
    } catch {
      return '<redacted-url>';
    }
  });
  return value.replace(/\s+/g, ' ').trim().slice(0, safeMax);
}

export function looksLikeTokenProblem(body: unknown): boolean {
  return /badjwt|invalid\s*jwt|token|unauthori[sz]ed/i.test(typeof body === 'string' ? body : String(body ?? ''));
}

export interface PushFailureDescription {
  code: PushFailureCode;
  message: string;
  retryable: boolean;
  subscriptionUnusable: boolean;
}

export function describePushFailure(result: WebPushResult, endpoint?: string): PushFailureDescription {
  const code = result.networkError ? 'network' : classifyPushStatus(result.status);
  const sensitiveEndpoints = endpoint ? [endpoint] : [];
  const detail = sanitizePushResponseText(result.responseText, 200, sensitiveEndpoints);
  const network = sanitizePushResponseText(result.networkError, 160, sensitiveEndpoints);
  const suffix = detail ? ` — ${detail}` : '';
  let message: string;

  if (code === 'ok') {
    message = `push service accepted the notification (HTTP ${result.status})`;
  } else if (code === 'expired') {
    message = `subscription expired (HTTP ${result.status})${suffix}`;
  } else if (code === 'unauthorized' || code === 'forbidden') {
    message = `push service rejected VAPID authorization (HTTP ${result.status})${suffix}`;
  } else if (code === 'network') {
    message = `could not reach the push service${network ? ` (${network})` : ''}`;
  } else {
    const label = code === 'bad_request'
      ? 'push service rejected the request'
      : code === 'payload_too_large'
        ? 'push payload is too large'
        : code === 'rate_limited'
          ? 'push service rate-limited the request'
          : 'push service returned a server error';
    message = `${label} (HTTP ${result.status})${suffix}`;
  }

  return {
    code,
    message: sanitizePushResponseText(message, 200),
    retryable: code === 'network' || code === 'rate_limited' || code === 'server_error',
    subscriptionUnusable: code === 'expired',
  };
}

/* ── Delivery ─────────────────────────────────────────────────────────────── */

function networkErrorMessage(err: unknown): string {
  const outer = err && typeof err === 'object' ? err as { message?: unknown; cause?: unknown } : null;
  const cause = outer?.cause;
  const nestedMessage = cause && typeof cause === 'object' && 'message' in cause
    ? (cause as { message?: unknown }).message
    : null;
  return sanitizePushResponseText(nestedMessage ?? outer?.message ?? err, 240) || 'network request failed';
}

export async function sendWebPush(opts: {
  endpoint: string;
  keys: PushSubscriptionKeys;
  payload: object;
  vapid: VapidConfig;
  ttlSeconds?: number;
  fetchImpl?: typeof fetch;
}): Promise<WebPushResult> {
  const doFetch = opts.fetchImpl ?? fetch;
  // Encryption and VAPID/header construction are intentionally pre-flight.
  // Bad stored key material throws here and never makes a network request.
  const body = encryptPushPayload(Buffer.from(JSON.stringify(opts.payload), 'utf8'), opts.keys);
  const authorization = vapidAuthorizationHeader(opts.endpoint, opts.vapid);

  let response: Response;
  try {
    response = await doFetch(opts.endpoint, {
      method: 'POST',
      headers: {
        TTL: String(opts.ttlSeconds ?? 24 * 60 * 60),
        'Content-Type': 'application/octet-stream',
        'Content-Encoding': 'aes128gcm',
        Authorization: authorization,
      },
      body: new Uint8Array(body),
    });
  } catch (err) {
    return {
      status: 0,
      ok: false,
      expired: false,
      responseText: '',
      networkError: networkErrorMessage(err),
    };
  }

  const text = await response.text().catch(() => '');
  return {
    status: response.status,
    ok: response.status >= 200 && response.status < 300,
    expired: response.status === 404 || response.status === 410,
    responseText: text,
  };
}
