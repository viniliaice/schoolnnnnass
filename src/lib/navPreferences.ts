// Sidebar preferences that survive reloads and navigation.
//
// Kept in one place (and free of React) so the persistence rules are testable
// and so a storage failure — Safari private mode, a sandboxed iframe without
// allow-same-origin — can never break the navigation: every read falls back to
// a sensible default.

import type { Role } from '../types';

export const SIDEBAR_COLLAPSED_KEY = 'mbk-sidebar-collapsed';
export const NAV_GROUPS_KEY_PREFIX = 'mbk-nav-groups:';

function storage(): Storage | null {
  try {
    if (typeof window === 'undefined' || !window.localStorage) return null;
    return window.localStorage;
  } catch {
    return null;
  }
}

/** Desktop sidebar collapsed? Defaults to expanded (the friendly first-run state). */
export function readSidebarCollapsed(): boolean {
  const store = storage();
  if (!store) return false;
  try {
    return store.getItem(SIDEBAR_COLLAPSED_KEY) === 'true';
  } catch {
    return false;
  }
}

export function writeSidebarCollapsed(collapsed: boolean): void {
  const store = storage();
  if (!store) return;
  try {
    store.setItem(SIDEBAR_COLLAPSED_KEY, collapsed ? 'true' : 'false');
  } catch {
    /* preference is not worth an error */
  }
}

function groupsKey(role: Role): string {
  return `${NAV_GROUPS_KEY_PREFIX}${role}`;
}

/**
 * Explicit open/closed choices per group id, per role. Only groups the user
 * touched are stored — everything else follows the automatic rule (open the
 * group that contains the current page).
 */
export function readNavGroupState(role: Role): Record<string, boolean> {
  const store = storage();
  if (!store) return {};
  try {
    const raw = store.getItem(groupsKey(role));
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const result: Record<string, boolean> = {};
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof value === 'boolean') result[key] = value;
    }
    return result;
  } catch {
    return {};
  }
}

export function writeNavGroupState(role: Role, state: Record<string, boolean>): void {
  const store = storage();
  if (!store) return;
  try {
    store.setItem(groupsKey(role), JSON.stringify(state));
  } catch {
    /* preference is not worth an error */
  }
}

/**
 * Open state for the nav groups: an explicit user choice always wins, and the
 * group holding the current route is opened automatically so a refresh inside a
 * nested page never hides the page you are on.
 */
export function resolveOpenGroups(
  role: Role,
  groupIds: string[],
  activeGroupIds: string[],
): Record<string, boolean> {
  const stored = readNavGroupState(role);
  const resolved: Record<string, boolean> = {};

  for (const id of groupIds) {
    if (typeof stored[id] === 'boolean') resolved[id] = stored[id];
  }
  // A route inside a group re-opens it: the user must never lose sight of
  // where they are, even if they collapsed the group on an earlier page.
  for (const id of activeGroupIds) resolved[id] = true;

  return resolved;
}
