// Real-PostgreSQL test for the submission tracker's teacher-roster RPC.
//
// PGlite is an actual PostgreSQL engine, so the ACTUAL shipped migration file
// is EXECUTED here (function body, role gate, grants) on top of a profiles
// table shaped like the shipped one (role + "assignedClasses" JSONB). That
// proves:
//   * list_lesson_plan_submitters returns one row per (teacher, assigned
//     class), normalising role casing/whitespace,
//   * teachers without assigned classes are NOT expected submitters,
//   * only supervisor/admin callers get the roster — every other role gets
//     an empty result,
//   * the SECURITY DEFINER read works for supervisors even though profiles
//     RLS denies them a direct SELECT (the reason the RPC exists),
//   * nothing is written.
//
// HONEST LIMITATIONS (same as lesson-plan-weeks.db.test.ts):
//   1. PGlite does not reproduce Supabase's PostgREST/JWT plumbing.
//   2. The live profiles policies are modeled here as "RLS enabled, no
//      SELECT policy for authenticated" — the strictest documented reading
//      of 20260708_profiles_auth_session_rls (own profile + admin).

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
  "assignedClasses" JSONB,
  auth_id UUID
);

-- The repo's standard security bridge (20260708_profiles_auth_session_rls.sql).
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
INSERT INTO profiles (id, name, email, role, "assignedClasses", auth_id) VALUES
  ('t1', 'Ms. Fatima',  'fatima@mbk.edu',  'teacher',    '["Grade 1-A"]',             '11111111-1111-1111-1111-111111111111'),
  ('t2', 'Mr. Omar',    'omar@mbk.edu',    'teacher',    '["Grade 2-C", "Grade 3-B"]','22222222-2222-2222-2222-222222222222'),
  -- Padded/cased role still identifies a teacher (getUsersByRole parity).
  ('t4', 'Mr. Caps',    'caps@mbk.edu',    ' Teacher ',  '["Grade 4-A"]',             '44444444-4444-4444-4444-444444444444'),
  -- A teacher with no assigned classes cannot submit plans in their planner,
  -- so they must not be flagged "Not Submitted".
  ('t3', 'Ms. Hodan',   'hodan@mbk.edu',   'teacher',    NULL,                        '55555555-5555-5555-5555-555555555555'),
  ('t5', 'Ms. Odd',     'odd@mbk.edu',     'teacher',    '"not-an-array"',            '66666666-6666-6666-6666-666666666666'),
  ('s1', 'Mr. Bashir',  'sup@mbk.edu',     'supervisor', '[]',                        '33333333-3333-3333-3333-333333333333'),
  ('a1', 'Dr. Admin',   'admin@mbk.edu',   'admin',      NULL,                        '77777777-7777-7777-7777-777777777777'),
  ('p1', 'Maxamed H.',  'parent@mbk.edu',  'parent',     NULL,                        '88888888-8888-8888-8888-888888888888'),
  ('o1', 'Front Desk',  'office@mbk.edu',  'office',     NULL,                        '99999999-9999-9999-9999-999999999999');
