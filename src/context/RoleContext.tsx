import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';

import type { RoleSession } from '../types';
import { supabase } from '../lib/supabase';
import {
  buildRoleSession,
  getProfileByAuthId,
  signInProfileSession,
  signOutProfileSession,
} from '../lib/auth';

interface RoleContextType {
  session: RoleSession | null;
  user: { id: string; email?: string; authId?: string } | null;
  login: (email: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
  isLoggedIn: boolean;
  loading: boolean;
  error: string | null;
}

const RoleContext = createContext<RoleContextType | undefined>(undefined);

type AuthEvent =
  | 'INITIAL_SESSION'
  | 'SIGNED_IN'
  | 'SIGNED_OUT'
  | 'TOKEN_REFRESHED'
  | 'USER_UPDATED'
  | 'PASSWORD_RECOVERY'
  | string;

export function RoleProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<RoleSession | null>(null);
  const [user, setUser] = useState<{ id: string; email?: string; authId?: string } | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Track which auth id we've already applied. Single source of truth.
  const appliedAuthIdRef = useRef<string | null>(null);
  const applyInFlightRef = useRef<Promise<void> | null>(null);

  const fetchProfileAndApply = useCallback(
    async (authUserId: string, authEmail?: string): Promise<boolean> => {
      const profile = await getProfileByAuthId(authUserId);
      const roleSession = buildRoleSession(profile);
      setSession(roleSession);
      setUser({ id: profile.id, authId: authUserId, email: profile.email ?? authEmail });
      appliedAuthIdRef.current = authUserId;
      return true;
    },
    [],
  );

  /**
   * Apply the authenticated user to the context. Idempotent: if we've already
   * applied this auth id and no new work is in flight, this is a no-op.
   * If a different auth id is provided, the previous state is invalidated
   * and the new profile is fetched.
   */
  const applyAuthUser = useCallback(
    async (authUserId: string | null | undefined, authEmail?: string): Promise<void> => {
      if (!authUserId) {
        appliedAuthIdRef.current = null;
        setSession(null);
        setUser(null);
        return;
      }

      if (appliedAuthIdRef.current === authUserId && !applyInFlightRef.current) {
        return;
      }

      if (applyInFlightRef.current) {
        await applyInFlightRef.current;
        if (appliedAuthIdRef.current === authUserId) return;
      }

      const work = (async () => {
        await fetchProfileAndApply(authUserId, authEmail);
      })();

      applyInFlightRef.current = work;
      try {
        await work;
      } finally {
        if (applyInFlightRef.current === work) {
          applyInFlightRef.current = null;
        }
      }
    },
    [fetchProfileAndApply],
  );

  const login = useCallback(async (email: string, password: string) => {
    setError(null);
    try {
      const restored = await signInProfileSession(email, password);
      setSession(restored.roleSession);
      setUser({
        id: restored.profile.id,
        authId: restored.profile.auth_id,
        email: restored.profile.email,
      });
      appliedAuthIdRef.current = restored.profile.auth_id;
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Login failed');
      throw err;
    }
  }, []);

  const logout = useCallback(async () => {
    setError(null);
    try {
      await signOutProfileSession();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Logout failed');
    } finally {
      appliedAuthIdRef.current = null;
      setSession(null);
      setUser(null);
    }
  }, []);

  useEffect(() => {
    let cancelled = false;

    /**
     * Bootstrap strategy:
     * - Treat the first INITIAL_SESSION event as the source of truth for "ready"
     * - Don't call getSession() directly: it can race with INITIAL_SESSION
     * - Don't wipe state to null on a transient failed getSession — the listener
     *   will deliver a fresh session if one exists
     * - loading stays true until INITIAL_SESSION is processed
     */
    const handleAuthEvent = async (event: AuthEvent, authSession: any) => {
      if (cancelled) return;

      const authUser = authSession?.user ?? null;
      const authUserId = authUser?.id ?? null;
      const authEmail = authUser?.email;

      // SIGNED_OUT clears any session unconditionally
      if (event === 'SIGNED_OUT') {
        appliedAuthIdRef.current = null;
        setSession(null);
        setUser(null);
        setError(null);
        return;
      }

      // For all other events (INITIAL_SESSION, SIGNED_IN, TOKEN_REFRESHED,
      // USER_UPDATED, PASSWORD_RECOVERY), apply the auth user when present.
      try {
        await applyAuthUser(authUserId, authEmail);
      } catch (e) {
        console.error('[RoleContext] auth event apply failed:', e);
        // Only wipe state if this was the initial bootstrap failing.
        // For mid-session events, leave state alone — minor flicker is
        // preferable to logging the user out on a transient failure.
        if (event === 'INITIAL_SESSION' && !appliedAuthIdRef.current) {
          setSession(null);
          setUser(null);
          setError(e instanceof Error ? e.message : 'Session restore failed');
        }
      } finally {
        // Loading only ends once we've seen INITIAL_SESSION at least once
        // (handled by the first-call tracker below).
        if (event === 'INITIAL_SESSION' && !cancelled) {
          setLoading(false);
        }
      }
    };

    const { data: { subscription } } = supabase.auth.onAuthStateChange((event, session) => {
      handleAuthEvent(event, session);
    });

    // Modern Supabase v2 fires INITIAL_SESSION automatically when the listener
    // is attached. Belt-and-suspenders: if no event arrives within 5 seconds,
    // fall back to getSession() so we never spin forever.
    const fallbackTimer = setTimeout(async () => {
      if (cancelled) return;
      if (appliedAuthIdRef.current !== null) return;
      // Try getSession as a fallback. Don't nuke state on null — leave it null.
      try {
        const { data, error: sessionError } = await supabase.auth.getSession();
        if (cancelled) return;
        if (sessionError) {
          console.warn('[RoleContext] getSession failed:', sessionError.message);
        } else {
          const authUser = data.session?.user ?? null;
          if (authUser) {
            await applyAuthUser(authUser.id, authUser.email);
          }
        }
      } catch (e) {
        console.error('[RoleContext] fallback getSession apply failed:', e);
      } finally {
        if (!cancelled) setLoading(false);
      }
    }, 5000);

    return () => {
      cancelled = true;
      subscription.unsubscribe();
      clearTimeout(fallbackTimer);
    };
  }, [applyAuthUser]);

  const value = useMemo<RoleContextType>(
    () => ({
      session,
      user,
      login,
      logout,
      isLoggedIn: !!session,
      loading,
      error,
    }),
    [session, user, login, logout, loading, error],
  );

  return <RoleContext.Provider value={value}>{children}</RoleContext.Provider>;
}

export function useRole() {
  const context = useContext(RoleContext);
  if (!context) throw new Error('useRole must be used within a RoleProvider');
  return context;
}
