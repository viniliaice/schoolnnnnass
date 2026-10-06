/**
 * Guards the "Enable Notifications" path: a malformed VAPID key must never
 * reach pushManager.subscribe() (browsers throw InvalidAccessError on it), and
 * the server endpoint is the only source of truth (a valid but stale
 * VITE_VAPID_PUBLIC_KEY must never bind a device to an old application key).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { getVapidPublicKey, isValidVapidPublicKey } from '../pwa/pushClient';

/** Real 65-byte uncompressed P-256 point, base64url. */
const VALID_KEY =
  'BGvYYSxalyLrTvteaFB01P_ru4TVfAhZ-SoTZMwc77SwXMj7ZDgfJvrvBJoFKjQFgsrV-c5ZlZdyVUA2RBA5jm4';

function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 1) binary += String.fromCharCode(bytes[i]);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

const WRONG_LENGTH_KEY = bytesToBase64Url(new Uint8Array(64).fill(7)); // 64 bytes
const NOT_A_POINT_KEY = bytesToBase64Url(Uint8Array.from([0x02, ...new Array(64).fill(3)])); // 0x02 prefix

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('isValidVapidPublicKey', () => {
  it('accepts a 65-byte uncompressed P-256 point (0x04 prefix)', () => {
    expect(isValidVapidPublicKey(VALID_KEY)).toBe(true);
  });

  it('rejects a key that is not 65 bytes', () => {
    expect(isValidVapidPublicKey(WRONG_LENGTH_KEY)).toBe(false);
  });

  it('rejects a 65-byte key without the 0x04 uncompressed prefix', () => {
    expect(isValidVapidPublicKey(NOT_A_POINT_KEY)).toBe(false);
  });

  it('rejects empty, non-string and non-base64url values', () => {
    expect(isValidVapidPublicKey(undefined)).toBe(false);
    expect(isValidVapidPublicKey(null)).toBe(false);
    expect(isValidVapidPublicKey('')).toBe(false);
    expect(isValidVapidPublicKey('not a valid key!!')).toBe(false);
    expect(isValidVapidPublicKey('short')).toBe(false);
  });
});

describe('getVapidPublicKey (API lookup path)', () => {
  it('returns the key when the API serves a valid P-256 point', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ publicKey: VALID_KEY }),
    }));

    await expect(getVapidPublicKey()).resolves.toBe(VALID_KEY);
  });

  it('always uses the server API as the source of truth', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ publicKey: VALID_KEY }),
    });
    vi.stubGlobal('fetch', fetchMock);

    await expect(getVapidPublicKey()).resolves.toBe(VALID_KEY);
    expect(fetchMock).toHaveBeenCalledWith('/api/push/vapid-public-key');
  });

  it('returns null when the API returns a malformed key', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ publicKey: 'still-broken' }),
    }));

    await expect(getVapidPublicKey()).resolves.toBeNull();
  });

  it('returns null when the API errors (the pre-fix production case: 500)', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      json: async () => ({ error: 'FUNCTION_INVOCATION_FAILED' }),
    }));

    await expect(getVapidPublicKey()).resolves.toBeNull();
  });

  it('returns null when the API is unreachable', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network down')));
    await expect(getVapidPublicKey()).resolves.toBeNull();
  });
});
