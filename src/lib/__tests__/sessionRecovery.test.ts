import { beforeEach, describe, expect, it, vi } from 'vitest';

const mock = vi.hoisted(() => ({
  getSession: vi.fn(),
  signOut: vi.fn(),
  from: vi.fn(),
}));
vi.mock('../supabase', () => ({
  supabase: { auth: { getSession: mock.getSession, signOut: mock.signOut }, from: mock.from },
}));

import { isUnrecoverableSessionError, recoverFromStaleSession, restoreProfileSession } from '../auth';

beforeEach(() => {
  mock.getSession.mockReset();
  mock.signOut.mockReset();
  mock.from.mockReset();
  mock.signOut.mockResolvedValue({ error: null });
});

describe('stale Supabase refresh-token recovery', () => {
  it.each([
    'Invalid Refresh Token: Refresh Token Not Found',
    'refresh_token_not_found',
    'invalid_grant',
  ])('classifies unrecoverable refresh errors: %s', (message) => {
    expect(isUnrecoverableSessionError(new Error(message))).toBe(true);
  });

  it('clears only unrecoverable local sessions and does not sign out on transient errors', async () => {
    expect(await recoverFromStaleSession({ message: 'Invalid Refresh Token: Refresh Token Not Found' })).toBe(true);
    expect(mock.signOut).toHaveBeenCalledWith({ scope: 'local' });
    mock.signOut.mockClear();
    expect(await recoverFromStaleSession(new Error('Network request failed'))).toBe(false);
    expect(mock.signOut).not.toHaveBeenCalled();
  });

  it('purges an invalid refresh session and returns null instead of retrying it forever', async () => {
    mock.getSession.mockResolvedValue({
      data: { session: null },
      error: { message: 'Invalid Refresh Token: Refresh Token Not Found' },
    });
    await expect(restoreProfileSession()).resolves.toBeNull();
    expect(mock.signOut).toHaveBeenCalledWith({ scope: 'local' });
    expect(mock.from).not.toHaveBeenCalled();
  });

  it('leaves the local session untouched when getSession fails transiently', async () => {
    mock.getSession.mockResolvedValue({ data: { session: null }, error: { message: 'Network error' } });
    await expect(restoreProfileSession()).resolves.toBeNull();
    expect(mock.signOut).not.toHaveBeenCalled();
  });
});
