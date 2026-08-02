import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import * as XLSX from 'xlsx';
import { parseExcel } from '../excel-parser';

const labels = ['HW1 5', 'HW2 5', 'HW3 5', 'HW4 5', 'CPW1 15', 'CPW2 15', 'CPW3 15', 'CPW4 15', 'Att 20', 'MT 20', 'Akhlaaq 10'];

function workbook(subjects: string[], data: unknown[][], mutateHeader?: (header: unknown[]) => void, legacyNameOnly = false): ArrayBuffer {
  const top = legacyNameOnly
    ? ['', ...subjects.flatMap(subject => [subject, ...Array(8).fill(''), 'MT', 'Akhlaaq'])]
    : ['', '', ...subjects.flatMap(subject => [subject, ...Array(8).fill(''), 'MT', 'Akhlaaq'])];
  const header: unknown[] = legacyNameOnly
    ? ['Student Name', ...subjects.flatMap(() => labels)]
    : ['Student ID', 'Student Name', ...subjects.flatMap(() => labels)];
  mutateHeader?.(header);
  const worksheet = XLSX.utils.aoa_to_sheet([top, header, ...data]);
  const leadingColumns = legacyNameOnly ? 1 : 2;
  worksheet['!merges'] = subjects.map((_, index) => {
    const start = leadingColumns + index * labels.length;
    return { s: { r: 0, c: start }, e: { r: 0, c: start + 8 } };
  });
  const book = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(book, worksheet, 'Grades');
  return XLSX.write(book, { bookType: 'xlsx', type: 'array' }) as ArrayBuffer;
}

describe('bulk grade Excel parser', () => {
  it('keeps the downloadable template aligned to all seven production subject blocks', () => {
    const bytes = fs.readFileSync('public/BulkUploadExample.xlsx');
    const result = parseExcel(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer);
    expect(result.subjects).toEqual(['English', 'Math', 'Science', 'Social', 'Somali', 'Arabic', 'Tarabiya']);
    expect(result.columns).toHaveLength(77);
    expect(result.columns.filter(column => column.assessmentLabel === 'AKHLAAQ')).toHaveLength(7);
  });

  it('parses exact per-subject assessment slots and preserves zero scores', () => {
    const result = parseExcel(workbook(['English', 'Math'], [[
      'S-001', 'Asha Ali',
      0, 1, 2, 3, 4, 5, 6, 7, 8, 19, 10,
      5, 4, 3, 2, 1, 0, 15, 14, 20, 18, 9,
    ]]));

    expect(result.issues.filter(issue => issue.severity === 'error')).toEqual([]);
    expect(result.subjects).toEqual(['English', 'Math']);
    expect(result.students).toHaveLength(1);
    expect(result.students[0].studentId).toBe('S-001');
    expect(result.students[0].scores).toHaveLength(22);
    expect(result.students[0].scores[0]).toMatchObject({ subjectName: 'English', assessmentLabel: 'HW1', examType: 'Homework', score: 0, total: 5, entryState: 'scored' });
    expect(result.students[0].scores[10]).toMatchObject({ subjectName: 'English', assessmentLabel: 'AKHLAAQ', examType: 'Discipline', score: 10, total: 10 });
    expect(result.students[0].scores[21]).toMatchObject({ subjectName: 'Math', assessmentLabel: 'AKHLAAQ', examType: 'Discipline', score: 9, total: 10 });
  });

  it('rejects an Akhlaaq score above its hard cap instead of clamping it', () => {
    const result = parseExcel(workbook(['English'], [[
      'S-001', 'Asha Ali', 5, 5, 5, 5, 15, 15, 15, 15, 20, 20, 11,
    ]]));

    expect(result.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'INVALID_SCORE', cell: 'M3', message: expect.stringContaining('cannot exceed 10') }),
    ]));
    expect(result.students[0].scores.some(score => score.assessmentLabel === 'AKHLAAQ')).toBe(false);
  });

  it('rejects reordered assessment headers rather than trusting their column position', () => {
    const result = parseExcel(workbook(['English'], [[
      'S-001', 'Asha Ali', 5, 5, 5, 5, 15, 15, 15, 15, 20, 20, 10,
    ]], header => {
      [header[2], header[3]] = [header[3], header[2]];
    }));

    expect(result.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'UNKNOWN_COLUMN', cell: 'C2' }),
      expect.objectContaining({ code: 'UNKNOWN_COLUMN', cell: 'D2' }),
    ]));
  });

  it('represents Absent and N/A explicitly while leaving blank cells unrecorded', () => {
    const values = ['Absent', 'N/A', '', '-', 15, 15, 15, 15, 20, 20, 10];
    const result = parseExcel(workbook(['English'], [['S-001', 'Asha Ali', ...values]]));
    const scores = result.students[0].scores;

    expect(scores).toEqual(expect.arrayContaining([
      expect.objectContaining({ assessmentLabel: 'HW1', entryState: 'absent', score: null }),
      expect.objectContaining({ assessmentLabel: 'HW2', entryState: 'not_applicable', score: null }),
    ]));
    expect(scores.some(score => score.assessmentLabel === 'HW3')).toBe(false);
    expect(scores.some(score => score.assessmentLabel === 'HW4')).toBe(false);
  });

  it('blocks an entirely blank subject block', () => {
    const result = parseExcel(workbook(['English'], [['S-001', 'Asha Ali']]));
    expect(result.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'EMPTY_SUBJECT_BLOCK', subjectName: 'English', severity: 'error' }),
    ]));
  });

  it('rejects decimal, negative, and parseFloat-style values with cell references', () => {
    const result = parseExcel(workbook(['English'], [[
      'S-001', 'Asha Ali', '3.5', '-1', '5oops', 0, 15, 15, 15, 15, 20, 20, 10,
    ]]));
    const invalidCells = result.issues.filter(issue => issue.code === 'INVALID_SCORE').map(issue => issue.cell);
    expect(invalidCells).toEqual(expect.arrayContaining(['C3', 'D3', 'E3']));
  });

  it('marks name-only files as legacy identity uploads', () => {
    const result = parseExcel(workbook(['English'], [[
      'Asha Ali', 5, 5, 5, 5, 15, 15, 15, 15, 20, 20, 10,
    ]], undefined, true));
    expect(result.usesLegacyNameIdentity).toBe(true);
    expect(result.issues).toEqual(expect.arrayContaining([expect.objectContaining({ code: 'MISSING_STUDENT_ID', severity: 'warning' })]));
  });
});
