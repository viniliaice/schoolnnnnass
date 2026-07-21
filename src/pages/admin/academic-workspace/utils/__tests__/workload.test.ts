import { describe, it, expect } from 'vitest';
import { calculateTeacherWorkload, DEFAULT_WEEKLY_LESSONS, TEACHER_WEEKLY_LIMIT } from '../workload';

describe('calculateTeacherWorkload', () => {
  it('returns empty map for empty mappings', () => {
    const result = calculateTeacherWorkload([], {});
    expect(result.size).toBe(0);
  });

  it('ignores mappings without teacherId', () => {
    const mappings = [{ id: 'm1', className: 'Grade 1-A', subjectId: 's1', createdAt: '' }];
    const result = calculateTeacherWorkload(mappings as any, { s1: { weeklyLessons: 5 } });
    expect(result.size).toBe(0);
  });

  it('sums weekly lessons per teacher', () => {
    const mappings = [
      { id: 'm1', className: 'Grade 1-A', subjectId: 's1', teacherId: 't1', createdAt: '' },
      { id: 'm2', className: 'Grade 1-A', subjectId: 's2', teacherId: 't1', createdAt: '' },
      { id: 'm3', className: 'Grade 1-B', subjectId: 's3', teacherId: 't2', createdAt: '' },
    ];
    const subjectMeta = {
      s1: { weeklyLessons: 5 },
      s2: { weeklyLessons: 4 },
      s3: { weeklyLessons: 3 },
    };
    const result = calculateTeacherWorkload(mappings as any, subjectMeta);
    expect(result.get('t1')).toBe(9);
    expect(result.get('t2')).toBe(3);
  });

  it('uses DEFAULT_WEEKLY_LESSONS when subject has no weeklyLessons', () => {
    const mappings = [
      { id: 'm1', className: 'Grade 1-A', subjectId: 's1', teacherId: 't1', createdAt: '' },
    ];
    const result = calculateTeacherWorkload(mappings as any, { s1: {} });
    expect(result.get('t1')).toBe(DEFAULT_WEEKLY_LESSONS);
  });

  it('uses DEFAULT_WEEKLY_LESSONS when subject is missing from meta', () => {
    const mappings = [
      { id: 'm1', className: 'Grade 1-A', subjectId: 's1', teacherId: 't1', createdAt: '' },
    ];
    const result = calculateTeacherWorkload(mappings as any, {});
    expect(result.get('t1')).toBe(DEFAULT_WEEKLY_LESSONS);
  });

  it('handles teachers with workload exceeding limit', () => {
    const mappings = Array.from({ length: 6 }, (_, i) => ({
      id: `m${i}`, className: 'Grade 1-A', subjectId: `s${i}`, teacherId: 't1', createdAt: '',
    }));
    const subjectMeta = Object.fromEntries(
      Array.from({ length: 6 }, (_, i) => [`s${i}`, { weeklyLessons: 5 }]),
    );
    const result = calculateTeacherWorkload(mappings as any, subjectMeta);
    expect(result.get('t1')).toBe(30);
    expect(result.get('t1')! > TEACHER_WEEKLY_LIMIT).toBe(true);
  });
});
