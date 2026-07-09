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
  const timestamp = Date.now();
  const random = Math.random().toString(36).substring(2, 8);
  const id = `${data.role}-${timestamp}-${random}`;
  const user: Omit<User, 'id'> = { ...data, createdAt: new Date().toISOString() };

  const { data: created, error } = await supabase
    .from('profiles')
    .insert({ id, ...user })
    .select()
    .single();
  if (error) throw error;

  return created as User;
}

export async function updateUser(id: string, data: Partial<User>): Promise<User> {
  const { data: updated, error } = await supabase
    .from('profiles')
    .update(data)
    .eq('id', id)
    .select()
    .single();
  if (error) throw error;

  return updated as User;
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
