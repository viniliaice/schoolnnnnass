import type { Exam, Student } from '../../types';

export type StudentSortDirection = 'none' | 'asc' | 'desc';

export function sortExamsByStudentName(
  exams: Exam[],
  students: Student[],
  direction: StudentSortDirection,
): Exam[] {
  const rows = [...exams];
  if (direction === 'none') return rows;

  const studentNameById = new Map(
    students.map(student => [student.id, student.name.toLowerCase()]),
  );

  return rows.sort((a, b) => {
    const aName = studentNameById.get(a.studentId) || '';
    const bName = studentNameById.get(b.studentId) || '';
    if (aName === bName) return 0;
    return direction === 'asc'
      ? (aName < bName ? -1 : 1)
      : (aName > bName ? -1 : 1);
  });
}

export function getTotalPages(totalItems: number, pageSize: number): number {
  return Math.max(1, Math.ceil(totalItems / Math.max(1, pageSize)));
}

export function clampPage(page: number, totalItems: number, pageSize: number): number {
  return Math.min(Math.max(1, page), getTotalPages(totalItems, pageSize));
}

export function getVisibleRange(page: number, pageSize: number, totalItems: number) {
  if (totalItems <= 0) return { from: 0, to: 0 };
  const safePage = clampPage(page, totalItems, pageSize);
  return {
    from: (safePage - 1) * pageSize + 1,
    to: Math.min(safePage * pageSize, totalItems),
  };
}
