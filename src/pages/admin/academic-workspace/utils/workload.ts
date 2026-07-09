import type { ClassSubject } from '../../../../types';

export type SubjectMeta = Record<string, { color?: string; weeklyLessons?: number }>;

export const DEFAULT_WEEKLY_LESSONS = 5;
export const TEACHER_WEEKLY_LIMIT = 25;

export function calculateTeacherWorkload(
  mappings: Array<ClassSubject & { teacherId?: string }>,
  subjectMeta: SubjectMeta,
): Map<string, number> {
  const workload = new Map<string, number>();

  for (const mapping of mappings) {
    if (!mapping.teacherId) continue;
    const lessons = subjectMeta[mapping.subjectId]?.weeklyLessons ?? DEFAULT_WEEKLY_LESSONS;
    workload.set(mapping.teacherId, (workload.get(mapping.teacherId) || 0) + lessons);
  }

  return workload;
}
