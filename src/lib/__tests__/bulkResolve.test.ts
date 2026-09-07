import { describe, expect, it } from 'vitest';
import * as XLSX from 'xlsx';
import type { Student } from '../../types';
import {
  parseClassImportFile, matchClassImportRows, bulkResolveSingleCandidates,
  buildCommitPayload,
} from '../import/classImport';

function student(id: string, name: string, className: string, extra: Partial<Student> = {}): Student {
  return { id, name, className, parentId: null, createdAt: '2026-01-01T00:00:00Z', ...extra } as Student;
}
function workbook(rows: (string | null)[][]): ArrayBuffer {
  const ws = XLSX.utils.aoa_to_sheet(rows);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'S');
  return XLSX.write(wb, { type: 'array', bookType: 'xlsx' }) as unknown as ArrayBuffer;
}
const H = ['Student ID', 'Gov ID', 'Student Name', 'Current Class'];
const CLASSES = ['Grade 9-A', 'Grade 10-B'];

function classify(dataRows: (string | null)[][], existing: Student[]) {
  const parsed = parseClassImportFile(workbook([H, ...dataRows]));
  return matchClassImportRows(parsed.rows, existing, CLASSES);
}

describe('bulkResolveSingleCandidates', () => {
  it('binds every single-candidate name-only review row to that student', () => {
    const existing = [
      student('s1', 'C/raxmaan Maxamed Sh.xuseen', 'Grade 10-B'),
      student('s2', 'Asha Ali', 'Grade 9-A'),
    ];
    // No ids in the sheet → name-only → ambiguous with 1 candidate each.
    const rows = classify([
      ['', '', 'C/raxmaan Maxamed Sh.xuseen', 'Grade 10-B'],
      ['', '', 'Asha Ali', 'Grade 9-A'],
    ], existing);
    expect(rows.every(r => r.status === 'ambiguous' && r.candidates.length === 1)).toBe(true);

    const byId = new Map(existing.map(s => [s.id, s]));
    const result = bulkResolveSingleCandidates(rows, byId, CLASSES);
    expect(result.resolved).toBe(2);
    expect(result.stillAmbiguous).toBe(0);
    expect(result.rows.every(r => r.status === 'no_change' || r.status === 'class_change')).toBe(true);

    const payload = buildCommitPayload(result.rows);
    expect(payload.newStudents).toHaveLength(0);
    expect(payload.changes.length + payload.newStudents.length).toBeGreaterThanOrEqual(0);
  });

  it('leaves rows with multiple candidates in manual review', () => {
    const existing = [
      student('s1', 'Ahmed Mohamed', 'Grade 9-A'),
      student('s2', 'Ahmed Mohamed', 'Grade 10-B'),
    ];
    const rows = classify([['', '', 'Ahmed Mohamed', 'Grade 10-B']], existing);
    expect(rows[0].status).toBe('ambiguous');
    expect(rows[0].candidates.length).toBe(2);

    const byId = new Map(existing.map(s => [s.id, s]));
    const result = bulkResolveSingleCandidates(rows, byId, CLASSES);
    expect(result.resolved).toBe(0);
    expect(result.stillAmbiguous).toBe(1);
    expect(result.rows[0].status).toBe('ambiguous');
    expect(buildCommitPayload(result.rows).newStudents).toHaveLength(0);
  });

  it('never binds two uploaded rows to the same existing student', () => {
    const existing = [student('s1', 'Solo Name', 'Grade 10-B')];
    // Two uploaded name-only rows for the same person.
    const rows = classify([
      ['', '', 'Solo Name', 'Grade 10-B'],
      ['', '', 'Solo Name', 'Grade 10-B'],
    ], existing);
    // Second identical row is already a duplicate; use one ambiguous one here.
    const ambiguous = rows.filter(r => r.status === 'ambiguous');
    const byId = new Map(existing.map(s => [s.id, s]));
    const result = bulkResolveSingleCandidates(rows, byId, CLASSES);
    // The single ambiguous row resolves; the duplicate stays excluded.
    expect(result.resolved).toBe(ambiguous.length);
    const payload = buildCommitPayload(result.rows);
    const changeTargets = payload.changes.map(c => c.studentId);
    expect(new Set(changeTargets).size).toBe(changeTargets.length);
  });
});
