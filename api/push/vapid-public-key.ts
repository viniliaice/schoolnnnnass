/**
 * GET /api/push/vapid-public-key
 *
 * Returns the VAPID *public* key the browser needs for pushManager.subscribe().
 * The private key never leaves the server: it is read from VAPID_PRIVATE_KEY
 * and only the derived public point is exposed here.
 */

// Explicit .js extension required — see api/notifications/send.ts.
import { base64UrlDecode, derivePublicKeyB64, generateVapidKeys, validateVapidConfig } from '../../server/lib/webpush.js';

let devKeys: ReturnType<typeof generateVapidKeys> | null = null;

/**
 * Last-resort error responder: guarantees a readable JSON body instead of
 * Vercel's opaque FUNCTION_INVOCATION_FAILED page. (Failures *before* the
 * handler runs — module resolution — cannot be caught here; that is what the
 * explicit .js import specifiers above prevent.)
 */
function sendJsonError(res: any, _err: unknown, scope: string) {
  try {
    console.error(`[${scope}] unhandled failure`);
  } catch {
    /* logging must never mask the response */
  }
  const payload = { error: 'Could not serve the push public key.', code: 'HANDLER_EXCEPTION' };
  try {
    if (typeof res?.status === 'function' && typeof res?.json === 'function') {
      return res.status(500).json(payload);
    }
    res.statusCode = 500;
    if (typeof res.setHeader === 'function') res.setHeader('Content-Type', 'application/json');
    if (typeof res.end === 'function') return res.end(JSON.stringify(payload));
  } catch {
    /* nothing else we can do */
  }
  return undefined;
}

async function handleVapidPublicKey(req: any, res: any) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ error: 'Method Not Allowed' });
  }

  const privateKey = process.env.VAPID_PRIVATE_KEY;

  if (!privateKey) {
    // Local/dev convenience only: an ephemeral keypair lets the subscribe
    // flow be exercised without configuring Vercel env vars. Production must
    // set VAPID_PRIVATE_KEY (scripts/generate-vapid-keys.mjs).
    if (process.env.NODE_ENV !== 'production') {
      if (!devKeys) devKeys = generateVapidKeys();
      return res.status(200).json({ publicKey: devKeys.publicKey, subject: 'mailto:dev@localhost' });
    }
    return res.status(500).json({
      error: 'Missing VAPID_PRIVATE_KEY. Generate one with scripts/generate-vapid-keys.mjs and set it (plus VAPID_SUBJECT) in Vercel environment variables.',
    });
  }

  // A VAPID private key is a raw 32-byte P-256 scalar (base64url). Node's
  // setPrivateKey() accepts shorter buffers and derives a *different*
  // (well-formed but useless) public key from them, so the length is checked
  // explicitly: a mis-set key must fail loudly here rather than silently
  // handing browsers a key that no notification could ever be decrypted with.
  let privateKeyBytes: Buffer;
  try {
    if (!/^[A-Za-z0-9_-]+$/.test(privateKey)) throw new Error('invalid base64url alphabet');
    privateKeyBytes = base64UrlDecode(privateKey);
  } catch {
    privateKeyBytes = Buffer.alloc(0);
  }
  if (privateKeyBytes.length !== 32) {
    console.error(`[push/vapid-public-key] VAPID_PRIVATE_KEY decodes to ${privateKeyBytes.length} bytes, expected 32.`);
    return res.status(500).json({
      error: 'VAPID_PRIVATE_KEY must be a base64url-encoded 32-byte P-256 private key. Generate one with scripts/generate-vapid-keys.mjs.',
      code: 'INVALID_VAPID_PRIVATE_KEY',
      decodedBytes: privateKeyBytes.length,
    });
  }

  const vapid = {
    privateKey,
    subject: process.env.VAPID_SUBJECT || (process.env.NODE_ENV !== 'production' ? 'mailto:dev@localhost' : ''),
  };
  const vapidCheck = validateVapidConfig(vapid);
  if (!vapidCheck.ok) {
    return res.status(500).json({
      error: 'VAPID configuration is invalid. Check VAPID_PRIVATE_KEY and VAPID_SUBJECT (see /api/push/health).',
      code: 'INVALID_VAPID_CONFIG',
      problems: vapidCheck.problems,
      vapid: vapidCheck,
    });
  }

  try {
    const publicKey = derivePublicKeyB64(vapid);
    // The client refuses anything that is not a 65-byte uncompressed P-256
    // point, so verify it here too instead of shipping a key the browser will
    // reject with "InvalidAccessError".
    const publicKeyBytes = base64UrlDecode(publicKey);
    if (publicKeyBytes.length !== 65 || publicKeyBytes[0] !== 0x04) {
      console.error(`[push/vapid-public-key] derived public key is malformed (${publicKeyBytes.length} bytes).`);
      return res.status(500).json({ error: 'Derived VAPID public key is malformed.', code: 'INVALID_VAPID_PUBLIC_KEY' });
    }
    res.setHeader('Cache-Control', 'no-store');
    return res.status(200).json({ publicKey });
  } catch {
    console.error('[push/vapid-public-key] VAPID configuration is unusable.');
    return res.status(500).json({ error: 'VAPID configuration is invalid.', code: 'INVALID_VAPID_CONFIG' });
  }
}

export default async function handler(req: any, res: any) {
  try {
    return await handleVapidPublicKey(req, res);
  } catch (err) {
    return sendJsonError(res, err, 'push/vapid-public-key');
  }
}
