-- RLS assertion test for the admin-only profile role RPCs (office-role fix).
--
-- Run against a database with the migrations applied:
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f supabase/tests/rls-user-role.sql
-- Every DO block RAISE EXCEPTION on failure, so a failing assertion fails
-- the script (exit non-zero under ON_ERROR_STOP).

-- ── 1. profiles has NO direct write policies ───────────────────────────────
-- The reason the old createUser() insert / updateUser() update could never
-- persist. Role writes must go through the admin-only RPCs.
DO $$
DECLARE
  v_bad INT;
BEGIN
  SELECT count(*) INTO v_bad
  FROM pg_policies
  WHERE schemaname = 'public' AND tablename = 'profiles'
    AND cmd IN ('INSERT', 'UPDATE', 'DELETE');
  IF v_bad > 0 THEN
    RAISE EXCEPTION 'profiles has % write policy(ies) — direct writes must stay blocked (RPC-only)', v_bad;
  END IF;
END $$;

-- ── 2. create_user_profile: exists, SECURITY DEFINER, admin-gated ─────────
DO $$
DECLARE
  v_def TEXT;
  v_secdef BOOLEAN;
  v_count INT;
BEGIN
  SELECT count(*) INTO v_count
  FROM pg_proc
  WHERE proname = 'create_user_profile' AND pronamespace = 'public'::regnamespace;
  IF v_count <> 1 THEN
    RAISE EXCEPTION 'create_user_profile not found (found %)', v_count;
  END IF;

  SELECT prosecdef INTO v_secdef
  FROM pg_proc
  WHERE proname = 'create_user_profile' AND pronamespace = 'public'::regnamespace;
  IF v_secdef IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'create_user_profile must be SECURITY DEFINER';
  END IF;

  SELECT pg_get_functiondef(oid) INTO v_def
  FROM pg_proc
  WHERE proname = 'create_user_profile' AND pronamespace = 'public'::regnamespace;
  IF v_def IS NULL OR position('admin' in v_def) = 0 THEN
    RAISE EXCEPTION 'create_user_profile lacks an admin role check';
  END IF;
END $$;

-- ── 3. set_user_role: exists, SECURITY DEFINER, admin-gated ────────────────
-- A non-admin caller must never be able to call this to grant itself (or
-- another user) an elevated role like admin/office.
DO $$
DECLARE
  v_def TEXT;
  v_secdef BOOLEAN;
  v_count INT;
BEGIN
  SELECT count(*) INTO v_count
  FROM pg_proc
  WHERE proname = 'set_user_role' AND pronamespace = 'public'::regnamespace;
  IF v_count <> 1 THEN
    RAISE EXCEPTION 'set_user_role not found (found %)', v_count;
  END IF;

  SELECT prosecdef INTO v_secdef
  FROM pg_proc
  WHERE proname = 'set_user_role' AND pronamespace = 'public'::regnamespace;
  IF v_secdef IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'set_user_role must be SECURITY DEFINER';
  END IF;

  SELECT pg_get_functiondef(oid) INTO v_def
  FROM pg_proc
  WHERE proname = 'set_user_role' AND pronamespace = 'public'::regnamespace;
  IF v_def IS NULL OR position('admin' in v_def) = 0 THEN
    RAISE EXCEPTION 'set_user_role lacks an admin role check';
  END IF;
END $$;

-- ── 4. Both RPCs revoke PUBLIC execute (authenticated only) ────────────────
DO $$
DECLARE
  v_ok BOOLEAN;
BEGIN
  SELECT bool_and(
    p.proacl IS NOT NULL
    AND NOT EXISTS (SELECT 1 FROM aclexplode(p.proacl) a WHERE a.grantee = 0)
  )
  INTO v_ok
  FROM pg_proc p
  WHERE proname IN ('create_user_profile', 'set_user_role')
    AND pronamespace = 'public'::regnamespace;
  IF v_ok IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'user-role RPCs must revoke PUBLIC execute';
  END IF;
END $$;

RAISE NOTICE 'RLS user-role assertions: ALL PASSED';
