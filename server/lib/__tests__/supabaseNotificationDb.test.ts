import { describe, expect, it, vi } from 'vitest';
import { createSupabaseNotificationDb } from '../supabaseNotificationDb.js';

describe('Supabase notification adapter', () => {
  it('loads selected teachers by ID in bounded batches instead of filtering only the first 1,000 profiles', async () => {
    const teacherIds = Array.from({ length: 205 }, (_, index) => `teacher-${index + 1}`);
    const queries: string[] = [];
    let batchIndex = 0;
    const rest = {
      select: vi.fn(async (_table: string, query: string) => {
        queries.push(query);
        const start = batchIndex * 100;
        batchIndex += 1;
        return {
          data: teacherIds.slice(start, start + 100).map((id) => ({ id, name: id, assignedClasses: [] })),
          error: null,
        };
      }),
    } as any;

    const db = createSupabaseNotificationDb(rest);
    const teachers = await db.listTeachers({ audience: 'teachers', teacherIds });

    expect(rest.select).toHaveBeenCalledTimes(3);
    expect(queries.every((query) => query.includes('role=eq.teacher') && query.includes('id=in.') && query.includes('limit=1000'))).toBe(true);
    expect(teachers.map((teacher) => teacher.id)).toEqual(teacherIds);
  });

  it('returns no teachers and makes no request for an empty selected audience', async () => {
    const rest = { select: vi.fn() } as any;
    const db = createSupabaseNotificationDb(rest);
    await expect(db.listTeachers({ audience: 'teachers', teacherIds: [] })).resolves.toEqual([]);
    expect(rest.select).not.toHaveBeenCalled();
  });
});