`;

const withDb = (await pgliteAvailable()) ? describe : describe.skip;

withDb('list_lesson_plan_submitters (executed on real Postgres)', () => {
  async function boot(opts: { profilesRlsDenied?: boolean } = {}) {
    const { PGlite } = await import('@electric-sql/pglite');
    const pg = await PGlite.create();
    await pg.exec(BASE);

    // The ACTUAL shipped migration, verbatim (function + role gate + grants).
    await pg.exec(readMigration('20260915_lesson_plan_submission_tracking.sql'));

    await pg.exec(`
      GRANT USAGE ON SCHEMA public, auth TO authenticated;
      GRANT SELECT ON public.profiles TO authenticated;
      GRANT EXECUTE ON FUNCTION auth.uid(), public.current_profile_id(), public.current_profile_role() TO authenticated;
    `);

    // Strictest documented profiles RLS: authenticated can read nothing
    // directly (own profile + admin only in production).
    if (opts.profilesRlsDenied) {
      await pg.exec(`
        ALTER TABLE profiles ENABLE ROW LEVEL SECURITY;
      `);
    }

    await pg.exec(SEED);

    return {
      pg,
      asUser: async (uid: string | null) => {
        await pg.exec('RESET ROLE');
        await pg.query('SELECT set_config($1,$2,false)', ['app.current_auth_uid', uid ?? '']);
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

  async function submittersFor(db: Db): Promise<Array<[string, string, string]>> {
    const res = await db.pg.query(
      'SELECT teacher_id, teacher_name, class_name FROM list_lesson_plan_submitters() ORDER BY teacher_id, class_name'
    );
    return (res.rows as Array<{ teacher_id: string; teacher_name: string; class_name: string }>).map((row) => [
      row.teacher_id,
      row.teacher_name,
      row.class_name,
    ]);
  }

  it('returns one row per teacher and assigned class, for the supervisor', async () => {
    const db = await boot();
    try {
      await db.asUser('33333333-3333-3333-3333-333333333333'); // supervisor
      expect(await submittersFor(db)).toEqual([
        ['t1', 'Ms. Fatima', 'Grade 1-A'],
        ['t2', 'Mr. Omar', 'Grade 2-C'],
        ['t2', 'Mr. Omar', 'Grade 3-B'],
        ['t4', 'Mr. Caps', 'Grade 4-A'], // padded/cased role still a teacher
      ]);
    } finally {
      await db.close();
    }
  });

  it('returns the same roster for the admin', async () => {
    const db = await boot();
    try {
      await db.asUser('77777777-7777-7777-7777-777777777777'); // admin
      const rows = await submittersFor(db);
      expect(rows.map(([id]) => id).sort()).toEqual(['t1', 't2', 't2', 't4']);
    } finally {
      await db.close();
    }
  });

  it('excludes teachers with no usable assigned classes — they cannot be "Not Submitted"', async () => {
    const db = await boot();
    try {
      await db.asUser('33333333-3333-3333-3333-333333333333');
      const rows = await submittersFor(db);
      expect(rows.some(([id]) => id === 't3')).toBe(false); // NULL classes
      expect(rows.some(([id]) => id === 't5')).toBe(false); // non-array JSONB
      expect(rows.some(([id]) => id === 's1')).toBe(false); // supervisor
      expect(rows.some(([id]) => id === 'a1')).toBe(false); // admin
      expect(rows.some(([id]) => id === 'p1')).toBe(false); // parent
    } finally {
      await db.close();
    }
  });

  it('returns nothing for every other role — the roster is supervisor/admin only', async () => {
    const db = await boot();
    try {
      for (const uid of [
        '11111111-1111-1111-1111-111111111111', // teacher
        '88888888-8888-8888-8888-888888888888', // parent
        '99999999-9999-9999-9999-999999999999', // office
      ]) {
        await db.asUser(uid);
        expect(await submittersFor(db)).toEqual([]);
      }
      // And with no authenticated profile at all.
      await db.asUser(null);
      expect(await submittersFor(db)).toEqual([]);
    } finally {
      await db.close();
    }
  });

  it('reads the roster for a supervisor even where profiles RLS denies a direct SELECT', async () => {
    const db = await boot({ profilesRlsDenied: true });
    try {
      await db.asUser('33333333-3333-3333-3333-333333333333'); // supervisor
      // The direct read is blocked — this is why the RPC exists.
      const direct = await db.pg.query('SELECT count(*)::INT AS n FROM profiles');
      expect((direct.rows as Array<{ n: number }>)[0].n).toBe(0);
      // The RPC still returns the roster.
      expect((await submittersFor(db)).length).toBe(4);
    } finally {
      await db.close();
    }
  });

  it('writes nothing', async () => {
    const db = await boot();
    try {
      await db.asOwner();
      const fingerprint = async () => {
        const res = await db.pg.query(
          `SELECT count(*)::INT AS n,
                  coalesce(md5(string_agg(id || role || coalesce("assignedClasses"::text, '~'), ',' ORDER BY id)), '') AS hash
           FROM profiles`
        );
        return (res.rows as Array<{ n: number; hash: string }>)[0];
      };

      const before = await fingerprint();
      await db.asUser('33333333-3333-3333-3333-333333333333');
      await submittersFor(db);
      await db.asUser('77777777-7777-7777-7777-777777777777');
      await submittersFor(db);
      await db.asOwner();
      expect(await fingerprint()).toEqual(before);
    } finally {
      await db.close();
    }
  });
});
