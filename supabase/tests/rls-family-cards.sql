-- RLS / schema assertions for the family-ID stability fixes and the
-- card-data RPC (migration 20260819_family_id_stability_and_cards.sql).
--
-- These check invariants that unit tests CANNOT: the unit tests mock Supabase,
-- so they would happily pass against a database where the stale overload is
-- still bound or where get_family_cards leaks to parents. That exact failure
-- mode already shipped once in this feature (the import "Apply" bug).
--
-- Run against a database with the migrations applied:
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f supabase/tests/rls-family-cards.sql
-- Every DO block RAISEs on failure, so a failing assertion exits non-zero.

-- ── 1. Exactly ONE generate_family_ids overload, and it takes the filter ───
-- Migrations apply lexicographically, so 20260802_mark_student_left.sql
-- (0-arg, unfiltered) landed AFTER 20260802_generate_transport_filter.sql
-- (1-arg, filtered). Two overloads made rpc('generate_family_ids', {})
-- ambiguous — or silently bound the stale body.
DO $$
DECLARE
  v_count INT;
  v_args TEXT;
BEGIN
  SELECT count(*) INTO v_count
  FROM pg_proc
  WHERE proname = 'generate_family_ids' AND pronamespace = 'public'::regnamespace;
  IF v_count <> 1 THEN
    RAISE EXCEPTION 'expected exactly 1 generate_family_ids overload, found % — the stale 0-arg body must be dropped', v_count;
  END IF;

  SELECT pg_get_function_identity_arguments(oid) INTO v_args
  FROM pg_proc
  WHERE proname = 'generate_family_ids' AND pronamespace = 'public'::regnamespace;
  IF v_args NOT LIKE '%text%' THEN
    RAISE EXCEPTION 'generate_family_ids should accept the transport filter, got args: %', v_args;
  END IF;
END $$;

-- ── 2. The generator REUSES an existing family ID (no sibling splitting) ───
DO $$
DECLARE
  v_def TEXT;
BEGIN
  SELECT pg_get_functiondef(oid) INTO v_def
  FROM pg_proc
  WHERE proname = 'generate_family_ids' AND pronamespace = 'public'::regnamespace;

  IF v_def NOT LIKE '%v_existing%' THEN
    RAISE EXCEPTION 'generate_family_ids must look up an existing familyId for the group key before allocating a new number';
  END IF;
  IF v_def NOT LIKE '%pg_advisory_xact_lock%' THEN
    RAISE EXCEPTION 'generate_family_ids must take an advisory lock so concurrent runs cannot hand out the same ID';
  END IF;
  IF v_def NOT LIKE '%studentsJoined%' THEN
    RAISE EXCEPTION 'generate_family_ids must report studentsJoined so the UI can distinguish new families from late siblings';
  END IF;
END $$;

-- ── 3. mark_student_left must NOT clear familyId ──────────────────────────
-- A Family ID is a stable identifier: marking a student as left and later
-- restoring them must return them to the SAME family.
DO $$
DECLARE
  v_def TEXT;
BEGIN
  SELECT pg_get_functiondef(oid) INTO v_def
  FROM pg_proc
  WHERE proname = 'mark_student_left' AND pronamespace = 'public'::regnamespace;

  IF v_def ~* '"familyId"\s*=\s*NULL' THEN
    RAISE EXCEPTION 'mark_student_left must not null familyId — restoring a student has to rejoin their original family';
  END IF;
END $$;

-- ── 4. Readers exclude students who left ──────────────────────────────────
-- Because LEFT students now keep their familyId, every place that
-- materialises a family must filter them, or a departed child reappears at
-- the dismissal gate.
DO $$
DECLARE
  v_lookup TEXT;
  v_cards TEXT;
BEGIN
  SELECT pg_get_functiondef(oid) INTO v_lookup
  FROM pg_proc WHERE proname = 'lookup_family' AND pronamespace = 'public'::regnamespace;
  SELECT pg_get_functiondef(oid) INTO v_cards
  FROM pg_proc WHERE proname = 'get_family_cards' AND pronamespace = 'public'::regnamespace;

  IF v_lookup NOT LIKE '%LEFT%' THEN
    RAISE EXCEPTION 'lookup_family must exclude students whose transport is LEFT';
  END IF;
  IF v_cards NOT LIKE '%LEFT%' THEN
    RAISE EXCEPTION 'get_family_cards must exclude students whose transport is LEFT';
  END IF;
