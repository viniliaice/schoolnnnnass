// @vitest-environment node
// Validates the NEW academic-reminder migration against PostgreSQL semantics
// using PGlite. Hosted Supabase/PostgREST deployment still needs verification.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../../..');
const MIGRATION = fs.readFileSync(path.join(ROOT, 'supabase/migrations/20261007_teacher_academic_reminders.sql'), 'utf8');

const ADMIN_UID = '11111111-1111-1111-1111-111111111111';
const TEACHER_UID = '22222222-2222-2222-2222-222222222222';
const SUPERVISOR_UID = '33333333-3333-3333-3333-333333333333';

let pg: any;

async function runAs(uid: string | null, role: string) {
  await pg.exec('RESET ROLE');
  await pg.query('SELECT set_config($1, $2, false)', ['request.jwt.claim.sub', uid ?? '']);
  await pg.query('SELECT set_config($1, $2, false)', ['request.jwt.claim.role', role]);
  await pg.query('SELECT set_config($1, $2, false)', ['request.jwt.claims', JSON.stringify({ sub: uid, role })]);
  if (role === 'authenticated') await pg.exec('SET ROLE authenticated');
}

beforeAll(async () => {
  const { PGlite } = await import('@electric-sql/pglite');
  pg = await PGlite.create();
  await pg.exec(`
    DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN CREATE ROLE authenticated NOLOGIN; END IF;
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN CREATE ROLE service_role NOLOGIN; END IF;
    END $$;
    CREATE SCHEMA auth;
    CREATE TABLE auth.users (id UUID PRIMARY KEY);
    CREATE OR REPLACE FUNCTION auth.uid() RETURNS UUID
      LANGUAGE sql STABLE AS $$ SELECT NULLIF(current_setting('request.jwt.claim.sub', true), '')::UUID $$;
    CREATE OR REPLACE FUNCTION auth.role() RETURNS TEXT
      LANGUAGE sql STABLE AS $$ SELECT NULLIF(current_setting('request.jwt.claim.role', true), '') $$;

    CREATE TABLE public.profiles (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      email TEXT NOT NULL UNIQUE,
      role TEXT NOT NULL,
      auth_id UUID REFERENCES auth.users(id),
      "assignedClasses" JSONB NOT NULL DEFAULT '[]'::jsonb
    );
    CREATE OR REPLACE FUNCTION public.current_profile_id() RETURNS TEXT
      LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
        SELECT id FROM public.profiles WHERE auth_id = auth.uid() LIMIT 1
      $$;
    CREATE OR REPLACE FUNCTION public.current_profile_role() RETURNS TEXT
      LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
        SELECT role FROM public.profiles WHERE auth_id = auth.uid() LIMIT 1
      $$;

    CREATE TABLE public.notifications (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      body TEXT NOT NULL,
      url TEXT,
      category TEXT NOT NULL,
      sender_id TEXT REFERENCES public.profiles(id) ON DELETE SET NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE TABLE public.notification_recipients (
      id TEXT PRIMARY KEY,
      notification_id TEXT NOT NULL REFERENCES public.notifications(id) ON DELETE CASCADE,
      user_id TEXT NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
      status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','sent','failed','no_devices','skipped')),
      delivered_devices INTEGER NOT NULL DEFAULT 0,
      failed_devices INTEGER NOT NULL DEFAULT 0,
      last_error TEXT,
      read_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (notification_id, user_id)
    );
    CREATE TABLE public.notification_preferences (
      user_id TEXT PRIMARY KEY REFERENCES public.profiles(id) ON DELETE CASCADE,
      push_enabled BOOLEAN NOT NULL DEFAULT TRUE,
      announcements BOOLEAN NOT NULL DEFAULT TRUE,
      messages BOOLEAN NOT NULL DEFAULT TRUE,
      lesson_plan_reminders BOOLEAN NOT NULL DEFAULT TRUE,
      admin_alerts BOOLEAN NOT NULL DEFAULT TRUE,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE FUNCTION public.monitor_marks_entries(
      p_academic_year_id TEXT, p_term_id TEXT, p_exam_scope TEXT DEFAULT 'monthly',
      p_month TEXT DEFAULT NULL, p_teacher_id TEXT DEFAULT NULL,
      p_class_name TEXT DEFAULT NULL, p_subject_id TEXT DEFAULT NULL
    ) RETURNS TABLE (
      assignment_id TEXT, teacher_id TEXT, teacher_name TEXT, class_name TEXT,
      subject_id TEXT, subject_name TEXT, academic_year_id TEXT, term_id TEXT,
      exam_scope TEXT, month TEXT, expected_students INTEGER, entered_students INTEGER,
      missing_students JSONB, percentage NUMERIC, completion_status TEXT,
      last_updated TIMESTAMPTZ, ca_entered INTEGER, homework_entered INTEGER,
      homework_ca_entered INTEGER, classwork_entered INTEGER, quiz_entered INTEGER, attendance_entered INTEGER,
      coursework_complete BOOLEAN, quiz_complete BOOLEAN, monthly_complete_students INTEGER
    ) LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
      SELECT public.current_profile_role(), 'teacher-1', 'Teacher One', 'Grade 8-A',
        'english', 'English', p_academic_year_id, p_term_id, p_exam_scope, p_month,
        1, 0, '[]'::jsonb, 0::numeric, 'not_started', NULL::timestamptz,
        0, 0, 0, 0, 0, 0, FALSE, FALSE, 0
    $$;

    GRANT USAGE ON SCHEMA public, auth TO authenticated, service_role;
    GRANT EXECUTE ON FUNCTION auth.uid(), auth.role(), public.current_profile_id(), public.current_profile_role() TO authenticated, service_role;
  `);

  await pg.query('INSERT INTO auth.users(id) VALUES ($1),($2),($3)', [ADMIN_UID, TEACHER_UID, SUPERVISOR_UID]);
  await pg.query(`
    INSERT INTO public.profiles(id,name,email,role,auth_id,"assignedClasses") VALUES
      ('admin-1','Admin','admin@example.test','admin',$1,'[]'::jsonb),
      ('teacher-1','Teacher','teacher@example.test','teacher',$2,'["Grade 8-A"]'::jsonb),
      ('supervisor-1','Supervisor','supervisor@example.test','supervisor',$3,'["Grade 8-A"]'::jsonb)
  `, [ADMIN_UID, TEACHER_UID, SUPERVISOR_UID]);

  await pg.exec(MIGRATION);
});

