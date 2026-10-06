#!/usr/bin/env node
/**
 * Generates a VAPID keypair and prints the server-side Vercel variables to set.
 * Run: node scripts/generate-vapid-keys.mjs
 *
 * VAPID_PRIVATE_KEY must NEVER be added to any VITE_-prefixed variable or
 * committed to the repo — it only belongs in Vercel's server-side env vars.
 * Do not configure VITE_VAPID_PUBLIC_KEY either: the browser fetches the
 * current public key from /api/push/vapid-public-key to avoid stale build keys.
 */

// server/lib/webpush.ts is TypeScript; replicate the tiny private-key
// extraction here so the script has no build step.
import crypto from 'node:crypto';

function b64url(buf) {
  return Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

const { privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
const privJwk = privateKey.export({ format: 'jwk' });
const rawPrivate = Buffer.from(privJwk.d, 'base64url');

console.log('Add these to your Vercel project (Settings → Environment Variables):\n');
console.log(`VAPID_PRIVATE_KEY=${b64url(rawPrivate)}`);
console.log('VAPID_SUBJECT=mailto:admin@schoolnnnnass.vercel.app');
console.log('\nDo not set VITE_VAPID_PUBLIC_KEY; the browser fetches the current public key from /api/push/vapid-public-key.');
console.log('Never expose VAPID_PRIVATE_KEY to the browser.');
