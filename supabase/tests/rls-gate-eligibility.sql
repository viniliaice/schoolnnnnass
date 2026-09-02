-- RLS / schema assertions for Dismissal Gate eligibility (20260903_gate_eligibility.sql).
--
-- Run against a database with the migrations applied:
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f supabase/tests/rls-gate-eligibility.sql
-- Every DO block RAISEs on failure, so a failing assertion fails the script
-- (exit non-zero under ON_ERROR_STOP). Static checks on function definitions and
-- the schema (no seeded students, no session role) — matching the repo's other
-- rls-*.sql tests.

-- ── 1. students_transport_check accepts DRIVER ─────────────────────────────
DO $$
DECLARE
  v_def TEXT;
BEGIN
  SELECT pg_get_constraintdef(oid) INTO v_def
  FROM pg_constraint
  WHERE conname = 'students_transport_check'
    AND conrelid = 'public.students'::regclass;
  IF v_def IS NULL THEN
    RAISE EXCEPTION 'students_transport_check is missing';
  END IF;
  IF position('''DRIVER''' in v_def) = 0 THEN
    RAISE EXCEPTION 'students_transport_check does not accept DRIVER';
  END IF;
  IF position('''LEFT''' in v_def) = 0 THEN
    RAISE EXCEPTION 'students_transport_check lost LEFT (mark_student_left regression)';
  END IF;
END $$;

-- ── 2. record_release() rejects BUS students (server-side, not just UI) ────
DO $$
DECLARE
  v_def TEXT;
BEGIN
  SELECT pg_get_functiondef('public.record_release(text,text,text)'::regprocedure) INTO v_def;
  IF position('Bus students cannot be released through the Dismissal Gate' in v_def) = 0 THEN
    RAISE EXCEPTION 'record_release() does not reject bus students';
  END IF;
  -- LEFT / unrecognized transports are rejected too.
  IF position('Student is not eligible for the Dismissal Gate' in v_def) = 0 THEN
    RAISE EXCEPTION 'record_release() does not reject LEFT/unknown transports';
  END IF;
  -- Walking release: WALKER / CAR branch (driver is not required).
  IF position('''WALKER'', ''CAR''' in v_def) = 0 THEN
    RAISE EXCEPTION 'record_release() lost the walking (WALKER/CAR) path';
  END IF;
  -- Driver release requires an existing, assigned registered driver.
  IF position('Driver not found' in v_def) = 0 THEN
    RAISE EXCEPTION 'record_release() does not reject a nonexistent driver';
  END IF;
  IF position('Driver is not assigned to this student' in v_def) = 0 THEN
    RAISE EXCEPTION 'record_release() does not reject an unassigned driver';
  END IF;
  -- Double-release guard.
  IF position('Student has already been released today' in v_def) = 0 THEN
    RAISE EXCEPTION 'record_release() lacks the double-release guard';
  END IF;
END $$;

-- ── 3. one release per student per day (the race-condition backstop) ───────
DO $$
DECLARE
  v_ok BOOLEAN;
BEGIN
  SELECT EXISTS (
    SELECT 1 FROM pg_indexes
    WHERE schemaname = 'public'
      AND tablename = 'release_log'
      AND indexname = 'uniq_release_log_student_day'
  ) INTO v_ok;
  IF NOT v_ok THEN
    RAISE EXCEPTION 'release_log is missing the (studentId, day) unique index — concurrent double-release is possible';
  END IF;
END $$;

-- ── 4. set_student_transport() accepts DRIVER (admin + office) ─────────────
DO $$
DECLARE
  v_def TEXT;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO v_def
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public' AND p.proname = 'set_student_transport'
  ORDER BY p.oid DESC LIMIT 1;
  IF position('''DRIVER''' in v_def) = 0 THEN
    RAISE EXCEPTION 'set_student_transport() does not accept DRIVER';
  END IF;
END $$;

