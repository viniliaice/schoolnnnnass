import { describe, it, expect } from 'vitest';
import * as XLSX from 'xlsx';
import type { Student } from '../../types';
import {
  parseClassImportFile,
  matchClassImportRows,
  buildClassImportTemplate,
  buildCommitPayload,
  summarizeClassImport,
} from '../import/classImport';

function student(id: string, name: string, className: string): Student {
  return {
    id,
    name,
    className,
    parentId: null,
    createdAt: '2026-01-01T00:00:00Z',
    govId: `GOV-${id}`,
    transport: id.endsWith('0') ? '5' : 'WALKER',
    parentPhone: null,
    familyId: null,
  };
}

describe('large roster export/import >1000 students', () => {
  const TOTAL = 1500;
  const KNOWN_CLASSES = [
    'Grade 7-A', 'Grade 7-B', 'Grade 7-C',
    'Grade 8-A', 'Grade 8-B',
    'Grade 6-A', 'Grade 6-B',
  ];

  const STUDENTS: Student[] = Array.from({ length: TOTAL }, (_, i) => {
    const cls = KNOWN_CLASSES[i % KNOWN_CLASSES.length];
    return student(`STU-${String(i + 1).padStart(5, '0')}`, `Student ${i + 1}`, cls);
  });

  it('export contains all students, not just first 1000', async () => {
    const blob = buildClassImportTemplate(STUDENTS);
    const buffer = await blob.arrayBuffer();
    const wb = XLSX.read(buffer, { type: 'array' });
    const sheet = wb.Sheets[wb.SheetNames[0]];
    const rows = XLSX.utils.sheet_to_json(sheet, { header: 1 }) as unknown[][];
    // header + data rows
    const dataRows = rows.length - 1;
    console.log(`Exported rows: ${dataRows}, expected: ${TOTAL}`);
    expect(dataRows).toBe(TOTAL);

    // Verify no missing after row 1000
    const parsed = parseClassImportFile(buffer);
    expect(parsed.rows).toHaveLength(TOTAL);
    // Check that student IDs beyond 1000 exist
    const ids = parsed.rows.map(r => r.studentId);
    expect(ids).toContain('STU-01001');
    expect(ids).toContain('STU-01500');
    expect(new Set(ids).size).toBe(TOTAL); // unique
  });

  it('re-importing exported file produces no duplicates and no changes', async () => {
    const blob = buildClassImportTemplate(STUDENTS);
    const buffer = await blob.arrayBuffer();
    const parsed = parseClassImportFile(buffer);
    const matched = matchClassImportRows(parsed.rows, STUDENTS, KNOWN_CLASSES);
    const summary = summarizeClassImport(matched);
    // All should be no_change
    expect(summary.noChange).toBe(TOTAL);
    expect(summary.classChanges).toBe(0);
    expect(summary.newStudents).toBe(0);
    expect(summary.ambiguous).toBe(0);
    expect(summary.invalidRows).toBe(0);
    expect(summary.duplicates).toBe(0);

    const payload = buildCommitPayload(matched);
    expect(payload.changes).toHaveLength(0);
    expect(payload.newStudents).toHaveLength(0);
  });

  it('changing a student class from 7A -> 7B updates existing record, not new', async () => {
    const blob = buildClassImportTemplate(STUDENTS);
    const buffer = await blob.arrayBuffer();
    const wb = XLSX.read(buffer, { type: 'array' });
    const sheet = wb.Sheets[wb.SheetNames[0]];
    const json = XLSX.utils.sheet_to_json<Record<string, string>>(sheet);
    // Change first student's class from whatever to Grade 7-B (different)
    // Ensure it's actually a change. Template is sorted by className/name, so
    // locate the row for STUDENTS[0] by ID rather than assuming index 0.
    const first = STUDENTS[0];
    const targetClass = first.className === 'Grade 7-B' ? 'Grade 7-A' : 'Grade 7-B';
    const idx = json.findIndex(r => r['Student ID'] === first.id);
    expect(idx).toBeGreaterThanOrEqual(0);
    json[idx]['Current Class'] = targetClass;
    // Also add a new student at bottom
    json.push({
      'Student ID': 'STU-NEW-001',
      'Gov ID': 'GOV-NEW-001',
      'Student Name': 'New Kid After 1500',
      'Current Class': 'Grade 7-A',
      'Bus': 'NB',
      'Parent Phone': '',
    });

    const newSheet = XLSX.utils.json_to_sheet(json);
    const newWb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(newWb, newSheet, 'Students');
    const out = XLSX.write(newWb, { type: 'array', bookType: 'xlsx' }) as ArrayBuffer;

    const parsed = parseClassImportFile(out);
    expect(parsed.rows).toHaveLength(TOTAL + 1);

    const matched = matchClassImportRows(parsed.rows, STUDENTS, KNOWN_CLASSES);
    const summary = summarizeClassImport(matched);
    expect(summary.classChanges).toBe(1);
    expect(summary.newStudents).toBe(1);
    expect(summary.noChange).toBe(TOTAL - 1);

    const payload = buildCommitPayload(matched);
    expect(payload.changes).toHaveLength(1);
    expect(payload.changes[0].studentId).toBe(first.id);
    expect(payload.changes[0].toClass).toBe(targetClass);
    expect(payload.newStudents).toHaveLength(1);
    expect(payload.newStudents[0].id).toBe('STU-NEW-001');
    expect(payload.newStudents[0].name).toBe('New Kid After 1500');

    // Simulate post-commit state: same IDs, no duplicates, history preserved
    const after = STUDENTS.map(s => s.id === first.id ? { ...s, className: targetClass } : s);
    const created = payload.newStudents.map(ns => student(ns.id, ns.name, ns.className));
    const final = [...after, ...created];
    expect(final.length).toBe(TOTAL + 1);
    expect(new Set(final.map(s => s.id)).size).toBe(TOTAL + 1);
    // Existing student's ID preserved
    expect(final.find(s => s.id === first.id)?.name).toBe(first.name);
    expect(final.find(s => s.id === first.id)?.className).toBe(targetClass);
  });

  it('preserves ordering and handles >1000 pagination correctly', async () => {
    // Simulate fetching via getStudents pagination: we already tested export,
    // but also ensure that sorting in template is deterministic and includes all.
    const blob = buildClassImportTemplate(STUDENTS);
    const buffer = await blob.arrayBuffer();
    const parsed = parseClassImportFile(buffer);
    // Template sorts by className then name
    const sorted = [...STUDENTS].sort((a, b) => a.className.localeCompare(b.className) || a.name.localeCompare(b.name));
    expect(parsed.rows[0].studentId).toBe(sorted[0].id);
    expect(parsed.rows[parsed.rows.length - 1].studentId).toBe(sorted[sorted.length - 1].id);
  });
});
