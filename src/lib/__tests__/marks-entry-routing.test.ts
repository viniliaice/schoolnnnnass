import { describe, expect, it } from 'vitest';
import { canAccessRoute } from '../routing';

describe('marks-entry monitor route access', () => {
  it('allows only admin on the admin path and admin/supervisor on the supervisor path', () => {
    expect(canAccessRoute('admin', '/admin/monitor-marks')).toBe(true);
    expect(canAccessRoute('supervisor', '/admin/monitor-marks')).toBe(false);
    expect(canAccessRoute('teacher', '/admin/monitor-marks')).toBe(false);
    expect(canAccessRoute('office', '/admin/monitor-marks')).toBe(false);
    expect(canAccessRoute('parent', '/admin/monitor-marks')).toBe(false);

    expect(canAccessRoute('admin', '/supervisor/monitor-marks')).toBe(true);
    expect(canAccessRoute('supervisor', '/supervisor/monitor-marks')).toBe(true);
    expect(canAccessRoute('teacher', '/supervisor/monitor-marks')).toBe(false);
    expect(canAccessRoute('office', '/supervisor/monitor-marks')).toBe(false);
    expect(canAccessRoute('parent', '/supervisor/monitor-marks')).toBe(false);
  });
});
