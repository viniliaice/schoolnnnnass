import { describe, expect, it } from 'vitest';
import { isPlaceholderEnv } from '../supabase';
import { fetchMarksEntryTracking } from '../db/marksEntryTracking';

const preview = isPlaceholderEnv ? describe : describe.skip;

preview('marks-entry preview client', () => {
  it('serves the sanitized demo RPC projection instead of a missing-function error', async () => {
    const rows = await fetchMarksEntryTracking({
      academicYearId: 'ay-2026',
      termId: 'term-1',
      examScope: 'monthly',
      month: 'September',
    });

    expect(rows.length).toBeGreaterThan(0);
    expect(rows.some((row) => row.status === 'complete')).toBe(true);
    expect(rows.some((row) => row.status === 'in_progress')).toBe(true);
    expect(rows.some((row) => row.status === 'not_started')).toBe(true);
    expect(rows.every((row) => row.assignmentId && row.expectedStudents >= row.enteredStudents)).toBe(true);
  });
});
