import { beforeEach, describe, expect, it, vi } from 'vitest';

const { authMock } = vi.hoisted(() => ({
  authMock: { getSession: vi.fn(), signOut: vi.fn() },
}));
vi.mock('../supabase', () => ({
  supabase: { auth: authMock, from: vi.fn() },
}));

import { isUnrecoverableSessionError, recoverFromStaleSession, restoreProfileSession } from '../auth';

describe('stale Supabase refresh-token recovery', () => {
  beforeEach(() => {
    authMock.getSession.mockReset();
    authMock.signOut.mockReset().mockResolvedValue({ error: null });
  });

  it('classifies the exact production refresh-token failure as unrecoverable', () => {
    expect(isUnrecoverableSessionError(new Error('Invalid Refresh Token: Refresh Token Not Found'))).toBe(true);
    expect(isUnrecoverableSessionError({ code: 'refresh_token_not_found' })).toBe(true);
    expect(isUnrecoverableSessionError({ message: 'invalid_grant' })).toBe(true);
    expect(isUnrecoverableSessionError(new Error('Invalid refresh token'))).toBe(true);
  });

  it('does not sign out for transient/network failures', async () => {
    expect(isUnrecoverableSessionError(new Error('Failed to fetch'))).toBe(false);
    await expect(recoverFromStaleSession(new Error('network timeout'))).resolves.toBe(false);
    expect(authMock.signOut).not.toHaveBeenCalled();
  });

  it('clears exactly the local session for a dead refresh token and never throws', async () => {
    await expect(recoverFromStaleSession(new Error('Invalid Refresh Token: Refresh Token Not Found'))).resolves.toBe(true);
    expect(authMock.signOut).toHaveBeenCalledWith({ scope: 'local' });

    authMock.signOut.mockRejectedValueOnce(new Error('storage unavailable'));
    await expect(recoverFromStaleSession({ code: 'invalid_grant' })).resolves.toBe(true);
  });

  it('returns null and purges the dead local session during profile restoration', async () => {
    authMock.getSession.mockResolvedValue({
      data: { session: null },
      error: { message: 'Invalid Refresh Token: Refresh Token Not Found' },
    });
    await expect(restoreProfileSession()).resolves.toBeNull();
    expect(authMock.signOut).toHaveBeenCalledWith({ scope: 'local' });
  });
});
