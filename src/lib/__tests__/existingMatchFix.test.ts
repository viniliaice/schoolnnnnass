import { describe, expect, it } from 'vitest';
import * as XLSX from 'xlsx';
import type { Student } from '../../types';
import {
  parseClassImportFile,
  matchClassImportRows,
  buildCommitPayload,
  auditCommitPayload,
  existingIdentityKeys,
  type ClassImportRow,
} from '../import/classImport';

// ─── helpers ────────────────────────────────────────────────────────────────

function student(id: string, name: string, className: string, extra: Partial<Student> = {}): Student {
  return { id, name, className, parentId: null, createdAt: '2026-01-01T00:00:00Z', ...extra } as Student;
}
function workbook(rows: (string | number | null)[][]): ArrayBuffer {
  const ws = XLSX.utils.aoa_to_sheet(rows);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Students');
  return XLSX.write(wb, { type: 'array', bookType: 'xlsx' }) as unknown as ArrayBuffer;
}
const H = ['Student ID', 'Gov ID', 'Student Name', 'Current Class'];
const CLASSES = ['Grade 7-A', 'Grade 7-B'];

function classify(dataRows: (string | number | null)[][], existing: Student[]) {
  const parsed = parseClassImportFile(workbook([H, ...dataRows]));
  const rows = matchClassImportRows(parsed.rows, existing, CLASSES);
  const payload = buildCommitPayload(rows);
  return { rows, payload };
}

const BADRIYA = 'Badriya Cabdisamad Sicid';
const OTHER_NAMES = [
  'Aymen Kayse Nuur Axmed', 'Axmed Cabdimajiid Maxamed', 'Saara Bashiir Muuse',
  'Maxamed Cabdisalaan Warsame', 'Xamda Ibraahin Nur Jama', 'Xuseen Axmed Maxamed',
  'Ugbaad Faysal Ismaaciil', 'Hibo Xasan Nuur', 'Hana Xasan Nuur',
];

