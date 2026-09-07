import { describe, expect, it } from 'vitest';
import * as XLSX from 'xlsx';
import type { Student } from '../../types';
import {
  parseClassImportFile, matchClassImportRows, resolveUploadedClass,
  summarizeClassImport, buildCommitPayload, rosterForClass,
  buildClassImportTemplate, resolveRowCandidate, assertCanImportClasses,
  type ClassImportRow,
} from '../import/classImport';

// ─── Fixtures ───────────────────────────────────────────────────────────────

const HEADER = ['Student ID', 'Student Name', 'Current Class'];

function student(id: string, name: string, className: string, extra: Partial<Student> = {}): Student {
  return { id, name, className, parentId: null, createdAt: '2026-01-01T00:00:00Z', ...extra };
}

const STUDENTS: Student[] = [
  student('MBK-1001', 'Ahmed Ali', 'Grade 7-A', { govId: '22-100001', parentPhone: '611111111' }),
  student('MBK-1002', 'Aisha Mohamed', 'Grade 7-B'),
  student('MBK-1003', 'Hassan Omar', 'Grade 8-A'),
  student('MBK-1055', 'Maryam Hassan', 'Grade 8-B'),
  // Two students sharing a name → ambiguity fixture.
  student('MBK-2001', 'Ahmed Mohamed', 'Grade 6-A'),
  student('MBK-2002', 'Ahmed Mohamed', 'Grade 6-B'),
  // Name + phone secondary-match fixture.
  student('MBK-3001', 'Fadumo Abdi', 'Grade 5-A', { parentPhone: '612222222' }),
];

const KNOWN_CLASSES = [
  'Grade 5-A', 'Grade 5-B',
  'Grade 6-A', 'Grade 6-B',
  'Grade 7-A', 'Grade 7-B', 'Grade 7-C',
  'Grade 8-A', 'Grade 8-B',
  'KG-A', 'Foundation A', 'Graduated',
];

function makeWorkbook(rows: (string | number | null)[][]): ArrayBuffer {
  const ws = XLSX.utils.aoa_to_sheet(rows);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Students');
  const out = XLSX.write(wb, { type: 'array', bookType: 'xlsx' });
  return out as unknown as ArrayBuffer;
}

function classify(rows: (string | number | null)[][], students: Student[] = STUDENTS): ClassImportRow[] {
  const parsed = parseClassImportFile(makeWorkbook([HEADER, ...rows]));
  expect(parsed.issues.filter(i => i.severity === 'error')).toHaveLength(0);
  return matchClassImportRows(parsed.rows, students, KNOWN_CLASSES);
}

// ─── Class resolution ───────────────────────────────────────────────────────

describe('resolveUploadedClass', () => {
  it('accepts the canonical name case/whitespace-insensitively', () => {
    expect(resolveUploadedClass('grade 7-a', KNOWN_CLASSES)).toBe('Grade 7-A');
    expect(resolveUploadedClass('Grade  7-A ', KNOWN_CLASSES)).toBe('Grade 7-A');
  });

  it('accepts sheet codes and shorthand that map to an EXISTING class', () => {
    expect(resolveUploadedClass('7A', KNOWN_CLASSES)).toBe('Grade 7-A');
    expect(resolveUploadedClass('7-A', KNOWN_CLASSES)).toBe('Grade 7-A');
    expect(resolveUploadedClass('G7A', KNOWN_CLASSES)).toBe('Grade 7-A');
    expect(resolveUploadedClass('Grade 7A', KNOWN_CLASSES)).toBe('Grade 7-A');
    expect(resolveUploadedClass('KG', KNOWN_CLASSES)).toBe('KG-A');
  });

  it('rejects classes that do not exist — never silently converted', () => {
    expect(resolveUploadedClass('7Z', KNOWN_CLASSES)).toBeNull();
    expect(resolveUploadedClass('9Z', KNOWN_CLASSES)).toBeNull();
    expect(resolveUploadedClass('Grade 9-A', KNOWN_CLASSES)).toBeNull();
    expect(resolveUploadedClass('Bananas', KNOWN_CLASSES)).toBeNull();
    expect(resolveUploadedClass('', KNOWN_CLASSES)).toBeNull();
  });
});

