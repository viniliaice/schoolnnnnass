// Route access control — single source of truth for which roles may open
// which routes. App.tsx consults this for every path; the office role is
// read/lookup only (its write actions are additionally blocked in SQL).

import type { Role } from '../types';

/**
 * Route access map. A route lists the roles allowed to open it; any role not
 * listed falls through to its role's default dashboard. Keep in sync with
 * the RLS/role checks in supabase/migrations (office reads students, family
 * IDs, and the gate audit trail; generate/transport-edit stay admin-only).
 */
export const ROUTE_ACCESS: Record<string, Role[]> = {
  // Dismissal gate — office is a first-class gate role (read/lookup only).
  '/gate': ['admin', 'supervisor', 'office'],

  // Family-ID admin page — office may VIEW + print + lookup; Generate,
  // transport-edit, and override are admin-only (enforced in SQL + UI guard).
  '/admin/family-ids': ['admin', 'supervisor', 'office'],

  // Read-only student directory (name, grade, transport, family ID).
  '/directory': ['admin', 'supervisor', 'office'],
};

/** Every role's default landing route. */
export const DEFAULT_ROUTE: Record<Role, string> = {
  admin: '/dashboard',
  supervisor: '/dashboard',
  teacher: '/dashboard',
  parent: '/dashboard',
  office: '/dashboard',
};

/** True when `role` may open `path`; falls back to the role default. */
export function canAccessRoute(role: Role, path: string): boolean {
  const allowed = ROUTE_ACCESS[path];
  if (!allowed) return true; // role-specific switches handle their own paths
  return allowed.includes(role);
}

/** Write-capable roles for the family-ID generator (SQL also enforces admin). */
export function canGenerateFamilyIds(role: Role): boolean {
  return role === 'admin';
}
