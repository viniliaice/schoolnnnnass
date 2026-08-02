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
    expect(Object.keys(ROUTE_ACCESS).sort()).toEqual(['/admin/family-ids', '/directory', '/gate']);
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
