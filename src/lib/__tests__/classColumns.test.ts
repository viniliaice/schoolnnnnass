import { describe, expect, it } from 'vitest';
import * as XLSX from 'xlsx';
import type { Student } from '../../types';
import {
  parseClassImportFile, matchClassImportRows, buildCommitPayload,
  resolveUploadedClassCandidates, classHasSection, classMissingSection,
} from '../import/classImport';

function student(id: string, name: string, className: string, extra: Partial<Student> = {}): Student {
  return { id, name, className, parentId: null, createdAt: '2026-01-01T00:00:00Z', ...extra } as Student;
}
function workbook(rows: (string | null)[][], header: (string|null)[]): ArrayBuffer {
  const ws = XLSX.utils.aoa_to_sheet([header, ...rows]);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'S');
  return XLSX.write(wb, { type: 'array', bookType: 'xlsx' }) as unknown as ArrayBuffer;
}

const CLASSES = ['Grade 3-A', 'Grade 3-C', 'Grade 9-A', 'Grade 9-B', 'KG-A', 'KG-B'];

describe('multiple class columns: section value is used over the bare grade', () => {
  // School sheet has BOTH a bare "Grade" column ("Grade 3") and a section
  // "Current Class" column ("Grade 3-C").
  const header = ['Gov ID', 'Student Name', 'Grade', 'Current Class', 'Bus'];

  it('picks Grade 3-C and ignores bare Grade 3 for a matched student', () => {
    const existing = [student('s1', 'Faadumo Cabdikariim Muuse', 'Grade 3-B', { govId: '25-881725' })];
    const parsed = parseClassImportFile(workbook(
      [['25-881725', 'Faadumo Cabdikariim Muuse', 'Grade 3', 'Grade 3-C', '1']],
      header,
    ));
    expect(parsed.rows[0].classCandidates).toEqual(['Grade 3', 'Grade 3-C']);
    const rows = matchClassImportRows(parsed.rows, existing, CLASSES);
    expect(rows[0].status).toBe('class_change');
    expect(rows[0].toClass).toBe('Grade 3-C');
    expect(buildCommitPayload(rows).newStudents).toHaveLength(0);
  });

  it('picks Grade 9-B when the section column has it, even if bare Grade 9 is present', () => {
    const existing = [student('s2', 'Ayuub Ayaanle Xasan', 'Grade 9-A', { govId: '19-015310' })];
    const parsed = parseClassImportFile(workbook(
      [['19-015310', 'Ayuub Ayaanle Xasan', 'Grade 9', 'Grade 9-B', '6']],
      header,
    ));
    const rows = matchClassImportRows(parsed.rows, existing, CLASSES);
    expect(rows[0].status).toBe('class_change');
    expect(rows[0].toClass).toBe('Grade 9-B');
  });

  it('bare grade alone (no section anywhere) → invalid with a section hint', () => {
    const existing = [student('s3', 'MUBAARICK maxamed maxamuud', 'Grade 1-A', { govId: 'x' })];
    const parsed = parseClassImportFile(workbook(
      [['x', 'MUBAARICK maxamed maxamuud', 'Grade 1', '', '3']],
      header,
    ));
    const rows = matchClassImportRows(parsed.rows, existing, CLASSES);
    expect(rows[0].status).toBe('invalid');
    const msg = rows[0].issues.find(i => i.code === 'INVALID_CLASS')?.message ?? '';
    expect(msg).toMatch(/section/i);
  });
});

describe('class candidate helpers', () => {
  it('detects section-specific vs bare values', () => {
    expect(classHasSection('Grade 3-C')).toBe(true);
    expect(classHasSection('G9B')).toBe(true);
    expect(classHasSection('KG-B')).toBe(true);
    expect(classHasSection('Grade 3')).toBe(false);
    expect(classHasSection('KG')).toBe(false);
    expect(classMissingSection('Grade 3')).toBe(true);
    expect(classMissingSection('Grade9')).toBe(true);
    expect(classMissingSection('KG')).toBe(true);
    expect(classMissingSection('Foundation')).toBe(true);
    expect(classMissingSection('SUPORT')).toBe(false); // not a grade → treated as unknown, not missing-section
  });

  it('resolveUploadedClassCandidates prefers a resolvable section value', () => {
    const r = resolveUploadedClassCandidates(['Grade 3', 'Grade 3-C'], CLASSES);
    expect(r.resolved).toBe('Grade 3-C');
  });

  it('resolveUploadedClassCandidates returns bestRaw = section value when nothing resolves', () => {
    const r = resolveUploadedClassCandidates(['Grade 9', 'Grade 9-Z'], CLASSES);
    expect(r.resolved).toBeNull();
    expect(r.bestRaw).toBe('Grade 9-Z');
  });
});
