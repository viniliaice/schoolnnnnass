-- RLS assertions for the audit_logs lockdown (20260902_lockdown_audit_logs.sql).
--
-- Run against a database with the migrations applied:
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f supabase/tests/rls-audit-logs.sql
-- Every DO block RAISE EXCEPTION on failure, so a failing assertion fails
-- the script (exit non-zero under ON_ERROR_STOP).

-- ── 1. the open policies are gone ─────────────────────────────────────────
DO $$
DECLARE
  v_bad INT;
BEGIN
  SELECT count(*) INTO v_bad
  FROM pg_policies
  WHERE schemaname = 'public' AND tablename = 'audit_logs'
    AND qual::text LIKE '%true%'
    AND cmd IN ('SELECT', 'INSERT');
  IF v_bad > 0 THEN
    RAISE EXCEPTION '% open (USING/WITH CHECK true) policy(ies) remain on audit_logs', v_bad;
  END IF;
END $$;

-- ── 2. SELECT is scoped to staff roles ─────────────────────────────────────
DO $$
DECLARE
  v_ok BOOLEAN;
BEGIN
  SELECT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'audit_logs'
      AND cmd = 'SELECT'
      AND qual::text LIKE '%''admin''%'
      AND qual::text LIKE '%''supervisor''%'
      AND qual::text LIKE '%''office''%'
  ) INTO v_ok;
  IF NOT v_ok THEN
    RAISE EXCEPTION 'audit_logs SELECT is not scoped to admin/supervisor/office';
  END IF;
END $$;

-- ── 3. no open client INSERT policy (writes go through create_audit_log) ──
DO $$
DECLARE
  v_bad INT;
BEGIN
  SELECT count(*) INTO v_bad
  FROM pg_policies
  WHERE schemaname = 'public' AND tablename = 'audit_logs'
    AND cmd IN ('INSERT', 'UPDATE', 'DELETE');
  IF v_bad > 0 THEN
    RAISE EXCEPTION '% direct write policy(ies) on audit_logs — client writes must go through create_audit_log()', v_bad;
  END IF;
END $$;

-- ── 4. create_audit_log() is SECURITY DEFINER and staff-gated ─────────────
DO $$
DECLARE
  v_def TEXT;
  v_secdef BOOLEAN;
  v_ok BOOLEAN;
BEGIN
  SELECT pg_get_functiondef(oid), prosecdef
    INTO v_def, v_secdef
  FROM pg_proc
  WHERE proname = 'create_audit_log' AND pronamespace = 'public'::regnamespace;
  IF v_def IS NULL THEN
    RAISE EXCEPTION 'create_audit_log() does not exist';
  END IF;
  IF v_secdef IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'create_audit_log() must be SECURITY DEFINER';
  END IF;
  IF position('''admin''' in v_def) = 0
     OR position('''supervisor''' in v_def) = 0
     OR position('''office''' in v_def) = 0 THEN
    RAISE EXCEPTION 'create_audit_log() is missing a staff role gate';
  END IF;

  SELECT NOT has_function_privilege('public', 'public.create_audit_log(TEXT,JSONB)', 'EXECUTE')
    INTO v_ok;
  IF NOT v_ok THEN
    RAISE EXCEPTION 'create_audit_log() must not be executable by PUBLIC';
  END IF;
END $$;

RAISE NOTICE 'RLS audit-logs assertions: ALL PASSED';
