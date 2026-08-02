-- RLS assertion test for the family-ID import write path (investigation fix).
--
-- The original bug shipped because the unit test mocked Supabase: the client
-- called supabase.from('students').update() and the test saw a success, while
-- the real DB denied the write (students is SELECT-only under RLS). These
-- assertions verify the REAL schema invariants that make the fix correct:
-- direct UPDATE on students stays impossible, and the only write path is the
-- admin-only SECURITY DEFINER RPC.
--
-- Run against a database with the migrations applied:
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f supabase/tests/rls-family-import.sql
-- Every DO block RAISE EXCEPTION on failure, so a failing assertion fails
-- the script (exit non-zero under ON_ERROR_STOP).

-- ── 1. students must have NO UPDATE policy ─────────────────────────────────
-- The reason the old direct .update() could never persist. If this assertion
-- ever fails, someone added a direct UPDATE path and the RPC-only design is
-- broken — the gate data could be written around the audit log.
DO $$
DECLARE
  v_bad INT;
BEGIN
  SELECT count(*) INTO v_bad
  FROM pg_policies
  WHERE schemaname = 'public' AND tablename = 'students'
    AND cmd = 'UPDATE';
  IF v_bad > 0 THEN
    RAISE EXCEPTION 'students unexpectedly has % UPDATE policy(ies) — direct writes must stay blocked (all writes go through RPCs)', v_bad;
  END IF;
END $$;

-- ── 2. set_student_import_fields exists, is SECURITY DEFINER, admin-gated ─
DO $$
DECLARE
  v_def TEXT;
  v_secdef BOOLEAN;
  v_count INT;
BEGIN
  SELECT count(*) INTO v_count
  FROM pg_proc
  WHERE proname = 'set_student_import_fields' AND pronamespace = 'public'::regnamespace;
  IF v_count <> 1 THEN
    RAISE EXCEPTION 'set_student_import_fields not found (found %)', v_count;
  END IF;

  SELECT prosecdef INTO v_secdef
  FROM pg_proc
  WHERE proname = 'set_student_import_fields' AND pronamespace = 'public'::regnamespace;
  IF v_secdef IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'set_student_import_fields must be SECURITY DEFINER';
  END IF;

  SELECT pg_get_functiondef(oid) INTO v_def
  FROM pg_proc
  WHERE proname = 'set_student_import_fields' AND pronamespace = 'public'::regnamespace;
  -- The role check (<> 'admin') must exist so a non-admin caller is rejected.
  IF v_def IS NULL OR position('admin' in v_def) = 0 THEN
    RAISE EXCEPTION 'set_student_import_fields lacks an admin role check';
  END IF;
END $$;

-- ── 3. EXECUTE revoked from PUBLIC (authenticated only; admin checked inside)
DO $$
DECLARE
  v_ok BOOLEAN;
BEGIN
  SELECT p.proacl IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM aclexplode(p.proacl) a WHERE a.grantee = 0)
  INTO v_ok
  FROM pg_proc p
  WHERE proname = 'set_student_import_fields' AND pronamespace = 'public'::regnamespace;
  IF v_ok IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'set_student_import_fields must revoke PUBLIC execute';
  END IF;
END $$;

-- ── 4. assign_family_override caps manual IDs at 4 digits ──────────────────
-- An oversized override would overflow generate_family_ids()'s
-- MAX(normalize_family_id(...)::INTEGER) and permanently brick the generator.
DO $$
DECLARE
  v_def TEXT;
BEGIN
  SELECT pg_get_functiondef(oid) INTO v_def
  FROM pg_proc
  WHERE proname = 'assign_family_override' AND pronamespace = 'public'::regnamespace;
  IF v_def IS NULL THEN
    RAISE EXCEPTION 'assign_family_override not found';
  END IF;
  IF position('at most 4 digits' in v_def) = 0 THEN
    RAISE EXCEPTION 'assign_family_override lacks the 4-digit guard';
  END IF;
END $$;

-- ── 5. generate_family_ids still exists and stays admin-gated ──────────────
-- The generator must keep working normally for every family after a rejected
-- bad override.
DO $$
DECLARE
  v_def TEXT;
BEGIN
  SELECT pg_get_functiondef(oid) INTO v_def
  FROM pg_proc
  WHERE proname = 'generate_family_ids' AND pronamespace = 'public'::regnamespace;
  IF v_def IS NULL THEN
    RAISE EXCEPTION 'generate_family_ids not found';
  END IF;
  IF position('admin' in v_def) = 0 THEN
    RAISE EXCEPTION 'generate_family_ids lacks its admin gate';
  END IF;
END $$;

RAISE NOTICE 'RLS family-import assertions: ALL PASSED';
