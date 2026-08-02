// Office-role save fix tests.
//
// Diagnosis: the office role is granted by creating a user with role
// 'office' in Manage Users. createUser() used to write the profile row with
// a direct supabase.from('profiles').insert() — but profiles has RLS enabled
// with SELECT-only policies (20260708_profiles_auth_session_rls), so the
// insert was denied for every role and the office account never persisted.
//
// These tests pin the fix: profile writes go through the admin-only
// SECURITY DEFINER RPCs (create_user_profile / set_user_role), and RPC
// rejections propagate as real errors. The SQL-side admin gate (a non-admin
// caller gets insufficient_privilege) is asserted in
// supabase/tests/rls-user-role.sql against the real schema.

import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../supabase', () => ({
  supabase: {
    rpc: vi.fn(),
    auth: { signUp: vi.fn(), getSession: vi.fn(), setSession: vi.fn() },
  },
}));

import { supabase } from '../supabase';
import { createUser, setUserRole } from '../db/profiles';

const rpc = supabase.rpc as unknown as ReturnType<typeof vi.fn>;
const signUp = supabase.auth.signUp as unknown as ReturnType<typeof vi.fn>;
const getSession = supabase.auth.getSession as unknown as ReturnType<typeof vi.fn>;
const setSession = supabase.auth.setSession as unknown as ReturnType<typeof vi.fn>;

const ADMIN_SESSION = {
  access_token: 'admin-at',
  refresh_token: 'admin-rt',
  user: { id: 'auth-admin' },
};

beforeEach(() => {
  rpc.mockReset();
  signUp.mockReset();
  getSession.mockReset();
  setSession.mockReset();
  signUp.mockResolvedValue({ data: { user: { id: 'auth-1' } }, error: null });
  // The admin is signed in when creating a user.
  getSession.mockResolvedValue({ data: { session: ADMIN_SESSION }, error: null });
  setSession.mockResolvedValue({ data: { session: ADMIN_SESSION }, error: null });
});

describe('createUser (office-role assignment path)', () => {
  it('creates the auth user, then writes the profile via the admin RPC', async () => {
    rpc.mockResolvedValue({ data: null, error: null });

    const created = await createUser({
      name: 'Umal Kharye Xuseen',
      email: 'umal@mbk.edu',
      role: 'office',
      password: 'secret123',
    });

    expect(signUp).toHaveBeenCalledWith({ email: 'umal@mbk.edu', password: 'secret123' });
    expect(rpc).toHaveBeenCalledWith('create_user_profile', expect.objectContaining({
      p_role: 'office',
      p_name: 'Umal Kharye Xuseen',
      p_email: 'umal@mbk.edu',
      p_auth_id: 'auth-1',
    }));
    // The role must persist on the returned profile.
    expect(created.role).toBe('office');
    expect(created.name).toBe('Umal Kharye Xuseen');
    expect(created.id).toMatch(/^office-/);
  });

  it('restores the admin session BEFORE the profile write (signUp hijacks the session)', async () => {
    rpc.mockResolvedValue({ data: null, error: null });

    await createUser({
      name: 'Umal Kharye Xuseen',
      email: 'umal@mbk.edu',
      role: 'office',
      password: 'secret123',
    });

    // signUp() replaces the client session with the new user's; if we didn't
    // restore the admin session, the RPC would run as the new user (no
    // profile yet → current_profile_role() = NULL → denied).
    expect(setSession).toHaveBeenCalledWith(ADMIN_SESSION);
    expect(setSession.mock.invocationCallOrder[0]).toBeLessThan(rpc.mock.invocationCallOrder[0]);
  });

  it('still writes the profile when there is no admin session to restore', async () => {
    getSession.mockResolvedValue({ data: { session: null }, error: null });
    rpc.mockResolvedValue({ data: null, error: null });

    await createUser({
      name: 'Umal Kharye Xuseen',
      email: 'umal@mbk.edu',
      role: 'office',
      password: 'secret123',
    });

    expect(setSession).not.toHaveBeenCalled();
    expect(rpc).toHaveBeenCalledWith('create_user_profile', expect.objectContaining({ p_role: 'office' }));
  });

  it('passes through optional parent/teacher fields for the matching roles', async () => {
    rpc.mockResolvedValue({ data: null, error: null });
    await createUser({
      name: 'Fadumo Abdi',
      email: 'fadumo@mbk.edu',
      role: 'parent',
      password: 'secret123',
      phone1: '0615551234',
      phone2: '0615551235',
      xafada: 'Hodan',
      udow: 'Bakaaraha',
      paymentnumber: 'EVC-0615551234',
    });
    expect(rpc).toHaveBeenCalledWith('create_user_profile', expect.objectContaining({
      p_role: 'parent',
      p_phone1: '0615551234',
      p_phone2: '0615551235',
      p_xafada: 'Hodan',
      p_udow: 'Bakaaraha',
      p_paymentnumber: 'EVC-0615551234',
      p_assigned_classes: [],
      p_assigned_subjects: [],
    }));
  });

  it('surfaces RLS/permission errors instead of a silent success', async () => {
    rpc.mockResolvedValue({ data: null, error: { message: 'Only admins may create user profiles.' } });
    await expect(createUser({
      name: 'X',
      email: 'x@mbk.edu',
      role: 'office',
      password: 'secret123',
    })).rejects.toThrow(/Only admins may create user profiles/);
  });

  it('requires a password before calling anything', async () => {
    await expect(createUser({
      name: 'X',
      email: 'x@mbk.edu',
      role: 'office',
      password: '',
    })).rejects.toThrow(/Password is required/);
    expect(rpc).not.toHaveBeenCalled();
  });
});

describe('setUserRole', () => {
  it('assigns a role (e.g. office) through the set_user_role RPC', async () => {
    rpc.mockResolvedValue({ data: null, error: null });
    await setUserRole('u-1', 'office');
    expect(rpc).toHaveBeenCalledWith('set_user_role', { p_user_id: 'u-1', p_role: 'office' });
  });

  it('propagates the RPC rejection when the caller is not admin', async () => {
    rpc.mockResolvedValue({ data: null, error: { message: 'Only admins may change user roles.' } });
    await expect(setUserRole('u-2', 'admin')).rejects.toThrow(/Only admins may change user roles/);
  });
});
