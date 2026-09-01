-- RLS assertions for authorized pickup people.
-- Run after migrations with:
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f supabase/tests/rls-authorized-pickups.sql

DO $$
DECLARE
  v_count INT;
BEGIN
  SELECT count(*) INTO v_count
  FROM information_schema.columns
  WHERE table_schema = 'public' AND table_name = 'authorized_pickups'
    AND column_name IN ('person_id', 'family_id', 'name', 'phone_number',
                        'relationship', 'photo_url', 'added_by_staff_id', 'added_at');
  IF v_count <> 8 THEN
    RAISE EXCEPTION 'authorized_pickups is missing required columns (found %)', v_count;
  END IF;
END $$;

DO $$
DECLARE
  v_found BOOLEAN;
  v_direct_writes INT;
BEGIN
  SELECT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'authorized_pickups'
      AND policyname = 'Gate staff can read authorized pickups'
      AND cmd = 'SELECT'
      AND qual::text LIKE '%current_profile_role()%'
      AND qual::text LIKE '%''office''%'
      AND qual::text LIKE '%''supervisor''%'
      AND qual::text LIKE '%''admin''%'
  ) INTO v_found;
  IF NOT v_found THEN
    RAISE EXCEPTION 'Missing gate-staff SELECT policy on authorized_pickups';
  END IF;

  SELECT count(*) INTO v_direct_writes
  FROM pg_policies
  WHERE schemaname = 'public' AND tablename = 'authorized_pickups'
    AND cmd IN ('INSERT', 'UPDATE', 'DELETE');
  IF v_direct_writes > 0 THEN
    RAISE EXCEPTION 'authorized_pickups has direct write policies; the RPC must be the only writer';
  END IF;
END $$;

DO $$
DECLARE
  v_def TEXT;
  v_granted BOOLEAN;
BEGIN
  SELECT pg_get_functiondef(
    'public.create_authorized_pickup(uuid,text,text,text,text,text)'::regprocedure
  ) INTO v_def;
  IF v_def IS NULL
     OR position('current_profile_id()' in v_def) = 0
     OR position('''office''' in v_def) = 0
     OR position('''supervisor''' in v_def) = 0
     OR position('''admin''' in v_def) = 0
     OR position('photo_url' in v_def) = 0
     OR position('photoCaptured' in v_def) = 0 THEN
    RAISE EXCEPTION 'create_authorized_pickup() is missing the actor/photo/audit safeguards';
  END IF;

  SELECT EXISTS (
    SELECT 1 FROM information_schema.routine_privileges
    WHERE routine_schema = 'public'
      AND routine_name = 'create_authorized_pickup'
      AND grantee = 'authenticated'
      AND privilege_type = 'EXECUTE'
  ) INTO v_granted;
  IF NOT v_granted THEN
    RAISE EXCEPTION 'create_authorized_pickup() is not granted to authenticated';
  END IF;
END $$;

RAISE NOTICE 'RLS authorized-pickups assertions: ALL PASSED';
