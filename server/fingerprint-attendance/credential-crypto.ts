import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

function encryptionKey(): Buffer {
  const encoded = process.env.FINGERPRINT_CREDENTIAL_ENCRYPTION_KEY || '';
  const key = Buffer.from(encoded, 'base64');
  if (key.length !== 32 || key.toString('base64').replace(/=+$/, '') !== encoded.replace(/=+$/, '')) {
    throw new Error('Credential encryption is not configured.');
  }
  return key;
}

export function encryptDeviceCredential(secret: string) {
  const nonce = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', encryptionKey(), nonce);
  const ciphertext = Buffer.concat([cipher.update(secret, 'utf8'), cipher.final()]);
  return {
    ciphertext_b64: ciphertext.toString('base64'),
    nonce_b64: nonce.toString('base64'),
    auth_tag_b64: cipher.getAuthTag().toString('base64'),
  };
}

export function decryptDeviceCredential(row: { ciphertext_b64: string; nonce_b64: string; auth_tag_b64: string }): string {
  const decipher = createDecipheriv('aes-256-gcm', encryptionKey(), Buffer.from(row.nonce_b64, 'base64'));
  decipher.setAuthTag(Buffer.from(row.auth_tag_b64, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(row.ciphertext_b64, 'base64')), decipher.final()]).toString('utf8');
}
