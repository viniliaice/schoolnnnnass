import { createContext, useContext, useState, useEffect, useCallback, type ReactNode } from 'react';
import { Role, RoleSession } from '../types';
import { supabase } from '../lib/supabase';
import { getCurrentUserProfile } from '../lib/database';

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

    const login = useCallback(async (email: string, password: string) => {

      setLoading(true);

      try {

        // For demo purposes, check against users table directly

        // In production, you'd use Supabase auth

        const { data: userProfile, error } = await supabase

          .from('users')

          .select('*')

          .eq('email', email)

          .maybeSingle();

  

        if (error) throw error;

  

        if (!userProfile) {

          throw new Error('User not found');

        }

  

        // Simple password check for demo (in production, use proper auth)
        const expectedPassword = email === 'admin@scholo.com' ? 'admin123' :
                                email === 'teacher@scholo.com' ? 'teacher123' :
                                email === 'parent@scholo.com' ? 'parent123' : null;

        if (password !== expectedPassword) {
          throw new Error('Invalid password');
        }



  

        const newSession: RoleSession = {

          role: userProfile.role,

          userId: userProfile.id,

          userName: userProfile.name,

        };

        setSession(newSession);

        setUser({ id: userProfile.id, email: userProfile.email });

      } catch (error) {

        console.error("Login error:", error);

        throw error;

      }

      finally {

        setLoading(false);

      }

    }, []);

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
