// @vitest-environment node
//
// Behavioral RLS proof for the push-notification tables. Loads the ACTUAL
// migration (20261005_push_notifications.sql) into a real PGlite Postgres and
// runs statements as a non-owner `authenticated` role — exactly how Supabase
// PostgREST clients experience RLS. Asserts:
//   * a teacher can only write/read their OWN subscriptions & preferences;
//   * the endpoint uniqueness prevents duplicate device rows;
//   * notification history is only visible to staff and actual recipients;
//   * current_session_context() resolves role from the auth bridge.
//
// LIMITATION (stated honestly): PGlite reproduces Postgres RLS/trigger
// semantics but not the hosted Supabase PostgREST/JWT plumbing — that remains
// to be verified against the live database.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, beforeAll, afterAll } from 'vitest';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '../../..');
const MIGRATION = fs.readFileSync(
  path.join(REPO_ROOT, 'supabase/migrations/20261005_push_notifications.sql'),
  'utf8',
);

const ADMIN_UID = '11111111-1111-1111-1111-111111111111';
const TEACHER_UID = '22222222-2222-2222-2222-222222222222';
const OTHER_UID = '33333333-3333-3333-3333-333333333333';

interface Db {
  query: (sql: string, params?: unknown[]) => Promise<{ rows: any[] }>;
  exec: (sql: string) => Promise<void>;
  asUser: (uid: string | null) => Promise<void>;
  close: () => Promise<void>;
}

let db: Db;

beforeAll(async () => {
  const { PGlite } = await import('@electric-sql/pglite');
  const pg = await PGlite.create();

  await pg.exec(`
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
      id TEXT PRIMARY KEY, name TEXT NOT NULL, email TEXT NOT NULL UNIQUE,
      role TEXT NOT NULL CHECK (role IN ('admin','teacher','parent','supervisor','office')),
      auth_id UUID
    );
    CREATE OR REPLACE FUNCTION public.current_profile_id() RETURNS TEXT
    LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $fn$
      SELECT id FROM public.profiles WHERE auth_id = auth.uid() LIMIT 1;
    $fn$;
    CREATE OR REPLACE FUNCTION public.current_profile_role() RETURNS TEXT
    LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $fn$
      SELECT role FROM public.profiles WHERE auth_id = auth.uid() LIMIT 1;
    $fn$;
  `);

  // Seed the three app profiles used by the scenarios.
  await pg.query(
    `INSERT INTO profiles (id, name, email, role, auth_id) VALUES
      ('admin-1', 'Admin', 'admin@x.io', 'admin', $1),
      ('teacher-1', 'Fatima', 'fatima@x.io', 'teacher', $2),
      ('teacher-2', 'Omar', 'omar@x.io', 'teacher', $3)`,
    [ADMIN_UID, TEACHER_UID, OTHER_UID],
  );

  // The artifact under test.
  await pg.exec(MIGRATION);

  await pg.exec(`
    GRANT USAGE ON SCHEMA public, auth TO authenticated;
    GRANT SELECT, INSERT, UPDATE, DELETE ON public.push_subscriptions TO authenticated;
    GRANT SELECT, INSERT, UPDATE ON public.notification_preferences TO authenticated;
    GRANT SELECT ON public.notifications TO authenticated;
    GRANT SELECT, UPDATE ON public.notification_recipients TO authenticated;
    GRANT EXECUTE ON FUNCTION public.current_profile_id(), public.current_profile_role(),
      public.current_session_context(), auth.uid() TO authenticated;
  `);

  db = {
    query: async (sql, params) => {
      const res = await pg.query(sql, params as unknown[] | undefined);
      return { rows: (res.rows ?? []) as any[] };
    },
    exec: async (sql) => {
      await pg.exec(sql);
    },
    asUser: async (uid) => {
      await pg.exec('RESET ROLE');
      if (uid) {
        await pg.query('SELECT set_config($1,$2,false)', ['app.current_auth_uid', uid]);
        await pg.exec('SET ROLE authenticated');
      }
    },
    close: async () => {
      await pg.close();
    },
  };
});

afterAll(async () => {
  await db.close();
});

