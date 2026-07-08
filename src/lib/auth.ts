import { supabase } from './supabase';
import type { Role, RoleSession } from '../types';

export type ProfileSessionRow = {
  id: string; // profiles.id
  name: string;
  email: string;
  role: Role;
  auth_id: string; // auth.users.id
  assignedClasses?: string[] | null;
  assignedSubjects?: string[] | null;
};

export async function getProfileByAuthId(authId: string): Promise<ProfileSessionRow> {
  const { data, error } = await supabase
    .from('profiles')
    .select('id, name, email, role, auth_id, assignedClasses, assignedSubjects')
    .eq('auth_id', authId)
    .single();

  if (error) throw new Error(`Unable to load profile: ${error.message}`);
  return data as ProfileSessionRow;
}

export function buildRoleSession(profile: ProfileSessionRow): RoleSession {
  return {
    role: profile.role,
    userId: profile.id, // profile id (your app uses this)
    userName: profile.name,
  };
}

export async function signInProfileSession(
  email: string,
  password: string,
): Promise<{ roleSession: RoleSession; profile: ProfileSessionRow }> {
  const { data: authData, error: authError } = await supabase.auth.signInWithPassword({
    email,
    password,
  });

  if (authError) throw authError;
  if (!authData.user) throw new Error('Supabase Auth did not return a user.');

  const profile = await getProfileByAuthId(authData.user.id);
  return { roleSession: buildRoleSession(profile), profile };
}

export async function signOutProfileSession() {
  const { error } = await supabase.auth.signOut();
  if (error) throw error;
}

/**
 * Restore a session by reading Supabase Auth state, then resolving the
 * corresponding profiles row. Returns null if no auth user is present.
 */
export async function restoreProfileSession(): Promise<{ roleSession: RoleSession; profile: ProfileSessionRow } | null> {
  const { data, error } = await supabase.auth.getSession();
  if (error || !data.session?.user) return null;
  const profile = await getProfileByAuthId(data.session.user.id);
  return { roleSession: buildRoleSession(profile), profile };
}