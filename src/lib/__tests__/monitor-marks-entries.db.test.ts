// Real-PostgreSQL behavioural test for the Monitor Marks Entries RPC.
//
// PGlite is an actual PostgreSQL engine (WASM) with full PL/pgSQL, so the
// ACTUAL shipped migration (20260918_monitor_marks_entries.sql) is EXECUTED
// here — function body, role gate, grants — on top of a schema shaped like the
// shipped one. That proves the derived monitoring view returns one row per
// EXPECTED teacher/class/subject (Not Started included), the correct
// expected/entered counts, the three-state status, the completion percentage,
// term + exam-type filtering, left-student exclusion, and teacher self-scoping.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '../../..');

async function pgliteAvailable(): Promise<boolean> {
  try {
    await import('@electric-sql/pglite');
    return true;
  } catch {
    return false;
  }
}

function readMigration(name: string): string {
  return fs.readFileSync(path.join(REPO_ROOT, 'supabase', 'migrations', name), 'utf8');
}

const BASE = `
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='authenticated') THEN
    CREATE ROLE authenticated NOLOGIN;
  END IF;
END $$;

CREATE SCHEMA IF NOT EXISTS auth;
CREATE OR REPLACE FUNCTION auth.uid() RETURNS UUID
LANGUAGE sql STABLE AS $fn$
  SELECT NULLIF(current_setting('app.current_auth_uid', true), '')::UUID;
$fn$;

CREATE TABLE profiles (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE,
  role TEXT NOT NULL,
  auth_id UUID
);

CREATE TABLE subjects (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL
);

CREATE TABLE students (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  "className" TEXT NOT NULL,
  transport TEXT
);

CREATE TABLE academic_years (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  "startDate" DATE NOT NULL,
  "endDate" DATE NOT NULL,
  "isCurrent" BOOLEAN NOT NULL DEFAULT false
);

CREATE TABLE terms (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  "academicYearId" TEXT NOT NULL REFERENCES academic_years(id) ON DELETE CASCADE,
  "startDate" DATE NOT NULL,
  "endDate" DATE NOT NULL,
  "isCurrent" BOOLEAN NOT NULL DEFAULT false,
  months TEXT[] NOT NULL DEFAULT '{}'
);

CREATE TABLE class_subjects (
  id TEXT PRIMARY KEY,
  "className" TEXT NOT NULL,
  "subjectId" TEXT NOT NULL REFERENCES subjects(id) ON DELETE CASCADE,
  "teacherId" TEXT REFERENCES profiles(id) ON DELETE SET NULL
);

CREATE TABLE exams (
  id TEXT PRIMARY KEY,
  "studentId" TEXT NOT NULL,
  "subjectId" TEXT,
  subject TEXT NOT NULL,
  "examType" TEXT NOT NULL,
  month TEXT NOT NULL,
  "termId" TEXT,
  "teacherId" TEXT,
  status TEXT NOT NULL,
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE OR REPLACE FUNCTION public.current_profile_id() RETURNS TEXT
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $fn$
  SELECT id FROM public.profiles WHERE auth_id = auth.uid() LIMIT 1;
$fn$;
CREATE OR REPLACE FUNCTION public.current_profile_role() RETURNS TEXT
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $fn$
  SELECT role FROM public.profiles WHERE auth_id = auth.uid() LIMIT 1;
$fn$;
`;