describe('push_subscriptions RLS', () => {
  it('lets a teacher insert and read their own subscription only', async () => {
    await db.asUser(TEACHER_UID);
    await db.exec(
      `INSERT INTO push_subscriptions (id, user_id, endpoint, p256dh, auth, device_type, browser)
       VALUES ('sub-1', 'teacher-1', 'https://push/a', 'p', 'a', 'mobile', 'chrome')`,
    );
    const own = await db.query(`SELECT * FROM push_subscriptions WHERE user_id = 'teacher-1'`);
    expect(own.rows).toHaveLength(1);

    const other = await db.query(`SELECT * FROM push_subscriptions WHERE user_id = 'teacher-2'`);
    expect(other.rows).toHaveLength(0); // nothing visible for someone else
  });

  it('blocks inserting a subscription for another user', async () => {
    await db.asUser(TEACHER_UID);
    await expect(
      db.exec(
        `INSERT INTO push_subscriptions (id, user_id, endpoint, p256dh, auth)
         VALUES ('sub-evil', 'teacher-2', 'https://push/evil', 'p', 'a')`,
      ),
    ).rejects.toThrow();
  });

  it('blocks reading another user\'s subscription', async () => {
    await db.asUser(OTHER_UID);
    const rows = await db.query(`SELECT * FROM push_subscriptions`);
    expect(rows.rows).toHaveLength(0);
  });

  it('enforces endpoint uniqueness (no duplicate device rows)', async () => {
    await db.asUser(TEACHER_UID);
    await expect(
      db.exec(
        `INSERT INTO push_subscriptions (id, user_id, endpoint, p256dh, auth)
         VALUES ('sub-dup', 'teacher-1', 'https://push/a', 'p', 'a')`,
      ),
    ).rejects.toThrow();
  });

  it('allows a second device for the same teacher (distinct endpoint)', async () => {
    await db.asUser(TEACHER_UID);
    await db.exec(
      `INSERT INTO push_subscriptions (id, user_id, endpoint, p256dh, auth, device_type)
       VALUES ('sub-2', 'teacher-1', 'https://push/laptop', 'p', 'a', 'desktop')`,
    );
    const rows = await db.query(`SELECT * FROM push_subscriptions WHERE user_id='teacher-1'`);
    expect(rows.rows).toHaveLength(2);
  });
});

describe('notification_preferences RLS', () => {
  it('teacher can upsert only their own preferences', async () => {
    await db.asUser(TEACHER_UID);
    await db.exec(
      `INSERT INTO notification_preferences (user_id, push_enabled) VALUES ('teacher-1', false)
       ON CONFLICT (user_id) DO UPDATE SET push_enabled = EXCLUDED.push_enabled`,
    );
    const own = await db.query(`SELECT * FROM notification_preferences WHERE user_id='teacher-1'`);
    expect(own.rows[0].push_enabled).toBe(false);

    await expect(
      db.exec(`INSERT INTO notification_preferences (user_id, push_enabled) VALUES ('teacher-2', true)`),
    ).rejects.toThrow();
  });
});

describe('notification history visibility', () => {
  beforeAll(async () => {
    // Owner seeds a notification addressed to teacher-1 only.
    await db.asUser(null);
    await db.exec(
      `INSERT INTO notifications (id, title, body, category, sender_id)
       VALUES ('ntf-1', 'Staff Meeting', 'Tomorrow 8am', 'announcement', 'admin-1')`,
    );
    await db.exec(
      `INSERT INTO notification_recipients (id, notification_id, user_id, status)
       VALUES ('ntr-1', 'ntf-1', 'teacher-1', 'sent')`,
    );
  });

  it('recipient can read their own history and mark it read', async () => {
    await db.asUser(TEACHER_UID);
    const rows = await db.query(
      `SELECT n.title, r.read_at FROM notification_recipients r JOIN notifications n ON n.id = r.notification_id WHERE r.user_id='teacher-1'`,
    );
    expect(rows.rows).toHaveLength(1);
    expect(rows.rows[0].title).toBe('Staff Meeting');

    await db.exec(`UPDATE notification_recipients SET read_at = NOW() WHERE user_id='teacher-1' AND read_at IS NULL`);
    const after = await db.query(`SELECT read_at FROM notification_recipients WHERE user_id='teacher-1'`);
    expect(after.rows[0].read_at).not.toBeNull();
  });

  it('non-recipient teacher cannot see it', async () => {
    await db.asUser(OTHER_UID);
    const rows = await db.query(`SELECT * FROM notification_recipients`);
    expect(rows.rows).toHaveLength(0);
    const notifs = await db.query(`SELECT * FROM notifications`);
    expect(notifs.rows).toHaveLength(0);
  });

  it('admin can see the full send log', async () => {
    await db.asUser(ADMIN_UID);
    const rows = await db.query(`SELECT * FROM notification_recipients`);
    expect(rows.rows).toHaveLength(1);
    const notifs = await db.query(`SELECT * FROM notifications`);
    expect(notifs.rows).toHaveLength(1);
  });

  it('teacher cannot write notification history', async () => {
    await db.asUser(TEACHER_UID);
    await expect(
      db.exec(`INSERT INTO notifications (id, title, body, category) VALUES ('ntf-evil','x','y','general')`),
    ).rejects.toThrow();
  });
});

describe('current_session_context', () => {
  it('resolves role through the auth bridge', async () => {
    await db.asUser(TEACHER_UID);
    const { rows } = await db.query(`SELECT public.current_session_context() AS ctx`);
    expect(rows[0].ctx).toEqual({ profile_id: 'teacher-1', role: 'teacher' });

    await db.asUser(ADMIN_UID);
    const admin = await db.query(`SELECT public.current_session_context() AS ctx`);
    expect(admin.rows[0].ctx).toEqual({ profile_id: 'admin-1', role: 'admin' });
  });
});
