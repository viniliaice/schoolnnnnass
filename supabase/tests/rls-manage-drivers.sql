-- RLS / role assertions for the driver-management surface (20260902_manage_drivers.sql).
--
-- Run against a database with the migrations applied:
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f supabase/tests/rls-manage-drivers.sql
-- Every DO block RAISEs on failure, so a failing assertion fails the script
-- (exit non-zero under ON_ERROR_STOP).
--
-- These are STATIC checks on the function definitions (no seeded students, no
-- session role), matching rls-office-transport.sql. The SECURITY DEFINER RPCs
-- all read current_profile_role() from auth.uid(), which is NULL in a plain
-- psql session, so the duplicate-create behaviour is asserted through the
-- function text (the guard must exist in create_authorized_pickup) rather than
-- by executing a write.

-- ── 1. find_authorized_pickup_by_phone(): de-dupe lookup, gate roles ───────
DO $$
DECLARE
  v_def TEXT;
  v_secdef BOOLEAN;
  v_config TEXT[];
BEGIN
  SELECT pg_get_functiondef(p.oid), p.prosecdef, p.proconfig INTO v_def, v_secdef, v_config
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public' AND p.proname = 'find_authorized_pickup_by_phone'
  ORDER BY p.oid DESC LIMIT 1;

  IF v_def IS NULL THEN
    RAISE EXCEPTION 'find_authorized_pickup_by_phone() is missing';
  END IF;
  IF NOT v_secdef THEN
    RAISE EXCEPTION 'find_authorized_pickup_by_phone() lost SECURITY DEFINER';
  END IF;
  IF v_config IS NULL OR NOT (v_config @> ARRAY['search_path=public']) THEN
    RAISE EXCEPTION 'find_authorized_pickup_by_phone() lost its pinned search_path';
  END IF;
  IF position('normalize_phone' in v_def) = 0 THEN
    RAISE EXCEPTION 'find_authorized_pickup_by_phone() does not normalize the phone';
  END IF;
  IF position('''admin''' in v_def) = 0
     OR position('''supervisor''' in v_def) = 0
     OR position('''office''' in v_def) = 0 THEN
    RAISE EXCEPTION 'find_authorized_pickup_by_phone() is missing a gate role';
  END IF;
END $$;

-- ── 2. list_authorized_pickups(): admin + office, supervisor EXCLUDED ──────
-- supervisor's students RLS is class-scoped, so a whole-school driver->student
-- ->family browse must NOT be exposed to them (the cross-family leak guard).
DO $$
DECLARE
  v_def TEXT;
  v_secdef BOOLEAN;
BEGIN
  SELECT pg_get_functiondef(p.oid), p.prosecdef INTO v_def, v_secdef
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public' AND p.proname = 'list_authorized_pickups'
  ORDER BY p.oid DESC LIMIT 1;

  IF v_def IS NULL THEN
    RAISE EXCEPTION 'list_authorized_pickups() is missing';
  END IF;
  IF NOT v_secdef THEN
    RAISE EXCEPTION 'list_authorized_pickups() lost SECURITY DEFINER';
  END IF;
  IF position('''admin''' in v_def) = 0 OR position('''office''' in v_def) = 0 THEN
    RAISE EXCEPTION 'list_authorized_pickups() must admit admin + office';
  END IF;
  IF position('''supervisor''' in v_def) > 0 THEN
    RAISE EXCEPTION 'list_authorized_pickups() admits supervisor — whole-school student/family browse would leak past their class-scoped students RLS';
  END IF;
END $$;

-- ── 3. attach_students_to_authorized_pickup(): gate roles, non-empty, audit ─
DO $$
DECLARE
  v_def TEXT;
  v_secdef BOOLEAN;
  v_config TEXT[];
BEGIN
  SELECT pg_get_functiondef(p.oid), p.prosecdef, p.proconfig INTO v_def, v_secdef, v_config
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public' AND p.proname = 'attach_students_to_authorized_pickup'
  ORDER BY p.oid DESC LIMIT 1;

  IF v_def IS NULL THEN
    RAISE EXCEPTION 'attach_students_to_authorized_pickup() is missing';
  END IF;
  IF NOT v_secdef THEN
    RAISE EXCEPTION 'attach_students_to_authorized_pickup() lost SECURITY DEFINER';
  END IF;
  IF v_config IS NULL OR NOT (v_config @> ARRAY['search_path=public']) THEN
    RAISE EXCEPTION 'attach_students_to_authorized_pickup() lost its pinned search_path';
  END IF;
  IF position('''admin''' in v_def) = 0
     OR position('''supervisor''' in v_def) = 0
     OR position('''office''' in v_def) = 0 THEN
    RAISE EXCEPTION 'attach_students_to_authorized_pickup() is missing a gate role';
  END IF;
  IF position('At least one student must be selected' in v_def) = 0 THEN
    RAISE EXCEPTION 'attach_students_to_authorized_pickup() does not reject an empty student selection';
  END IF;
  IF position('audit_logs' in v_def) = 0 THEN
    RAISE EXCEPTION 'attach_students_to_authorized_pickup() does not write the audit trail';
  END IF;
