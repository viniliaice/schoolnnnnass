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

/**
 * Resolve the app profile for an auth user id, or null when the profile row
 * does not exist yet. Uses maybeSingle: a missing profile is a NORMAL state
 * (e.g. an admin just created the auth user and the profile write follows a
 * beat later), so it must not throw "Cannot coerce the result to a single
 * JSON object" like .single() does on zero rows.
 */
export async function getProfileByAuthId(authId: string): Promise<ProfileSessionRow | null> {
  const { data, error } = await supabase
    .from('profiles')
    .select('id, name, email, role, auth_id, assignedClasses, assignedSubjects')
    .eq('auth_id', authId)
    .maybeSingle();

  if (error) throw new Error(`Unable to load profile: ${error.message}`);
  return (data as ProfileSessionRow | null) ?? null;
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
  if (!profile) {
    throw new Error('No app profile found for this account — ask the school to link your profile.');
  }
  return { roleSession: buildRoleSession(profile), profile };
}

export async function signOutProfileSession() {
  const { error } = await supabase.auth.signOut();
  if (error) throw error;
}

export async function signUp(email: string, password: string) {
  const { data, error } = await supabase.auth.signUp({ email, password });
  if (error) throw error;
  return data;
}

/**
 * Restore a session by reading Supabase Auth state, then resolving the
 * corresponding profiles row. Returns null if no auth user is present OR if
 * the auth user has no profile row yet (e.g. created moments ago by an admin
 * — treat as "not logged in" rather than crashing).
 */
export async function restoreProfileSession(): Promise<{ roleSession: RoleSession; profile: ProfileSessionRow } | null> {
  const { data, error } = await supabase.auth.getSession();
  if (error || !data.session?.user) return null;
  const profile = await getProfileByAuthId(data.session.user.id);
  if (!profile) return null;
  return { roleSession: buildRoleSession(profile), profile };
}