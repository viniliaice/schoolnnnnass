import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../supabase', () => ({
  supabase: {
    auth: {
      signInWithPassword: vi.fn(),
      getSession: vi.fn(),
      signOut: vi.fn(),
    },
    from: vi.fn(),
  },
}));

import { supabase } from '../supabase';
import { restoreProfileSession, signInProfileSession } from '../auth';

const mockAuth = supabase.auth as unknown as {
  signInWithPassword: ReturnType<typeof vi.fn>;
  getSession: ReturnType<typeof vi.fn>;
};
const mockFrom = supabase.from as unknown as ReturnType<typeof vi.fn>;

function mockProfileQuery(profile: unknown) {
  const query: any = {
    select: vi.fn(() => query),
    eq: vi.fn(() => query),
    single: vi.fn(() => Promise.resolve({ data: profile, error: null })),
  };
  mockFrom.mockReturnValue(query);
  return query;
}

beforeEach(() => {
  mockAuth.signInWithPassword.mockReset();
  mockAuth.getSession.mockReset();
  mockFrom.mockReset();
});

describe('profile auth session bridge', () => {
  it('logs in with Supabase Auth and returns profiles.id as app session userId', async () => {
    mockAuth.signInWithPassword.mockResolvedValue({
      data: { user: { id: 'auth-uuid' } },
      error: null,
    });
    const query = mockProfileQuery({
      id: 'profile-admin-1',
      auth_id: 'auth-uuid',
      name: 'Admin User',
      email: 'admin@example.com',
      role: 'admin',
    });

    await expect(signInProfileSession('admin@example.com', 'secret')).resolves.toEqual({
      roleSession: { role: 'admin', userId: 'profile-admin-1', userName: 'Admin User' },
      profile: {
        id: 'profile-admin-1',
        auth_id: 'auth-uuid',
        name: 'Admin User',
        email: 'admin@example.com',
        role: 'admin',
      },
    });

    expect(mockAuth.signInWithPassword).toHaveBeenCalledWith({ email: 'admin@example.com', password: 'secret' });
    expect(mockFrom).toHaveBeenCalledWith('profiles');
    expect(query.eq).toHaveBeenCalledWith('auth_id', 'auth-uuid');
  });

  it('restores a session through profiles.auth_id', async () => {
    mockAuth.getSession.mockResolvedValue({
      data: { session: { user: { id: 'auth-uuid' } } },
      error: null,
    });
    mockProfileQuery({
      id: 'profile-teacher-1',
      auth_id: 'auth-uuid',
      name: 'Teacher User',
      email: 'teacher@example.com',
      role: 'teacher',
    });

    await expect(restoreProfileSession()).resolves.toMatchObject({
      roleSession: { role: 'teacher', userId: 'profile-teacher-1', userName: 'Teacher User' },
    });
  });
});
