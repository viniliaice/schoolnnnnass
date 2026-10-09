import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  createBulkGradesTestDb,
  extractStatementContaining,
  pgliteAvailable,
  readMigration,
  type PgTestDb,
} from '../bulk-grades/__tests__/pgHarness';

const AVAILABLE = await pgliteAvailable();
const d = AVAILABLE ? describe : describe.skip;

const AUTH_ADMIN = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const AUTH_SUPERVISOR = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
const AUTH_UNASSIGNED_TEACHER = 'cccccccc-cccc-cccc-cccc-cccccccccccc';

async function installMonitorSchema(db: PgTestDb) {
  await db.exec(`
    ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS "assignedClasses" JSONB NOT NULL DEFAULT '[]'::jsonb;
    ALTER TABLE public.students ADD COLUMN IF NOT EXISTS transport TEXT;
    CREATE TABLE IF NOT EXISTS public.student_enrollments (
      id TEXT PRIMARY KEY,
      "studentId" TEXT NOT NULL REFERENCES public.students(id) ON DELETE CASCADE,
      "className" TEXT NOT NULL,
      "academicYearId" TEXT REFERENCES public.academic_years(id) ON DELETE SET NULL,
      "termId" TEXT REFERENCES public.terms(id) ON DELETE SET NULL,
      "effectiveFrom" DATE NOT NULL,
      "effectiveTo" DATE,
      reason TEXT NOT NULL DEFAULT 'backfill',
      "sourceRef" TEXT,
      "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);
  const history = readMigration('20260906b_student_enrollments_history.sql');
  await db.exec(extractStatementContaining(history, 'FUNCTION public.class_students_for_term', '$$;'));
  // Applied in production order: base monitor, Quiz fix, Homework (CA) tile,
  // then the current-student roster update for Former Students.
  await db.exec(readMigration('20260919_marks_entry_tracking.sql'));
  await db.exec(readMigration('20260919b_marks_monitor_quiz_component.sql'));
  await db.exec(readMigration('20260919c_marks_monitor_homework_ca_tile.sql'));
  // The monitor migration must remain deployable even if the Former Students
  // status-column migration has not run yet; status is added afterwards here.
  await db.exec(readMigration('20261010_monitor_excludes_former_students.sql'));
  await db.exec(`ALTER TABLE public.students ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'active';`);
}

/**
 * Seeds the reported scenario: a 42-student class whose August marks came from
 * the class-specific bulk upload for `enteredCount` students. Bulk upload
 * stores Homework as HW1, Classwork as CPW1, Attendance as ATTENDANCE and the
 * monthly test (the Quiz component) as examType 'Quiz' + assessmentLabel 'MT'.
 */
async function seedBulkUploadedMonth(db: PgTestDb, options: { classSize: number; enteredCount: number }) {
  const students = Array.from({ length: options.classSize }, (_, index) => {
    const n = index + 1;
    return `('g2c-${n}','Grade Two Student ${String(n).padStart(2, '0')}','Grade 2-C',NULL)`;
  }).join(',');
  const enrollments = Array.from({ length: options.classSize }, (_, index) => {
    const n = index + 1;
    return `('enr-g2c-${n}','g2c-${n}','Grade 2-C','ay-1','term-1','2026-08-01','backfill')`;
  }).join(',');
  const exams = Array.from({ length: options.enteredCount }, (_, index) => {
    const s = `g2c-${index + 1}`;
    const row = (id: string, examType: string, label: string, total: number, score: number) =>
      `('${id}-${s}','${s}','english','English','${examType}','${label}','term-1','August','pending','scored','2026-08-20','2026-08-20T10:00:00Z','teacher-1',${total},${score})`;
    return [
      row('hw', 'Homework', 'HW1', 5, 4),
      row('cw', 'Classwork', 'CPW1', 15, 12),
      row('att', 'Attendance', 'ATTENDANCE', 20, 18),
      row('mt', 'Quiz', 'MT', 20, 15),
    ].join(',');
  }).join(',');
  await db.exec(`
    INSERT INTO public.students(id,name,"className",transport) VALUES ${students};
    INSERT INTO public.student_enrollments(id,"studentId","className","academicYearId","termId","effectiveFrom",reason) VALUES ${enrollments};
    INSERT INTO public.class_subjects(id,"className","subjectId","teacherId") VALUES ('cs-2c-english','Grade 2-C','english','teacher-1');
    INSERT INTO public.exams(id,"studentId","subjectId",subject,"examType","assessmentLabel","termId",month,status,"entryState",date,"createdAt","teacherId",total,score) VALUES ${exams};
  `);
}

async function seed(db: PgTestDb) {
  await db.exec(`
    INSERT INTO auth.users(id) VALUES
      ('${AUTH_ADMIN}'), ('${AUTH_SUPERVISOR}'), ('${AUTH_UNASSIGNED_TEACHER}');

    INSERT INTO public.profiles(id,name,email,role,auth_id,"assignedClasses") VALUES
      ('admin-1','Admin One','admin@example.com','admin','${AUTH_ADMIN}','[]'::jsonb),
      ('supervisor-1','Supervisor One','supervisor@example.com','supervisor','${AUTH_SUPERVISOR}','["Grade 5-A"]'::jsonb),
      ('teacher-1','Teacher One','teacher@example.com','teacher',NULL,'[]'::jsonb),
      ('teacher-unassigned','Unassigned Teacher','unassigned@example.com','teacher','${AUTH_UNASSIGNED_TEACHER}','[]'::jsonb);

    INSERT INTO public.subjects(id,name) VALUES ('english','English'), ('math','Mathematics');
    INSERT INTO public.academic_years(id,name) VALUES ('ay-1','2026/2027');
    INSERT INTO public.terms(id,name,"academicYearId","startDate","endDate",months) VALUES
      ('term-1','Term 1','ay-1','2026-08-01','2026-12-31',ARRAY['September','October']);

    INSERT INTO public.students(id,name,"className",transport,status) VALUES
      ('s-1','Ayaan Ali','Grade 5-A',NULL,'active'),
      ('s-2','Bilan Hassan','Grade 5-A',NULL,'active'),
      ('s-3','Cumar Omar','Grade 5-A',NULL,'active'),
      ('s-left','Left Student','Grade 5-A','LEFT','active'),
      ('s-former','Former Student','Grade 5-A',NULL,'former'),
      ('s-6','Grade Six Student','Grade 6-A',NULL,'active');

    INSERT INTO public.student_enrollments(id,"studentId","className","academicYearId","termId","effectiveFrom",reason) VALUES
      ('enr-1','s-1','Grade 5-A','ay-1','term-1','2026-08-01','backfill'),
      ('enr-2','s-2','Grade 5-A','ay-1','term-1','2026-08-01','backfill'),
      ('enr-3','s-3','Grade 5-A','ay-1','term-1','2026-08-01','backfill'),
      ('enr-left','s-left','Grade 5-A','ay-1','term-1','2026-08-01','backfill'),
      ('enr-former','s-former','Grade 5-A','ay-1','term-1','2026-08-01','backfill'),
      ('enr-6','s-6','Grade 6-A','ay-1','term-1','2026-08-01','backfill');

    INSERT INTO public.class_subjects(id,"className","subjectId","teacherId") VALUES
      ('cs-5a-english','Grade 5-A','english','teacher-1'),
      ('cs-6a-english','Grade 6-A','english','teacher-1');

    -- A duplicate row for s-1 and an explicit absent/pending row for s-2
    -- must still count as two entered students, not three mark records.
    INSERT INTO public.exams(id,"studentId","subjectId",subject,"examType","assessmentLabel","termId",month,status,"entryState",date,"createdAt","teacherId",total,score) VALUES
      ('exam-s1-final-a','s-1','english','English','Final',NULL,'term-1','October','approved','scored','2026-10-10','2026-10-10T10:00:00Z','teacher-1',100,80),
      ('exam-s1-final-duplicate','s-1','english','English','Final',NULL,'term-1','October','approved','scored','2026-10-10','2026-10-10T10:01:00Z','teacher-1',100,80),
      ('exam-s2-final-legacy','s-2','english','English','Final',NULL,NULL,'October','pending','absent','2026-10-11','2026-10-11T10:00:00Z','teacher-1',100,NULL);
  `);
}

async function monitor(db: PgTestDb, scope: string, className: string | null = null, month = 'October') {
  const { rows } = await db.query<any>(
    `SELECT * FROM public.monitor_marks_entries($1,$2,$3,$4,$5,$6,$7)`,
    ['ay-1', 'term-1', scope, month, null, className, null],
  );
  return rows;
}

d('monitor_marks_entries — real Postgres via PGlite', () => {
  let db: PgTestDb;

  beforeAll(async () => {
    db = await createBulkGradesTestDb();
    await installMonitorSchema(db);
  }, 30000);

  beforeEach(async () => {
    await db.setAuthUid(null);
    await db.exec(`
      DELETE FROM public.exams;
      DELETE FROM public.class_subjects;
      DELETE FROM public.student_enrollments;
      DELETE FROM public.students;
      DELETE FROM public.subjects;
      DELETE FROM public.terms;
      DELETE FROM public.academic_years;
      DELETE FROM public.profiles;
      DELETE FROM auth.users;
    `);
    await seed(db);
  });

  afterAll(async () => {
    await db?.close();
  });

  it('starts from class_subjects, includes zero-entry assignments, and scopes supervisors to assigned classes', async () => {
    await db.setAuthUid(AUTH_SUPERVISOR);
    const rows = await monitor(db, 'final');
    expect(rows.map((row) => row.assignment_id)).toEqual(['cs-5a-english']);
    expect(rows[0]).toMatchObject({
      expected_students: 3,
      entered_students: 2,
      completion_status: 'in_progress',
    });
    expect(Number(rows[0].percentage)).toBeCloseTo(66.67, 2);
    expect(rows[0].missing_students).toEqual([{ id: 's-3', name: 'Cumar Omar' }]);

    await db.setAuthUid(AUTH_ADMIN);
    const adminRows = await monitor(db, 'final');
    expect(adminRows.map((row) => row.assignment_id)).toEqual(['cs-5a-english', 'cs-6a-english']);
    expect(adminRows.find((row) => row.assignment_id === 'cs-6a-english')).toMatchObject({
      expected_students: 1,
      entered_students: 0,
      completion_status: 'not_started',
    });
    expect(Number(adminRows.find((row) => row.assignment_id === 'cs-6a-english')?.percentage)).toBe(0);
  });

  it('excludes Former Students from monitor counts while historical term rosters retain them', async () => {
    await db.setAuthUid(AUTH_ADMIN);

    const historicalRoster = await db.query<{ student_id: string }>(
      `SELECT student_id FROM public.class_students_for_term($1, $2)`,
      ['Grade 5-A', 'term-1'],
    );
    expect(historicalRoster.rows.map((student) => student.student_id)).toContain('s-former');

    const row = (await monitor(db, 'final', 'Grade 5-A'))[0];
    expect(row.expected_students).toBe(3);
    expect(row.entered_students).toBe(2);
    expect(row.missing_students).toEqual([{ id: 's-3', name: 'Cumar Omar' }]);
    expect(row.missing_students.map((student: { id: string }) => student.id)).not.toContain('s-former');
  });

  it('counts explicit entry states and legacy term-null rows once by student ID', async () => {
    await db.setAuthUid(AUTH_ADMIN);
    const rows = await monitor(db, 'final', 'Grade 5-A');
    const row = rows[0];
    expect(row.expected_students).toBe(3); // LEFT and Former students are excluded
    expect(row.entered_students).toBe(2); // s-1 duplicate rows + s-2 absent row
    expect(row.missing_students).toEqual([{ id: 's-3', name: 'Cumar Omar' }]);
    expect(new Date(row.last_updated).toISOString()).toBe('2026-10-11T10:00:00.000Z');
  });

  it('reuses the existing monthly coursework rule, counts every Quiz record, and keeps MT visible to midterm', async () => {
    await db.setAuthUid(AUTH_ADMIN);
    await db.exec('DELETE FROM public.exams');
    await db.exec(`
      INSERT INTO public.exams(id,"studentId","subjectId",subject,"examType","assessmentLabel","termId",month,status,"entryState",date,"createdAt","teacherId",total,score) VALUES
        ('ca-1','s-1','english','English','CA',NULL,'term-1','October','approved','scored','2026-10-01','2026-10-01T10:00:00Z','teacher-1',10,8),
        ('hw-2','s-2','english','English','Homework','HW1','term-1','October','approved','scored','2026-10-02','2026-10-02T10:00:00Z','teacher-1',5,4),
        ('cw-2','s-2','english','English','Classwork','CPW1','term-1','October','approved','scored','2026-10-03','2026-10-03T10:00:00Z','teacher-1',15,12),
        ('quiz-1','s-1','english','English','Quiz',NULL,'term-1','October','approved','scored','2026-10-04','2026-10-04T10:00:00Z','teacher-1',20,16),
        ('quiz-2','s-2','english','English','Quiz',NULL,'term-1','October','approved','scored','2026-10-04','2026-10-04T10:01:00Z','teacher-1',20,15),
        ('mt-1','s-3','english','English','Quiz','MT','term-1','October','approved','scored','2026-10-05','2026-10-05T10:00:00Z','teacher-1',20,15),
        ('midterm-2','s-2','english','English','Midterm',NULL,'term-1','October','approved','scored','2026-10-06','2026-10-06T10:00:00Z','teacher-1',100,70);
    `);
    const monthly = (await monitor(db, 'monthly', 'Grade 5-A'))[0];
    expect(monthly).toMatchObject({
      expected_students: 3,
      // s-1 (CA + Quiz) and s-2 (Homework + Classwork + Quiz) are complete;
      // s-3 has a Quiz (bulk MT) but no coursework, so it stays missing.
      entered_students: 2,
      ca_entered: 1,
      homework_entered: 1,
      homework_ca_entered: 2, // s-1 via CA, s-2 via Homework: two students
      classwork_entered: 1,
      quiz_entered: 3,
      coursework_complete: false,
      quiz_complete: true,
      completion_status: 'in_progress',
    });
    expect(monthly.missing_students).toEqual([{ id: 's-3', name: 'Cumar Omar' }]);
    // Existing blended rule: (max(1/3, (1/3 + 1/3) / 2) + 3/3) / 2 = 66.67%.
    expect(Number(monthly.percentage)).toBeCloseTo(66.67, 2);

    const midterm = (await monitor(db, 'midterm', 'Grade 5-A'))[0];
    expect(midterm.entered_students).toBe(2); // explicit Midterm + Quiz/MT are both supported
    expect(midterm.missing_students).toEqual([{ id: 's-1', name: 'Ayaan Ali' }]);
  });

  it('shows the coursework behind a legacy CA month in the Homework (CA) count', async () => {
    // Manual entry (UploadResults) still writes examType 'CA' — it is the
    // form's default type. The completion rule and percentage honour those
    // rows, so before 20260919c such a month read "Complete · 100%" next to
    // "Homework (CA) 0/3": the coursework that made it complete was invisible
    // in the only coursework tile.
    await db.setAuthUid(AUTH_ADMIN);
    await db.exec('DELETE FROM public.exams');
    await db.exec(`
      INSERT INTO public.exams(id,"studentId","subjectId",subject,"examType","assessmentLabel","termId",month,status,"entryState",date,"createdAt","teacherId",total,score) VALUES
        ('ca-1','s-1','english','English','CA',NULL,'term-1','October','approved','scored','2026-10-01','2026-10-01T10:00:00Z','teacher-1',10,8),
        ('ca-2','s-2','english','English','CA',NULL,'term-1','October','approved','scored','2026-10-01','2026-10-01T10:01:00Z','teacher-1',10,7),
        ('ca-3','s-3','english','English','CA',NULL,'term-1','October','approved','scored','2026-10-01','2026-10-01T10:02:00Z','teacher-1',10,9),
        ('quiz-1','s-1','english','English','Quiz',NULL,'term-1','October','approved','scored','2026-10-04','2026-10-04T10:00:00Z','teacher-1',20,16),
        ('quiz-2','s-2','english','English','Quiz',NULL,'term-1','October','approved','scored','2026-10-04','2026-10-04T10:01:00Z','teacher-1',20,15),
        ('quiz-3','s-3','english','English','Quiz',NULL,'term-1','October','approved','scored','2026-10-04','2026-10-04T10:02:00Z','teacher-1',20,14);
    `);
    const row = (await monitor(db, 'monthly', 'Grade 5-A'))[0];
    expect(row).toMatchObject({
      expected_students: 3,
      entered_students: 3,
      ca_entered: 3,
      homework_entered: 0,
      homework_ca_entered: 3, // the Homework (CA) tile now shows the CA coursework
      classwork_entered: 0,
      quiz_entered: 3,
      coursework_complete: true,
      quiz_complete: true,
      monthly_complete_students: 3,
      completion_status: 'complete',
    });
    expect(Number(row.percentage)).toBeCloseTo(100, 2);
    expect(row.missing_students).toEqual([]);
  });

  it('folds legacy CA records into the Homework (CA) count once per student', async () => {
    await db.setAuthUid(AUTH_ADMIN);
    await db.exec('DELETE FROM public.exams');
    await db.exec(`
      INSERT INTO public.exams(id,"studentId","subjectId",subject,"examType","assessmentLabel","termId",month,status,"entryState",date,"createdAt","teacherId",total,score) VALUES
        ('ca-1','s-1','english','English','CA',NULL,'term-1','October','approved','scored','2026-10-01','2026-10-01T10:00:00Z','teacher-1',10,8),
        ('ca-2','s-2','english','English','CA',NULL,'term-1','October','approved','scored','2026-10-01','2026-10-01T10:01:00Z','teacher-1',10,7),
        ('hw-2','s-2','english','English','Homework','HW1','term-1','October','approved','scored','2026-10-02','2026-10-02T10:00:00Z','teacher-1',5,4),
        ('quiz-1','s-1','english','English','Quiz',NULL,'term-1','October','approved','scored','2026-10-04','2026-10-04T10:00:00Z','teacher-1',20,16),
        ('quiz-2','s-2','english','English','Quiz',NULL,'term-1','October','approved','scored','2026-10-04','2026-10-04T10:01:00Z','teacher-1',20,15),
        ('quiz-3','s-3','english','English','Quiz',NULL,'term-1','October','approved','scored','2026-10-04','2026-10-04T10:02:00Z','teacher-1',20,14);
    `);
    const row = (await monitor(db, 'monthly', 'Grade 5-A'))[0];
    expect(row).toMatchObject({
      expected_students: 3,
      ca_entered: 2,
      homework_entered: 1,
      // s-2 has both a CA and a Homework record but is one student: the
      // per-student union is 2, never the naive sum 3.
      homework_ca_entered: 2,
      quiz_entered: 3,
      entered_students: 2, // s-3 has a quiz but no coursework
      coursework_complete: false,
      completion_status: 'in_progress',
    });
    expect(row.missing_students).toEqual([{ id: 's-3', name: 'Cumar Omar' }]);
    // Unchanged blended rule: (max(2/3, (1/3 + 0) / 2) + 3/3) / 2 = 83.33%.
    expect(Number(row.percentage)).toBeCloseTo(83.33, 2);
  });

  it('detects bulk-uploaded MT quizzes as the monthly Quiz component instead of reporting 0', async () => {
    // ENGLISH · Grade 2-C · August: 42 on the roster, 34 bulk uploaded.
    await db.setAuthUid(AUTH_ADMIN);
    await db.exec('DELETE FROM public.exams');
    await seedBulkUploadedMonth(db, { classSize: 42, enteredCount: 34 });

    const row = (await monitor(db, 'monthly', 'Grade 2-C', 'August'))[0];
    expect(row).toMatchObject({
      assignment_id: 'cs-2c-english',
      expected_students: 42,
      homework_entered: 34,
      homework_ca_entered: 34, // no CA rows: the union equals the homework count
      classwork_entered: 34,
      quiz_entered: 34, // previously 0: every Quiz/MT row was filtered out
      attendance_entered: 34,
      entered_students: 34,
      monthly_complete_students: 34,
      coursework_complete: false,
      quiz_complete: false,
      completion_status: 'in_progress',
    });
    expect(row.quiz_entered).not.toBe(0);
    expect(row.missing_students).toHaveLength(8);
    expect(row.missing_students.map((student: { id: string }) => student.id)).toEqual(
      Array.from({ length: 8 }, (_, index) => `g2c-${35 + index}`),
    );
    // Existing monitor rule, unchanged: ((34/42 + 34/42) / 2 + 34/42) / 2 = 80.95%.
    expect(Number(row.percentage)).toBeCloseTo(80.95, 2);
  });

  it('reaches complete once every roster student has coursework and a quiz, and the quiz-only scope agrees', async () => {
    await db.setAuthUid(AUTH_ADMIN);
    await db.exec('DELETE FROM public.exams');
    await seedBulkUploadedMonth(db, { classSize: 42, enteredCount: 42 });

    const monthly = (await monitor(db, 'monthly', 'Grade 2-C', 'August'))[0];
    expect(monthly).toMatchObject({
      expected_students: 42,
      entered_students: 42,
      quiz_entered: 42,
      coursework_complete: true,
      quiz_complete: true,
      completion_status: 'complete',
      missing_students: [],
    });
    expect(Number(monthly.percentage)).toBe(100);

    const quizScope = (await monitor(db, 'quiz', 'Grade 2-C', 'August'))[0];
    expect(quizScope).toMatchObject({ expected_students: 42, entered_students: 42, completion_status: 'complete' });
  });

  it('counts a student once when both a plain Quiz and an MT quiz exist, and still requires coursework', async () => {
    await db.setAuthUid(AUTH_ADMIN);
    await db.exec('DELETE FROM public.exams');
    await db.exec(`
      INSERT INTO public.exams(id,"studentId","subjectId",subject,"examType","assessmentLabel","termId",month,status,"entryState",date,"createdAt","teacherId",total,score) VALUES
        ('quiz-plain-1','s-1','english','English','Quiz',NULL,'term-1','October','approved','scored','2026-10-04','2026-10-04T10:00:00Z','teacher-1',20,16),
        ('quiz-mt-1','s-1','english','English','Quiz','MT','term-1','October','pending','scored','2026-10-05','2026-10-05T10:00:00Z','teacher-1',20,15);
    `);
    const row = (await monitor(db, 'monthly', 'Grade 5-A'))[0];
    expect(row).toMatchObject({
      expected_students: 3,
      quiz_entered: 1,
      homework_entered: 0,
      classwork_entered: 0,
      entered_students: 0,
      completion_status: 'in_progress',
    });
    // Quiz alone is half of the blended rule: (0 + 1/3) / 2 = 16.67%.
    expect(Number(row.percentage)).toBeCloseTo(16.67, 2);
  });

  it('denies anonymous calls and does not make an unassigned teacher expected', async () => {
    const anonymousError = await db.query('SELECT * FROM public.monitor_marks_entries($1,$2,$3,$4,$5,$6,$7)', ['ay-1', 'term-1', 'final', 'October', null, null, null]).catch((error) => error as Error);
    expect((anonymousError as Error).message).toContain('Only admins and supervisors');

    await db.setAuthUid(AUTH_UNASSIGNED_TEACHER);
    const denied = await db.query('SELECT * FROM public.monitor_marks_entries($1,$2,$3,$4,$5,$6,$7)', ['ay-1', 'term-1', 'final', 'October', null, null, null]).catch((error) => error as Error);
    expect((denied as Error).message).toContain('Only admins and supervisors');
  });
});
