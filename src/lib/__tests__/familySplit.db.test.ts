// @vitest-environment node
//
// Real-PostgreSQL (PGlite) test for split_family_members().
//
// The split is a write path that can move a child onto a different dismissal
// card, so its guards must be executed, not inferred:
//   * admin + office only (office was granted the repair on 2026-11-09),
//   * every selected student must currently be in the family being split,
//   * a family must keep at least one student,
//   * the new number is allocated (MAX+1, 4 digits) under the generator lock,
//   * ONLY "familyId" changes — parent account and transport are untouched,
//   * an audit row is written,
//   * a malformed historical ID cannot brick the allocation.
//
// The harness loads the ACTUAL shipped migration file, so a failure means the
// shipped SQL is wrong, not a copy of it.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../../..');
// Applied in order: the feature, then the migration that opens it to office.
const MIGRATIONS = [
  '20261109_split_family_members.sql',
  '20261109b_office_split_family.sql',
].map(name => fs.readFileSync(path.join(ROOT, 'supabase/migrations', name), 'utf8'));

const ADMIN_UID = '11111111-1111-1111-1111-111111111111';
const OFFICE_UID = '22222222-2222-2222-2222-222222222222';
const TEACHER_UID = '33333333-3333-3333-3333-333333333333';

let pg: any;

async function runAs(uid: string | null) {
  await pg.exec('RESET ROLE');
  await pg.query('SELECT set_config($1, $2, false)', ['request.jwt.claim.sub', uid ?? '']);
  if (uid) await pg.exec('SET ROLE authenticated');
}

async function split(familyId: string, ids: string[]) {
  const res = await pg.query('SELECT public.split_family_members($1, $2) AS result', [familyId, ids]);
  const result = res.rows[0].result;
  return typeof result === 'string' ? JSON.parse(result) : result;
}