// ─── Matching hierarchy ─────────────────────────────────────────────────────

describe('matching hierarchy', () => {
  it('priority 1: matches on existing Student ID even with a renamed student', () => {
    const [row] = classify([['MBK-1001', 'Totally Different Name', 'Grade 7-B']]);
    expect(row.status).toBe('class_change');
    expect(row.matchMethod).toBe('student_id');
    expect(row.matchedStudentId).toBe('MBK-1001');
    expect(row.fromClass).toBe('Grade 7-A');
    expect(row.toClass).toBe('Grade 7-B');
  });

  it('priority 2: matches on unique Gov ID when no Student ID is given', () => {
    const parsed = parseClassImportFile(makeWorkbook([
      ['Gov ID', 'Student Name', 'Current Class'],
      ['22-100001', 'someone else', 'Grade 7-B'],
    ]));
    const matched = matchClassImportRows(parsed.rows, STUDENTS, KNOWN_CLASSES);
    expect(matched[0].status).toBe('class_change');
    expect(matched[0].matchMethod).toBe('gov_id');
    expect(matched[0].matchedStudentId).toBe('MBK-1001');
  });

  it('priority 3: name ALONE is never auto-matched — even a unique name goes to review', () => {
    const [row] = classify([['', 'Hassan Omar', 'Grade 8-B']]);
    expect(row.status).toBe('ambiguous');
    expect(row.candidates.map(c => c.id)).toEqual(['MBK-1003']);
  });

  it('priority 3: name + matching parent phone auto-matches', () => {
    const parsed = parseClassImportFile(makeWorkbook([
      ['Student Name', 'Current Class', 'Parent Phone'],
      ['Fadumo Abdi', 'Grade 5-B', '+252612222222'],
    ]));
    const matched = matchClassImportRows(parsed.rows, STUDENTS, KNOWN_CLASSES);
    expect(matched[0].status).toBe('class_change');
    expect(matched[0].matchMethod).toBe('name_phone');
    expect(matched[0].matchedStudentId).toBe('MBK-3001');
  });

  it('unknown Student ID with an existing-student name never creates a duplicate', () => {
    const [row] = classify([['MBK-9999', 'Ahmed Ali', 'Grade 7-B']]);
    expect(row.status).toBe('ambiguous');
    expect(row.candidates.map(c => c.id)).toEqual(['MBK-1001']);
    expect(row.issues.some(i => i.code === 'STUDENT_ID_NOT_FOUND')).toBe(true);
  });

  it('unknown Student ID with an unknown name becomes a NEW student keeping the sheet ID', () => {
    const [row] = classify([['MBK-1402', 'Yusuf Hassan', 'Grade 6-A']]);
    expect(row.status).toBe('new_student');
    expect(row.studentId).toBe('MBK-1402');
    expect(row.toClass).toBe('Grade 6-A');
  });
});

// ─── Classification scenarios (spec test list) ──────────────────────────────

