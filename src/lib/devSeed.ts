import { supabase } from './supabase';

const isDev = import.meta.env?.MODE !== 'production';

function debug(...args: unknown[]) {
  if (isDev) console.debug(...args);
}

export async function createDemoAccounts() {
  const demoUsers = [
    { email: 'admin@scholo.com', password: 'admin123', name: 'Dr. Sarah Mitchell', role: 'admin' as const },
    { email: 'teacher@scholo.com', password: 'teacher123', name: 'Prof. James Wilson', role: 'teacher' as const, assignedClasses: ['Grade 10-A', 'Grade 9-A', 'Grade 8-B'], assignedSubjects: ['Mathematics', 'English', 'Science'] },
    { email: 'parent@scholo.com', password: 'parent123', name: 'Michael Johnson', role: 'parent' as const },
  ];

  for (const user of demoUsers) {
    try {
      const { data: existing } = await supabase
        .from('profiles')
        .select('id')
        .eq('email', user.email)
        .maybeSingle();

      if (existing) {
        debug(`Demo account for ${user.email} already exists`);
        continue;
      }

      const userId = `${user.role}-${Date.now()}-${Math.random().toString(36).substring(2, 8)}`;
      const { error: profileError } = await supabase
        .from('profiles')
        .insert({
          id: userId,
          email: user.email,
          name: user.name,
          role: user.role,
          password: user.password,
          assignedClasses: user.assignedClasses || [],
        });

      if (profileError) throw profileError;
      debug(`Created demo account for ${user.email}`);
    } catch (error) {
      console.error(`Error creating demo account for ${user.email}:`, error);
    }
  }
}

export async function seedDatabase(): Promise<void> {
  console.warn('seedDatabase: not implemented in this environment');
}

export async function isSeeded(): Promise<boolean> {
  try {
    const { data } = await supabase.from('profiles').select('id').limit(1).maybeSingle();
    return !!data;
  } catch {
    return false;
  }
}
