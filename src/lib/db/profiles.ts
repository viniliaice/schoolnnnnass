import type { Role, User } from '../../types';
import { supabase } from '../supabase';

const MAX_QUERY_LIMIT = 30000;

function applyLimit(query: any, limit: number) {
  if (typeof query.limit === 'function') {
    return query.limit(Math.min(limit, MAX_QUERY_LIMIT));
  }
  return query;
}

export async function getUsers(limit: number = MAX_QUERY_LIMIT): Promise<User[]> {
  const { data, error } = await applyLimit(supabase.from('profiles').select('*'), limit);
  if (error) throw error;
  return (data || []) as User[];
}

export async function getUsersPaginated(
  page: number = 1,
  limit: number = 10,
  search?: string,
): Promise<{ users: User[]; total: number }> {
  const from = (page - 1) * limit;
  const to = from + limit - 1;

  let query = supabase
    .from('profiles')
    .select('*', { count: 'exact' });

  if (search && search.trim()) {
    query = query.or(`name.ilike.%${search}%,email.ilike.%${search}%`);
  }

  const { data, error, count } = await query.range(from, to);
  if (error) throw error;

  return { users: (data || []) as User[], total: count || 0 };
}

export async function getUsersByRole(role: Role, page: number = 1, limit: number = 100): Promise<User[]> {
  const from = (page - 1) * limit;
  const to = from + limit - 1;
  const normalizedRole = String(role).toLowerCase().trim();

  const { data, error } = await supabase
    .from('profiles')
    .select('*', { count: 'exact' })
    .ilike('role', normalizedRole)
    .range(from, to);
  if (error) throw error;

  const rows = (data || []) as User[];
  return rows.filter(user => String(user.role || '').toLowerCase().trim() === normalizedRole);
}

export async function getUsersByIds(ids: string[]): Promise<User[]> {
  if (!Array.isArray(ids) || ids.length === 0) return [];

  const { data, error } = await supabase.from('profiles').select('*').in('id', ids);
  if (error) throw error;
  return (data || []) as User[];
}

export async function getUserById(id: string): Promise<User | null> {
  const { data, error } = await supabase.from('profiles').select('*').eq('id', id).maybeSingle();
  if (error) throw error;
  return (data as User | null) ?? null;
}

export async function createUser(data: Omit<User, 'id' | 'createdAt'>): Promise<User> {
  const { password, ...rest } = data;

  if (!password) throw new Error('Password is required');

  // signUp() (with email auto-confirm enabled) replaces the client session
  // with the NEW user's session and fires an auth event before the profile
  // row exists. If we then called the RPC, it would run as the new user —
  // denied, because their profile doesn't exist yet (current_profile_role()
  // is NULL). It would also leave the admin's stored session pointing at the
  // brand-new user. Capture the admin session first and restore it after
  // signUp, before the profile write.
  const { data: sessionData } = await supabase.auth.getSession();
  const adminSession = sessionData?.session;

  const { data: authData, error: authError } = await supabase.auth.signUp({ email: data.email, password });
  if (authError) throw new Error(authError.message || 'Failed to create auth user');
  if (!authData.user) throw new Error('Failed to create auth user');

  const id = `${data.role}-${Date.now()}-${Math.random().toString(36).substring(2, 8)}`;

  // Restore the admin identity BEFORE the profile write so the RPC runs with
  // admin privileges (and the stored session stays the admin's).
  if (adminSession) {
    const { error: restoreError } = await supabase.auth.setSession(adminSession);
    if (restoreError) {
      console.warn('[createUser] could not restore admin session:', restoreError.message);
      throw new Error(`Failed to restore admin session: ${restoreError.message}`);
    }
  }

  // profiles is SELECT-only under RLS (20260708_profiles_auth_session_rls) —
  // a direct supabase.from('profiles').insert() is denied for every role
  // (this is the office-role save bug). Profile creation goes through the
  // admin-only SECURITY DEFINER RPC instead.
  const { error: rpcError } = await supabase.rpc('create_user_profile', {
    p_id: id,
    p_name: rest.name,
    p_email: rest.email,
    p_role: rest.role,
    p_auth_id: authData.user.id,
    p_phone1: rest.phone1 ?? null,
    p_phone2: rest.phone2 ?? null,
    p_xafada: rest.xafada ?? null,
    p_udow: rest.udow ?? null,
    p_paymentnumber: rest.paymentnumber ?? null,
    p_assigned_classes: rest.assignedClasses ?? [],
    p_assigned_subjects: rest.assignedSubjects ?? [],
  });
  if (rpcError) throw new Error(rpcError.message || 'Failed to create user profile');

  return { id, ...rest, createdAt: new Date().toISOString() } as User;
}

/**
 * Admin-only role change (e.g. grant the office gate role to an existing
 * user). The RPC enforces the admin check in SQL — a non-admin caller gets
 * insufficient_privilege and cannot grant itself or others elevated roles.
 */
export async function setUserRole(userId: string, role: Role): Promise<void> {
  const { error } = await supabase.rpc('set_user_role', { p_user_id: userId, p_role: role });
  if (error) throw new Error(error.message || 'Failed to set user role');
}

export async function updateUser(id: string, data: Partial<User>): Promise<User> {
  const { password: _pw, ...rest } = data; // password handled by Supabase Auth, not stored in profiles

  const { data: updated, error } = await supabase
    .from('profiles')
    .update(rest)
    .eq('id', id)
    .select()
    .single();
  if (error) throw error;

  return updated as User;
}

export async function resetUserPassword(email: string): Promise<void> {
  const { error } = await supabase.auth.resetPasswordForEmail(email);
  if (error) throw error;
}

export async function deleteUser(id: string): Promise<boolean> {
  const { error } = await supabase.from('profiles').delete().eq('id', id);
  if (error) throw error;

  const { error: unlinkError } = await supabase
    .from('students')
    .update({ parentId: null })
    .eq('parentId', id);
  if (unlinkError) throw unlinkError;

  return true;
}

/**
 * Lightweight function to fetch all teacher profiles.
 * Uses a simple eq filter (not ilike), no count, no pagination.
 * Much lighter on the server than getUsersByRole.
 */
export async function getAllTeachers(): Promise<User[]> {
  const { data, error } = await supabase
    .from('profiles')
    .select('*')
    .eq('role', 'teacher');
  if (error) throw error;
  return (data || []) as User[];
}