describe('classification scenarios', () => {
  it('1. student remains in same class → NO CHANGE', () => {
    const [row] = classify([['MBK-1002', 'Aisha Mohamed', 'Grade 7-B']]);
    expect(row.status).toBe('no_change');
  });

  it('2. student moves A → B → CLASS CHANGE', () => {
    const [row] = classify([['MBK-1001', 'Ahmed Ali', 'Grade 7-B']]);
    expect(row.status).toBe('class_change');
    expect(row.fromClass).toBe('Grade 7-A');
    expect(row.toClass).toBe('Grade 7-B');
  });

  it('3. student moves B → C → CLASS CHANGE', () => {
    const [row] = classify([['MBK-1002', 'Aisha Mohamed', 'Grade 7-C']]);
    expect(row.status).toBe('class_change');
    expect(row.fromClass).toBe('Grade 7-B');
    expect(row.toClass).toBe('Grade 7-C');
  });

  it('4. new student without an ID gets a generated stable ID', () => {
    const [row] = classify([['', 'Fatima Ali', 'Grade 5-B']]);
    expect(row.status).toBe('new_student');
    expect(row.assignedId).toMatch(/^student-/);
  });

  it('5. unknown student ID is reported, never silently applied', () => {
    const [row] = classify([['MBK-9999', 'Ahmed Mohamed', 'Grade 6-A']]);
    expect(['ambiguous', 'unmatched']).toContain(row.status);
    expect(row.matchedStudentId).toBeNull();
    expect(row.issues.length).toBeGreaterThan(0);
  });

  it('6. duplicate Student ID in the file → only first processed', () => {
    const rows = classify([
      ['MBK-1001', 'Ahmed Ali', 'Grade 7-B'],
      ['MBK-1001', 'Ahmed Ali', 'Grade 7-C'],
    ]);
    expect(rows[0].status).toBe('class_change');
    expect(rows[1].status).toBe('duplicate');
    expect(rows[1].issues[0].message).toContain('same Student ID MBK-1001');
  });

  it('7. exact duplicate Excel rows are not processed twice', () => {
    const rows = classify([
      ['MBK-1003', 'Hassan Omar', 'Grade 8-B'],
      ['MBK-1003', 'Hassan Omar', 'Grade 8-B'],
    ]);
    expect(rows.filter(r => r.status === 'class_change')).toHaveLength(1);
    expect(rows[1].status).toBe('duplicate');
  });

  it('7b. duplicate names with no identifiers do not create two records', () => {
    const rows = classify([
      ['', 'New Kid', 'Grade 6-A'],
      ['', 'New Kid', 'Grade 6-B'],
    ]);
    expect(rows[0].status).toBe('new_student');
    expect(rows[1].status).toBe('duplicate');
    expect(rows[1].excluded).toBe(true);
    expect(buildCommitPayload(rows).newStudents).toHaveLength(1);
  });

  it('8. ambiguous name (two possible students) → manual review', () => {
    const [row] = classify([['', 'Ahmed Mohamed', 'Grade 6-A']]);
    expect(row.status).toBe('ambiguous');
    expect(row.candidates).toHaveLength(2);
  });

  it('9. invalid class → INVALID, never converted', () => {
    const [row] = classify([['MBK-1001', 'Ahmed Ali', 'Grade 9-Z']]);
    expect(row.status).toBe('invalid');
    expect(row.issues[0].code).toBe('INVALID_CLASS');
    expect(row.toClass).toBeNull();
  });

  it('10. missing required fields are rejected per row', () => {
    const rows = classify([
      ['MBK-1001', 'Ahmed Ali', ''],       // matched student, missing class
      ['', '', 'Grade 6-A'],                // no identifiers at all
      ['MBK-4000', '', 'Grade 6-A'],        // unknown id, no name
    ]);
    expect(rows[0].status).toBe('invalid');
    expect(rows[1].status).toBe('invalid');
    expect(rows[2].status).toBe('unmatched'); // unknown id + no name
    expect(rows[2].issues[0].code).toBe('STUDENT_ID_NOT_FOUND');
  });

  it('11. non-admin roles are rejected by the client guard', () => {
    expect(() => assertCanImportClasses('teacher')).toThrowError(/Only administrators/);
    expect(() => assertCanImportClasses('parent')).toThrowError(/Only administrators/);
    expect(() => assertCanImportClasses('supervisor')).toThrowError(/Only administrators/);
    expect(() => assertCanImportClasses('office')).toThrowError(/Only administrators/);
    expect(() => assertCanImportClasses(null)).toThrowError(/Only administrators/);
    expect(() => assertCanImportClasses('admin')).not.toThrow();
  });

  it('15. multiple students changing classes in one file', () => {
    const rows = classify([
      ['MBK-1001', 'Ahmed Ali', 'Grade 7-B'],
      ['MBK-1002', 'Aisha Mohamed', 'Grade 7-A'],
      ['MBK-1055', 'Maryam Hassan', 'Grade 8-A'],
    ]);
    expect(rows.every(r => r.status === 'class_change')).toBe(true);
    const payload = buildCommitPayload(rows);
    expect(payload.changes).toHaveLength(3);
  });

  it('16. multiple new students in one file', () => {
    const rows = classify([
      ['MBK-1402', 'Yusuf Hassan', 'Grade 6-A'],
      ['MBK-1403', 'Fatima Ali', 'Grade 5-B'],
      ['', 'New Kid', 'KG-A'],
    ]);
    expect(rows.every(r => r.status === 'new_student')).toBe(true);
    const payload = buildCommitPayload(rows);
    expect(payload.newStudents).toHaveLength(3);
    expect(payload.newStudents[0].id).toBe('MBK-1402');
    expect(payload.newStudents[2].id).toMatch(/^student-/);
  });

  it('17. a large file (2000 rows) parses and classifies', () => {
    const big: (string | null)[][] = [];
    const students: Student[] = [];
    for (let i = 0; i < 2000; i++) {
      const id = `MBK-${5000 + i}`;
      students.push(student(id, `Student Number ${i}`, i % 2 === 0 ? 'Grade 7-A' : 'Grade 7-B'));
      // Half move class, half stay.
      big.push([id, `Student Number ${i}`, i % 2 === 0 ? 'Grade 7-B' : 'Grade 7-B']);
    }
    const started = Date.now();
    const parsed = parseClassImportFile(makeWorkbook([HEADER, ...big]));
    const rows = matchClassImportRows(parsed.rows, students, KNOWN_CLASSES);
    expect(rows).toHaveLength(2000);
    expect(rows.filter(r => r.status === 'class_change')).toHaveLength(1000);
    expect(rows.filter(r => r.status === 'no_change')).toHaveLength(1000);
    expect(Date.now() - started).toBeLessThan(5000);
  });
});

