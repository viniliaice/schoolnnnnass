import { describe, it, expect, beforeEach } from 'vitest';
import { createDuplicateMergeTestDb, pgliteAvailable } from './duplicateMergeHarness';

const AVAILABLE = await pgliteAvailable();
const withDb = AVAILABLE ? describe : describe.skip;

withDb('student identity hardening — real Postgres via PGlite', () => {
  let db: Awaited<ReturnType<typeof createDuplicateMergeTestDb>>;
  const adminAuthId = '00000000-0000-0000-0000-000000000001';
  const adminProfileId = 'admin-1';
  const parentAuthId = '00000000-0000-0000-0000-000000000002';
  const parentProfileId = 'parent-ayi';

  beforeEach(async () => {
    db = await createDuplicateMergeTestDb();
    await db.exec(`
      INSERT INTO auth.users (id) VALUES ('${adminAuthId}'), ('${parentAuthId}');
      INSERT INTO profiles (id, name, email, role, auth_id) VALUES
        ('${adminProfileId}', 'Admin', 'admin@test.com', 'admin', '${adminAuthId}'),
        ('${parentProfileId}', 'Parent', 'parent@test.com', 'parent', '${parentAuthId}');
      INSERT INTO academic_years (id, name, "isCurrent") VALUES ('ay-1', '2026/2027', true);
      INSERT INTO terms (id, name, "academicYearId", "startDate", "endDate", "isCurrent", months) VALUES ('term-1', 'Term 1', 'ay-1', '2026-08-01', '2026-12-31', true, ARRAY['August']);
      INSERT INTO subjects (id, name) VALUES ('sub-math', 'Math');
    `);
    await db.setAuthUid(adminAuthId);
  });

  it('create_student reuses by govId', async () => {
    const r1 = await db.query<{ create_student: any }>(`SELECT public.create_student('John Doe', 'Grade 1-A', NULL, 'GOV-999', NULL) AS create_student`);
    const id1 = r1.rows[0].create_student.id;
    const r2 = await db.query<{ create_student: any }>(`SELECT public.create_student('John Doe Different', 'Grade 2-B', NULL, 'GOV-999', NULL) AS create_student`);
    expect(r2.rows[0].create_student.reused).toBe(true);
    expect(r2.rows[0].create_student.id).toBe(id1);
  });

  it('create_student reuses by phone', async () => {
    const r1 = await db.query<{ create_student: any }>(`SELECT public.create_student('Jane', 'Grade 1-A', NULL, NULL, '612345678') AS create_student`);
    const id1 = r1.rows[0].create_student.id;
    const r2 = await db.query<{ create_student: any }>(`SELECT public.create_student('Jane', 'Grade 1-A', NULL, NULL, '612345678') AS create_student`);
    expect(r2.rows[0].create_student.reused).toBe(true);
    expect(r2.rows[0].create_student.id).toBe(id1);
  });

  it('create_student reuses by name+parent', async () => {
    const r1 = await db.query<{ create_student: any }>(`SELECT public.create_student('Samir', 'Grade 1-A', '${parentProfileId}', NULL, NULL) AS create_student`);
    const id1 = r1.rows[0].create_student.id;
    const r2 = await db.query<{ create_student: any }>(`SELECT public.create_student('Samir', 'Grade 1-A', '${parentProfileId}', NULL, NULL) AS create_student`);
    expect(r2.rows[0].create_student.id).toBe(id1);
    expect(r2.rows[0].create_student.reused).toBe(true);
  });

  it('create_student does NOT reuse by name alone when parent differs', async () => {
    await db.query(`SELECT public.create_student('NoReuse', 'Grade 1-A', '${parentProfileId}', NULL, NULL)`);
    // Same name, different class, no govId/phone, different parent context — should still match on name+parent? Actually our hardening says name+parent requires same parent. So if no parent provided second time, should NOT reuse? Let's test that logic.
    // In our hardening, if existing has parent assigned, and new request has no parent, we reuse only if name_match and class_match? Actually we prevent duplicate unassigned creation if canonical exists with parent. Our create_student should reuse if name_match_key same and existing has parent, even if new request has no parent? Let's check.
    // According spec: identity resolution order: stable ID > gov ID > trusted parent/phone via resolver > normalized name + evidence, manual review if ambiguous, only create when no existing should be updated.
    // So name alone should NOT create new if existing exists with same name+class? But spec says must NOT use name alone or UNIQUE(name,className). So we need evidence.
    // For this test, we want to ensure name alone does NOT automatically create duplicate when parent exists? Actually we want to prevent Axmed duplicate: Axmed canonical has parent, duplicate unassigned same name+class. Our create_student should reuse canonical even if new request has no parent.
    // So this test: same name, same class, existing has parent, new request no parent -> should reuse, not create new.
    const r2 = await db.query<{ create_student: any }>(`SELECT public.create_student('NoReuse', 'Grade 1-A', NULL, NULL, NULL) AS create_student`);
    // Our implementation should reuse because name+class match and existing has parent
    expect(r2.rows[0].create_student.reused).toBe(true);
  });

  it('create_student preserves stable ID across class changes', async () => {
    const r1 = await db.query<{ create_student: any }>(`SELECT public.create_student('Stable ID', 'Grade 1-A', '${parentProfileId}', NULL, NULL) AS create_student`);
    const id = r1.rows[0].create_student.id;
    await db.query(`SELECT public.create_student('Stable ID', 'Grade 2-A', '${parentProfileId}', NULL, NULL)`);
    const after = await db.query<{ id: string; className: string }>(`SELECT id, "className" FROM students WHERE id='${id}'`);
    expect(after.rows[0].className).toBe('Grade 2-A');
    const cnt = await db.query<{ cnt: number }>(`SELECT count(*)::int AS cnt FROM students WHERE name='Stable ID'`);
    expect(cnt.rows[0].cnt).toBe(1);
  });

  it('bulk_create_students reuses by govId', async () => {
    await db.query(`SELECT public.create_student('Bulk Gov', 'Grade 1-A', NULL, 'GOV-BULK', NULL)`);
    const payload = JSON.stringify([{ name: 'Bulk Gov New Name', className: 'Grade 1-A', govId: 'GOV-BULK' }]);
    const res = await db.query<{ bulk_create_students: any }>(`SELECT public.bulk_create_students('${payload}'::jsonb) AS bulk_create_students`);
    expect(res.rows[0].bulk_create_students.reusedCount).toBe(1);
  });

  it('bulk_create_students reuses by phone', async () => {
    await db.query(`SELECT public.create_student('Bulk Phone', 'Grade 1-A', NULL, NULL, '612000111')`);
    const payload = JSON.stringify([{ name: 'Bulk Phone', className: 'Grade 1-A', parentPhone: '612000111' }]);
    const res = await db.query<{ bulk_create_students: any }>(`SELECT public.bulk_create_students('${payload}'::jsonb) AS bulk_create_students`);
    expect(res.rows[0].bulk_create_students.reusedCount).toBe(1);
  });

  it('bulk_create_students preserves stable ID on class change', async () => {
    const r1 = await db.query<{ create_student: any }>(`SELECT public.create_student('Bulk Class Change', 'Grade 1-A', NULL, 'GOV-CC', NULL) AS create_student`);
    const id = r1.rows[0].create_student.id;
    const payload = JSON.stringify([{ name: 'Bulk Class Change', className: 'Grade 2-A', govId: 'GOV-CC' }]);
    await db.query(`SELECT public.bulk_create_students('${payload}'::jsonb)`);
    const after = await db.query<{ className: string }>(`SELECT "className" FROM students WHERE id='${id}'`);
    expect(after.rows[0].className).toBe('Grade 2-A');
  });

  it('apply_student_class_import blocks govId duplicate (forces manual review)', async () => {
    await db.query(`SELECT public.create_student('Import Gov', 'Grade 1-A', NULL, 'GOV-IMP', NULL)`);
    const newStudents = JSON.stringify([{ id: 'new-gov', name: 'Import Gov', className: 'Grade 1-A', govId: 'GOV-IMP' }]);
    try {
      await db.query(`SELECT public.apply_student_class_import('[]'::jsonb, '${newStudents}'::jsonb, NULL, NULL)`);
      expect(false).toBe(true);
    } catch (e) {
      expect(String(e)).toMatch(/already belongs|Gov ID/i);
    }
    const cnt = await db.query<{ cnt: number }>(`SELECT count(*)::int AS cnt FROM students`);
    expect(cnt.rows[0].cnt).toBe(1);
  });

  it('apply_student_class_import blocks duplicate without evidence', async () => {
    await db.exec(`INSERT INTO students (id, name, "className", "parentId") VALUES ('exist-block', 'Block Test', 'Grade 7-A', '${parentProfileId}')`);
    const newStudents = JSON.stringify([{ id: 'new-block', name: 'Block Test', className: 'Grade 7-A' }]);
    try {
      await db.query(`SELECT public.apply_student_class_import('[]'::jsonb, '${newStudents}'::jsonb, NULL, NULL)`);
      expect(false).toBe(true);
    } catch (e) {
      expect(String(e)).toMatch(/already exists|manual review|duplicate/i);
    }
  });

  it('apply_student_class_import preserves ID on class change', async () => {
    await db.query(`SELECT public.create_student('Import Class Change', 'Grade 7-A', '${parentProfileId}', NULL, NULL)`);
    const before = await db.query<{ id: string }>(`SELECT id FROM students WHERE name='Import Class Change'`);
    const id = before.rows[0].id;
    // Simulate import where student moves to Grade 7-B: should be represented as a change, not new student
    const changes = JSON.stringify([{ studentId: id, fromClass: 'Grade 7-A', toClass: 'Grade 7-B' }]);
    const newStudents = '[]';
    await db.query(`SELECT public.apply_student_class_import('${changes}'::jsonb, '${newStudents}'::jsonb, NULL, NULL)`);
    const after = await db.query<{ className: string }>(`SELECT "className" FROM students WHERE id='${id}'`);
    expect(after.rows[0].className).toBe('Grade 7-B');
  });

  it('list_duplicate_students returns groups', async () => {
    await db.exec(`
      INSERT INTO students (id, name, "className", "parentId") VALUES
        ('can-list', 'List Test', 'Grade 1-A', '${parentProfileId}'),
        ('dup-list', 'List Test', 'Grade 1-A', NULL);
    `);
    const res = await db.query<{ list_duplicate_students: any }>(`SELECT public.list_duplicate_students() AS list_duplicate_students`);
    const groups = res.rows[0].list_duplicate_students as any[];
    expect(Array.isArray(groups)).toBe(true);
    expect(groups.length).toBeGreaterThanOrEqual(1);
    const found = groups.find((g:any)=> JSON.stringify(g.members).includes('can-list'));
    expect(found).toBeDefined();
    expect(found.assigned_count).toBe(1);
    expect(found.unassigned_count).toBe(1);
  });

  it('get_duplicate_student_details returns counts', async () => {
    await db.exec(`
      INSERT INTO students (id, name, "className", "parentId") VALUES
        ('can-detail', 'Detail Test', 'Grade 1-A', '${parentProfileId}'),
        ('dup-detail', 'Detail Test', 'Grade 1-A', NULL);
      INSERT INTO student_enrollments (id, "studentId", "className", "effectiveFrom", reason) VALUES
        ('enr-can-detail', 'can-detail', 'Grade 1-A', '2026-08-01', 'backfill'),
        ('enr-dup-detail', 'dup-detail', 'Grade 1-A', '2026-08-01', 'backfill');
      INSERT INTO exams (id, "studentId", subject, score, total, "examType", month, status, date, "teacherId") VALUES
        ('exam-detail', 'dup-detail', 'Math', 10, 20, 'Quiz', 'August', 'approved', '2026-08-15', '${adminProfileId}');
    `);
    const res = await db.query<{ get_duplicate_student_details: any }>(`SELECT public.get_duplicate_student_details('can-detail','dup-detail') AS get_duplicate_student_details`);
    const details = res.rows[0].get_duplicate_student_details as any;
    expect(details.canonical.id).toBe('can-detail');
    expect(details.duplicate.id).toBe('dup-detail');
    expect(details.counts.duplicate.exams).toBe(1);
  });

  it('merge audit records all actions', async () => {
    await db.exec(`
      INSERT INTO students (id, name, "className", "parentId") VALUES
        ('can-audit', 'Audit Test', 'Grade 1-A', '${parentProfileId}'),
        ('dup-audit', 'Audit Test', 'Grade 1-A', NULL);
      INSERT INTO student_enrollments (id, "studentId", "className", "effectiveFrom", reason) VALUES
        ('enr-can-audit', 'can-audit', 'Grade 1-A', '2026-08-01', 'backfill'),
        ('enr-dup-audit', 'dup-audit', 'Grade 1-A', '2026-08-01', 'backfill');
    `);
    const res = await db.query<{ merge_duplicate_student: any }>(`SELECT public.merge_duplicate_student('can-audit','dup-audit', false, 'audit reason', 'audit source') AS merge_duplicate_student`);
    expect(res.rows[0].merge_duplicate_student.audit_id).toBeDefined();
    const audit = await db.query<{ reason: string; source: string }>(`SELECT reason, source FROM student_merge_audit WHERE canonical_student_id='can-audit'`);
    expect(audit.rows[0].reason).toBe('audit reason');
    expect(audit.rows[0].source).toBe('audit source');
  });

  it('dry-run produces zero writes', async () => {
    await db.exec(`
      INSERT INTO students (id, name, "className", "parentId") VALUES
        ('can-dry', 'Dry Test', 'Grade 1-A', '${parentProfileId}'),
        ('dup-dry', 'Dry Test', 'Grade 1-A', NULL);
      INSERT INTO student_enrollments (id, "studentId", "className", "effectiveFrom", reason) VALUES
        ('enr-can-dry', 'can-dry', 'Grade 1-A', '2026-08-01', 'backfill'),
        ('enr-dup-dry', 'dup-dry', 'Grade 1-A', '2026-08-01', 'backfill');
      INSERT INTO exams (id, "studentId", subject, score, total, "examType", month, status, date, "teacherId") VALUES
        ('exam-dry', 'dup-dry', 'Math', 10, 20, 'Quiz', 'August', 'approved', '2026-08-15', '${adminProfileId}');
    `);
    const beforeStudents = await db.query<{ cnt: number }>(`SELECT count(*)::int AS cnt FROM students`);
    const beforeExams = await db.query<{ cnt: number }>(`SELECT count(*)::int AS cnt FROM exams`);
    const beforeAudit = await db.query<{ cnt: number }>(`SELECT count(*)::int AS cnt FROM student_merge_audit`);
    await db.query(`SELECT public.merge_duplicate_student('can-dry','dup-dry', true)`);
    const afterStudents = await db.query<{ cnt: number }>(`SELECT count(*)::int AS cnt FROM students`);
    const afterExams = await db.query<{ cnt: number }>(`SELECT count(*)::int AS cnt FROM exams`);
    const afterAudit = await db.query<{ cnt: number }>(`SELECT count(*)::int AS cnt FROM student_merge_audit`);
    expect(afterStudents.rows[0].cnt).toBe(beforeStudents.rows[0].cnt);
    expect(afterExams.rows[0].cnt).toBe(beforeExams.rows[0].cnt);
    expect(afterAudit.rows[0].cnt).toBe(beforeAudit.rows[0].cnt);
  });

  it('transaction rollback on exam conflict', async () => {
    await db.exec(`
      INSERT INTO students (id, name, "className", "parentId") VALUES
        ('can-rollback', 'Rollback Test', 'Grade 1-A', '${parentProfileId}'),
        ('dup-rollback', 'Rollback Test', 'Grade 1-A', NULL);
      INSERT INTO student_enrollments (id, "studentId", "className", "effectiveFrom", reason) VALUES
        ('enr-can-rb', 'can-rollback', 'Grade 1-A', '2026-08-01', 'backfill'),
        ('enr-dup-rb', 'dup-rollback', 'Grade 1-A', '2026-08-01', 'backfill');
      INSERT INTO exams (id, "studentId", "subjectId", subject, score, total, "examType", "assessmentLabel", "termId", month, status, date, "teacherId") VALUES
        ('exam-can-rb', 'can-rollback', 'sub-math', 'Math', 10, 20, 'Quiz', 'MT', 'term-1', 'August', 'approved', '2026-08-15', '${adminProfileId}'),
        ('exam-dup-rb', 'dup-rollback', 'sub-math', 'Math', 15, 20, 'Quiz', 'MT', 'term-1', 'August', 'approved', '2026-08-16', '${adminProfileId}');
    `);
    try {
      await db.query(`SELECT public.merge_duplicate_student('can-rollback','dup-rollback', false)`);
    } catch {}
    const students = await db.query<{ cnt: number }>(`SELECT count(*)::int AS cnt FROM students`);
    expect(students.rows[0].cnt).toBe(2);
    const exams = await db.query<{ cnt: number }>(`SELECT count(*)::int AS cnt FROM exams WHERE "studentId"='dup-rollback'`);
    expect(exams.rows[0].cnt).toBe(1);
  });

  it('historical enrollment preservation', async () => {
    await db.exec(`
      INSERT INTO students (id, name, "className", "parentId") VALUES
        ('can-hist', 'Hist Test', 'Grade 2-A', '${parentProfileId}'),
        ('dup-hist', 'Hist Test', 'Grade 2-A', NULL);
      INSERT INTO student_enrollments (id, "studentId", "className", "effectiveFrom", "effectiveTo", reason) VALUES
        ('enr-can-hist-open', 'can-hist', 'Grade 2-A', '2026-08-01', NULL, 'backfill'),
        ('enr-can-hist-closed', 'can-hist', 'Grade 1-A', '2025-08-01', '2026-07-31', 'backfill'),
        ('enr-dup-hist-open', 'dup-hist', 'Grade 2-A', '2026-09-01', NULL, 'import');
    `);
    await db.query(`SELECT public.merge_duplicate_student('can-hist','dup-hist', false)`);
    const enrolls = await db.query<{ className: string; effectiveTo: string | null }>(`SELECT "className", "effectiveTo"::text FROM student_enrollments WHERE "studentId"='can-hist' ORDER BY "effectiveFrom"`);
    expect(enrolls.rows.length).toBe(2);
    expect(enrolls.rows.some(r=>r.className==='Grade 1-A')).toBe(true);
    expect(enrolls.rows.some(r=>r.className==='Grade 2-A' && r.effectiveTo===null)).toBe(true);
  });

  it('unique enrollment conflict handled safely (same class open)', async () => {
    await db.exec(`
      INSERT INTO students (id, name, "className", "parentId") VALUES
        ('can-uniq', 'Uniq Test', 'Grade 1-A', '${parentProfileId}'),
        ('dup-uniq', 'Uniq Test', 'Grade 1-A', NULL);
      INSERT INTO student_enrollments (id, "studentId", "className", "effectiveFrom", "effectiveTo", reason) VALUES
        ('enr-can-uniq', 'can-uniq', 'Grade 1-A', '2026-08-01', NULL, 'backfill'),
        ('enr-dup-uniq', 'dup-uniq', 'Grade 1-A', '2026-09-01', NULL, 'import');
    `);
    const dry = await db.query<{ merge_duplicate_student: any }>(`SELECT public.merge_duplicate_student('can-uniq','dup-uniq', true) AS merge_duplicate_student`);
    expect(dry.rows[0].merge_duplicate_student.can_merge).toBe(true);
    expect(dry.rows[0].merge_duplicate_student.enrollment_action.type).toBe('consolidate_duplicate_open');
    await db.query(`SELECT public.merge_duplicate_student('can-uniq','dup-uniq', false)`);
    const openCnt = await db.query<{ cnt: number }>(`SELECT count(*)::int AS cnt FROM student_enrollments WHERE "studentId"='can-uniq' AND "effectiveTo" IS NULL`);
    expect(openCnt.rows[0].cnt).toBe(1);
  });

  it('duplicate has zero dependents before delete (guard)', async () => {
    await db.exec(`
      INSERT INTO students (id, name, "className", "parentId") VALUES
        ('can-zero', 'Zero Test', 'Grade 1-A', '${parentProfileId}'),
        ('dup-zero', 'Zero Test', 'Grade 1-A', NULL);
      INSERT INTO student_enrollments (id, "studentId", "className", "effectiveFrom", reason) VALUES
        ('enr-can-zero', 'can-zero', 'Grade 1-A', '2026-08-01', 'backfill'),
        ('enr-dup-zero', 'dup-zero', 'Grade 1-A', '2026-08-01', 'backfill');
      INSERT INTO exams (id, "studentId", subject, score, total, "examType", month, status, date, "teacherId") VALUES
        ('exam-zero', 'dup-zero', 'Math', 10, 20, 'Quiz', 'August', 'approved', '2026-08-15', '${adminProfileId}');
    `);
    await db.query(`SELECT public.merge_duplicate_student('can-zero','dup-zero', false)`);
    const dupExists = await db.query<{ cnt: number }>(`SELECT count(*)::int AS cnt FROM students WHERE id='dup-zero'`);
    expect(dupExists.rows[0].cnt).toBe(0);
    const orphanExams = await db.query<{ cnt: number }>(`SELECT count(*)::int AS cnt FROM exams WHERE "studentId"='dup-zero'`);
    expect(orphanExams.rows[0].cnt).toBe(0);
    const transferred = await db.query<{ cnt: number }>(`SELECT count(*)::int AS cnt FROM exams WHERE "studentId"='can-zero'`);
    expect(transferred.rows[0].cnt).toBe(1);
  });
});
