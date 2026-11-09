// Preview mode must be able to sign in as every role, including office.
//
// Regression: the demo profile table had admin/teacher/supervisor/parent but no
// office row, so ANY email that was not one of those four silently signed in as
// the admin — the office dashboard (gate, family IDs, no-parent worklist) could
// not be previewed at all.

import { describe, expect, it } from 'vitest';
import { isPlaceholderEnv, resolvePreviewProfile } from '../supabase';

describe('preview sign-in — office role', () => {
  it('runs against the mock backend in this test environment', () => {
    expect(isPlaceholderEnv).toBe(true);
  });

  it('resolves office@mbk.edu to the office role', () => {
    expect(resolvePreviewProfile('office@mbk.edu')).toMatchObject({
      id: 'office-1',
      role: 'office',
      email: 'office@mbk.edu',
    });
  });

  it('is case/whitespace tolerant like the sign-in form', () => {
    expect(resolvePreviewProfile('  Office@MBK.edu ')).toMatchObject({ role: 'office' });
  });

  it('still resolves the other demo roles', () => {
    expect(resolvePreviewProfile('admin@mbk.edu')?.role).toBe('admin');
    expect(resolvePreviewProfile('supervisor@mbk.edu')?.role).toBe('supervisor');
    expect(resolvePreviewProfile('fatima@mbk.edu')?.role).toBe('teacher');
    expect(resolvePreviewProfile('parent1@example.com')?.role).toBe('parent');
  });

  it('returns null for an unknown email (caller falls back to the demo admin)', () => {
    expect(resolvePreviewProfile('nobody@example.com')).toBeNull();
  });
});