const SEED = `
INSERT INTO profiles (id, name, email, role, auth_id) VALUES
  ('a1', 'Dr. Admin',  'admin@mbk.edu',   'admin',      '11111111-1111-1111-1111-111111111111'),
  ('s1', 'Mr. Bashir', 'sup@mbk.edu',     'supervisor', '22222222-2222-2222-2222-222222222222'),
  ('t1', 'Fatima Ali', 'fatima@mbk.edu',  'teacher',    '33333333-3333-3333-3333-333333333333'),
  ('t2', 'Omar Hassan','omar@mbk.edu',    'teacher',    '44444444-4444-4444-4444-444444444444');

INSERT INTO academic_years (id, name, "startDate", "endDate", "isCurrent") VALUES
  ('ay1', '2026-2027', '2026-08-01', '2027-07-31', true);

INSERT INTO terms (id, name, "academicYearId", "startDate", "endDate", "isCurrent", months) VALUES
  ('t1', 'Term 1', 'ay1', '2026-09-01', '2026-10-31', true, ARRAY['September','October']);

INSERT INTO subjects (id, name) VALUES
  ('sub-math', 'Mathematics'),
  ('sub-eng',  'English');

-- Grade 7-A has 5 students; s5 has LEFT the school and must be excluded.
INSERT INTO students (id, name, "className", transport) VALUES
  ('s1', 'Ali A.',  'Grade 7-A', NULL),
  ('s2', 'Bilan B.','Grade 7-A', NULL),
  ('s3', 'Cali C.', 'Grade 7-A', NULL),
  ('s4', 'Deeq D.', 'Grade 7-A', NULL),
  ('s5', 'Eyas E.', 'Grade 7-A', 'LEFT'),
  ('s6', 'Farah F.','Grade 8-A', NULL),
  ('s7', 'Guled G.','Grade 8-A', NULL);

INSERT INTO class_subjects (id, "className", "subjectId", "teacherId") VALUES
  ('cs1', 'Grade 7-A', 'sub-math', 't1'),
  ('cs2', 'Grade 7-A', 'sub-eng',  't2'),
  ('cs3', 'Grade 8-A', 'sub-math', 't1');

-- Mathematics / Grade 7-A (teacher t1), September, Term 1:
--   CA + Homework + Classwork for s1,s2,s3 ; Quiz for s1,s2 only.
--   => Monthly entered = s1,s2 (2 of 4) -> in_progress 50%.
INSERT INTO exams (id, "studentId", "subjectId", subject, "examType", month, "termId", "teacherId", status, "createdAt") VALUES
  ('e1',  's1', 'sub-math', 'Mathematics', 'CA',         'September', 't1', 't1', 'approved', '2026-09-10T08:00:00Z'),
  ('e2',  's2', 'sub-math', 'Mathematics', 'CA',         'September', 't1', 't1', 'approved', '2026-09-10T08:00:00Z'),
  ('e3',  's3', 'sub-math', 'Mathematics', 'CA',         'September', 't1', 't1', 'approved', '2026-09-10T08:00:00Z'),
  ('e4',  's1', 'sub-math', 'Mathematics', 'Homework',   'September', 't1', 't1', 'approved', '2026-09-11T08:00:00Z'),
  ('e5',  's2', 'sub-math', 'Mathematics', 'Homework',   'September', 't1', 't1', 'approved', '2026-09-11T08:00:00Z'),
  ('e6',  's3', 'sub-math', 'Mathematics', 'Homework',   'September', 't1', 't1', 'approved', '2026-09-11T08:00:00Z'),
  ('e7',  's1', 'sub-math', 'Mathematics', 'Classwork',  'September', 't1', 't1', 'approved', '2026-09-11T08:00:00Z'),
  ('e8',  's2', 'sub-math', 'Mathematics', 'Classwork',  'September', 't1', 't1', 'approved', '2026-09-11T08:00:00Z'),
  ('e9',  's3', 'sub-math', 'Mathematics', 'Classwork',  'September', 't1', 't1', 'approved', '2026-09-11T08:00:00Z'),
  ('e10', 's1', 'sub-math', 'Mathematics', 'Quiz',       'September', 't1', 't1', 'approved', '2026-09-12T09:00:00Z'),
  ('e11', 's2', 'sub-math', 'Mathematics', 'Quiz',       'September', 't1', 't1', 'approved', '2026-09-12T09:00:00Z'),
  -- Midterm exam for s1,s2,s3 (3 of 4) — used by the exam-type filter test.
  ('e12', 's1', 'sub-math', 'Mathematics', 'Midterm',    'September', 't1', 't1', 'approved', '2026-09-13T09:00:00Z'),
  ('e13', 's2', 'sub-math', 'Mathematics', 'Midterm',    'September', 't1', 't1', 'approved', '2026-09-13T09:00:00Z'),
  ('e14', 's3', 'sub-math', 'Mathematics', 'Midterm',    'September', 't1', 't1', 'approved', '2026-09-13T09:00:00Z');

-- English / Grade 7-A (teacher t2), September, Term 1: full coursework + quiz
-- for all four active students => complete 100%.
INSERT INTO exams (id, "studentId", "subjectId", subject, "examType", month, "termId", "teacherId", status, "createdAt") VALUES
  ('f1', 's1', 'sub-eng', 'English', 'CA',        'September', 't1', 't2', 'approved', '2026-09-10T08:00:00Z'),
  ('f2', 's2', 'sub-eng', 'English', 'CA',        'September', 't1', 't2', 'approved', '2026-09-10T08:00:00Z'),
  ('f3', 's3', 'sub-eng', 'English', 'CA',        'September', 't1', 't2', 'approved', '2026-09-10T08:00:00Z'),
  ('f4', 's4', 'sub-eng', 'English', 'CA',        'September', 't1', 't2', 'approved', '2026-09-10T08:00:00Z'),
  ('f5', 's1', 'sub-eng', 'English', 'Quiz',      'September', 't1', 't2', 'approved', '2026-09-12T09:00:00Z'),
  ('f6', 's2', 'sub-eng', 'English', 'Quiz',      'September', 't1', 't2', 'approved', '2026-09-12T09:00:00Z'),
  ('f7', 's3', 'sub-eng', 'English', 'Quiz',      'September', 't1', 't2', 'approved', '2026-09-12T09:00:00Z'),
  ('f8', 's4', 'sub-eng', 'English', 'Quiz',      'September', 't1', 't2', 'approved', '2026-09-12T09:00:00Z');
-- (Homework + Classwork omitted: CA alone satisfies coursework, so complete.)
`;

