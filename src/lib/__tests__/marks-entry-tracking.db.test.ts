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
  await db.exec(readMigration('20260919_marks_entry_tracking.sql'));
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

    INSERT INTO public.students(id,name,"className",transport) VALUES
      ('s-1','Ayaan Ali','Grade 5-A',NULL),
      ('s-2','Bilan Hassan','Grade 5-A',NULL),
      ('s-3','Cumar Omar','Grade 5-A',NULL),
      ('s-left','Left Student','Grade 5-A','LEFT'),
      ('s-6','Grade Six Student','Grade 6-A',NULL);

    INSERT INTO public.student_enrollments(id,"studentId","className","academicYearId","termId","effectiveFrom",reason) VALUES
      ('enr-1','s-1','Grade 5-A','ay-1','term-1','2026-08-01','backfill'),
      ('enr-2','s-2','Grade 5-A','ay-1','term-1','2026-08-01','backfill'),
      ('enr-3','s-3','Grade 5-A','ay-1','term-1','2026-08-01','backfill'),
      ('enr-left','s-left','Grade 5-A','ay-1','term-1','2026-08-01','backfill'),
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

async function monitor(db: PgTestDb, scope: string, className: string | null = null) {
  const { rows } = await db.query<any>(
    `SELECT * FROM public.monitor_marks_entries($1,$2,$3,$4,$5,$6,$7)`,
    ['ay-1', 'term-1', scope, 'October', null, className, null],
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

  it('counts explicit entry states and legacy term-null rows once by student ID', async () => {
    await db.setAuthUid(AUTH_ADMIN);
    const rows = await monitor(db, 'final', 'Grade 5-A');
    const row = rows[0];
    expect(row.expected_students).toBe(3); // LEFT is excluded
    expect(row.entered_students).toBe(2); // s-1 duplicate rows + s-2 absent row
    expect(row.missing_students).toEqual([{ id: 's-3', name: 'Cumar Omar' }]);
    expect(new Date(row.last_updated).toISOString()).toBe('2026-10-11T10:00:00.000Z');
  });

  it('reuses the existing monthly coursework rule and keeps MT in the midterm scope', async () => {
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
      entered_students: 2,
      ca_entered: 1,
      homework_entered: 1,
      classwork_entered: 1,
      quiz_entered: 2,
      coursework_complete: false,
      quiz_complete: false,
      completion_status: 'in_progress',
    });
    expect(Number(monthly.percentage)).toBeCloseTo(50, 2);

    const midterm = (await monitor(db, 'midterm', 'Grade 5-A'))[0];
    expect(midterm.entered_students).toBe(2); // explicit Midterm + Quiz/MT are both supported
    expect(midterm.missing_students).toEqual([{ id: 's-1', name: 'Ayaan Ali' }]);
  });

  it('denies anonymous calls and does not make an unassigned teacher expected', async () => {
    const anonymousError = await db.query('SELECT * FROM public.monitor_marks_entries($1,$2,$3,$4,$5,$6,$7)', ['ay-1', 'term-1', 'final', 'October', null, null, null]).catch((error) => error as Error);
    expect((anonymousError as Error).message).toContain('Only admins and supervisors');

    await db.setAuthUid(AUTH_UNASSIGNED_TEACHER);
    const denied = await db.query('SELECT * FROM public.monitor_marks_entries($1,$2,$3,$4,$5,$6,$7)', ['ay-1', 'term-1', 'final', 'October', null, null, null]).catch((error) => error as Error);
    expect((denied as Error).message).toContain('Only admins and supervisors');
  });
});
