-- RLS assertion test for the office role + parent family isolation.
--
-- Run against a database with the migrations applied:
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f supabase/tests/rls-office-role.sql
-- Every DO block RAISE EXCEPTION on failure, so a failing assertion fails
-- the script (exit non-zero under ON_ERROR_STOP).

-- ── 1. profiles role CHECK includes 'office' ─────────────────────────────
DO $$
DECLARE
  v_check TEXT;
BEGIN
  SELECT pg_get_constraintdef(oid) INTO v_check
  FROM pg_constraint
  WHERE conrelid = 'public.profiles'::regclass
    AND contype = 'c'
    AND conname = 'profiles_role_check';
  IF v_check IS NULL OR position('office' in v_check) = 0 THEN
    RAISE EXCEPTION 'profiles_role_check does not allow office: %', v_check;
  END IF;
END $$;

-- ── 2. office can SELECT students (read family ids) ───────────────────────
DO $$
DECLARE
  v_found BOOLEAN;
BEGIN
  SELECT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'students'
      AND policyname = 'Office can read all students'
      AND cmd = 'SELECT'
      AND roles @> ARRAY['authenticated']
      AND qual::text LIKE '%''office''%'
  ) INTO v_found;
  IF NOT v_found THEN
    RAISE EXCEPTION 'Missing SELECT policy granting office read on students';
  END IF;
END $$;

-- office must have NO write policy on students (INSERT/UPDATE/DELETE)
DO $$
DECLARE
  v_bad INT;
BEGIN
  SELECT count(*) INTO v_bad
  FROM pg_policies
  WHERE schemaname = 'public' AND tablename = 'students'
    AND cmd IN ('INSERT', 'UPDATE', 'DELETE')
    AND qual::text LIKE '%''office''%';
  IF v_bad > 0 THEN
    RAISE EXCEPTION 'office has % write policies on students — should be read-only', v_bad;
  END IF;
END $$;

-- ── 3. office is blocked from grade/exam writes ───────────────────────────
DO $$
DECLARE
  v_bad INT;
BEGIN
  SELECT count(*) INTO v_bad
  FROM pg_policies
  WHERE schemaname = 'public' AND tablename = 'exams'
    AND cmd IN ('INSERT', 'UPDATE', 'DELETE')
    AND (qual::text LIKE '%''office''%' OR with_check::text LIKE '%''office''%');
  IF v_bad > 0 THEN
    RAISE EXCEPTION 'office has % write policies on exams — must be blocked', v_bad;
  END IF;
END $$;

DO $$
DECLARE
  v_bad INT;
BEGIN
  SELECT count(*) INTO v_bad
  FROM pg_policies
  WHERE schemaname = 'public' AND tablename = 'grade_uploads'
    AND cmd IN ('INSERT', 'UPDATE', 'DELETE')
    AND (qual::text LIKE '%''office''%' OR with_check::text LIKE '%''office''%');
  IF v_bad > 0 THEN
    RAISE EXCEPTION 'office has % write policies on grade_uploads — must be blocked', v_bad;
  END IF;
END $$;

DO $$
DECLARE
  v_bad INT;
BEGIN
  SELECT count(*) INTO v_bad
  FROM pg_policies
  WHERE schemaname = 'public' AND tablename = 'student_promotions'
    AND cmd IN ('INSERT', 'UPDATE', 'DELETE')
    AND (qual::text LIKE '%''office''%' OR with_check::text LIKE '%''office''%');
  IF v_bad > 0 THEN
    RAISE EXCEPTION 'office has % write policies on student_promotions — must be blocked', v_bad;
  END IF;
END $$;

-- ── 4. gate audit trail readable by office (authenticated) ────────────────
DO $$
DECLARE
  v_read BOOLEAN; v_insert BOOLEAN;
BEGIN
  SELECT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'audit_logs'
      AND cmd = 'SELECT' AND roles @> ARRAY['authenticated']
  ) INTO v_read;
  IF NOT v_read THEN
    RAISE EXCEPTION 'audit_logs has no authenticated SELECT policy (office cannot read gate audit trail)';
  END IF;
END $$;

-- ── 5. lookup_family() widened to office ──────────────────────────────────
DO $$
DECLARE
  v_def TEXT;
BEGIN
  SELECT pg_get_functiondef('public.lookup_family(text)'::regprocedure) INTO v_def;
  IF v_def IS NULL OR position('''office''' in v_def) = 0 THEN
    RAISE EXCEPTION 'lookup_family does not allow office';
  END IF;
END $$;

-- ── 6. parent isolation: parents may only read their OWN children ─────────
DO $$
DECLARE
  v_ok BOOLEAN;
BEGIN
  -- The parent policy must scope strictly to the caller's own profile id.
  SELECT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'students'
      AND policyname = 'Parents can read own children'
      AND cmd = 'SELECT'
      AND qual::text LIKE '%current_profile_id()%'
      AND qual::text LIKE '%parentId%'
  ) INTO v_ok;
  IF NOT v_ok THEN
    RAISE EXCEPTION 'Parent students policy is not scoped to own parentId';
  END IF;
END $$;

-- Parent A must have no way to read another parent's rows: there must be no
-- student SELECT policy that grants all-authenticated access.
DO $$
DECLARE
  v_bad INT;
BEGIN
  SELECT count(*) INTO v_bad
  FROM pg_policies
  WHERE schemaname = 'public' AND tablename = 'students'
    AND cmd = 'SELECT'
    AND roles @> ARRAY['authenticated']
    AND qual::text NOT LIKE '%current_profile_id()%'
    AND qual::text NOT LIKE '%current_profile_role()%';
  IF v_bad > 0 THEN
    RAISE EXCEPTION '% unrestricted SELECT policy(ies) on students — cross-family read possible', v_bad;
  END IF;
END $$;

RAISE NOTICE 'RLS office-role + parent-isolation assertions: ALL PASSED';
