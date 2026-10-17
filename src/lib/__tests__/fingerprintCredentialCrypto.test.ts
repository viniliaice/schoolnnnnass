import { afterEach, expect, it, vi } from 'vitest';
import { decryptDeviceCredential, encryptDeviceCredential } from '../../../server/fingerprint-attendance/credential-crypto';

afterEach(() => vi.unstubAllEnvs());
it('encrypts with AES-GCM and decrypts only on the server', () => {
  vi.stubEnv('FINGERPRINT_CREDENTIAL_ENCRYPTION_KEY', Buffer.alloc(32, 7).toString('base64'));
  const syntheticCredential = 'synthetic-test-only-4821';
  const stored = encryptDeviceCredential(syntheticCredential);
  expect(JSON.stringify(stored)).not.toContain(syntheticCredential);
  expect(Buffer.from(stored.nonce_b64, 'base64')).toHaveLength(12);
  expect(decryptDeviceCredential(stored)).toBe(syntheticCredential);
});
it('rejects tampering and missing/invalid encryption configuration', () => {
  vi.stubEnv('FINGERPRINT_CREDENTIAL_ENCRYPTION_KEY', Buffer.alloc(32, 3).toString('base64'));
  const stored = encryptDeviceCredential('synthetic-only');
  stored.ciphertext_b64 = Buffer.alloc(8, 0).toString('base64');
  expect(() => decryptDeviceCredential(stored)).toThrow();
  vi.stubEnv('FINGERPRINT_CREDENTIAL_ENCRYPTION_KEY', '');
  expect(() => encryptDeviceCredential('synthetic-only')).toThrow(/not configured/i);
});
