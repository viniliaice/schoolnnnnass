import { createContext, useContext, useState, useEffect, useCallback, type ReactNode } from 'react';
import { RoleSession } from '../types';
import { supabase } from '../lib/supabase';

interface RoleContextType {
  session: RoleSession | null;
  user: any;
  login: (email: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
  isLoggedIn: boolean;
  loading: boolean;
}

const RoleContext = createContext<RoleContextType | undefined>(undefined);

export function RoleProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<RoleSession | null>(null);
  const [user, setUser] = useState<any>(null);
  const [loading, setLoading] = useState(true);

    // Login logic: only checks password from users table (no Supabase Auth)
    const login = useCallback(async (email: string, password: string) => {
      setLoading(true);
      try {
        // 1. Check if user exists in users table
        const { data: userProfile, error: userError } = await supabase
          .from('users')
          .select('*')
          .eq('email', email)
          .maybeSingle();
        if (userError) throw userError;
        if (!userProfile) throw new Error('User not found');

        // 2. Check password (plain text, or hash if implemented)
        if (!userProfile.password || userProfile.password !== password) {
          throw new Error('Invalid password');
        }

        // Success: set session
        const newSession: RoleSession = {
          role: userProfile.role,
          userId: userProfile.id,
          userName: userProfile.name,
        };
        setSession(newSession);
        setUser({ id: userProfile.id, email: userProfile.email });
      } catch (error) {
        console.error('Login error:', error);
        throw error;
      } finally {
        setLoading(false);
      }
    }, []);

    // Helper: Set password for first-time users (creates Supabase Auth account and links to users table)
// setFirstTimePassword helper removed for now (can be re-exposed via context/provider if needed)

  const logout = useCallback(async () => {
    setLoading(true);
    try {
      // For demo purposes, just clear the session
      // In production, you'd sign out from Supabase auth
      setSession(null);
      setUser(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    // For demo purposes, we don't persist sessions
    // In production, you'd check for existing auth sessions
    setLoading(false);
  }, []);

  return (
    <RoleContext.Provider value={{
      session,
      user,
      login,
      logout,
      isLoggedIn: !!session,
      loading
    }}>
      {children}
    </RoleContext.Provider>
  );
}

export function useRole() {
  const context = useContext(RoleContext);
  if (!context) throw new Error('useRole must be used within a RoleProvider');
  return context;
}