async function splitError(familyId: string, ids: string[]): Promise<string> {
  try {
    await split(familyId, ids);
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
  throw new Error('expected split_family_members to fail');
}

async function familyOf(studentId: string): Promise<string | null> {
  const res = await pg.query('SELECT "familyId" FROM public.students WHERE id = $1', [studentId]);
  return res.rows[0]?.['familyId'] ?? null;
}

beforeAll(async () => {
  const { PGlite } = await import('@electric-sql/pglite');
  pg = await PGlite.create();

  await pg.exec(`
    DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
        CREATE ROLE authenticated NOLOGIN;
      END IF;
    END $$;
    CREATE SCHEMA auth;
    CREATE TABLE auth.users (id UUID PRIMARY KEY);
    CREATE OR REPLACE FUNCTION auth.uid() RETURNS UUID
      LANGUAGE sql STABLE AS $$ SELECT NULLIF(current_setting('request.jwt.claim.sub', true), '')::UUID $$;

    CREATE TABLE public.profiles (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      role TEXT NOT NULL,
      auth_id UUID
    );

    -- Production security bridge (copied unchanged from 20260708).
    CREATE OR REPLACE FUNCTION public.current_profile_id() RETURNS TEXT
      LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
        SELECT id FROM public.profiles WHERE auth_id = auth.uid() LIMIT 1
      $$;
    CREATE OR REPLACE FUNCTION public.current_profile_role() RETURNS TEXT
      LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
        SELECT role FROM public.profiles WHERE auth_id = auth.uid() LIMIT 1
      $$;

    -- Helpers the split RPC depends on (copied unchanged from 20260802).
    CREATE OR REPLACE FUNCTION public.normalize_phone(p_raw TEXT) RETURNS TEXT
      LANGUAGE sql IMMUTABLE SET search_path = public AS $$
        SELECT CASE WHEN p_raw IS NULL THEN '' ELSE
          regexp_replace(regexp_replace(p_raw, '\\D', '', 'g'), '^252(\\d{9})$', '\\1') END
      $$;
    CREATE OR REPLACE FUNCTION public.normalize_family_id(p_raw TEXT) RETURNS TEXT
      LANGUAGE sql IMMUTABLE SET search_path = public AS $$
        SELECT regexp_replace(COALESCE(p_raw, ''), '\\D', '', 'g')
      $$;

    CREATE TABLE public.students (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      "className" TEXT NOT NULL,
      "parentId" TEXT REFERENCES public.profiles(id) ON DELETE SET NULL,
      "govId" TEXT,
      "parentPhone" TEXT,
      transport TEXT,
      "familyId" TEXT,
      "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE public.audit_logs (
      id BIGSERIAL PRIMARY KEY,
      action TEXT NOT NULL,
      details JSONB DEFAULT '{}'::jsonb,
      "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    GRANT USAGE ON SCHEMA public, auth TO authenticated;
    GRANT EXECUTE ON FUNCTION auth.uid(), public.current_profile_id(), public.current_profile_role() TO authenticated;
    -- Harness only: assertions and fixture updates read/write these tables
    -- directly. Production reaches them through RLS policies + SECURITY
    -- DEFINER RPCs (the RPC itself is what is under test here).
    GRANT SELECT, INSERT, UPDATE ON public.students TO authenticated;
    GRANT SELECT ON public.audit_logs TO authenticated;
  `);

  await pg.query('INSERT INTO auth.users(id) VALUES ($1),($2),($3)', [ADMIN_UID, OFFICE_UID, TEACHER_UID]);
  await pg.query(`
    INSERT INTO public.profiles(id,name,role,auth_id) VALUES
      ('admin-1','Admin','admin',$1),
      ('office-1','Office','office',$2),
      ('teacher-1','Teacher','teacher',$3),
      ('parent-a','ikraan cabdi khaliif','parent',NULL),
      ('parent-b','ikraanmaxmedaxmed','parent',NULL)
  `, [ADMIN_UID, OFFICE_UID, TEACHER_UID]);

  // The reported family: 8 students, two parent accounts and one unparented
  // student, all on MBK-0305.
  await pg.query(`
    INSERT INTO public.students(id,name,"className","parentId","parentPhone",transport,"familyId") VALUES
      ('s-akram','Akram salebaan cabdi','Grade 2-B','parent-b',NULL,'WALKER','0305'),
      ('s-safa','Safa sulayman cabdi','Grade 9-A','parent-b',NULL,'WALKER','0305'),
      ('s-sudaysi','Sudaysi sulayman cabdi','Grade 9-B','parent-b',NULL,'WALKER','0305'),
      ('s-marwa','Marwa suleban cabdi','Grade 6-B',NULL,NULL,'WALKER','0305'),
      ('s-barwaaqo','barwaaqo maxamed heeban','Grade 2-C','parent-a',NULL,'DRIVER','0305'),
      ('s-cabdiraxmaan','Cabdiraxmaan Maxamed Heebaan','Grade 6-A','parent-a','4474422','DRIVER','0305'),
      ('s-cabdiwaasac','CabdiWaasac Maxamed Heebaan','Grade 4-B','parent-a',NULL,'DRIVER','0305'),
      ('s-cawale','Cawale Maxamed Heebaan','Grade 8-B','parent-a','634506719','DRIVER','0305'),
      ('s-other','Other Family Child','Grade 3-A','parent-a',NULL,'WALKER','0678')
  `);

  for (const migration of MIGRATIONS) await pg.exec(migration);
  await runAs(ADMIN_UID);
});

afterAll(async () => { await pg?.close(); });

describe('split_family_members (20261109)', () => {
  it('refuses callers that are neither admin nor office, and writes nothing', async () => {
    for (const uid of [TEACHER_UID, null]) {
      await runAs(uid);
      const message = await splitError('0305', ['s-akram']);
      expect(message).toMatch(/only administrators or office users may split/i);
    }
    await runAs(ADMIN_UID);
    expect(await familyOf('s-akram')).toBe('0305');

    const after = await pg.query(`SELECT count(*)::int AS n FROM public.audit_logs WHERE action = 'family_ids.split'`);
    expect(after.rows[0].n).toBe(0);
  });

  it('lets OFFICE staff split the reported family, audited with their role', async () => {
    await runAs(OFFICE_UID);
    const result = await split('MBK-0305', ['s-akram', 's-safa', 's-sudaysi', 's-marwa']);

    // 0678 is the highest existing number -> 0679.
    expect(result).toMatchObject({ familyId: '0305', newFamilyId: '0679', studentsMoved: 4, remaining: 4 });

    expect(await familyOf('s-akram')).toBe('0679');
    expect(await familyOf('s-safa')).toBe('0679');
    expect(await familyOf('s-sudaysi')).toBe('0679');
    expect(await familyOf('s-marwa')).toBe('0679');

    expect(await familyOf('s-barwaaqo')).toBe('0305');
    expect(await familyOf('s-cabdiraxmaan')).toBe('0305');
    expect(await familyOf('s-cawale')).toBe('0305');

    // Only familyId changes: parent account, phone, transport are untouched.
    const kept = await pg.query(
      `SELECT "parentId", "parentPhone", transport FROM public.students WHERE id = 's-cabdiraxmaan'`,
    );
    expect(kept.rows[0]).toMatchObject({ parentId: 'parent-a', parentPhone: '4474422', transport: 'DRIVER' });

    const moved = await pg.query(
      `SELECT "parentId", transport FROM public.students WHERE id = 's-safa'`,
    );
    expect(moved.rows[0]).toMatchObject({ parentId: 'parent-b', transport: 'WALKER' });

    // Audited, including who acted and in what role.
    const audit = await pg.query(
      `SELECT details FROM public.audit_logs WHERE action = 'family_ids.split' ORDER BY id DESC LIMIT 1`,
    );
    expect(audit.rows[0].details).toMatchObject({
      by: 'office-1',
      byRole: 'office',
      familyId: '0305',
      newFamilyId: '0679',
      studentsMoved: 4,
      remaining: 4,
    });
  });

  it('rejects a student who is not in the family being split', async () => {
    await runAs(OFFICE_UID);
    const message = await splitError('0305', ['s-akram']); // now in 0679
    expect(message).toMatch(/currently in family 0305/i);
    expect(await familyOf('s-akram')).toBe('0679');
  });

  it('rejects moving the whole family', async () => {
    await runAs(OFFICE_UID);
    const message = await splitError('0305', ['s-barwaaqo', 's-cabdiraxmaan', 's-cabdiwaasac', 's-cawale']);
    expect(message).toMatch(/leave at least one student/i);
    expect(await familyOf('s-barwaaqo')).toBe('0305');
  });

  it('ignores a malformed historical ID when allocating the next number', async () => {
    await runAs(ADMIN_UID);
    // The old override bug allowed IDs longer than 4 digits; they must not
    // break MAX()::INTEGER for this or any later split.
    await pg.query(`INSERT INTO public.students(id,name,"className",transport,"familyId") VALUES
      ('s-bad','Bad Legacy Id','Grade 1-A','WALKER','123456789012')`);

    const result = await split('0679', ['s-marwa']);
    expect(result.newFamilyId).toBe('0680');
    expect(result.remaining).toBe(3);
    expect(await familyOf('s-marwa')).toBe('0680');
  });

  it('still lets admins split', async () => {
    await runAs(ADMIN_UID);
    const result = await split('0679', ['s-safa']);
    expect(result).toMatchObject({ newFamilyId: '0681', studentsMoved: 1, remaining: 2 });
    expect(await familyOf('s-safa')).toBe('0681');
  });
});