END $$;

-- ── 4. remove_student_from_authorized_pickup(): admin + office, no supervisor ─
DO $$
DECLARE
  v_def TEXT;
  v_secdef BOOLEAN;
BEGIN
  SELECT pg_get_functiondef(p.oid), p.prosecdef INTO v_def, v_secdef
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public' AND p.proname = 'remove_student_from_authorized_pickup'
  ORDER BY p.oid DESC LIMIT 1;

  IF v_def IS NULL THEN
    RAISE EXCEPTION 'remove_student_from_authorized_pickup() is missing';
  END IF;
  IF NOT v_secdef THEN
    RAISE EXCEPTION 'remove_student_from_authorized_pickup() lost SECURITY DEFINER';
  END IF;
  IF position('''admin''' in v_def) = 0 OR position('''office''' in v_def) = 0 THEN
    RAISE EXCEPTION 'remove_student_from_authorized_pickup() must admit admin + office';
  END IF;
  IF position('''supervisor''' in v_def) > 0 THEN
    RAISE EXCEPTION 'remove_student_from_authorized_pickup() admits supervisor — removal is back-office, not oversight';
  END IF;
  IF position('audit_logs' in v_def) = 0 THEN
    RAISE EXCEPTION 'remove_student_from_authorized_pickup() does not write the audit trail';
  END IF;
END $$;

-- ── 5. create_authorized_pickup(): de-dupe guard + explicit override ───────
-- The guard (normalized-phone match refuses a new row) is what prevents
-- "adding the same driver twice" from producing two authorized_pickups rows;
-- p_allow_duplicate_phone is the audited override for two people sharing a
-- number (the family-ID code already documents shared-phone households).
DO $$
DECLARE
  v_def TEXT;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO v_def
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public' AND p.proname = 'create_authorized_pickup'
  ORDER BY p.oid DESC LIMIT 1;

  IF v_def IS NULL THEN
    RAISE EXCEPTION 'create_authorized_pickup() is missing';
  END IF;
  IF position('p_allow_duplicate_phone' in v_def) = 0 THEN
    RAISE EXCEPTION 'create_authorized_pickup() lost the duplicate-phone override flag';
  END IF;
  IF position('A driver with this phone number already exists' in v_def) = 0 THEN
    RAISE EXCEPTION 'create_authorized_pickup() lacks the duplicate-phone guard — a second row for the same phone would be created silently';
  END IF;
  IF position('normalize_phone' in v_def) = 0 THEN
    RAISE EXCEPTION 'create_authorized_pickup() does not compare normalized phone numbers';
  END IF;
END $$;

-- ── 6. THE NARROW-WIDENING INVARIANT (office) ──────────────────────────────
-- Office gains driver management and NOTHING else. Each of these must still be
-- admin-only, or a front-desk account could reshape families.
DO $$
DECLARE
  v_name TEXT;
  v_def  TEXT;
BEGIN
  FOREACH v_name IN ARRAY ARRAY[
    'generate_family_ids',
    'assign_family_override',
    'mark_student_left',
    'set_student_import_fields'
  ] LOOP
    SELECT pg_get_functiondef(p.oid) INTO v_def
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.proname = v_name
    ORDER BY p.oid DESC LIMIT 1;

    IF v_def IS NULL THEN
      RAISE NOTICE 'skip: %() not present in this database', v_name;
      CONTINUE;
    END IF;

    IF position('''office''' in v_def) > 0 THEN
      RAISE EXCEPTION
        '%() now admits office — the driver-management widening leaked into family-ID powers', v_name;
    END IF;
  END LOOP;
END $$;

-- ── 7. the new RPCs are not executable by PUBLIC ───────────────────────────
DO $$
DECLARE
  v_name TEXT;
BEGIN
  FOREACH v_name IN ARRAY ARRAY[
    'find_authorized_pickup_by_phone(TEXT)',
    'list_authorized_pickups()',
    'attach_students_to_authorized_pickup(TEXT,TEXT[])',
    'remove_student_from_authorized_pickup(TEXT,TEXT)'
  ] LOOP
    IF has_function_privilege('public', format('public.%s', v_name), 'EXECUTE') THEN
      RAISE EXCEPTION '%() is executable by PUBLIC', v_name;
    END IF;
  END LOOP;
END $$;

-- ── 8. no direct write policy on the driver tables ─────────────────────────
-- Writes must go through the SECURITY DEFINER RPCs, never straight to the
-- tables (that is what keeps the role check and the audit row).
DO $$
DECLARE
  v_bad INT;
BEGIN
  SELECT count(*) INTO v_bad
  FROM pg_policies
  WHERE schemaname = 'public'
    AND tablename IN ('authorized_pickups', 'authorized_pickup_students')
    AND cmd IN ('INSERT', 'UPDATE', 'DELETE');
  IF v_bad > 0 THEN
    RAISE EXCEPTION '% direct write policy(ies) on authorized_pickups(_students) — RPCs must be the only writer', v_bad;
  END IF;
END $$;

SELECT 'rls-manage-drivers: all assertions passed' AS result;
