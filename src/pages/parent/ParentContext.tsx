// Shared parent state: the children linked to the logged-in parent and the
// ONE "active child" the parent is currently viewing.
//
// Why this exists: the old parent UI re-fetched the child list inside every
// page and made parents re-pick a child on each screen. The mobile-first
// redesign loads the children once (in the parent shell) and keeps a single
// active child — choosing a child on Home or My Children makes that child
// active everywhere else (Exam Results, reports, weekly learning).
//
// The selection persists in localStorage ('parent-active-child') so it
// survives refreshes. The weekly-learning feature's existing storage key is
// kept in sync so that page shows the same child too.
//
// Pages can be rendered without the provider (tests, future reuse): the hook
// returns null and pages keep their own fetch as a fallback.

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import type { Student } from '../../types';
import { getStudentsByParent } from '../../lib/db/students';

export const ACTIVE_CHILD_STORAGE_KEY = 'parent-active-child';
// Pre-existing key used by WeeklyLearning; kept in sync on selectChild.
const WEEKLY_LEARNING_CHILD_KEY = 'parent-weekly-learning-child';

function readStoredChildId(): string | null {
  if (typeof window === 'undefined') return null;
  return window.localStorage.getItem(ACTIVE_CHILD_STORAGE_KEY);
}

export interface ParentContextValue {
  /** Children linked to this parent account (may be empty). */
  kids: Student[];
  loading: boolean;
  /** The active student's id; defaults to the first child alphabetically. */
  activeChildId: string | null;
  activeChild: Student | null;
  /** Make a child the active student for the rest of the app. */
  selectChild: (id: string) => void;
  /** Re-fetch the children (e.g. after realtime changes). */
  refresh: () => Promise<void>;
}

const ParentContext = createContext<ParentContextValue | null>(null);

export function ParentProvider({ parentId, children }: { parentId: string; children: ReactNode }) {
  const [kids, setKids] = useState<Student[]>([]);
  const [loading, setLoading] = useState(true);
  const [activeChildId, setActiveChildId] = useState<string | null>(readStoredChildId);

  const persistSelection = useCallback((id: string | null) => {
    if (typeof window === 'undefined') return;
    if (id) {
      window.localStorage.setItem(ACTIVE_CHILD_STORAGE_KEY, id);
      window.localStorage.setItem(WEEKLY_LEARNING_CHILD_KEY, id);
    } else {
      window.localStorage.removeItem(ACTIVE_CHILD_STORAGE_KEY);
    }
  }, []);

  const refresh = useCallback(async () => {
    try {
      const result = await getStudentsByParent(parentId);
      setKids(result);
      setActiveChildId(prev => {
        if (prev && result.some(k => k.id === prev)) return prev;
        // No (valid) stored choice — pick a stable default so every report
        // screen opens with a child already selected.
        const fallback = [...result].sort((a, b) => a.name.localeCompare(b.name))[0]?.id ?? null;
        persistSelection(fallback);
        return fallback;
      });
    } catch {
      setKids([]);
    } finally {
      setLoading(false);
    }
  }, [parentId, persistSelection]);

  useEffect(() => {
    setLoading(true);
    void refresh();
  }, [refresh]);

  const selectChild = useCallback(
    (id: string) => {
      setActiveChildId(id);
      persistSelection(id);
    },
    [persistSelection],
  );

  const value = useMemo<ParentContextValue>(() => {
    const activeChild = kids.find(k => k.id === activeChildId) ?? null;
    return { kids, loading, activeChildId, activeChild, selectChild, refresh };
  }, [kids, loading, activeChildId, selectChild, refresh]);

  return <ParentContext.Provider value={value}>{children}</ParentContext.Provider>;
}

/**
 * Shared parent state, or null when the page is rendered outside the parent
 * shell. Pages must handle null by falling back to their own data fetching
 * (the pre-existing behaviour).
 */
export function useParentContext(): ParentContextValue | null {
  return useContext(ParentContext);
}