const withDb = (await pgliteAvailable()) ? describe : describe.skip;

withDb('get_monitor_marks_entries (executed on real Postgres)', () => {
  async function boot() {
    const { PGlite } = await import('@electric-sql/pglite');
    const pg = await PGlite.create();
    await pg.exec(BASE);
    // The ACTUAL shipped migration, verbatim.
    await pg.exec(readMigration('20260918_monitor_marks_entries.sql'));
    await pg.exec(`
      GRANT USAGE ON SCHEMA public, auth TO authenticated;
      GRANT EXECUTE ON FUNCTION auth.uid(), public.current_profile_id(), public.current_profile_role() TO authenticated;
      GRANT EXECUTE ON FUNCTION public.get_monitor_marks_entries(TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT) TO authenticated;
    `);
    await pg.exec(SEED);
    return {
      pg,
      asUser: async (uid: string | null) => {
        await pg.exec('RESET ROLE');
        await pg.query('SELECT set_config($1, $2, false)', ['app.current_auth_uid', uid ?? '']);
        await pg.exec('SET ROLE authenticated');
      },
      asOwner: async () => {
        await pg.exec('RESET ROLE');
      },
      close: async () => {
        await pg.close();
      },
    };
  }

  type Db = Awaited<ReturnType<typeof boot>>;

  function col(row: Record<string, unknown>, name: string): unknown {
    if (name in row) return row[name];
    const lower = name.toLowerCase();
    if (lower in row) return row[lower];
    const snake = name.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);
    if (snake in row) return row[snake];
    return undefined;
  }

  async function rowsFor(db: Db, params: unknown[], uid: string | null) {
    await db.asUser(uid);
    const res = await db.pg.query(
      'SELECT * FROM get_monitor_marks_entries($1,$2,$3,$4,$5,$6,$7) ORDER BY "className", "subjectId", "teacherId"',
      params
    );
    return res.rows as Array<Record<string, unknown>>;
  }

  const math7 = (rows: Array<Record<string, unknown>>) => {
    const r = rows.find((x) => col(x, 'className') === 'Grade 7-A' && col(x, 'subjectId') === 'sub-math');
    if (!r) throw new Error(`Grade 7-A Mathematics row missing. keys=${rows[0] ? Object.keys(rows[0]).join(',') : 'none'}`);
    return r;
  };
  const eng7 = (rows: Array<Record<string, unknown>>) => {
    const r = rows.find((x) => col(x, 'className') === 'Grade 7-A' && col(x, 'subjectId') === 'sub-eng');
    if (!r) throw new Error('Grade 7-A English row missing');
    return r;
  };
  const math8 = (rows: Array<Record<string, unknown>>) => {
    const r = rows.find((x) => col(x, 'className') === 'Grade 8-A' && col(x, 'subjectId') === 'sub-math');
    if (!r) throw new Error('Grade 8-A Mathematics row missing');
    return r;
  };

  it('returns one row per expected assignment, including Not Started', async () => {
    const db = await boot();
    try {
      const rows = await rowsFor(db, ['t1', 'September', 'Monthly', null, null, null, null], '11111111-1111-1111-1111-111111111111');
      // 3 expected assignments: Grade7A Math, Grade7A Eng, Grade8A Math.
      expect(rows.length).toBe(3);
      expect(math7(rows) && eng7(rows) && math8(rows)).toBeTruthy();
    } finally {
      await db.close();
    }
  });

  it('computes expected students excluding the LEFT student (5 -> 4)', async () => {
    const db = await boot();
    try {
      const rows = await rowsFor(db, ['t1', 'September', 'Monthly', null, null, null, null], '11111111-1111-1111-1111-111111111111');
      expect(Number(col(math7(rows), 'expectedStudents'))).toBe(4);
    } finally {
      await db.close();
    }
  });

  it('marks a partially-entered Monthly assignment as in_progress at 50%', async () => {
    const db = await boot();
    try {
      const rows = await rowsFor(db, ['t1', 'September', 'Monthly', null, null, null, null], '11111111-1111-1111-1111-111111111111');
      const m = math7(rows);
      expect(Number(col(m, 'enteredStudents'))).toBe(2); // s1,s2 have coursework AND quiz
      expect(Number(col(m, 'expectedStudents'))).toBe(4);
      expect(Number(col(m, 'completionPercent'))).toBe(50);
      expect(col(m, 'status')).toBe('in_progress');
      // lastUpdate is the latest createdAt among the September exams.
      expect(col(m, 'lastUpdate')).not.toBeNull();
    } finally {
      await db.close();
    }
  });

  it('marks a fully-entered assignment as complete at 100%', async () => {
    const db = await boot();
    try {
      const rows = await rowsFor(db, ['t1', 'September', 'Monthly', null, null, null, null], '11111111-1111-1111-1111-111111111111');
      const e = eng7(rows);
      expect(Number(col(e, 'enteredStudents'))).toBe(4);
      expect(Number(col(e, 'expectedStudents'))).toBe(4);
      expect(Number(col(e, 'completionPercent'))).toBe(100);
      expect(col(e, 'status')).toBe('complete');
    } finally {
      await db.close();
    }
  });

  it('shows Not Started with 0 entered and null lastUpdate for an unentered assignment', async () => {
    const db = await boot();
    try {
      const rows = await rowsFor(db, ['t1', 'September', 'Monthly', null, null, null, null], '11111111-1111-1111-1111-111111111111');
      const m8 = math8(rows);
      expect(Number(col(m8, 'enteredStudents'))).toBe(0);
      expect(Number(col(m8, 'expectedStudents'))).toBe(2);
      expect(col(m8, 'status')).toBe('not_started');
      expect(col(m8, 'lastUpdate')).toBeNull();
    } finally {
      await db.close();
    }
  });

  it('filters by exam type: Midterm counts only Midterm rows (3 of 4)', async () => {
    const db = await boot();
    try {
      const rows = await rowsFor(db, ['t1', 'September', 'Midterm', null, null, null, null], '11111111-1111-1111-1111-111111111111');
      const m = math7(rows);
      expect(Number(col(m, 'enteredStudents'))).toBe(3);
      expect(Number(col(m, 'expectedStudents'))).toBe(4);
      expect(col(m, 'status')).toBe('in_progress');
    } finally {
      await db.close();
    }
  });

  it('returns nothing for an unknown/unauthorised role', async () => {
    const db = await boot();
    try {
      const rows = await rowsFor(db, ['t1', 'September', 'Monthly', null, null, null, null], null);
      expect(rows).toEqual([]);
    } finally {
      await db.close();
    }
  });

  it('scopes a teacher to their own assignments only', async () => {
    const db = await boot();
    try {
      // Logged in as teacher t1 (Fatima): only her two math assignments.
      const rows = await rowsFor(db, ['t1', 'September', 'Monthly', null, null, null, null], '33333333-3333-3333-3333-333333333333');
      expect(rows.length).toBe(2);
      expect(rows.every((r) => col(r, 'teacherId') === 't1')).toBe(true);
      expect(rows.some((r) => col(r, 'subjectId') === 'sub-eng')).toBe(false);
    } finally {
      await db.close();
    }
  });

  it('supports the status filter (complete only)', async () => {
    const db = await boot();
    try {
      const rows = await rowsFor(db, ['t1', 'September', 'Monthly', null, null, null, 'complete'], '11111111-1111-1111-1111-111111111111');
      expect(rows.length).toBe(1);
      expect(col(rows[0], 'status')).toBe('complete');
      expect(col(rows[0], 'className')).toBe('Grade 7-A');
      expect(col(rows[0], 'subjectId')).toBe('sub-eng');
    } finally {
      await db.close();
    }
  });

  it('filters by class (Grade 8-A only) for the admin', async () => {
    const db = await boot();
    try {
      const rows = await rowsFor(db, ['t1', 'September', 'Monthly', null, 'Grade 8-A', null, null], '11111111-1111-1111-1111-111111111111');
      expect(rows.length).toBe(1);
      expect(col(rows[0], 'className')).toBe('Grade 8-A');
    } finally {
      await db.close();
    }
  });
});
