import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  createBulkGradesTestDb,
  extractStatementContaining,
  pgliteAvailable,
  readMigration,
  type PgTestDb,
} from '../bulk-grades/__tests__/pgHarness';

/**
 * Former Students must never count in the CURRENT-term marks monitor, while the
 * historical, term-scoped roster helper keeps returning them for reports.
 *
 * Runs the shipped SQL in PGlite: the marks-monitor migrations in production
 * order, then 20261010_monitor_excludes_former_students.sql on top.
 */

const AVAILABLE = await pgliteAvailable();
const d = AVAILABLE ? describe : describe.skip;

const AUTH_ADMIN = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';

async function installSchema(db: PgTestDb) {
  await db.exec(`
    ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS "assignedClasses" JSONB NOT NULL DEFAULT '[]'::jsonb;
    ALTER TABLE public.students ADD COLUMN IF NOT EXISTS transport TEXT;
    ALTER TABLE public.students ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'active';
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
  await db.exec(readMigration('20260919b_marks_monitor_quiz_component.sql'));
  await db.exec(readMigration('20260919c_marks_monitor_homework_ca_tile.sql'));
  await db.exec(readMigration('20261010_monitor_excludes_former_students.sql'));
}

async function seed(db: PgTestDb) {
  await db.exec(`
    INSERT INTO auth.users(id) VALUES ('${AUTH_ADMIN}');
    INSERT INTO public.profiles(id,name,email,role,auth_id,"assignedClasses") VALUES
      ('admin-1','Admin One','admin@example.com','admin','${AUTH_ADMIN}','[]'::jsonb),
      ('teacher-1','Teacher One','teacher@example.com','teacher',NULL,'[]'::jsonb);
    INSERT INTO public.subjects(id,name) VALUES ('english','English');
    INSERT INTO public.academic_years(id,name) VALUES ('ay-1','2026/2027');
    INSERT INTO public.terms(id,name,"academicYearId","startDate","endDate",months) VALUES
      ('term-1','Term 1','ay-1','2026-08-01','2026-12-31',ARRAY['October']);

    -- Four students in Grade 5-A, all enrolled for the whole term.
    INSERT INTO public.students(id,name,"className",transport,status) VALUES
      ('s-active',   'Active Student',        'Grade 5-A', NULL,   'active'),
      ('s-former',   'Former (transport NULL)','Grade 5-A', NULL,   'former'),
      ('s-former-l', 'Former (transport LEFT)','Grade 5-A', 'LEFT', 'former'),
      ('s-restored', 'Restored Student',      'Grade 5-A', NULL,   'active');

    INSERT INTO public.student_enrollments(id,"studentId","className","academicYearId","termId","effectiveFrom",reason) VALUES
      ('enr-1','s-active','Grade 5-A','ay-1','term-1','2026-08-01','backfill'),
      ('enr-2','s-former','Grade 5-A','ay-1','term-1','2026-08-01','backfill'),
      ('enr-3','s-former-l','Grade 5-A','ay-1','term-1','2026-08-01','backfill'),
      ('enr-4','s-restored','Grade 5-A','ay-1','term-1','2026-08-01','backfill');

    INSERT INTO public.class_subjects(id,"className","subjectId","teacherId") VALUES
      ('cs-5a-english','Grade 5-A','english','teacher-1');
  `);
}

async function monitorRows(db: PgTestDb) {
  const { rows } = await db.query<any>(
    'SELECT * FROM public.monitor_marks_entries($1,$2,$3,$4,$5,$6,$7)',
    ['ay-1', 'term-1', 'final', 'October', null, null, null],
  );
  return rows;
}

d('marks monitor excludes Former Students (20261010)', () => {
  let db: PgTestDb;

  beforeAll(async () => {
    db = await createBulkGradesTestDb();
    await installSchema(db);
  }, 30000);

  beforeEach(async () => {
    await db.setAuthUid(AUTH_ADMIN);
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

  it('does not count a former student as expected when transport is NULL (status alone excludes)', async () => {
    const [row] = await monitorRows(db);
    // Roster is 4 students by enrollment; the two former students are removed.
    // Only s-active and s-restored remain -> 2 expected.
    expect(row.expected_students).toBe(2);
    expect(row.missing_students.map((s: { id: string }) => s.id).sort()).toEqual(['s-active', 's-restored']);
  });

  it('still excludes a former student flagged transport = LEFT (no regression)', async () => {
    const rows = await monitorRows(db);
    const ids = rows.flatMap((r: any) => r.missing_students.map((s: { id: string }) => s.id));
    expect(ids).not.toContain('s-former-l');
    expect(ids).not.toContain('s-former');
  });

  it('keeps the historical term roster helper unchanged: former students are still returned for reports', async () => {
    const { rows } = await db.query<{ student_id: string }>(
      'SELECT student_id FROM public.class_students_for_term($1,$2) ORDER BY student_id',
      ['Grade 5-A', 'term-1'],
    );
    expect(rows.map((r) => r.student_id)).toEqual(['s-active', 's-former', 's-former-l', 's-restored']);
  });

  it('counts a restored student again once status is back to active and transport is cleared', async () => {
    await db.exec(`UPDATE public.students SET status = 'active' WHERE id = 's-former';`);
    const [row] = await monitorRows(db);
    expect(row.expected_students).toBe(3);
    expect(row.missing_students.map((s: { id: string }) => s.id)).toContain('s-former');
  });
});
