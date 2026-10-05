/**
 * In-app navigation bridge.
 *
 * The app navigates with React state (DashboardLayout owns the current path),
 * not with a URL router. Push-notification deep links therefore arrive in two
 * ways, both funnelled here:
 *
 *  1. Cold start: the service worker opens `https://…/teacher/lesson-plans`
 *     and the layout seeds its state from the URL (initialPathFromLocation).
 *  2. Warm start: the worker focuses an existing window and posts
 *     { type: 'NAVIGATE', path }; register.ts forwards it to
 *     requestNavigation(), which the layout listens for.
 *
 * sanitizeAppPath() only accepts same-app paths — an external or absolute
 * URL in a crafted notification payload can never be navigated to.
 */

export type NavigationListener = (path: string) => void;

const listeners = new Set<NavigationListener>();

export function onNavigationRequest(listener: NavigationListener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function requestNavigation(path: string): void {
  const safe = sanitizeAppPath(path);
  if (!safe) return;
  listeners.forEach((listener) => listener(safe));
}

const KNOWN_PREFIXES = [
  '/dashboard',
  '/messages',
  '/streams',
  '/gate',
  '/directory',
  '/teacher/',
  '/admin/',
  '/supervisor/',
  '/office',
  '/parent/',
];

/** Returns the path when it is a known in-app route, otherwise null. */
export function sanitizeAppPath(candidate: string | null | undefined): string | null {
  if (!candidate || typeof candidate !== 'string') return null;
  let path: string;
  try {
    // Tolerates absolute URLs but ONLY same-origin ones.
    if (candidate.startsWith('http://') || candidate.startsWith('https://')) {
      const url = new URL(candidate);
      if (url.origin !== window.location.origin) return null;
      path = url.pathname;
    } else {
      path = candidate;
    }
  } catch {
    return null;
  }
  if (!path.startsWith('/')) return null;
  if (path === '/') return '/dashboard';
  if (KNOWN_PREFIXES.some((prefix) => path === prefix.replace(/\/$/, '') || path.startsWith(prefix))) {
    return path;
  }
  return null;
}

/** The in-app route encoded in the current URL, if any. */
export function initialPathFromLocation(): string | null {
  if (typeof window === 'undefined') return null;
  return sanitizeAppPath(window.location.pathname);
}