afterAll(async () => {
  await pg?.close();
});

describe('20261007 academic reminder migration', () => {
  it('adds independent defaults for the two reminder types', async () => {
    const scheduleRows = await pg.query(`SELECT reminder_type, enabled, timezone, days_of_week, send_time, exam_scope FROM public.academic_reminder_schedules ORDER BY reminder_type`);
    expect(scheduleRows.rows).toHaveLength(2);
    expect(scheduleRows.rows.map((row: any) => row.reminder_type)).toEqual(['lesson_plan_reminder', 'marks_entry_reminder']);
    expect(scheduleRows.rows[0]).toMatchObject({ enabled: true, timezone: 'Africa/Mogadishu', exam_scope: 'monthly' });
    expect(scheduleRows.rows.find((row: any) => row.reminder_type === 'marks_entry_reminder').days_of_week).toEqual([0, 1, 2, 3, 4, 5, 6]);
    await pg.query(`INSERT INTO public.notification_preferences (user_id) VALUES ('teacher-1')`);
    const preference = await pg.query(`SELECT marks_entry_reminders FROM public.notification_preferences WHERE user_id = 'teacher-1'`);
    expect(preference.rows).toEqual([{ marks_entry_reminders: true }]);
  });

  it('allows staff to read schedules but hides them from teacher sessions via RLS', async () => {
    await runAs(TEACHER_UID, 'authenticated');
    const teacherRows = await pg.query('SELECT reminder_type FROM public.academic_reminder_schedules ORDER BY reminder_type');
    expect(teacherRows.rows).toEqual([]);

    await runAs(SUPERVISOR_UID, 'authenticated');
    const supervisorRows = await pg.query('SELECT reminder_type FROM public.academic_reminder_schedules ORDER BY reminder_type');
    expect(supervisorRows.rows).toHaveLength(2);
    await pg.exec('RESET ROLE');
  });

  it('atomically claims the same deduplication event once and rejects browser-role claims', async () => {
    await pg.query(`
      INSERT INTO public.notifications(id,title,body,category) VALUES
        ('notice-1','Lesson reminder','Incomplete','lesson_plan_reminder'),
        ('notice-2','Lesson reminder','Retry','lesson_plan_reminder')
    `);
    const row = {
      id: 'recipient-1',
      notification_id: 'notice-1',
      user_id: 'teacher-1',
      status: 'pending',
      reminder_type: 'lesson_plan_reminder',
      academic_period: 'year-2026:2026-W10',
      relevant_entity: '["plan-1"]',
      reminder_occurrence: 'scheduled:lesson_plan_reminder:reminder:2026-10-07:16:00@Africa/Mogadishu',
      reminder_stage: 'reminder',
      deduplication_key: 'dedupe-key-one',
    };
    await runAs(null, 'service_role');
    const first = await pg.query('SELECT id,user_id,reminder_stage,deduplication_key FROM public.claim_academic_reminder_recipients($1::jsonb)', [JSON.stringify([row])]);
    expect(first.rows).toEqual([{ id: 'recipient-1', user_id: 'teacher-1', reminder_stage: 'reminder', deduplication_key: 'dedupe-key-one' }]);
    const retry = await pg.query('SELECT id FROM public.claim_academic_reminder_recipients($1::jsonb)', [JSON.stringify([{ ...row, id: 'recipient-2', notification_id: 'notice-2' }])]);
    expect(retry.rows).toEqual([]);
    const persisted = await pg.query(`SELECT count(*)::int AS count FROM public.notification_recipients WHERE deduplication_key = 'dedupe-key-one'`);
    expect(persisted.rows[0].count).toBe(1);

    await runAs(TEACHER_UID, 'authenticated');
    await expect(pg.query('SELECT * FROM public.claim_academic_reminder_recipients($1::jsonb)', [JSON.stringify([row])])).rejects.toThrow();
    await pg.exec('RESET ROLE');
  });

  it('restricts the marks monitor wrapper to service role and invokes the authoritative RPC as an admin', async () => {
    await runAs(TEACHER_UID, 'authenticated');
    await expect(pg.query(`SELECT * FROM public.monitor_marks_entries_for_reminders('year-1','term-1','monthly','October')`)).rejects.toThrow();

    await runAs(null, 'service_role');
    const result = await pg.query(`SELECT * FROM public.monitor_marks_entries_for_reminders('year-1','term-1','monthly','October')`);
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]).toMatchObject({ assignment_id: 'admin', teacher_id: 'teacher-1', class_name: 'Grade 8-A' });
    const roleAfter = await pg.query(`SELECT auth.role() AS role, auth.uid() AS user_id`);
    expect(roleAfter.rows[0].role).toBe('service_role');
    expect(roleAfter.rows[0].user_id).toBeNull();
    await pg.exec('RESET ROLE');
  });
});