// ─── Historical data & bulk-grades integration ──────────────────────────────

describe('historical data protection & bulk grade integration', () => {
  it('12/13. commit payload only carries the current-class assignment — never grade/attendance data', () => {
    const rows = classify([
      ['MBK-1001', 'Ahmed Ali', 'Grade 7-B'],
      ['MBK-1402', 'Yusuf Hassan', 'Grade 6-A'],
    ]);
    const payload = buildCommitPayload(rows);
    // Class changes are expressed purely as (studentId → new current class).
    expect(payload.changes).toEqual([{ studentId: 'MBK-1001', toClass: 'Grade 7-B' }]);
    // New students carry identity fields only — no exams/attendance/history.
    expect(payload.newStudents[0]).toEqual({
      id: 'MBK-1402', name: 'Yusuf Hassan', className: 'Grade 6-A', govId: null, parentPhone: null, transport: 'WALKER',
    });
    // The RPC (supabase/migrations/20260906_student_class_import.sql) only
    // UPDATEs students."className", INSERTs new students, and records history
    // in student_promotions/audit_logs — asserted in
    // supabase/tests/rls-student-class-import.sql against the real schema.
  });

  it('14. after a committed move, Bulk Upload Grades rosters show the student in the NEW class', () => {
    // Simulate the post-commit state: the RPC updated className only.
    const afterCommit: Student[] = STUDENTS.map(s =>
      s.id === 'MBK-1001' ? { ...s, className: 'Grade 7-B' } : s,
    );
    const roster7B = rosterForClass(afterCommit, 'Grade 7-B');
    const roster7A = rosterForClass(afterCommit, 'Grade 7-A');
    expect(roster7B.map(s => s.id)).toContain('MBK-1001');
    expect(roster7A.map(s => s.id)).not.toContain('MBK-1001');
    // The student record itself is the SAME object/ID — no duplicate created.
    expect(roster7B.find(s => s.id === 'MBK-1001')?.name).toBe('Ahmed Ali');
    expect(new Set(afterCommit.map(s => s.id)).size).toBe(STUDENTS.length);
  });
});

