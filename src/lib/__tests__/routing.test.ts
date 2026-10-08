import { describe, expect, it } from 'vitest';
import { canAccessRoute, canGenerateFamilyIds, DEFAULT_ROUTE, ROUTE_ACCESS } from '../routing';

describe('canAccessRoute — office role', () => {
  it('allows office on /gate, /admin/family-ids, and /directory', () => {
    expect(canAccessRoute('office', '/gate')).toBe(true);
    expect(canAccessRoute('office', '/admin/family-ids')).toBe(true);
    expect(canAccessRoute('office', '/directory')).toBe(true);
  });

  it('keeps admin + supervisor on the gate routes', () => {
    expect(canAccessRoute('admin', '/gate')).toBe(true);
    expect(canAccessRoute('supervisor', '/gate')).toBe(true);
    expect(canAccessRoute('supervisor', '/directory')).toBe(true);
  });

  it('blocks roles not listed on a guarded route', () => {
    expect(canAccessRoute('teacher', '/gate')).toBe(false);
    expect(canAccessRoute('parent', '/gate')).toBe(false);
    expect(canAccessRoute('teacher', '/directory')).toBe(false);
    expect(canAccessRoute('parent', '/admin/family-ids')).toBe(false);
  });

  it('leaves role-specific routes to their own switches (not guarded here)', () => {
    expect(canAccessRoute('teacher', '/teacher/students')).toBe(true); // unlisted → role switch owns it
    expect(canAccessRoute('parent', '/parent/children')).toBe(true);
    expect(canAccessRoute('office', '/admin/users')).toBe(true); // unlisted → office switch default-drops it
  });

  it('every guarded route is listed in ROUTE_ACCESS', () => {
    expect(Object.keys(ROUTE_ACCESS).sort()).toEqual([
      '/admin/class-import', '/admin/drivers', '/admin/duplicate-students', '/admin/family-ids', '/admin/family-ids/setup',
      '/admin/former-students', '/admin/grade-corrections', '/admin/lesson-plan-submissions', '/admin/lesson-plans',
      '/admin/monitor-marks', '/admin/student-cleanup', '/directory', '/gate', '/supervisor/lesson-plan-submissions',
      '/supervisor/lesson-plans', '/supervisor/monitor-marks',
    ]);
  });
});

describe('grade corrections route is admin-only', () => {
  it('only admins may open /admin/grade-corrections', () => {
    expect(canAccessRoute('admin', '/admin/grade-corrections')).toBe(true);
    for (const role of ['supervisor', 'office', 'teacher', 'parent'] as const) {
      expect(canAccessRoute(role, '/admin/grade-corrections'), role).toBe(false);
    }
  });
});

describe('student class import route is admin-only', () => {
  it('only admins may open /admin/class-import', () => {
    expect(canAccessRoute('admin', '/admin/class-import')).toBe(true);
    for (const role of ['supervisor', 'office', 'teacher', 'parent'] as const) {
      expect(canAccessRoute(role, '/admin/class-import'), role).toBe(false);
    }
  });
});

describe('former students routes are admin-only', () => {
  it('only admins may open /admin/student-cleanup (the upload + review flow)', () => {
    expect(canAccessRoute('admin', '/admin/student-cleanup')).toBe(true);
    for (const role of ['supervisor', 'office', 'teacher', 'parent'] as const) {
      expect(canAccessRoute(role, '/admin/student-cleanup'), role).toBe(false);
    }
  });

  it('only admins may open /admin/former-students (the directory)', () => {
    expect(canAccessRoute('admin', '/admin/former-students')).toBe(true);
    for (const role of ['supervisor', 'office', 'teacher', 'parent'] as const) {
      expect(canAccessRoute(role, '/admin/former-students'), role).toBe(false);
    }
  });
});

describe('family-ID setup route is admin-only', () => {
  it('only admins may open /admin/family-ids/setup', () => {
    expect(canAccessRoute('admin', '/admin/family-ids/setup')).toBe(true);
    for (const role of ['supervisor', 'office', 'teacher', 'parent'] as const) {
      expect(canAccessRoute(role, '/admin/family-ids/setup'), role).toBe(false);
    }
  });

  it('but supervisor and office can still browse + print', () => {
    expect(canAccessRoute('supervisor', '/admin/family-ids')).toBe(true);
    expect(canAccessRoute('office', '/admin/family-ids')).toBe(true);
    expect(canAccessRoute('teacher', '/admin/family-ids')).toBe(false);
    expect(canAccessRoute('parent', '/admin/family-ids')).toBe(false);
  });
});

describe('canGenerateFamilyIds', () => {
  it('is admin-only (SQL enforces the same)', () => {
    expect(canGenerateFamilyIds('admin')).toBe(true);
    expect(canGenerateFamilyIds('supervisor')).toBe(false);
    expect(canGenerateFamilyIds('office')).toBe(false);
    expect(canGenerateFamilyIds('teacher')).toBe(false);
    expect(canGenerateFamilyIds('parent')).toBe(false);
  });
});

describe('DEFAULT_ROUTE', () => {
  it('covers every role including office', () => {
    for (const role of ['admin', 'supervisor', 'teacher', 'parent', 'office'] as const) {
      expect(DEFAULT_ROUTE[role]).toBe('/dashboard');
    }
  });
});

describe('lesson plan review route — admin reviews like a supervisor', () => {
  it('lets admin open its own lesson-plan review path', () => {
    expect(canAccessRoute('admin', '/admin/lesson-plans')).toBe(true);
  });

  it('lets admin open the supervisor path too, so shared links work', () => {
    expect(canAccessRoute('admin', '/supervisor/lesson-plans')).toBe(true);
    expect(canAccessRoute('supervisor', '/supervisor/lesson-plans')).toBe(true);
  });

  it('keeps everyone else off the admin lesson-plan path', () => {
    for (const role of ['supervisor', 'office', 'teacher', 'parent'] as const) {
      expect(canAccessRoute(role, '/admin/lesson-plans'), role).toBe(false);
    }
    // Teachers keep their own planner; they are not reviewers.
    expect(canAccessRoute('teacher', '/supervisor/lesson-plans')).toBe(false);
    expect(canAccessRoute('office', '/supervisor/lesson-plans')).toBe(false);
  });
});

describe('lesson plan submission tracking route — same roles as review', () => {
  it('lets supervisors track submissions on their own path', () => {
    expect(canAccessRoute('supervisor', '/supervisor/lesson-plan-submissions')).toBe(true);
  });

  it('lets admin use both paths, mirroring the review page', () => {
    expect(canAccessRoute('admin', '/admin/lesson-plan-submissions')).toBe(true);
    expect(canAccessRoute('admin', '/supervisor/lesson-plan-submissions')).toBe(true);
  });

  it('keeps teachers, parents, and office off the tracker', () => {
    for (const role of ['office', 'teacher', 'parent'] as const) {
      expect(canAccessRoute(role, '/supervisor/lesson-plan-submissions'), role).toBe(false);
      expect(canAccessRoute(role, '/admin/lesson-plan-submissions'), role).toBe(false);
    }
    // Supervisors do not get the admin-prefixed path either, like review.
    expect(canAccessRoute('supervisor', '/admin/lesson-plan-submissions')).toBe(false);
  });
});