-- ── 5. attach_students_to_authorized_pickup() REPLACES (one driver/student) ─
DO $$
DECLARE
  v_def TEXT;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO v_def
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public' AND p.proname = 'attach_students_to_authorized_pickup'
  ORDER BY p.oid DESC LIMIT 1;
  IF position('DELETE FROM public.authorized_pickup_students' in v_def) = 0 THEN
    RAISE EXCEPTION 'attach_students_to_authorized_pickup() does not clear the prior assignment (a student could end up with two drivers)';
  END IF;
END $$;

-- ── 6. remove_student_driver(): gate roles, deletes the link not the driver ─
DO $$
DECLARE
  v_def TEXT;
  v_secdef BOOLEAN;
BEGIN
  SELECT pg_get_functiondef(p.oid), p.prosecdef INTO v_def, v_secdef
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public' AND p.proname = 'remove_student_driver'
  ORDER BY p.oid DESC LIMIT 1;

  IF v_def IS NULL THEN
    RAISE EXCEPTION 'remove_student_driver() is missing';
  END IF;
  IF NOT v_secdef THEN
    RAISE EXCEPTION 'remove_student_driver() lost SECURITY DEFINER';
  END IF;
  IF position('''admin''' in v_def) = 0
     OR position('''supervisor''' in v_def) = 0
     OR position('''office''' in v_def) = 0 THEN
    RAISE EXCEPTION 'remove_student_driver() is missing a gate role';
  END IF;
  -- Removes the assignment only — never the registered driver row.
  IF position('DELETE FROM public.authorized_pickup_students' in v_def) = 0 THEN
    RAISE EXCEPTION 'remove_student_driver() does not delete the junction row';
  END IF;
  IF position('DELETE FROM public.authorized_pickups' in v_def) > 0 THEN
    RAISE EXCEPTION 'remove_student_driver() deletes the registered driver — it must only remove the assignment';
  END IF;
END $$;

-- ── 7. search_authorized_pickups(): identity only, no family/student data ──
-- This is the cross-family-leak guard: a supervisor at the gate can search
-- drivers but must not see the driver's other students/families.
DO $$
DECLARE
  v_def TEXT;
  v_secdef BOOLEAN;
BEGIN
  SELECT pg_get_functiondef(p.oid), p.prosecdef INTO v_def, v_secdef
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public' AND p.proname = 'search_authorized_pickups'
  ORDER BY p.oid DESC LIMIT 1;

  IF v_def IS NULL THEN
    RAISE EXCEPTION 'search_authorized_pickups() is missing';
  END IF;
  IF NOT v_secdef THEN
    RAISE EXCEPTION 'search_authorized_pickups() lost SECURITY DEFINER';
  END IF;
  IF position('''admin''' in v_def) = 0
     OR position('''supervisor''' in v_def) = 0
     OR position('''office''' in v_def) = 0 THEN
    RAISE EXCEPTION 'search_authorized_pickups() is missing a gate role';
  END IF;
  IF position('authorized_pickup_students' in v_def) > 0 OR position('public.students' in v_def) > 0 THEN
    RAISE EXCEPTION 'search_authorized_pickups() joins student/family data — a shared driver would leak other families';
  END IF;
END $$;

-- ── 8. THE NARROW-WIDENING INVARIANT (office) ──────────────────────────────
-- Office gains driver assignment at the gate and NOTHING else. Family-ID powers
-- stay admin-only.
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
        '%() now admits office — the gate-eligibility widening leaked into family-ID powers', v_name;
    END IF;
  END LOOP;
END $$;

-- ── 9. new/changed RPCs are not executable by PUBLIC ───────────────────────
DO $$
DECLARE
  v_name TEXT;
BEGIN
  FOREACH v_name IN ARRAY ARRAY[
    'search_authorized_pickups(TEXT)',
    'remove_student_driver(TEXT)'
  ] LOOP
    IF has_function_privilege('public', format('public.%s', v_name), 'EXECUTE') THEN
      RAISE EXCEPTION '%() is executable by PUBLIC', v_name;
    END IF;
  END LOOP;
END $$;

SELECT 'rls-gate-eligibility: all assertions passed' AS result;
