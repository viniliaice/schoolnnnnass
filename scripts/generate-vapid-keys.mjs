#!/usr/bin/env node
/**
 * Generates a VAPID keypair for Web Push and prints the Vercel environment
 * variables to set. Run: node scripts/generate-vapid-keys.mjs
 *
 * VAPID_PRIVATE_KEY must NEVER be added to any VITE_-prefixed variable or
 * committed to the repo — it only belongs in Vercel's server-side env vars.
 */

// server/lib/webpush.ts is TypeScript; replicate the tiny derivation here so
// the script has no build step.
import crypto from 'node:crypto';

function b64url(buf) {
  return Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

const { privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
const privJwk = privateKey.export({ format: 'jwk' });
const pubJwk = crypto.createPublicKey(privateKey).export({ format: 'jwk' });

const rawPrivate = Buffer.from(privJwk.d, 'base64url');
const rawPublic = Buffer.concat([
  Buffer.from([0x04]),
  Buffer.from(pubJwk.x, 'base64url'),
  Buffer.from(pubJwk.y, 'base64url'),
]);

console.log('Add these to your Vercel project (Settings → Environment Variables):\n');
console.log(`VAPID_PRIVATE_KEY=${b64url(rawPrivate)}`);
console.log(`VAPID_SUBJECT=mailto:admin@schoolnnnnass.vercel.app`);
console.log('\nOptional (lets the frontend skip the /api lookup):');
console.log(`VITE_VAPID_PUBLIC_KEY=${b64url(rawPublic)}`);
console.log('\nNever expose VAPID_PRIVATE_KEY to the browser.');