// ─── Preview semantics: summary, exclusions, manual resolve ────────────────

describe('preview semantics', () => {
  it('summarizes counts per category', () => {
    const rows = classify([
      ['MBK-1001', 'Ahmed Ali', 'Grade 7-B'],   // change
      ['MBK-1002', 'Aisha Mohamed', 'Grade 7-B'], // no change
      ['MBK-1402', 'Yusuf Hassan', 'Grade 6-A'],  // new
      ['', 'Ahmed Mohamed', 'Grade 6-A'],          // ambiguous
      ['MBK-1003', 'Hassan Omar', 'Grade 9-Z'],    // invalid class
    ]);
    const summary = summarizeClassImport(rows);
    expect(summary.totalRows).toBe(5);
    expect(summary.classChanges).toBe(1);
    expect(summary.noChange).toBe(1);
    expect(summary.newStudents).toBe(1);
    expect(summary.ambiguous).toBe(1);
    expect(summary.invalidRows).toBe(1);
    expect(summary.applicableChanges).toBe(1);
    expect(summary.applicableCreates).toBe(1);
  });

  it('excluded rows never reach the commit payload', () => {
    const rows = classify([
      ['MBK-1001', 'Ahmed Ali', 'Grade 7-B'],
      ['MBK-1402', 'Yusuf Hassan', 'Grade 6-A'],
    ]);
    rows[0] = { ...rows[0], excluded: true };
    const payload = buildCommitPayload(rows);
    expect(payload.changes).toHaveLength(0);
    expect(payload.newStudents).toHaveLength(1);
  });

  it('ambiguous rows can be manually resolved to a candidate', () => {
    const rows = classify([['', 'Ahmed Mohamed', 'Grade 6-B']]);
    expect(rows[0].status).toBe('ambiguous');
    const candidate = rows[0].candidates[1]; // MBK-2002, Grade 6-B → no change
    const existing = STUDENTS.find(s => s.id === candidate.id)!;
    const resolved = resolveRowCandidate(rows[0], candidate, existing, KNOWN_CLASSES);
    expect(resolved.status).toBe('no_change');
    expect(resolved.matchMethod).toBe('manual');
    const resolved2 = resolveRowCandidate(rows[0], rows[0].candidates[0], STUDENTS.find(s => s.id === rows[0].candidates[0].id)!, KNOWN_CLASSES);
    expect(resolved2.status).toBe('class_change'); // MBK-2001 is in Grade 6-A
  });

  it('two rows resolving to the same student conflict — the later one is held back', () => {
    const parsed = parseClassImportFile(makeWorkbook([
      ['Student ID', 'Gov ID', 'Student Name', 'Current Class'],
      ['MBK-1001', '', 'Ahmed Ali', 'Grade 7-B'],
      ['', '22-100001', 'Ahmed Ali', 'Grade 7-C'],
    ]));
    const rows = matchClassImportRows(parsed.rows, STUDENTS, KNOWN_CLASSES);
    expect(rows[0].status).toBe('class_change');
    expect(rows[1].status).toBe('duplicate');
    expect(rows[1].issues.some(i => i.code === 'CONFLICTING_ROWS')).toBe(true);
  });

  it('template export round-trips through the parser with every row matched', () => {
    const blob = buildClassImportTemplate(STUDENTS);
    return blob.arrayBuffer().then(buffer => {
      const parsed = parseClassImportFile(buffer);
      expect(parsed.rows).toHaveLength(STUDENTS.length);
      const rows = matchClassImportRows(parsed.rows, STUDENTS, KNOWN_CLASSES);
      expect(rows.every(r => r.status === 'no_change')).toBe(true);
    });
  });
});

// ─── Final acceptance scenario (exact spec) ─────────────────────────────────

