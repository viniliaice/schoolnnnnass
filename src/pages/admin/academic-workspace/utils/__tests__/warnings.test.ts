import { describe, it, expect } from 'vitest';
import { buildAcademicWarnings, IMPORTANT_SUBJECTS } from '../warnings';
import type { Subject, User } from '../../../../../types';

const subjectsById = new Map<string, Subject>([
  ['s1', { id: 's1', name: 'Mathematics', createdAt: '' }],
  ['s2', { id: 's2', name: 'Science', createdAt: '' }],
  ['s3', { id: 's3', name: 'Arabic', createdAt: '' }],
]);

const teachersById = new Map<string, User>([
  ['t1', { id: 't1', name: 'Alice', email: 'alice@school.com', role: 'teacher', createdAt: '' }],
  ['t2', { id: 't2', name: 'Bob', email: 'bob@school.com', role: 'teacher', createdAt: '' }],
]);

const baseParams = {
  classes: ['Grade 1-A'],
  mappings: [],
  subjects: Array.from(subjectsById.values()),
  subjectsById,
  teachersById,
  workloadByTeacher: new Map<string, number>(),
  teacherWeeklyLimit: 25,
};

describe('buildAcademicWarnings', () => {
  it('returns empty array when everything is fine', () => {
    const warnings = buildAcademicWarnings({
      ...baseParams,
      mappings: [
        { id: 'm1', className: 'Grade 1-A', subjectId: 's1', teacherId: 't1', createdAt: '' } as any,
        { id: 'm2', className: 'Grade 1-A', subjectId: 's2', teacherId: 't1', createdAt: '' } as any,
        { id: 'm3', className: 'Grade 1-A', subjectId: 's3', teacherId: 't2', createdAt: '' } as any,
      ],
      workloadByTeacher: new Map([['t1', 10], ['t2', 5]]),
    });
    expect(warnings).toHaveLength(0);
  });

  it('flags mappings without a teacher', () => {
    const warnings = buildAcademicWarnings({
      ...baseParams,
      mappings: [
        { id: 'm2', className: 'Grade 1-A', subjectId: 's2', teacherId: 't1', createdAt: '' } as any,
        { id: 'm3', className: 'Grade 1-A', subjectId: 's3', teacherId: 't2', createdAt: '' } as any,
        { id: 'm1', className: 'Grade 1-A', subjectId: 's1', teacherId: null, createdAt: '' } as any,
      ],
    });
    expect(warnings).toHaveLength(1);
    expect(warnings[0].type).toBe('missing-teacher');
    expect(warnings[0].className).toBe('Grade 1-A');
  });

  it('flags missing important subjects per class', () => {
    const warnings = buildAcademicWarnings({
      ...baseParams,
      subjects: [
        { id: 's2', name: 'Science', createdAt: '' },
        { id: 's3', name: 'Arabic', createdAt: '' },
      ],
      subjectsById: new Map([
        ['s2', { id: 's2', name: 'Science', createdAt: '' }],
        ['s3', { id: 's3', name: 'Arabic', createdAt: '' }],
      ]),
      classes: ['Grade 1-A', 'Grade 2-A'],
      mappings: [],
    });
    const missingScience = warnings.filter(w => w.type === 'missing-subject');
    expect(missingScience).toHaveLength(4);
    expect(missingScience.every(w => w.type === 'missing-subject')).toBe(true);
  });

  it('does not flag missing subjects that do not exist in the subject list', () => {
    const warnings = buildAcademicWarnings({
      ...baseParams,
      subjects: [{ id: 's1', name: 'Mathematics', createdAt: '' }],
      subjectsById: new Map([['s1', { id: 's1', name: 'Mathematics', createdAt: '' }]]),
      mappings: [],
    });
    expect(warnings.filter(w => w.type === 'missing-subject')).toHaveLength(0);
  });

  it('flags teacher overload', () => {
    const warnings = buildAcademicWarnings({
      ...baseParams,
      mappings: [
        { id: 'm1', className: 'Grade 1-A', subjectId: 's1', teacherId: 't1', createdAt: '' } as any,
      ],
      workloadByTeacher: new Map([['t1', 30]]),
    });
    const overloadWarnings = warnings.filter(w => w.type === 'overload');
    expect(overloadWarnings).toHaveLength(1);
    expect(overloadWarnings[0].teacherId).toBe('t1');
  });

  it('does not flag overload if within limit', () => {
    const warnings = buildAcademicWarnings({
      ...baseParams,
      mappings: [
        { id: 'm1', className: 'Grade 1-A', subjectId: 's1', teacherId: 't1', createdAt: '' } as any,
      ],
      workloadByTeacher: new Map([['t1', 20]]),
    });
    expect(warnings.filter(w => w.type === 'overload')).toHaveLength(0);
  });

  it('flags duplicate subject assignments in same class', () => {
    const warnings = buildAcademicWarnings({
      ...baseParams,
      mappings: [
        { id: 'm1', className: 'Grade 1-A', subjectId: 's1', teacherId: 't1', createdAt: '' } as any,
        { id: 'm2', className: 'Grade 1-A', subjectId: 's1', teacherId: 't2', createdAt: '' } as any,
      ],
    });
    const dupes = warnings.filter(w => w.type === 'duplicate');
    expect(dupes).toHaveLength(1);
    expect(dupes[0].subjectId).toBe('s1');
    expect(dupes[0].className).toBe('Grade 1-A');
  });

  it('respects custom importantSubjects', () => {
    const warnings = buildAcademicWarnings({
      ...baseParams,
      importantSubjects: ['Mathematics'],
      subjects: [{ id: 's1', name: 'Mathematics', createdAt: '' }],
      subjectsById: new Map([['s1', { id: 's1', name: 'Mathematics', createdAt: '' }]]),
      classes: ['Grade 1-A'],
      mappings: [],
    });
    expect(warnings.filter(w => w.type === 'missing-subject')).toHaveLength(1);
  });
});
