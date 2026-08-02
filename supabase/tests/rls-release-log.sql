-- RLS assertion test for the release log (gate handoff records).
--
-- Run against a database with the migrations applied:
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f supabase/tests/rls-release-log.sql
-- Every DO block RAISE EXCEPTION on failure, so a failing assertion fails
-- the script (exit non-zero under ON_ERROR_STOP).

-- ── 1. release_log exists with the record shape ────────────────────────────
DO $$
DECLARE
  v_count INT;
BEGIN
  SELECT count(*) INTO v_count
  FROM information_schema.columns
  WHERE table_schema = 'public' AND table_name = 'release_log'
    AND column_name IN ('studentId', 'familyId', 'staffId', 'createdAt');
  IF v_count <> 4 THEN
    RAISE EXCEPTION 'release_log is missing required columns (found %)', v_count;
  END IF;
END $$;

-- ── 2. staff (admin/supervisor/office) can read all releases ───────────────
DO $$
DECLARE
  v_found BOOLEAN;
BEGIN
  SELECT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'release_log'
      AND cmd = 'SELECT'
      AND roles @> ARRAY['authenticated']
      AND qual::text LIKE '%''office''%'
      AND qual::text LIKE '%''supervisor''%'
      AND qual::text LIKE '%''admin''%'
  ) INTO v_found;
  IF NOT v_found THEN
    RAISE EXCEPTION 'Missing staff SELECT policy on release_log (admin/supervisor/office)';
  END IF;
END $$;

-- ── 3. parents read only their OWN children's releases ────────────────────
DO $$
DECLARE
  v_found BOOLEAN;
BEGIN
  SELECT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'release_log'
      AND cmd = 'SELECT'
      AND policyname = 'Parents can read own children releases'
      AND qual::text LIKE '%students%'
      AND qual::text LIKE '%parentId%'
      AND qual::text LIKE '%current_profile_id()%'
  ) INTO v_found;
  IF NOT v_found THEN
    RAISE EXCEPTION 'Parent release policy is not scoped to own children';
  END IF;
END $$;

-- ── 4. no unrestricted read and no direct writes ───────────────────────────
DO $$
DECLARE
  v_bad INT;
BEGIN
  -- Any authenticated SELECT policy that does NOT reference the staff roles
  -- or the parent-child join would leak releases across families.
  SELECT count(*) INTO v_bad
  FROM pg_policies
  WHERE schemaname = 'public' AND tablename = 'release_log'
    AND cmd = 'SELECT'
    AND roles @> ARRAY['authenticated']
    AND qual::text NOT LIKE '%current_profile_role()%'
    AND qual::text NOT LIKE '%current_profile_id()%';
  IF v_bad > 0 THEN
    RAISE EXCEPTION '% unrestricted SELECT policy(ies) on release_log — cross-family leak possible', v_bad;
  END IF;
END $$;

DO $$
DECLARE
  v_bad INT;
BEGIN
  SELECT count(*) INTO v_bad
  FROM pg_policies
  WHERE schemaname = 'public' AND tablename = 'release_log'
    AND cmd IN ('INSERT', 'UPDATE', 'DELETE');
  IF v_bad > 0 THEN
    RAISE EXCEPTION '% direct write policy(ies) on release_log — record_release() must be the only writer', v_bad;
  END IF;
END $$;

-- ── 5. record_release() gates the three gate roles and is granted ──────────
DO $$
DECLARE
  v_def TEXT;
  v_granted BOOLEAN;
BEGIN
  SELECT pg_get_functiondef('public.record_release(text,text)'::regprocedure) INTO v_def;
  IF v_def IS NULL THEN
    RAISE EXCEPTION 'record_release() does not exist';
  END IF;
  IF position('''office''' in v_def) = 0
     OR position('''supervisor''' in v_def) = 0
     OR position('''admin''' in v_def) = 0 THEN
    RAISE EXCEPTION 'record_release() role gate is missing a gate role';
  END IF;

  SELECT EXISTS (
    SELECT 1 FROM information_schema.routine_privileges
    WHERE routine_schema = 'public'
      AND routine_name = 'record_release'
      AND grantee = 'authenticated'
      AND privilege_type = 'EXECUTE'
  ) INTO v_granted;
  IF NOT v_granted THEN
    RAISE EXCEPTION 'record_release() is not granted to authenticated';
  END IF;
END $$;

-- ── 6. integrity guard: release must match the student's own family ────────
DO $$
DECLARE
  v_def TEXT;
BEGIN
  SELECT pg_get_functiondef('public.record_release(text,text)'::regprocedure) INTO v_def;
  IF position('integrity_constraint_violation' in v_def) = 0 THEN
    RAISE EXCEPTION 'record_release() lacks the student-belongs-to-family integrity check';
  END IF;
END $$;

RAISE NOTICE 'RLS release-log assertions: ALL PASSED';
