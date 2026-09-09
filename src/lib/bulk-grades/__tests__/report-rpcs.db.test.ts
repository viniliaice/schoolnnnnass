// Behavioral PostgreSQL tests for the shipped report RPCs.
//
// These tests execute the ACTUAL submit_bulk_grades RPC, the ACTUAL historical
// class helpers, and the ACTUAL report remediation migration against PGlite.
// The main scenario proves a half-point score survives:
//   XLSX template -> parser -> resolver -> server preview -> DB write ->
//   approved exam row -> monthly report -> midterm report -> final report.

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import * as XLSX from 'xlsx';
import type { Student, Subject } from '../../../types';
import { buildRosterWorkbook, GRADES_SHEET_NAME, parseRosterWorkbook } from '../workbook';
import { resolveWorkbook } from '../resolve';
import {
  createBulkGradesTestDb,
  extractStatementContaining,
  pgliteAvailable,
  readMigration,
  type PgTestDb,
} from './pgHarness';

const AVAILABLE = await pgliteAvailable();
const d = AVAILABLE ? describe : describe.skip;

const AUTH_TEACHER_A = '11111111-1111-1111-1111-111111111111';
const AUTH_TEACHER_B = '22222222-2222-2222-2222-222222222222';
const AUTH_PARENT = '33333333-3333-3333-3333-333333333333';

const ENGLISH: Subject = { id: 'english', name: 'English', createdAt: 'x' } as Subject;
const GRADE_5A_ROSTER: Student[] = [
  { id: 'S1', name: 'Ayaan Ali', className: 'Grade 5-A', parentId: 'parent1', createdAt: 'x' } as Student,
  { id: 'S2', name: 'Bilan Hassan', className: 'Grade 5-A', parentId: null, createdAt: 'x' } as Student,
  { id: 'S3', name: 'Cumar Omar', className: 'Grade 5-A', parentId: null, createdAt: 'x' } as Student,
];