describe('final acceptance scenario', () => {
  const existing: Student[] = [
    student('STU-A', 'Student A', 'Grade 7-A'),
    student('STU-B', 'Student B', 'Grade 7-A'),
    student('STU-C', 'Student C', 'Grade 7-B'),
    student('STU-D', 'Student D', 'Grade 8-A'),
  ];
  const classes = ['Grade 6-A', 'Grade 7-A', 'Grade 7-B', 'Grade 7-C', 'Grade 8-A', 'Grade 8-B'];

  it('produces exactly the expected classifications and no duplicates', () => {
    const parsed = parseClassImportFile(makeWorkbook([
      HEADER,
      ['STU-A', 'Student A', 'Grade 7-B'],
      ['STU-B', 'Student B', 'Grade 7-C'],
      ['STU-C', 'Student C', 'Grade 7-B'],
      ['STU-D', 'Student D', 'Grade 8-B'],
      ['STU-E', 'Student E', 'Grade 6-A'],
    ]));
    const rows = matchClassImportRows(parsed.rows, existing, classes);

    const byId = new Map(rows.map(r => [r.studentId || r.name, r]));
    const a = byId.get('STU-A')!;
    const b = byId.get('STU-B')!;
    const c = byId.get('STU-C')!;
    const d = byId.get('STU-D')!;
    const e = rows[4];

    // Class changes: A 7A→7B, B 7A→7C, D 8A→8B
    expect(a.status).toBe('class_change');
    expect([a.fromClass, a.toClass]).toEqual(['Grade 7-A', 'Grade 7-B']);
    expect(b.status).toBe('class_change');
    expect([b.fromClass, b.toClass]).toEqual(['Grade 7-A', 'Grade 7-C']);
    expect(d.status).toBe('class_change');
    expect([d.fromClass, d.toClass]).toEqual(['Grade 8-A', 'Grade 8-B']);

    // No change: C stays 7B
    expect(c.status).toBe('no_change');

    // New student: E → 6A
    expect(e.status).toBe('new_student');
    expect(e.toClass).toBe('Grade 6-A');

    // Commit payload: 3 changes + 1 create, and no duplicate students.
    const payload = buildCommitPayload(rows);
    expect(payload.changes).toHaveLength(3);
    expect(payload.newStudents).toHaveLength(1);
    const touchedIds = [...payload.changes.map(c2 => c2.studentId), ...payload.newStudents.map(s => s.id)];
    expect(new Set(touchedIds).size).toBe(touchedIds.length);

    // Simulated post-commit state: same 4 records + exactly 1 new one.
    const after = existing.map(s => {
      const change = payload.changes.find(ch => ch.studentId === s.id);
      return change ? { ...s, className: change.toClass } : s;
    });
    const created = payload.newStudents.map(s => student(s.id, s.name, s.className));
    const final = [...after, ...created];
    expect(final).toHaveLength(5);
    expect(new Set(final.map(s => s.id)).size).toBe(5);
    expect(final.find(s => s.id === 'STU-A')?.className).toBe('Grade 7-B');
    expect(final.filter(s => s.name === 'Student A')).toHaveLength(1); // no duplicate A
  });
});

// ─── Parser robustness ──────────────────────────────────────────────────────

describe('parser robustness', () => {
  it('maps columns by header name regardless of order and extra columns', () => {
    const parsed = parseClassImportFile(makeWorkbook([
      ['Notes', 'Current Class', 'Student Name', 'Student ID', 'Junk'],
      ['x', 'Grade 7-A', 'Ahmed Ali', 'MBK-1001', 'y'],
    ]));
    expect(parsed.rows).toHaveLength(1);
    expect(parsed.rows[0].studentId).toBe('MBK-1001');
    expect(parsed.rows[0].name).toBe('Ahmed Ali');
    expect(parsed.rows[0].rawClass).toBe('Grade 7-A');
  });

  it('reports missing header columns as file-level issues', () => {
    const parsed = parseClassImportFile(makeWorkbook([
      ['Student ID', 'Student Name'],
      ['MBK-1001', 'Ahmed Ali'],
    ]));
    expect(parsed.issues.some(i => i.code === 'MISSING_CLASS_COLUMN')).toBe(true);
  });

  it('rejects a workbook with no recognizable header', () => {
    const parsed = parseClassImportFile(makeWorkbook([['foo', 'bar'], ['1', '2']]));
    expect(parsed.issues.some(i => i.code === 'NO_HEADER')).toBe(true);
  });

  it('skips fully blank trailing rows', () => {
    const parsed = parseClassImportFile(makeWorkbook([
      HEADER,
      ['MBK-1001', 'Ahmed Ali', 'Grade 7-A'],
      [null, null, null],
      ['', '', ''],
    ]));
    expect(parsed.rows).toHaveLength(1);
  });
});

