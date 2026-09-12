-- RLS / schema assertions for authorized pickup people ("drivers").
--
-- Run against a database with the migrations applied:
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f supabase/tests/rls-authorized-pickups.sql
-- Every DO block RAISE EXCEPTION on failure, so a failing assertion fails
-- the script (exit non-zero under ON_ERROR_STOP).

-- ── 1. authorized_pickups exists with the required columns ─────────────────
DO $$
DECLARE
  v_count INT;
BEGIN
  SELECT count(*) INTO v_count
  FROM information_schema.columns
  WHERE table_schema = 'public' AND table_name = 'authorized_pickups'
    AND column_name IN ('name', 'phoneNumber', 'relationship', 'photoPath',
                        'addedByStaffId', 'addedAt');
  IF v_count <> 6 THEN
    RAISE EXCEPTION 'authorized_pickups is missing required columns (found %)', v_count;
  END IF;
END $$;

-- ── 2. authorized_pickup_students links people to students ────────────────
DO $$
DECLARE
  v_count INT;
BEGIN
  SELECT count(*) INTO v_count
  FROM information_schema.columns
  WHERE table_schema = 'public' AND table_name = 'authorized_pickup_students'
    AND column_name IN ('authorizedPickupId', 'studentId');
  IF v_count <> 2 THEN
    RAISE EXCEPTION 'authorized_pickup_students is missing its link columns (found %)', v_count;
  END IF;
END $$;

-- ── 3. SELECT-only for gate roles; NO direct write policies ────────────────
DO $$
DECLARE
  v_ok BOOLEAN;
  v_bad INT;
BEGIN
  SELECT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'authorized_pickups'
      AND cmd = 'SELECT'
      AND qual::text LIKE '%''office''%'
      AND qual::text LIKE '%''supervisor''%'
      AND qual::text LIKE '%''admin''%'
  ) INTO v_ok;
  IF NOT v_ok THEN
    RAISE EXCEPTION 'Missing gate-role SELECT policy on authorized_pickups';
  END IF;

  SELECT count(*) INTO v_bad
  FROM pg_policies
  WHERE schemaname = 'public' AND tablename IN ('authorized_pickups', 'authorized_pickup_students')
    AND cmd IN ('INSERT', 'UPDATE', 'DELETE');
  IF v_bad > 0 THEN
    RAISE EXCEPTION '% direct write policy(ies) on authorized_pickups — create_authorized_pickup() must be the only writer', v_bad;
  END IF;
END $$;

-- ── 4. create_authorized_pickup(): SECURITY DEFINER, role-gated, photo OPTIONAL
DO $$
DECLARE
  v_def TEXT;
  v_secdef BOOLEAN;
BEGIN
  SELECT pg_get_functiondef(oid) INTO v_def
  FROM pg_proc
  WHERE proname = 'create_authorized_pickup' AND pronamespace = 'public'::regnamespace;
  IF v_def IS NULL THEN
    RAISE EXCEPTION 'create_authorized_pickup() does not exist';
  END IF;
  IF position('''office''' in v_def) = 0
     OR position('''supervisor''' in v_def) = 0
     OR position('''admin''' in v_def) = 0 THEN
    RAISE EXCEPTION 'create_authorized_pickup() is missing a gate role';
  END IF;
  -- The photo is now OPTIONAL: the old hard "A photo is required." guard must
  -- be gone so drivers can be saved without a photo (camera OR upload both
  -- feed the same single photoPath).
  IF position('A photo is required' in v_def) > 0 THEN
    RAISE EXCEPTION 'create_authorized_pickup() still requires a photo — drivers must be saveable without one';
  END IF;
  -- Staff must explicitly select one or more students; no implicit "all
  -- family students" default is permitted server-side.
  IF position('At least one student must be selected' in v_def) = 0 THEN
    RAISE EXCEPTION 'create_authorized_pickup() does not require an explicit student selection';
  END IF;
  IF position('audit_logs' in v_def) = 0 THEN
    RAISE EXCEPTION 'create_authorized_pickup() does not write the audit trail';
  END IF;

  SELECT prosecdef INTO v_secdef
  FROM pg_proc
  WHERE proname = 'create_authorized_pickup' AND pronamespace = 'public'::regnamespace;
  IF v_secdef IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'create_authorized_pickup() must be SECURITY DEFINER';
  END IF;
END $$;

-- ── 4b. photoPath is nullable (drivers can be saved without a photo) ────────
DO $$
DECLARE
  v_nullable TEXT;
BEGIN
  SELECT is_nullable INTO v_nullable
  FROM information_schema.columns
  WHERE table_schema = 'public' AND table_name = 'authorized_pickups'
    AND column_name = 'photoPath';
  IF v_nullable IS DISTINCT FROM 'YES' THEN
    RAISE EXCEPTION 'authorized_pickups.photoPath must be nullable so drivers can be saved without a photo';
  END IF;
END $$;

-- ── 5. get_family_pickups(): SECURITY DEFINER, STABLE, role-gated ─────────
DO $$
DECLARE
  v_def TEXT;
  v_secdef BOOLEAN;
  v_volatile "char";