async function installReportSchemaAndRpcs(db: PgTestDb) {
  await db.exec(`
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
      "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      CHECK ("effectiveTo" IS NULL OR "effectiveTo" >= "effectiveFrom")
    );

    CREATE TABLE IF NOT EXISTS public.report_config (
      id TEXT PRIMARY KEY,
      "caWeight" INTEGER NOT NULL DEFAULT 60,
      "midtermWeight" INTEGER NOT NULL DEFAULT 20,
      "finalWeight" INTEGER NOT NULL DEFAULT 20,
      "caTypes" TEXT[] NOT NULL DEFAULT ARRAY['CA','Homework','Classwork','Quiz','Attendance'],
      "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS public.report_comments (
      id TEXT PRIMARY KEY,
      "studentId" TEXT NOT NULL REFERENCES public.students(id) ON DELETE CASCADE,
      "termId" TEXT NOT NULL REFERENCES public.terms(id) ON DELETE CASCADE,
      "examId" TEXT REFERENCES public.exams(id) ON DELETE SET NULL,
      "teacherComment" TEXT,
      "principalComment" TEXT,
      "teacherId" TEXT REFERENCES public.profiles(id) ON DELETE SET NULL,
      "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  const historicalHelpers = readMigration('20260906b_student_enrollments_history.sql');
  await db.exec(extractStatementContaining(historicalHelpers, 'FUNCTION public.class_students_for_term', '$$;'));
  await db.exec(extractStatementContaining(historicalHelpers, 'FUNCTION public.class_for_term', '$$;'));

  await db.exec(readMigration('20260912_report_rpc_remediation.sql'));
}

async function seed(db: PgTestDb) {
  await db.exec(`
    INSERT INTO auth.users(id) VALUES
      ('${AUTH_TEACHER_A}'),
      ('${AUTH_TEACHER_B}'),
      ('${AUTH_PARENT}');

    INSERT INTO profiles(id,name,email,role,auth_id) VALUES
      ('teacherA','Teacher A','teacher-a@example.com','teacher','${AUTH_TEACHER_A}'),
      ('teacherB','Teacher B','teacher-b@example.com','teacher','${AUTH_TEACHER_B}'),
      ('parent1','Parent One','parent@example.com','parent','${AUTH_PARENT}');

    INSERT INTO subjects(id,name) VALUES ('english','English');

    INSERT INTO students(id,name,"className","parentId") VALUES
      ('S1','Ayaan Ali','Grade 5-A','parent1'),
      ('S2','Bilan Hassan','Grade 5-A',NULL),
      ('S3','Cumar Omar','Grade 5-A',NULL);

    INSERT INTO class_subjects(id,"className","subjectId","teacherId") VALUES
      ('cs-5a-english','Grade 5-A','english','teacherA'),
      ('cs-6a-english','Grade 6-A','english','teacherB');

    INSERT INTO academic_years(id,name) VALUES ('ay1','2026');
    INSERT INTO terms(id,name,"academicYearId","startDate","endDate","isCurrent",months) VALUES
      ('term1','Term 1','ay1','2026-01-01','2026-05-31',true,ARRAY['May']);

    INSERT INTO report_config(id,"caWeight","midtermWeight","finalWeight","caTypes") VALUES
      ('default',30,30,40,ARRAY['CA','Homework','Classwork','Quiz','Attendance']);

    INSERT INTO student_enrollments(id,"studentId","className","academicYearId","termId","effectiveFrom","effectiveTo",reason) VALUES
      ('enr-s1-5a','S1','Grade 5-A','ay1','term1','2026-01-01',NULL,'backfill'),
      ('enr-s2-5a','S2','Grade 5-A','ay1','term1','2026-01-01',NULL,'backfill'),
      ('enr-s3-5a','S3','Grade 5-A','ay1','term1','2026-01-01',NULL,'backfill');
  `);
}

function buildWorkbookParse() {
  const bytes = buildRosterWorkbook({
    className: 'Grade 5-A',
    subjects: [ENGLISH],
    blocks: ['HW1', 'CPW1', 'MT'],
    roster: GRADE_5A_ROSTER,
    termName: 'Term 1',
    month: 'May',
    assessmentDate: '2026-05-10',
  });
  const wb = XLSX.read(bytes, { type: 'array' });
  const sheet = wb.Sheets[GRADES_SHEET_NAME];
  sheet.B2 = { t: 'n', v: 4.5 };
  sheet.C2 = { t: 'n', v: 12.5 };
  sheet.D2 = { t: 'n', v: 17.5 };
  sheet.B3 = { t: 'n', v: 4 };
  sheet.C3 = { t: 'n', v: 10.5 };
  sheet.D3 = { t: 'n', v: 15.5 };
  sheet.B4 = { t: 'n', v: 3.5 };
  sheet.C4 = { t: 'n', v: 9.5 };
  sheet.D4 = { t: 'n', v: 12.5 };

  return parseRosterWorkbook(XLSX.write(wb, { bookType: 'xlsx', type: 'array' }) as ArrayBuffer, {
    expectedSubjects: [ENGLISH.name],
    expectedBlocks: ['HW1', 'CPW1', 'MT'],
  });
}

async function submit(db: PgTestDb, records: unknown[], uploadKey: string, confirm: boolean) {
  const { rows } = await db.query<{ result: Record<string, unknown> }>(
    'SELECT public.submit_bulk_grades($1::jsonb, $2, $3) AS result',
    [JSON.stringify(records), uploadKey, confirm],
  );
  return rows[0].result;
}

async function expectDenied(operation: () => Promise<unknown>): Promise<string> {
  try {
    await operation();
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  throw new Error('Expected the operation to be denied, but it succeeded.');
}

function expectClose(actual: number, expected: number) {
  expect(actual).toBeCloseTo(expected, 2);
}

d('report RPC remediation — real Postgres via PGlite', () => {
  let db: PgTestDb;

  beforeAll(async () => {
    db = await createBulkGradesTestDb({ includeGradeCorrection: true, includeHalfPoints: true });
    await installReportSchemaAndRpcs(db);
  });

  afterAll(async () => {
    await db?.close();
  });

  beforeEach(async () => {
    await db.setAuthUid(null);
    await db.exec(`
      DELETE FROM public.report_comments;
      DELETE FROM public.exams;
      DELETE FROM public.grade_uploads;
      DELETE FROM public.student_enrollments;
      DELETE FROM public.report_config;
      DELETE FROM public.class_subjects;
      DELETE FROM public.students;
      DELETE FROM public.subjects;
      DELETE FROM public.profiles;
      DELETE FROM public.terms;
      DELETE FROM public.academic_years;
      DELETE FROM auth.users;
    `);
    await seed(db);
  });

  it('denies report access to an unrelated teacher', async () => {
    await db.setAuthUid(AUTH_TEACHER_B);
    const message = await expectDenied(() => db.query(
      'SELECT public.get_monthly_report($1, $2) AS result',
      ['S1', 'term1'],
    ));
    expect(message).toContain('not allowed to view reports');
  });

  it('preserves half-point values from workbook upload through monthly, midterm, and final reports', async () => {
    const parsed = buildWorkbookParse();
    expect(parsed.issues.filter(issue => issue.severity === 'error')).toEqual([]);

    const targetStudent = parsed.students.find(student => student.studentId === 'S1');
    expect(targetStudent?.studentName).toBe('Ayaan Ali');
    expect(targetStudent?.scores).toEqual(expect.arrayContaining([
      expect.objectContaining({ subjectName: 'English', assessmentLabel: 'HW1', examType: 'Homework', total: 5, score: 4.5 }),
      expect.objectContaining({ subjectName: 'English', assessmentLabel: 'CPW1', examType: 'Classwork', total: 15, score: 12.5 }),
      expect.objectContaining({ subjectName: 'English', assessmentLabel: 'MT', examType: 'Quiz', total: 20, score: 17.5 }),
    ]));

    const resolved = resolveWorkbook(parsed, {
      className: 'Grade 5-A',
      authorizedSubjects: [ENGLISH],
      roster: GRADE_5A_ROSTER,
      termId: 'term1',
      month: 'May',
      date: '2026-05-10',
    });
    expect(resolved.errors).toEqual([]);
    expect(resolved.reviewCount).toBe(0);
    expect(resolved.records).toEqual(expect.arrayContaining([
      expect.objectContaining({ studentId: 'S1', subjectId: 'english', assessmentLabel: 'HW1', examType: 'Homework', total: 5, score: 4.5 }),
      expect.objectContaining({ studentId: 'S1', subjectId: 'english', assessmentLabel: 'CPW1', examType: 'Classwork', total: 15, score: 12.5 }),
      expect.objectContaining({ studentId: 'S1', subjectId: 'english', assessmentLabel: 'MT', examType: 'Quiz', total: 20, score: 17.5 }),
    ]));

    await db.setAuthUid(AUTH_TEACHER_A);
    const preview = await submit(db, resolved.records, 'report-flow-preview', false);
    expect(preview.insertCount).toBe(9);
    expect(preview.updateCount).toBe(0);
    expect(preview.changes).toEqual(expect.arrayContaining([
      expect.objectContaining({ studentId: 'S1', subjectId: 'english', assessmentLabel: 'HW1', subject: 'English', newScore: 4.5, changeType: 'new' }),
      expect.objectContaining({ studentId: 'S1', subjectId: 'english', assessmentLabel: 'CPW1', subject: 'English', newScore: 12.5, changeType: 'new' }),
      expect.objectContaining({ studentId: 'S1', subjectId: 'english', assessmentLabel: 'MT', subject: 'English', newScore: 17.5, changeType: 'new' }),
    ]));

    const committed = await submit(db, resolved.records, 'report-flow-commit', true);
    expect(committed.insertCount).toBe(9);

    const { rows: storedRows } = await db.query<{
      studentId: string;
      subjectId: string;
      subject: string;
      assessmentLabel: string;
      examType: string;
      total: number;
      score: string;
      status: string;
    }>(
      `SELECT "studentId" AS "studentId", "subjectId" AS "subjectId", subject,
              "assessmentLabel" AS "assessmentLabel", "examType" AS "examType",
              total, score::text AS score, status
         FROM public.exams
        WHERE "studentId" = 'S1'
        ORDER BY "assessmentLabel"`,
    );
    expect(storedRows).toEqual([
      {
        studentId: 'S1',
        subjectId: 'english',
        subject: 'English',
        assessmentLabel: 'CPW1',
        examType: 'Classwork',
        total: 15,
        score: '12.5',
        status: 'pending',
      },
      {
        studentId: 'S1',
        subjectId: 'english',
        subject: 'English',
        assessmentLabel: 'HW1',
        examType: 'Homework',
        total: 5,
        score: '4.5',
        status: 'pending',
      },
      {
        studentId: 'S1',
        subjectId: 'english',
        subject: 'English',
        assessmentLabel: 'MT',
        examType: 'Quiz',
        total: 20,
        score: '17.5',
        status: 'pending',
      },
    ]);

    await db.exec(`UPDATE public.exams SET status = 'approved' WHERE "termId" = 'term1';`);
    await db.exec(`
      INSERT INTO public.exams(
        id, "studentId", "subjectId", subject, score, total, "examType", "assessmentLabel",
        "entryState", "termId", month, status, date, "teacherId"
      ) VALUES
        ('final-s1','S1','english','English',42.5,50,'Final',NULL,'scored','term1','May','approved','2026-05-28','teacherA'),
        ('final-s2','S2','english','English',40,50,'Final',NULL,'scored','term1','May','approved','2026-05-28','teacherA'),
        ('final-s3','S3','english','English',35.5,50,'Final',NULL,'scored','term1','May','approved','2026-05-28','teacherA');

      INSERT INTO public.report_comments(id,"studentId","termId","examId","teacherComment","principalComment","teacherId")
      VALUES ('comment-s1','S1','term1',NULL,'Consistent effort','Keep it up','teacherA');
    `);

    // Simulate the student moving after the term ended. Reports must still use
    // the Grade 5-A peer group from student_enrollments, not students.className.
    await db.exec(`
      UPDATE public.students SET "className" = 'Grade 6-A' WHERE id = 'S1';
      UPDATE public.student_enrollments
         SET "effectiveTo" = '2026-05-31'
       WHERE id = 'enr-s1-5a';
      INSERT INTO public.student_enrollments(
        id, "studentId", "className", "academicYearId", "termId", "effectiveFrom", "effectiveTo", reason
      ) VALUES (
        'enr-s1-6a','S1','Grade 6-A','ay1',NULL,'2026-07-01',NULL,'transfer'
      );
    `);

    const { rows: monthlyRows } = await db.query<{ result: any }>(
      'SELECT public.get_monthly_report($1, $2) AS result',
      ['S1', 'term1'],
    );
    const monthlyReport = monthlyRows[0].result as Array<Record<string, any>>;
    expect(monthlyReport).toHaveLength(1);
    expect(monthlyReport[0].subject).toBe('English');
    expect(monthlyReport[0].month).toBe('May');
    expect(monthlyReport[0].assessment_count).toBe(2);
    expectClose(Number(monthlyReport[0].average), 86.67);
    expect(monthlyReport[0].details).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'HW1', score: 4.5, total: 5, percentage: 90 }),
      expect.objectContaining({ type: 'CPW1', score: 12.5, total: 15 }),
    ]));
    expect(monthlyReport[0].details).toHaveLength(2);
    expect(monthlyReport[0].details.some((detail: { type: string }) => detail.type === 'MT')).toBe(false);
    const cpw1Detail = monthlyReport[0].details.find((detail: { type: string }) => detail.type === 'CPW1');
    expect(cpw1Detail).toBeTruthy();
    expectClose(Number(cpw1Detail.percentage), 83.33);

    const { rows: midtermRows } = await db.query<{ result: any }>(
      'SELECT public.get_midterm_report($1, $2) AS result',
      ['S1', 'term1'],
    );
    const midtermReport = midtermRows[0].result as Record<string, any>;
    expect(midtermReport.total_students).toBe(3);
    expect(midtermReport.overall_rank).toBe(1);
    expect(midtermReport.scores).toEqual([
      expect.objectContaining({
        subject: 'English',
        score: 17.5,
        total: 20,
        percentage: 87.5,
        subject_rank: 1,
      }),
    ]);
    expectClose(Number(midtermReport.scores[0].class_average), 75.83);
    expectClose(Number(midtermReport.scores[0].highest_in_class), 87.5);

    const { rows: finalRows } = await db.query<{ result: any }>(
      'SELECT public.get_final_report($1, $2) AS result',
      ['S1', 'term1'],
    );
    const finalReport = finalRows[0].result as Record<string, any>;
    expect(finalReport.weights).toEqual({ ca: 30, midterm: 30, final: 40 });
    expect(finalReport.total_students).toBe(3);
    expect(finalReport.overall_rank).toBe(1);
    expect(finalReport.comment).toEqual({ teacher: 'Consistent effort', principal: 'Keep it up' });
    expect(finalReport.results).toHaveLength(1);
    expect(finalReport.results[0].subject).toBe('English');
    expectClose(Number(finalReport.results[0].ca_avg), 86.67);
    expectClose(Number(finalReport.results[0].ca_weighted), 26.0);
    expectClose(Number(finalReport.results[0].midterm_score), 87.5);
    expectClose(Number(finalReport.results[0].midterm_weighted), 26.25);
    expectClose(Number(finalReport.results[0].final_score), 85);
    expectClose(Number(finalReport.results[0].final_weighted), 34.0);
    expectClose(Number(finalReport.results[0].total), 86.25);
  });
});

if (!AVAILABLE) {
  describe('report RPC remediation', () => {
    it.skip('SKIPPED: @electric-sql/pglite not installed — report RPC DB behavior is NOT VERIFIED', () => {});
  });
}