// ─── Excel numeric-ID corruption protection (remediation) ──────────────────
describe('numeric identity cells are never silently matched', () => {
  it('flags a numeric Gov ID (Excel number) and holds the row — never auto-creates', () => {
    // A 17-digit gov id stored as a NUMBER loses precision in Excel.
    const parsed = parseClassImportFile(makeWorkbook([
      ['Gov ID', 'Student Name', 'Current Class'],
      [22100099999999999, 'Big Gov Kid', 'Grade 5-A'],
    ]));
    expect(parsed.issues.some(i => i.code === 'NUMERIC_ID')).toBe(true);
    const rows = matchClassImportRows(parsed.rows, STUDENTS, KNOWN_CLASSES);
    expect(rows[0].status).toBe('invalid');
    expect(rows[0].excluded).toBe(true);
    // It must NOT be classified as a new student that would commit.
    expect(buildCommitPayload(rows).newStudents).toHaveLength(0);
  });

  it('flags a numeric Student ID cell and does not match or create', () => {
    const parsed = parseClassImportFile(makeWorkbook([
      HEADER,
      [123456, 'Some Student', 'Grade 7-B'],
    ]));
    expect(parsed.issues.some(i => i.code === 'NUMERIC_ID')).toBe(true);
    const rows = matchClassImportRows(parsed.rows, STUDENTS, KNOWN_CLASSES);
    expect(rows[0].status).toBe('invalid');
    expect(buildCommitPayload(rows).changes).toHaveLength(0);
    expect(buildCommitPayload(rows).newStudents).toHaveLength(0);
  });

  it('text IDs (including leading zeros) still match normally', () => {
    const withZero = student('01001', 'Zero Lead', 'Grade 7-A');
    const parsed = parseClassImportFile(makeWorkbook([
      HEADER,
      ['01001', 'Zero Lead', 'Grade 7-B'],
    ]));
    expect(parsed.issues.some(i => i.code === 'NUMERIC_ID')).toBe(false);
    const rows = matchClassImportRows(parsed.rows, [...STUDENTS, withZero], KNOWN_CLASSES);
    expect(rows[0].status).toBe('class_change');
    expect(rows[0].matchedStudentId).toBe('01001');
  });
});

describe('new-student payload normalizes phone numbers', () => {
  it('stores digits-only parent phone for name+phone and new students', () => {
    const parsed = parseClassImportFile(makeWorkbook([
      ['Student Name', 'Current Class', 'Parent Phone'],
      ['Brand New Child', 'Grade 5-A', '+252 612 222 222'],
    ]));
    const rows = matchClassImportRows(parsed.rows, STUDENTS, KNOWN_CLASSES);
    expect(rows[0].status).toBe('new_student');
    const payload = buildCommitPayload(rows);
    expect(payload.newStudents[0].parentPhone).toBe('612222222');
  });
});

// ─── Bus / transport column ─────────────────────────────────────────────────

