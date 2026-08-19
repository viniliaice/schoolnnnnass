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

  // Family-ID browse/print page — office may VIEW + print + lookup.
  '/admin/family-ids': ['admin', 'supervisor', 'office'],

  // Setup: import the transport sheet + generate IDs. Admin only, enforced
  // here, in the App route switch, AND in SQL (the RPCs re-check the role).
  '/admin/family-ids/setup': ['admin'],

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

/**
 * Who may change a student's transport.
 *
 * admin + office. Transport corrections are front-desk work: the office is
 * who takes the parent's phone call, so requiring an admin either delays the
 * fix or pushes the school to share an admin login — worse for security than
 * granting this one narrow write.
 *
 * This mirrors set_student_transport() (20260820_office_transport_edit.sql),
 * which raises insufficient_privilege for every other role. It is the ONLY
 * write office gains: generation, family override, mark-left and the sheet
 * import all remain admin-only, so print/search access still does not become
 * general student-write access.
 *
 * supervisor is deliberately excluded — a gate/oversight role, not data entry.
 * The client check is convenience only: SQL remains the enforcement point.
 */
export function canEditTransport(role: Role): boolean {
  return role === 'admin' || role === 'office';
}
