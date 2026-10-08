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

  // Driver management (back-office): admin + office manage the authorized
  // pickup list. supervisor is deliberately excluded — a whole-school
  // driver→student→family browse would leak mappings beyond their
  // class-scoped students RLS; their dismissal-oversight view is /gate.
  '/admin/drivers': ['admin', 'office'],

  // Setup: import the transport sheet + generate IDs. Admin only, enforced
  // here, in the App route switch, AND in SQL (the RPCs re-check the role).
  '/admin/family-ids/setup': ['admin'],

  // Admin Grade Correction. Admin only — it corrects an existing grade through
  // the admin-gated admin_correct_grade RPC (which re-checks the role in SQL).
  '/admin/grade-corrections': ['admin'],

  // Duplicate Students — safe guided merge. Admin only; the merge RPC
  // re-checks the role server-side and the tables have no direct write RLS.
  '/admin/duplicate-students': ['admin'],

  // Student class update / new-student import. Admin only — it writes
  // students."className" and creates student rows through the admin-gated
  // apply_student_class_import RPC (which re-checks the role in SQL).
  '/admin/class-import': ['admin'],

  // Former Students / Student Cleanup. Admin only — it flips students.status to
  // 'former' through the admin-gated apply_former_student_import RPC (which
  // re-checks the role in SQL). Nothing is ever deleted, but deciding that a
  // child left the school is an administrator decision, so both the upload /
  // review flow and the former-students directory are admin-only.
  '/admin/student-cleanup': ['admin'],
  '/admin/former-students': ['admin'],

  // Lesson Plan Review. Admin reviews plans exactly like a supervisor: the
  // database already grants both roles identical rights (`admin_all_plans` RLS
  // plus the `('supervisor','admin')` checks inside decide_lesson_plan_review,
  // request_lesson_plan_revision, retry_lesson_plan_ai_review and the
  // quiz-replacement RPC), so admin gets the same page — not a wider one.
  // Admin's own path is /admin/lesson-plans; the supervisor path is open to
  // admin as well so a link shared by a supervisor still opens.
  '/admin/lesson-plans': ['admin'],
  '/supervisor/lesson-plans': ['admin', 'supervisor'],

  // Lesson Plan Submission tracking (who submitted / who hasn't). Same roles
  // as review: the list_lesson_plan_submitters RPC (20260915) allows exactly
  // supervisor + admin, and the plan reads ride the same lesson_plans SELECT
  // policies the review page uses. Mirrors the review page's two-path setup.
  '/admin/lesson-plan-submissions': ['admin'],
  '/supervisor/lesson-plan-submissions': ['admin', 'supervisor'],

  // Derived marks-entry monitoring. The RPC independently enforces the same
  // admin/supervisor roles and limits supervisors to their assigned classes.
  '/admin/monitor-marks': ['admin'],
  '/supervisor/monitor-marks': ['admin', 'supervisor'],

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
