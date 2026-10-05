/**
 * GET /api/push/vapid-public-key
 *
 * Returns the VAPID *public* key the browser needs for pushManager.subscribe().
 * The private key never leaves the server: it is read from VAPID_PRIVATE_KEY
 * and only the derived public point is exposed here.
 */

import { derivePublicKeyB64, generateVapidKeys } from '../../server/lib/webpush';

let devKeys: ReturnType<typeof generateVapidKeys> | null = null;

export default async function handler(req: any, res: any) {
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

  try {
    const publicKey = derivePublicKeyB64({
      privateKey,
      subject: process.env.VAPID_SUBJECT || 'mailto:admin@schoolnnnnass.vercel.app',
    });
    res.setHeader('Cache-Control', 'public, max-age=3600');
    return res.status(200).json({ publicKey });
  } catch (err) {
    return res.status(500).json({ error: 'VAPID_PRIVATE_KEY is invalid.' });
  }
}