END $$;

-- ── 5. get_family_cards: exists, SECURITY DEFINER, STABLE, role-gated ─────
-- STABLE is load-bearing: Postgres rejects writes inside a STABLE function,
-- so the printing path is structurally incapable of generating a family ID.
DO $$
DECLARE
  v_secdef BOOLEAN;
  v_volatile "char";
  v_def TEXT;
  v_count INT;
BEGIN
  SELECT count(*) INTO v_count
  FROM pg_proc WHERE proname = 'get_family_cards' AND pronamespace = 'public'::regnamespace;
  IF v_count <> 1 THEN
    RAISE EXCEPTION 'get_family_cards not found (found %)', v_count;
  END IF;

  SELECT prosecdef, provolatile, pg_get_functiondef(oid)
    INTO v_secdef, v_volatile, v_def
  FROM pg_proc WHERE proname = 'get_family_cards' AND pronamespace = 'public'::regnamespace;

  IF NOT v_secdef THEN
    RAISE EXCEPTION 'get_family_cards must be SECURITY DEFINER so supervisors get the COMPLETE sibling roster';
  END IF;
  IF v_volatile <> 's' THEN
    RAISE EXCEPTION 'get_family_cards must be STABLE so printing can never write (got volatility %)', v_volatile;
  END IF;
  IF v_def NOT LIKE '%current_profile_role()%'
     OR v_def NOT LIKE '%admin%' OR v_def NOT LIKE '%supervisor%' OR v_def NOT LIKE '%office%' THEN
    RAISE EXCEPTION 'get_family_cards must gate on current_profile_role() IN (admin, supervisor, office)';
  END IF;
  IF v_def NOT LIKE '%search_path%' THEN
    RAISE EXCEPTION 'get_family_cards must pin search_path (SECURITY DEFINER hardening)';
  END IF;
END $$;

-- ── 6. get_family_cards resolves the parent phone like the gate does ──────
-- The card and the gate must never show different numbers for one family.
DO $$
DECLARE
  v_def TEXT;
BEGIN
  SELECT pg_get_functiondef(oid) INTO v_def
  FROM pg_proc WHERE proname = 'get_family_cards' AND pronamespace = 'public'::regnamespace;

  IF v_def NOT LIKE '%phone1%' OR v_def NOT LIKE '%phone2%' THEN
    RAISE EXCEPTION 'get_family_cards must prefer profile phones (phone1/phone2) exactly like lookup_family';
  END IF;
  IF v_def NOT LIKE '%className%' THEN
    RAISE EXCEPTION 'get_family_cards must return className — it is the grade source printed on the card';
  END IF;
END $$;

-- ── 7. PUBLIC execute is revoked on the new/changed RPCs ──────────────────
DO $$
DECLARE
  v_fn TEXT;
BEGIN
  FOREACH v_fn IN ARRAY ARRAY['get_family_cards', 'generate_family_ids', 'mark_student_left', 'lookup_family']
  LOOP
    IF EXISTS (
      SELECT 1 FROM pg_proc p
      WHERE p.proname = v_fn AND p.pronamespace = 'public'::regnamespace
        AND has_function_privilege('public', p.oid, 'EXECUTE')
    ) THEN
      RAISE EXCEPTION '% must not be executable by PUBLIC', v_fn;
    END IF;
  END LOOP;
END $$;

-- ── 8. students still has no direct write policy ──────────────────────────
DO $$
DECLARE
  v_bad INT;
BEGIN
  SELECT count(*) INTO v_bad
  FROM pg_policies
  WHERE schemaname = 'public' AND tablename = 'students'
    AND cmd IN ('UPDATE', 'INSERT', 'DELETE', 'ALL');
  IF v_bad > 0 THEN
    RAISE EXCEPTION 'students has % direct write policy(ies) — all writes must go through the RPCs', v_bad;
  END IF;
END $$;

SELECT 'rls-family-cards.sql: all assertions passed' AS result;