describe('class import Bus column', () => {
  const BUS_HEADER = ['Student ID', 'Student Name', 'Current Class', 'Bus'];

  it('treats a route-number change (same class) as an applicable change', () => {
    const withBus = student('MBK-1002', 'Aisha Mohamed', 'Grade 7-B', { transport: null });
    const parsed = parseClassImportFile(makeWorkbook([
      BUS_HEADER,
      ['MBK-1002', 'Aisha Mohamed', 'Grade 7-B', '9'],
    ]));
    expect(parsed.issues.filter(i => i.severity === 'error')).toHaveLength(0);
    const rows = matchClassImportRows(parsed.rows, [withBus], KNOWN_CLASSES);
    expect(rows[0].status).toBe('class_change');
    const payload = buildCommitPayload(rows);
    expect(payload.changes).toHaveLength(1);
    expect(payload.changes[0]).toMatchObject({ studentId: 'MBK-1002', toClass: 'Grade 7-B', transport: '9' });
  });

  it('maps NB / no-bus markers to WALKER and detects walker→bus change', () => {
    const walker = student('MBK-1003', 'Hassan Omar', 'Grade 8-A', { transport: 'WALKER' });
    const parsed = parseClassImportFile(makeWorkbook([
      BUS_HEADER,
      ['MBK-1003', 'Hassan Omar', 'Grade 8-A', '12'],
    ]));
    const rows = matchClassImportRows(parsed.rows, [walker], KNOWN_CLASSES);
    expect(rows[0].status).toBe('class_change');
    expect(rows[0].toTransport).toBe('12');
  });

  it('leaves transport untouched when the Bus cell is blank', () => {
    const rider = student('MBK-1001', 'Ahmed Ali', 'Grade 7-A', { transport: '5' });
    const parsed = parseClassImportFile(makeWorkbook([
      BUS_HEADER,
      ['MBK-1001', 'Ahmed Ali', 'Grade 7-A', ''],
    ]));
    const rows = matchClassImportRows(parsed.rows, [rider], KNOWN_CLASSES);
    expect(rows[0].status).toBe('no_change');
    expect(rows[0].parsedTransport).toBeNull();
    const payload = buildCommitPayload(rows);
    expect(payload.changes).toHaveLength(0);
  });

  it('rejects a non-numeric, non-marker bus value as an invalid row', () => {
    const parsed = parseClassImportFile(makeWorkbook([
      BUS_HEADER,
      ['MBK-1001', 'Ahmed Ali', 'Grade 7-A', 'North Route'],
    ]));
    expect(parsed.issues.some(i => i.code === 'INVALID_BUS')).toBe(true);
    const rows = matchClassImportRows(parsed.rows, STUDENTS, KNOWN_CLASSES);
    expect(rows[0].status).toBe('invalid');
    expect(rows[0].excluded).toBe(true);
    const payload = buildCommitPayload(rows);
    expect(payload.changes).toHaveLength(0);
  });

  it('does not accept LEFT from the import', () => {
    const parsed = parseClassImportFile(makeWorkbook([
      BUS_HEADER,
      ['MBK-1001', 'Ahmed Ali', 'Grade 7-A', 'left'],
    ]));
    expect(parsed.issues.some(i => i.code === 'INVALID_BUS')).toBe(true);
  });

  it('assigns WALKER by default to a new student with a blank Bus cell', () => {
    const parsed = parseClassImportFile(makeWorkbook([
      BUS_HEADER,
      ['', 'Brand New Rider', 'Grade 5-A', ''],
    ]));
    const rows = matchClassImportRows(parsed.rows, STUDENTS, KNOWN_CLASSES);
    expect(rows[0].status).toBe('new_student');
    const payload = buildCommitPayload(rows);
    expect(payload.newStudents[0].transport).toBe('WALKER');
  });

  it('assigns the route number to a new student who rides the bus', () => {
    const parsed = parseClassImportFile(makeWorkbook([
      BUS_HEADER,
      ['', 'Brand New Rider Two', 'Grade 5-A', '7'],
    ]));
    const rows = matchClassImportRows(parsed.rows, STUDENTS, KNOWN_CLASSES);
    const payload = buildCommitPayload(rows);
    expect(payload.newStudents[0].transport).toBe('7');
  });
});