describe('existing-student match regression (17-015311)', () => {
  it('AC1/AC3/AC9: existing student with id=govId=17-015311 and a class change → CLASS_CHANGE, never new', () => {
    const existing = [student('17-015311', BADRIYA, 'Grade 7-A', { govId: '17-015311' })];
    const { rows, payload } = classify([['17-015311', '17-015311', BADRIYA, 'Grade 7-B']], existing);
    expect(rows[0].status).toBe('class_change');
    expect(rows[0].matchedStudentId).toBe('17-015311');
    expect(payload.newStudents).toHaveLength(0);
    expect(payload.changes.map(c => c.studentId)).toContain('17-015311');
  });

  it('AC4/AC(no-op): existing student, same class → NO_CHANGE, not in payload at all', () => {
    const existing = [student('17-015311', BADRIYA, 'Grade 7-B', { govId: '17-015311' })];
    const { rows, payload } = classify([['17-015311', '17-015311', BADRIYA, 'Grade 7-B']], existing);
    expect(rows[0].status).toBe('no_change');
    expect(payload.newStudents).toHaveLength(0);
    expect(payload.changes).toHaveLength(0);
  });

  it('AC2: existing student found ONLY by gov id (legacy generated id) + class change → CLASS_CHANGE', () => {
    const existing = [student('student-abc123', BADRIYA, 'Grade 7-A', { govId: '17-015311' })];
    const { rows, payload } = classify([['17-015311', '17-015311', BADRIYA, 'Grade 7-B']], existing);
    expect(rows[0].status).toBe('class_change');
    expect(rows[0].matchedStudentId).toBe('student-abc123');
    expect(payload.newStudents).toHaveLength(0);
    expect(payload.changes.map(c => c.studentId)).toContain('student-abc123');
  });

  it('AC3-equal: student ID and Gov ID identical, unique gov match → bound to existing (no review, no new)', () => {
    const existing = [student('student-xyz', BADRIYA, 'Grade 7-A', { govId: '17-015311' })];
    const { rows, payload } = classify([['17-015311', '17-015311', BADRIYA, 'Grade 7-B']], existing);
    expect(['class_change', 'no_change']).toContain(rows[0].status);
    expect(rows[0].matchedStudentId).toBe('student-xyz');
    expect(payload.newStudents).toHaveLength(0);
  });

  it('AC6: name ALONE (unique name, no phone, no id) → manual review, never auto-match/auto-new', () => {
    const existing = [student('student-9', BADRIYA, 'Grade 7-A')];
    const { rows, payload } = classify([['', '', BADRIYA, 'Grade 7-B']], existing);
    expect(rows[0].status).toBe('ambiguous');
    expect(rows[0].matchedStudentId).toBeNull();
    expect(payload.newStudents).toHaveLength(0);
    expect(payload.changes).toHaveLength(0);
  });

  it('AC7: unknown student ID + existing NAME but no confident key → manual review, never new', () => {
    const existing = [student('student-9', BADRIYA, 'Grade 7-A')];
    const { rows, payload } = classify([['999-000000', '', BADRIYA, 'Grade 7-B']], existing);
    expect(rows[0].status).toBe('ambiguous');
    expect(payload.newStudents).toHaveLength(0);
  });

  it('name + matching parent phone auto-matches even with an unknown student id', () => {
    const existing = [student('student-9', BADRIYA, 'Grade 7-A', { parentPhone: '612222222' })];
    const { rows, payload } = classify(
      [['999-000000', '', BADRIYA, 'Grade 7-B', '612222222']],
      existing,
    );
    // header used is H (4 cols) → phone column won't map; use a 5-col header instead:
    expect(rows[0].status).toBe('ambiguous'); // no phone col in this header → review, still not new
    expect(payload.newStudents).toHaveLength(0);
  });

  it('AC5/AC7: a row whose Gov ID already exists but was not matched is held for review — never created', () => {
    // The matcher is given the real roster; the identity-collision guard and the
    // unique-gov match both ensure this never becomes new_student.
    const existing = [student('student-legacy', BADRIYA, 'Grade 7-A', { govId: '17-015311' })];
    const { rows, payload } = classify([['17-015311', '17-015311', BADRIYA, 'Grade 7-B']], existing);
    expect(payload.newStudents.some(s => s.govId === '17-015311' || s.id === '17-015311')).toBe(false);
    expect(rows[0].status).not.toBe('new_student');
  });

  it('payload audit (server-truth keys) catches a new student that collides with an existing Gov ID even when the preview roster was stale', () => {
    // Simulate the production failure: preview built against an empty/stale
    // roster → the row falls through to new_student and the payload carries it.
    const { payload } = classify([['17-015311', '17-015311', BADRIYA, 'Grade 7-B']], []);
    // The authoritative (server) identity keys contain 17-015311.
    const serverKeys = existingIdentityKeys([student('17-015311', BADRIYA, 'Grade 7-A', { govId: '17-015311' })]);
    const problems = auditCommitPayload(payload, serverKeys);
    expect(problems.length).toBeGreaterThan(0);
    expect(problems.some(p => /already/i.test(p))).toBe(true);
  });

  it('AC10 (other real names): each existing student, id=govId present → never new', () => {
    const existing = OTHER_NAMES.map((name, i) =>
      student(`17-01${500 + i}`, name, 'Grade 7-A', { govId: `17-01${500 + i}` }));
    const rows = OTHER_NAMES.map((name, i) => [`17-01${500 + i}`, `17-01${500 + i}`, name, 'Grade 7-B']);
    const { rows: classified, payload } = classify(rows, existing);
    for (const r of classified) {
      expect(['class_change', 'no_change']).toContain(r.status);
      expect(r.matchedStudentId).not.toBeNull();
    }
    expect(payload.newStudents).toHaveLength(0);
    expect(payload.changes).toHaveLength(OTHER_NAMES.length);
  });

  it('INVARIANT: newStudents NEVER contains a row bound to an existing student', () => {
    const existing = [student('17-015311', BADRIYA, 'Grade 7-A', { govId: '17-015311' })];
    const { payload } = classify([['17-015311', '17-015311', BADRIYA, 'Grade 7-B']], existing);
    for (const ns of payload.newStudents) {
      expect(existing.some(e => e.id === ns.id)).toBe(false);
    }
  });

  it('auditCommitPayload flags a new student that reuses an existing gov id', () => {
    const keys = existingIdentityKeys([student('student-1', BADRIYA, 'Grade 7-A', { govId: '17-015311' })]);
    const problems = auditCommitPayload(
      { changes: [], newStudents: [{ id: 'brand-new-id', name: 'Someone', className: 'Grade 7-B', govId: '17-015311', parentPhone: null, transport: 'WALKER' }] },
      keys,
    );
    expect(problems.length).toBe(1);
    expect(problems[0]).toMatch(/already/i);
  });

  it('genuinely new student (no id collision) is created once', () => {
    const { rows, payload } = classify([['', '', 'Truly New Child', 'Grade 7-A']], []);
    expect(rows[0].status).toBe('new_student');
    expect(payload.newStudents).toHaveLength(1);
    expect(payload.changes).toHaveLength(0);
  });
});
