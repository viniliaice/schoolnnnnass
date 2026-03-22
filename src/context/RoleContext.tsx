import { createContext, useContext, useState, useEffect, useCallback, type ReactNode } from 'react';
import { Role, RoleSession } from '../types';

interface RoleContextType {
  session: RoleSession | null;
  login: (role: Role, userId: string, userName: string) => void;
  logout: () => void;
  isLoggedIn: boolean;
}

const RoleContext = createContext<RoleContextType | undefined>(undefined);

const SESSION_KEY = 'cc_session';

export function RoleProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<RoleSession | null>(() => {
    try {
      const stored = localStorage.getItem(SESSION_KEY);
      return stored ? JSON.parse(stored) : null;
    } catch {
      return null;
    }
  });

  const login = useCallback((role: Role, userId: string, userName: string) => {
    const newSession: RoleSession = { role, userId, userName };
    setSession(newSession);
    localStorage.setItem(SESSION_KEY, JSON.stringify(newSession));
  }, []);

  const logout = useCallback(() => {
    setSession(null);
    localStorage.removeItem(SESSION_KEY);
  }, []);

  useEffect(() => {
    if (session) {
      localStorage.setItem(SESSION_KEY, JSON.stringify(session));
    }
  }, [session]);

  return (
    <RoleContext.Provider value={{ session, login, logout, isLoggedIn: !!session }}>
      {children}
    </RoleContext.Provider>
  );
}

export function useRole() {
  const context = useContext(RoleContext);
  if (!context) throw new Error('useRole must be used within a RoleProvider');
  return context;
}