BEGIN
  SELECT pg_get_functiondef(oid), prosecdef, provolatile
    INTO v_def, v_secdef, v_volatile
  FROM pg_proc
  WHERE proname = 'get_family_pickups' AND pronamespace = 'public'::regnamespace;
  IF v_def IS NULL THEN
    RAISE EXCEPTION 'get_family_pickups() does not exist';
  END IF;
  IF NOT v_secdef THEN
    RAISE EXCEPTION 'get_family_pickups() must be SECURITY DEFINER';
  END IF;
  IF v_volatile <> 's' THEN
    RAISE EXCEPTION 'get_family_pickups() must be STABLE (no writes possible)';
  END IF;
  IF position('''office''' in v_def) = 0
     OR position('''supervisor''' in v_def) = 0
     OR position('''admin''' in v_def) = 0 THEN
    RAISE EXCEPTION 'get_family_pickups() is missing a gate role';
  END IF;
END $$;

-- ── 6. release_log carries the (required) pickup person ───────────────────
DO $$
DECLARE
  v_ok BOOLEAN;
BEGIN
  SELECT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'release_log'
      AND column_name = 'pickupPersonId'
  ) INTO v_ok;
  IF NOT v_ok THEN
    RAISE EXCEPTION 'release_log is missing the pickupPersonId column';
  END IF;
END $$;

-- ── 7. storage.objects restricted to the bucket + gate roles ──────────────
DO $$
DECLARE
  v_ok BOOLEAN;
BEGIN
  SELECT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'storage' AND tablename = 'objects'
      AND cmd = 'INSERT'
      AND qual::text LIKE '%authorized-pickups%'
  ) INTO v_ok;
  IF NOT v_ok THEN
    RAISE EXCEPTION 'storage.objects has no upload policy for the authorized-pickups bucket';
  END IF;

  -- Signed-URL generation requires a SELECT policy on the bucket.
  SELECT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'storage' AND tablename = 'objects'
      AND cmd = 'SELECT'
      AND qual::text LIKE '%authorized-pickups%'
      AND qual::text LIKE '%''office''%'
  ) INTO v_ok;
  IF NOT v_ok THEN
    RAISE EXCEPTION 'storage.objects has no staff SELECT policy for signing authorized-pickups photos';
  END IF;
END $$;

-- ── 8. the bucket is PRIVATE (no anonymous photo access by URL) ───────────
DO $$
DECLARE
  v_public BOOLEAN;
BEGIN
  SELECT public INTO v_public
  FROM storage.buckets
  WHERE id = 'authorized-pickups';
  IF v_public IS DISTINCT FROM false THEN
    RAISE EXCEPTION 'authorized-pickups bucket must be private (public = false)';
  END IF;
END $$;

-- ── 9. record_release() REQUIRES a selected driver for a DRIVER student ───
DO $$
DECLARE
  v_def TEXT;
BEGIN
  SELECT pg_get_functiondef('public.record_release(text,text,text)'::regprocedure) INTO v_def;
  IF v_def IS NULL THEN
    RAISE EXCEPTION 'record_release() does not exist';
  END IF;
  IF position('A driver must be selected before releasing this student' in v_def) = 0 THEN
    RAISE EXCEPTION 'record_release() does not reject a missing driver';
  END IF;
  -- The driver must actually be assigned to the student.
  IF position('Driver is not assigned to this student' in v_def) = 0 THEN
    RAISE EXCEPTION 'record_release() does not reject an unassigned driver';
  END IF;
END $$;

-- ── 10. update_authorized_pickup_photo(): replace/remove, admin + office ────
DO $$
DECLARE
  v_def TEXT;
  v_secdef BOOLEAN;
  v_config TEXT[];
BEGIN
  SELECT pg_get_functiondef(p.oid), p.prosecdef, p.proconfig INTO v_def, v_secdef, v_config
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public' AND p.proname = 'update_authorized_pickup_photo'
  ORDER BY p.oid DESC LIMIT 1;

  IF v_def IS NULL THEN
    RAISE EXCEPTION 'update_authorized_pickup_photo() is missing';
  END IF;
  IF NOT v_secdef THEN
    RAISE EXCEPTION 'update_authorized_pickup_photo() lost SECURITY DEFINER';
  END IF;
  IF v_config IS NULL OR NOT (v_config @> ARRAY['search_path=public']) THEN
    RAISE EXCEPTION 'update_authorized_pickup_photo() lost its pinned search_path';
  END IF;
  IF position('''admin''' in v_def) = 0 OR position('''office''' in v_def) = 0 THEN
    RAISE EXCEPTION 'update_authorized_pickup_photo() must admit admin + office';
  END IF;
  IF position('''supervisor''' in v_def) > 0 THEN
    RAISE EXCEPTION 'update_authorized_pickup_photo() admits supervisor — photo editing is back-office';
  END IF;
  IF position('audit_logs' in v_def) = 0 THEN
    RAISE EXCEPTION 'update_authorized_pickup_photo() does not write the audit trail';
  END IF;
END $$;

RAISE NOTICE 'RLS authorized-pickups assertions: ALL PASSED';
