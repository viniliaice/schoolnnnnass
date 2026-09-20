import { describe, it, expect, beforeEach } from 'vitest';
import { createDuplicateMergeTestDb, pgliteAvailable } from './duplicateMergeHarness';

const AVAILABLE = await pgliteAvailable();
const withDb = AVAILABLE ? describe : describe.skip;

withDb('student duplicate merge — real Postgres via PGlite', () => {
  let db: Awaited<ReturnType<typeof createDuplicateMergeTestDb>>;
  const adminAuthId = '00000000-0000-0000-0000-000000000001';
  const adminProfileId = 'admin-1';
  const parentAuthId = '00000000-0000-0000-0000-000000000002';
  const parentProfileId = 'parent-ayi';

  beforeEach(async () => {
    db = await createDuplicateMergeTestDb();
    // Seed auth users and profiles
    await db.exec(`
      INSERT INTO auth.users (id) VALUES ('${adminAuthId}'), ('${parentAuthId}');
      INSERT INTO profiles (id, name, email, role, auth_id) VALUES
        ('${adminProfileId}', 'Admin', 'admin@test.com', 'admin', '${adminAuthId}'),
        ('${parentProfileId}', 'Ayi', 'ayi@test.com', 'parent', '${parentAuthId}');
      INSERT INTO academic_years (id, name, "isCurrent") VALUES ('ay-1783098450413-snzz9n', '2026/2027', true);
      INSERT INTO terms (id, name, "academicYearId", "startDate", "endDate", "isCurrent", months) VALUES ('term-1', 'Term 1', 'ay-1783098450413-snzz9n', '2026-08-01', '2026-12-31', true, ARRAY['August','September']);
      INSERT INTO subjects (id, name) VALUES ('sub-math', 'Mathematics'), ('sub-eng', 'English');
      INSERT INTO class_subjects (id, "className", "subjectId", "teacherId") VALUES ('cs-1', 'Grade 1-B', 'sub-math', '${adminProfileId}');
    `);
    await db.setAuthUid(adminAuthId);
  });

  it('merge with no history — Axmed dry-run then actual', async () => {
    // Setup Axmed case from task
    await db.exec(`
      INSERT INTO students (id, name, "className", "parentId") VALUES
        ('student-1774882609050-bqws0b', 'Axmed yaasiin ismaaciil', 'Grade 1-B', '${parentProfileId}'),
        ('student-1788799266378-r64ffp', 'Axmed yaasiin ismaaciil', 'Grade 1-B', NULL);
      INSERT INTO student_enrollments (id, "studentId", "className", "academicYearId", "effectiveFrom", "effectiveTo", reason) VALUES
        ('enr-canonical-open', 'student-1774882609050-bqws0b', 'Grade 1-B', 'ay-1783098450413-snzz9n', '2026-08-01', NULL, 'backfill'),
        ('enr-canonical-closed', 'student-1774882609050-bqws0b', 'Grade 1-B', 'ay-1783098450413-snzz9n', '2025-08-01', '2026-07-31', 'backfill'),
        ('enr-duplicate-open', 'student-1788799266378-r64ffp', 'Grade 1-B', 'ay-1783098450413-snzz9n', '2026-09-07', NULL, 'import');
      INSERT INTO student_promotions (id, "studentId", "fromClass", "toClass", "academicYearId") VALUES
        ('promo-1', 'student-1774882609050-bqws0b', 'KG-C', 'Grade 1-B', 'ay-1783098450413-snzz9n');
    `);

    // Dry run
    const dry = await db.query<{ merge_duplicate_student: any }>(
      `SELECT public.merge_duplicate_student('student-1774882609050-bqws0b','student-1788799266378-r64ffp', true) AS merge_duplicate_student`
    );
    const result = dry.rows[0].merge_duplicate_student as any;
    expect(result.can_merge).toBe(true);
    expect(result.student_name).toBe('Axmed yaasiin ismaaciil');
    expect(result.enrollment_action.type).toBe('consolidate_duplicate_open');
    expect(result.before_counts.enrollments.canonical).toBe(2);
    expect(result.before_counts.enrollments.duplicate).toBe(1);

    // Verify zero writes after dry-run
    const afterDry = await db.query<{ cnt: number }>(`SELECT count(*)::int AS cnt FROM students`);
    expect(afterDry.rows[0].cnt).toBe(2);

    // Actual merge
    const actual = await db.query<{ merge_duplicate_student: any }>(
      `SELECT public.merge_duplicate_student('student-1774882609050-bqws0b','student-1788799266378-r64ffp', false, 'test axmed', 'test') AS merge_duplicate_student`
    );
    const merged = actual.rows[0].merge_duplicate_student as any;
    expect(merged.can_merge).toBe(true);
    expect(merged.audit_id).toBeDefined();

    // Verify canonical survives, duplicate removed, only one open enrollment remains
    const students = await db.query<{ id: string }>(`SELECT id FROM students ORDER BY id`);
    expect(students.rows.map(r=>r.id)).toEqual(['student-1774882609050-bqws0b']);
    const enrolls = await db.query<{ id: string; effectiveTo: string | null }>(`SELECT id, "effectiveTo"::text FROM student_enrollments WHERE "studentId"='student-1774882609050-bqws0b' ORDER BY id`);
    // Should have 2 enrollments: canonical open + canonical closed (duplicate open consolidated away)
    expect(enrolls.rows.length).toBe(2);
    const openCount = await db.query<{ cnt: number }>(`SELECT count(*)::int AS cnt FROM student_enrollments WHERE "studentId"='student-1774882609050-bqws0b' AND "effectiveTo" IS NULL`);
    expect(openCount.rows[0].cnt).toBe(1);

    // Audit exists
    const audit = await db.query<{ id: string }>(`SELECT id FROM student_merge_audit WHERE canonical_student_id='student-1774882609050-bqws0b'`);
    expect(audit.rows.length).toBe(1);
  });

  it('Abshir case: 1 + 55 = 56 exams preserved', async () => {
    await db.exec(`
      INSERT INTO students (id, name, "className", "parentId") VALUES
        ('student-1774350713663-0puj2e', 'Abshir Cabdi Maxamed', 'Grade 2-A', '${parentProfileId}'),
        ('student-1788799266371-5mxvk1', 'Abshir Cabdi Maxamed', 'Grade 2-A', NULL);
      INSERT INTO student_enrollments (id, "studentId", "className", "academicYearId", "effectiveFrom", "effectiveTo", reason) VALUES
        ('enr-abshir-canonical', 'student-1774350713663-0puj2e', 'Grade 2-A', 'ay-1783098450413-snzz9n', '2026-08-01', NULL, 'backfill'),
        ('enr-abshir-duplicate', 'student-1788799266371-5mxvk1', 'Grade 2-A', 'ay-1783098450413-snzz9n', '2026-09-07', NULL, 'import');
    `);

    // Create 1 canonical exam and 55 duplicate distinct exams
    const canonicalExam = `INSERT INTO exams (id, "studentId", "subjectId", subject, score, total, "examType", "assessmentLabel", "termId", month, status, date, "teacherId") VALUES ('exam-canonical-1', 'student-1774350713663-0puj2e', 'sub-math', 'Mathematics', 15, 20, 'Quiz', 'MT', 'term-1', 'August', 'approved', '2026-08-15', '${adminProfileId}');`;
    await db.exec(canonicalExam);

    // 55 distinct exams: vary subjectId, assessmentLabel, termId, etc. Use different subjects and labels
    let examInserts = '';
    for (let i=0;i<55;i++) {
      const subj = i % 2 === 0 ? 'sub-math' : 'sub-eng';
      const label = `HW${(i % 4)+1}`;
      const term = i < 27 ? 'term-1' : 'term-1'; // same term but different label/subject combos should be distinct
      // To make distinct under identity key (studentId, subjectId, examType, assessmentLabel, termId), we need varying subjectId or assessmentLabel
      // We'll use combination of subjectId + assessmentLabel + examType that is unique
      const examType = i % 3 === 0 ? 'Homework' : i % 3 === 1 ? 'Classwork' : 'Quiz';
      const assessment = examType === 'Homework' ? `HW${(i%4)+1}` : examType === 'Classwork' ? `CPW${(i%4)+1}` : `MT${i}`;
      // For simplicity, make each exam identity unique by using different assessmentLabel values that still satisfy CHECK? Use valid labels for Homework/Classwork, but for Quiz we can use NULL? However unique index requires subjectId, termId, assessmentLabel all NOT NULL, so we must provide valid assessmentLabel for Quiz? Actually Quiz MT is valid. We'll use distinct termIds by creating extra terms? Simpler: create exams with different subjectId + assessmentLabel combos that are valid per CHECK.
      // We'll generate valid combos: Homework HW1-4 total 5, Classwork CPW1-4 total 15, Quiz MT total 20, etc.
      // To keep 55 distinct, we'll vary subjectId and assessmentLabel and use different months/dates but same identity key must be unique.
      // Let's create many exams with same subjectId but different assessmentLabel and examType - that will be distinct.
      // We'll just create 55 rows with unique id and varying assessmentLabel that still passes CHECK by using appropriate examType/total.
      // For this test harness, we bypass CHECK by using total that matches assessmentLabel rules? Our base schema has no CHECK for assessmentLabel vs examType/total, so we can use any.
      examInserts += `INSERT INTO exams (id, "studentId", "subjectId", subject, score, total, "examType", "assessmentLabel", "termId", month, status, date, "teacherId") VALUES ('exam-dup-${i}', 'student-1788799266371-5mxvk1', '${subj}', '${subj}', ${10+i%10}, 20, '${examType}', '${assessment}-${i}', 'term-1', 'August', 'approved', '2026-08-${String(1+(i%28)).padStart(2,'0')}', '${adminProfileId}');\n`;
    }
    await db.exec(examInserts);

    const beforeCanonical = await db.query<{ cnt: number }>(`SELECT count(*)::int AS cnt FROM exams WHERE "studentId"='student-1774350713663-0puj2e'`);
    const beforeDup = await db.query<{ cnt: number }>(`SELECT count(*)::int AS cnt FROM exams WHERE "studentId"='student-1788799266371-5mxvk1'`);
    expect(beforeCanonical.rows[0].cnt).toBe(1);
    expect(beforeDup.rows[0].cnt).toBe(55);

    const dry = await db.query<{ merge_duplicate_student: any }>(`SELECT public.merge_duplicate_student('student-1774350713663-0puj2e','student-1788799266371-5mxvk1', true) AS merge_duplicate_student`);
    const dryRes = dry.rows[0].merge_duplicate_student as any;
    expect(dryRes.can_merge).toBe(true);
    expect(dryRes.before_counts.exams.canonical).toBe(1);
    expect(dryRes.before_counts.exams.duplicate).toBe(55);

    const actual = await db.query<{ merge_duplicate_student: any }>(`SELECT public.merge_duplicate_student('student-1774350713663-0puj2e','student-1788799266371-5mxvk1', false) AS merge_duplicate_student`);
    const merged = actual.rows[0].merge_duplicate_student as any;
    expect(merged.can_merge).toBe(true);

    const afterCanonical = await db.query<{ cnt: number }>(`SELECT count(*)::int AS cnt FROM exams WHERE "studentId"='student-1774350713663-0puj2e'`);
    expect(afterCanonical.rows[0].cnt).toBe(56);

    const afterDup = await db.query<{ cnt: number }>(`SELECT count(*)::int AS cnt FROM exams WHERE "studentId"='student-1788799266371-5mxvk1'`);
    expect(afterDup.rows[0].cnt).toBe(0);

    // Verify IDs preserved
    const examIds = await db.query<{ id: string }>(`SELECT id FROM exams WHERE "studentId"='student-1774350713663-0puj2e' ORDER BY id`);
    expect(examIds.rows.some(r=>r.id==='exam-canonical-1')).toBe(true);
    expect(examIds.rows.some(r=>r.id==='exam-dup-0')).toBe(true);
  });

  it('exam conflict blocks merge', async () => {
    await db.exec(`
      INSERT INTO students (id, name, "className", "parentId") VALUES
        ('canonical-conflict', 'Test Student', 'Grade 1-A', '${parentProfileId}'),
        ('duplicate-conflict', 'Test Student', 'Grade 1-A', NULL);
      INSERT INTO student_enrollments (id, "studentId", "className", "effectiveFrom", reason) VALUES
        ('enr-can-conf', 'canonical-conflict', 'Grade 1-A', '2026-08-01', 'backfill'),
        ('enr-dup-conf', 'duplicate-conflict', 'Grade 1-A', '2026-08-01', 'backfill');
      INSERT INTO exams (id, "studentId", "subjectId", subject, score, total, "examType", "assessmentLabel", "termId", month, status, date, "teacherId") VALUES
        ('exam-can-conf', 'canonical-conflict', 'sub-math', 'Mathematics', 10, 20, 'Quiz', 'MT', 'term-1', 'August', 'approved', '2026-08-15', '${adminProfileId}'),
        ('exam-dup-conf', 'duplicate-conflict', 'sub-math', 'Mathematics', 15, 20, 'Quiz', 'MT', 'term-1', 'August', 'approved', '2026-08-16', '${adminProfileId}');
    `);
    const dry = await db.query<{ merge_duplicate_student: any }>(`SELECT public.merge_duplicate_student('canonical-conflict','duplicate-conflict', true) AS merge_duplicate_student`);
    const res = dry.rows[0].merge_duplicate_student as any;
    expect(res.can_merge).toBe(false);
    expect(res.conflicts.some((c:any)=>c.type==='EXAM_CONFLICT')).toBe(true);

    // Actual merge should raise
    try {
      await db.query(`SELECT public.merge_duplicate_student('canonical-conflict','duplicate-conflict', false)`);
      expect(false).toBe(true); // should not reach
    } catch (e) {
      expect(String(e)).toMatch(/blocked|conflict/i);
    }

    // Verify no writes happened
    const cnt = await db.query<{ cnt: number }>(`SELECT count(*)::int AS cnt FROM students`);
    expect(cnt.rows[0].cnt).toBe(2);
  });

  it('enrollment conflict blocks merge when different class', async () => {
    await db.exec(`
      INSERT INTO students (id, name, "className", "parentId") VALUES
        ('can-enr-conf', 'Enroll Test', 'Grade 1-A', '${parentProfileId}'),
        ('dup-enr-conf', 'Enroll Test', 'Grade 1-A', NULL);
      INSERT INTO student_enrollments (id, "studentId", "className", "academicYearId", "effectiveFrom", "effectiveTo", reason) VALUES
        ('enr-can-diff', 'can-enr-conf', 'Grade 1-A', 'ay-1783098450413-snzz9n', '2026-08-01', NULL, 'backfill'),
        ('enr-dup-diff', 'dup-enr-conf', 'Grade 2-A', 'ay-1783098450413-snzz9n', '2026-08-01', NULL, 'backfill');
    `);
    const dry = await db.query<{ merge_duplicate_student: any }>(`SELECT public.merge_duplicate_student('can-enr-conf','dup-enr-conf', true) AS merge_duplicate_student`);
    const res = dry.rows[0].merge_duplicate_student as any;
    expect(res.can_merge).toBe(false);
    expect(res.conflicts.some((c:any)=>c.type==='enrollment_conflict')).toBe(true);
  });

  it('attendance, homework, promotions, quiz, pickups, release, report transfer', async () => {
    await db.exec(`
      INSERT INTO students (id, name, "className", "parentId") VALUES
        ('can-full', 'Full Transfer', 'Grade 3-B', '${parentProfileId}'),
        ('dup-full', 'Full Transfer', 'Grade 3-B', NULL);
      INSERT INTO student_enrollments (id, "studentId", "className", "effectiveFrom", reason) VALUES
        ('enr-can-full', 'can-full', 'Grade 3-B', '2026-08-01', 'backfill'),
        ('enr-dup-full', 'dup-full', 'Grade 3-B', '2026-08-01', 'backfill');
      INSERT INTO attendance (id, "studentId", "className", date, status, "teacherId") VALUES
        ('att-dup-1', 'dup-full', 'Grade 3-B', '2026-09-01', 'present', '${adminProfileId}');
      INSERT INTO homework (id, "studentId", "className", subject, title, "dueDate", "teacherId") VALUES
        ('hw-dup-1', 'dup-full', 'Grade 3-B', 'Math', 'Test HW', '2026-09-10', '${adminProfileId}');
      INSERT INTO student_promotions (id, "studentId", "fromClass", "toClass") VALUES
        ('promo-dup-1', 'dup-full', 'Grade 2-B', 'Grade 3-B');
      INSERT INTO quizzes (id, "className", subject, title, "teacherId") VALUES ('quiz-1', 'Grade 3-B', 'Math', 'Quiz 1', '${adminProfileId}');
      INSERT INTO quiz_attempts (id, "quizId", "studentId") VALUES ('qa-dup-1', 'quiz-1', 'dup-full');
      INSERT INTO authorized_pickups (id, name, "phoneNumber", "addedByStaffId") VALUES ('pickup-1', 'Driver', '612345678', '${adminProfileId}');
      INSERT INTO authorized_pickup_students ("authorizedPickupId", "studentId") VALUES ('pickup-1', 'dup-full');
      INSERT INTO release_log ("studentId", "familyId", "staffId") VALUES ('dup-full', '0001', '${adminProfileId}');
      INSERT INTO report_comments (id, "studentId", "termId", "teacherComment") VALUES ('rc-dup-1', 'dup-full', 'term-1', 'Good');
    `);

    const res = await db.query<{ merge_duplicate_student: any }>(`SELECT public.merge_duplicate_student('can-full','dup-full', false) AS merge_duplicate_student`);
    expect(res.rows[0].merge_duplicate_student.can_merge).toBe(true);

    const checks = await Promise.all([
      db.query<{ cnt: number }>(`SELECT count(*)::int AS cnt FROM attendance WHERE "studentId"='can-full'`),
      db.query<{ cnt: number }>(`SELECT count(*)::int AS cnt FROM homework WHERE "studentId"='can-full'`),
      db.query<{ cnt: number }>(`SELECT count(*)::int AS cnt FROM student_promotions WHERE "studentId"='can-full'`),
      db.query<{ cnt: number }>(`SELECT count(*)::int AS cnt FROM quiz_attempts WHERE "studentId"='can-full'`),
      db.query<{ cnt: number }>(`SELECT count(*)::int AS cnt FROM authorized_pickup_students WHERE "studentId"='can-full'`),
      db.query<{ cnt: number }>(`SELECT count(*)::int AS cnt FROM release_log WHERE "studentId"='can-full'`),
      db.query<{ cnt: number }>(`SELECT count(*)::int AS cnt FROM report_comments WHERE "studentId"='can-full'`),
    ]);
    expect(checks[0].rows[0].cnt).toBe(1);
    expect(checks[1].rows[0].cnt).toBe(1);
    expect(checks[2].rows[0].cnt).toBe(1);
    expect(checks[3].rows[0].cnt).toBe(1);
    expect(checks[4].rows[0].cnt).toBe(1);
    expect(checks[5].rows[0].cnt).toBe(1);
    expect(checks[6].rows[0].cnt).toBe(1);
  });

  it('zero-dependency delete guard', async () => {
    await db.exec(`
      INSERT INTO students (id, name, "className", "parentId") VALUES
        ('can-guard', 'Guard Test', 'Grade 1-A', '${parentProfileId}'),
        ('dup-guard', 'Guard Test', 'Grade 1-A', NULL);
      INSERT INTO student_enrollments (id, "studentId", "className", "effectiveFrom", reason) VALUES
        ('enr-can-guard', 'can-guard', 'Grade 1-A', '2026-08-01', 'backfill'),
        ('enr-dup-guard', 'dup-guard', 'Grade 1-A', '2026-08-01', 'backfill');
      INSERT INTO exams (id, "studentId", "subjectId", subject, score, total, "examType", "assessmentLabel", "termId", month, status, date, "teacherId") VALUES
        ('exam-guard', 'dup-guard', 'sub-math', 'Math', 10, 20, 'Homework', 'HW1', 'term-1', 'August', 'approved', '2026-08-15', '${adminProfileId}');
    `);
    // First dry-run should be mergeable (exam not conflicting)
    const dry = await db.query<{ merge_duplicate_student: any }>(`SELECT public.merge_duplicate_student('can-guard','dup-guard', true) AS merge_duplicate_student`);
    expect(dry.rows[0].merge_duplicate_student.can_merge).toBe(true);

    // Actual merge should transfer exam and delete duplicate
    await db.query(`SELECT public.merge_duplicate_student('can-guard','dup-guard', false)`);

    const dupExists = await db.query<{ cnt: number }>(`SELECT count(*)::int AS cnt FROM students WHERE id='dup-guard'`);
    expect(dupExists.rows[0].cnt).toBe(0);

    const examTransferred = await db.query<{ cnt: number }>(`SELECT count(*)::int AS cnt FROM exams WHERE "studentId"='can-guard'`);
    expect(examTransferred.rows[0].cnt).toBe(1);
  });

  it('prevents creation of duplicate via create_student (Axmed regression)', async () => {
    // First create Axmed with parent
    await db.query(`SELECT public.create_student('Axmed yaasiin ismaaciil', 'Grade 1-B', '${parentProfileId}', NULL, NULL)`);
    const first = await db.query<{ id: string }>(`SELECT id FROM students WHERE name='Axmed yaasiin ismaaciil'`);
    expect(first.rows.length).toBe(1);
    const firstId = first.rows[0].id;

    // Try to create same student without parent — should reuse, not create duplicate
    const second = await db.query<{ create_student: any }>(`SELECT public.create_student('Axmed yaasiin ismaaciil', 'Grade 1-B', NULL, NULL, NULL) AS create_student`);
    const secondRes = second.rows[0].create_student as any;
    expect(secondRes.reused).toBe(true);
    expect(secondRes.id).toBe(firstId);

    const count = await db.query<{ cnt: number }>(`SELECT count(*)::int AS cnt FROM students WHERE public.name_match_key(name) = public.name_match_key('Axmed yaasiin ismaaciil')`);
    expect(count.rows[0].cnt).toBe(1);
  });

  it('class change preserves stable ID via create_student', async () => {
    await db.query(`SELECT public.create_student('Test Class Change', 'Grade 7-A', '${parentProfileId}', NULL, NULL)`);
    const before = await db.query<{ id: string; className: string }>(`SELECT id, "className" FROM students WHERE name='Test Class Change'`);
    const id = before.rows[0].id;
    expect(before.rows[0].className).toBe('Grade 7-A');

    // Create same student with different class — should reuse same ID and update class
    await db.query(`SELECT public.create_student('Test Class Change', 'Grade 7-B', '${parentProfileId}', NULL, NULL)`);
    const after = await db.query<{ id: string; className: string }>(`SELECT id, "className" FROM students WHERE id='${id}'`);
    expect(after.rows[0].id).toBe(id);
    expect(after.rows[0].className).toBe('Grade 7-B');
  });

  it('bulk_create_students reuses existing', async () => {
    await db.query(`SELECT public.create_student('Bulk Test', 'Grade 1-A', NULL, 'GOV-123', NULL)`);
    const payload = JSON.stringify([{ name: 'Bulk Test', className: 'Grade 1-A', govId: 'GOV-123' }]);
    const res = await db.query<{ bulk_create_students: any }>(`SELECT public.bulk_create_students('${payload}'::jsonb) AS bulk_create_students`);
    const r = res.rows[0].bulk_create_students as any;
    expect(r.reusedCount).toBe(1);
    expect(r.createdCount).toBe(0);
    const cnt = await db.query<{ cnt: number }>(`SELECT count(*)::int AS cnt FROM students`);
    expect(cnt.rows[0].cnt).toBe(1);
  });

  it('apply_student_class_import blocks duplicate unassigned creation', async () => {
    await db.exec(`INSERT INTO students (id, name, "className", "parentId") VALUES ('existing-1', 'Existing Student', 'Grade 7-A', '${parentProfileId}')`);
    // Try to import same name as new student without govId/phone — should fail
    const newStudents = JSON.stringify([{ id: 'new-1', name: 'Existing Student', className: 'Grade 7-A' }]);
    try {
      await db.query(`SELECT public.apply_student_class_import('[]'::jsonb, '${newStudents}'::jsonb, NULL, NULL)`);
      expect(false).toBe(true);
    } catch (e) {
      expect(String(e)).toMatch(/already exists|manual review|duplicate/i);
    }
    const cnt = await db.query<{ cnt: number }>(`SELECT count(*)::int AS cnt FROM students`);
    expect(cnt.rows[0].cnt).toBe(1);
  });

  it('two parent-assigned records are not auto-merged', async () => {
    await db.exec(`
      INSERT INTO students (id, name, "className", "parentId") VALUES
        ('can-two-parent', 'Same Name', 'Grade 1-A', '${parentProfileId}'),
        ('dup-two-parent', 'Same Name', 'Grade 1-A', '${adminProfileId}');
      INSERT INTO student_enrollments (id, "studentId", "className", "effectiveFrom", reason) VALUES
        ('enr-can-two', 'can-two-parent', 'Grade 1-A', '2026-08-01', 'backfill'),
        ('enr-dup-two', 'dup-two-parent', 'Grade 1-A', '2026-08-01', 'backfill');
    `);
    const res = await db.query<{ merge_duplicate_student: any }>(`SELECT public.merge_duplicate_student('can-two-parent','dup-two-parent', true) AS merge_duplicate_student`);
    expect(res.rows[0].merge_duplicate_student.can_merge).toBe(false);
    expect(res.rows[0].merge_duplicate_student.conflicts.some((c:any)=>c.type==='duplicate_has_parent')).toBe(true);
  });

  it('two unassigned records are not auto-merged', async () => {
    await db.exec(`
      INSERT INTO students (id, name, "className", "parentId") VALUES
        ('can-unassigned', 'Same Name', 'Grade 1-A', NULL),
        ('dup-unassigned', 'Same Name', 'Grade 1-A', NULL);
    `);
    const res = await db.query<{ merge_duplicate_student: any }>(`SELECT public.merge_duplicate_student('can-unassigned','dup-unassigned', true) AS merge_duplicate_student`);
    expect(res.rows[0].merge_duplicate_student.can_merge).toBe(false);
  });
});
