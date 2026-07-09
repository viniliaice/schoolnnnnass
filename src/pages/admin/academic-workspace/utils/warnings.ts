import type { ClassSubject, Subject, User } from '../../../../types';

export type WarningType = 'missing-teacher' | 'missing-subject' | 'overload' | 'duplicate';

export type WorkspaceWarning = {
  id: string;
  type: WarningType;
  message: string;
  className?: string;
  teacherId?: string;
  subjectId?: string;
};

export const IMPORTANT_SUBJECTS = ['Science', 'Arabic'];

type MappingRow = ClassSubject & { subjects?: { name: string }; users?: { name: string } };

function getSubjectName(row: MappingRow, subjectsById: Map<string, Subject>) {
  return row.subjects?.name || subjectsById.get(row.subjectId)?.name || row.subjectId;
}

export function buildAcademicWarnings(params: {
  classes: string[];
  mappings: MappingRow[];
  subjects: Subject[];
  subjectsById: Map<string, Subject>;
  teachersById: Map<string, User>;
  workloadByTeacher: Map<string, number>;
  teacherWeeklyLimit: number;
  importantSubjects?: string[];
}): WorkspaceWarning[] {
  const {
    classes,
    mappings,
    subjects,
    subjectsById,
    teachersById,
    workloadByTeacher,
    teacherWeeklyLimit,
    importantSubjects = IMPORTANT_SUBJECTS,
  } = params;
  const warnings: WorkspaceWarning[] = [];

  for (const row of mappings) {
    if (!row.teacherId) {
      warnings.push({
        id: `missing-teacher-${row.id}`,
        type: 'missing-teacher',
        className: row.className,
        subjectId: row.subjectId,
        message: `${row.className} has no ${getSubjectName(row, subjectsById)} teacher`,
      });
    }
  }

  for (const className of classes) {
    const classSubjectNames = mappings
      .filter(row => row.className === className)
      .map(row => getSubjectName(row, subjectsById).toLowerCase());

    for (const required of importantSubjects) {
      const subjectExists = subjects.some(subject => subject.name.toLowerCase() === required.toLowerCase());
      if (subjectExists && !classSubjectNames.includes(required.toLowerCase())) {
        warnings.push({
          id: `missing-subject-${className}-${required}`,
          type: 'missing-subject',
          className,
          message: `${className} missing ${required}`,
        });
      }
    }
  }

  for (const [teacherId, workload] of workloadByTeacher.entries()) {
    if (workload > teacherWeeklyLimit) {
      warnings.push({
        id: `overload-${teacherId}`,
        type: 'overload',
        teacherId,
        message: `${teachersById.get(teacherId)?.name || 'Teacher'} exceeds workload limit (${workload}/${teacherWeeklyLimit} lessons)`,
      });
    }
  }

  for (const className of classes) {
    const keys = new Map<string, number>();
    for (const row of mappings.filter(row => row.className === className)) {
      keys.set(row.subjectId, (keys.get(row.subjectId) || 0) + 1);
    }
    for (const [subjectId, count] of keys.entries()) {
      if (count > 1) {
        warnings.push({
          id: `duplicate-${className}-${subjectId}`,
          type: 'duplicate',
          className,
          subjectId,
          message: `${subjectsById.get(subjectId)?.name || subjectId} assigned ${count} times in ${className}`,
        });
      }
    }
  }

  return warnings;
}
