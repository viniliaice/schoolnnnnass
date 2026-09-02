-- Dismissal Gate transport eligibility + driver assignment + fast release.
--
-- The gate is NOT for every student. Transport (the student's PERMANENT/default
-- classification) decides gate eligibility; the CURRENT pickup arrangement is a
-- separate concept stored in authorized_pickup_students:
--
--   WALKER / CAR / unset  -> eligible. Released one-click with NO driver, OR to a
--                            driver the office assigns (a temporary pickup — the
--                            student's permanent transport is NOT overwritten).
--   DRIVER                -> eligible. Release REQUIRES an assigned registered driver.
--   numeric (bus)         -> EXCLUDED: never released AND never assigned a driver
--                            (the server rejects both).
--   LEFT / unrecognized   -> EXCLUDED.
--
-- Drivers stay in authorized_pickups (registered centrally, admin+office) linked
-- to students via authorized_pickup_students. ONE driver -> MANY students ->
-- MANY families is the existing data model (no familyId on the driver). The gate
-- only SEARCHES registered drivers and assigns them; it can no longer create a
-- driver record.
--
-- Changes here:
--   1. students_transport_check gains 'DRIVER'.
--   2. set_student_transport() accepts 'DRIVER' (admin+office, unchanged scope).
--   3. record_release() branches on transport: a WALKER/CAR student may be
--      released walking (no driver) OR to an assigned driver (temporary pickup);
--      a DRIVER student requires an assigned driver; bus/LEFT/unknown are
--      rejected. Adds a double-release guard (one release per student per UTC day).
--   4. release_log gains a UNIQUE index on (studentId, UTC date) — the
--      race-condition guard: concurrent releases of the same student -> one wins,
--      the other gets unique_violation.
--   5. attach_students_to_authorized_pickup() becomes a REPLACE (delete-then-insert
--      per student) so a student has exactly ONE assigned driver, and rejects
--      bus students (they can never be assigned a gate driver).
--   6. remove_student_driver() clears a student's assignment(s) without touching
--      the registered driver.
--   7. search_authorized_pickups() returns driver IDENTITY only (no student/family
--      data) for the gate picker — supervisor-safe, no cross-family leak.

-- ─── 1. transport CHECK accepts DRIVER ──────────────────────────────────────
ALTER TABLE public.students DROP CONSTRAINT IF EXISTS students_transport_check;
ALTER TABLE public.students ADD CONSTRAINT students_transport_check
  CHECK ("transport" IS NULL
     OR "transport" IN ('WALKER', 'CAR', 'DRIVER', 'LEFT')
     OR "transport" ~ '^\d+$');

-- ─── 2. set_student_transport(): accept DRIVER (admin + office) ─────────────
-- Recreated from 20260820_office_transport_edit.sql with the validator widened.
CREATE OR REPLACE FUNCTION public.set_student_transport(p_student_id TEXT, p_transport TEXT)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_role     TEXT := public.current_profile_role();
  v_actor    TEXT := public.current_profile_id();
  v_previous TEXT;
BEGIN
  IF v_role IS NULL OR v_role NOT IN ('admin', 'office') THEN
    RAISE EXCEPTION 'Only admins and office staff may change transport.'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  IF p_transport IS NULL OR trim(p_transport) = '' THEN
    RAISE EXCEPTION 'Transport value is required.'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  -- WALKER, CAR, DRIVER, or a bus number. 'LEFT' is NOT settable here —
  -- leaving the school goes through mark_student_left(), which stays admin-only.
  IF p_transport NOT IN ('WALKER', 'CAR', 'DRIVER') AND p_transport !~ '^\d+$' THEN
    RAISE EXCEPTION 'Transport must be WALKER, CAR, DRIVER, or a bus number.'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  SELECT "transport" INTO v_previous FROM public.students WHERE id = p_student_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Student not found.' USING ERRCODE = 'no_data_found';
  END IF;

  -- Guard the one thing office must never do by accident: revive a student
  -- who has left. Changing transport is not an enrolment decision.
  IF COALESCE(v_previous, '') = 'LEFT' AND v_role <> 'admin' THEN
    RAISE EXCEPTION 'This student is marked as LEFT. An admin must re-enrol them first.'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  UPDATE public.students SET "transport" = p_transport WHERE id = p_student_id;

  INSERT INTO public.audit_logs (action, details, "createdAt")
  VALUES (
    'family_ids.transport',
    jsonb_build_object(
      'studentId', p_student_id,
      'transport', p_transport,
      'previous',  v_previous,
      'actorId',   v_actor,
      'actorRole', v_role
    ),
    NOW()
  );
END;
$$;

-- ─── 3. record_release(): transport-eligibility + double-release ────────────
-- Drop the old 3-arg body first (same overload discipline as before: never leave
-- two bindable definitions). pickup_person_id is NULL for a walking release.
DROP FUNCTION IF EXISTS public.record_release(TEXT, TEXT, TEXT);

CREATE OR REPLACE FUNCTION public.record_release(
  p_student_id TEXT,
  p_family_id TEXT,
  p_pickup_person_id TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_actor_id TEXT := public.current_profile_id();
  v_role TEXT := public.current_profile_role();
  v_norm_family TEXT := public.normalize_family_id(p_family_id);
  v_student RECORD;
  v_transport TEXT;
  v_mode TEXT;
  v_release_id BIGINT;
BEGIN
  IF v_actor_id IS NULL OR v_role NOT IN ('admin', 'supervisor', 'office') THEN
    RAISE EXCEPTION 'Only admins, supervisors, and office staff may record releases.'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF p_student_id IS NULL OR p_student_id = '' OR v_norm_family = '' THEN
    RAISE EXCEPTION 'Student and family IDs are required.'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  SELECT id, "familyId", "transport" INTO v_student
  FROM public.students
  WHERE id = p_student_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Student not found.' USING ERRCODE = 'no_data_found';
  END IF;

  IF v_student."familyId" IS NULL
     OR public.normalize_family_id(v_student."familyId") <> v_norm_family THEN
    RAISE EXCEPTION 'Student does not belong to the given family.'
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;

  -- Unset transport means WALKER (the system-wide business rule). This is the
  -- student's PERMANENT/default classification; the pickup arrangement for
  -- this release is decided below from p_pickup_person_id.
  v_transport := COALESCE(v_student."transport", 'WALKER');

  -- Bus students are never released through the Dismissal Gate.
  IF v_transport ~ '^\d+$' THEN
    RAISE EXCEPTION 'Bus students cannot be released through the Dismissal Gate.'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  -- LEFT or an unrecognized transport value is never eligible.
  IF v_transport NOT IN ('WALKER', 'CAR', 'DRIVER') THEN
    RAISE EXCEPTION 'Student is not eligible for the Dismissal Gate.'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  -- Decide walking release vs driver pickup:
  --   no driver   -> a plain walking release. Only WALKER/CAR qualify — a DRIVER
  --                  student must select an assigned driver first.
  --   with driver -> a driver pickup. WALKER, CAR, and DRIVER all qualify; the
  --                  student's permanent transport stays unchanged, so a walking
  --                  student with a temporary pickup keeps transport = WALKER.
  IF p_pickup_person_id IS NULL OR p_pickup_person_id = '' THEN
    IF v_transport = 'DRIVER' THEN
      RAISE EXCEPTION 'A driver must be selected before releasing this student.'
        USING ERRCODE = 'invalid_parameter_value';
    END IF;
    p_pickup_person_id := NULL;
    v_mode := 'walking';
  ELSE
    IF NOT EXISTS (
      SELECT 1 FROM public.authorized_pickups ap WHERE ap.id = p_pickup_person_id
    ) THEN
      RAISE EXCEPTION 'Driver not found.' USING ERRCODE = 'no_data_found';
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM public.authorized_pickup_students aps
      WHERE aps."authorizedPickupId" = p_pickup_person_id
        AND aps."studentId" = p_student_id
    ) THEN
      RAISE EXCEPTION 'Driver is not assigned to this student.'
        USING ERRCODE = 'integrity_constraint_violation';
    END IF;
    v_mode := 'driver';
  END IF;

  -- Insert with a double-release guard. The UNIQUE index on (studentId, UTC day)
  -- is the race-condition backstop: concurrent inserts collide, one wins.
  BEGIN
    INSERT INTO public.release_log
      ("studentId", "familyId", "staffId", "pickupPersonId", "createdAt")
    VALUES
      (p_student_id, v_student."familyId", v_actor_id, p_pickup_person_id, NOW())
    RETURNING id INTO v_release_id;
  EXCEPTION WHEN unique_violation THEN
    RAISE EXCEPTION 'Student has already been released today.'
      USING ERRCODE = 'unique_violation';
  END;

  INSERT INTO public.audit_logs (action, details, "createdAt")
  VALUES (
    'family_ids.release',
    jsonb_build_object(
      'releaseId', v_release_id,
      'studentId', p_student_id,
      'familyId', v_student."familyId",
      'staffId', v_actor_id,
      'mode', v_mode,              -- 'driver' pickup vs 'walking' release
      'transport', v_transport,    -- the student's PERMANENT/default transport
      'driverId', p_pickup_person_id
    ),
    NOW()
  );

  RETURN jsonb_build_object(
    'id', v_release_id,
    'studentId', p_student_id,
    'familyId', v_student."familyId",
    'staffId', v_actor_id,
    'pickupPersonId', p_pickup_person_id,
    'mode', v_mode,
    'createdAt', NOW()
  );
END;
$$;

-- ─── 4. double-release guard: one release per student per UTC day ───────────
-- Before the UNIQUE index can exist, collapse any pre-existing same-day
-- duplicates (they violate the new invariant and are exactly what this guard
-- prevents). Keep the FIRST release per (student, UTC day) — the row with the
-- lowest id — and delete the later ones. The release EVENT is not lost: every
-- release also wrote a family_ids.release row into audit_logs, which is left
-- untouched. Idempotent: with no duplicates it deletes nothing.
DELETE FROM public.release_log
WHERE id IN (
  SELECT id
  FROM (
    SELECT id,
           ROW_NUMBER() OVER (
             PARTITION BY "studentId", ("createdAt" AT TIME ZONE 'UTC')::date
             ORDER BY id
           ) AS rn
    FROM public.release_log
  ) ranked
  WHERE rn > 1
);

-- The race-condition backstop: concurrent releases of the same student -> one
-- wins, the other gets unique_violation (surfaced by record_release as
-- 'Student has already been released today.').
CREATE UNIQUE INDEX IF NOT EXISTS uniq_release_log_student_day
  ON public.release_log ("studentId", (("createdAt" AT TIME ZONE 'UTC')::date));

-- ─── 5. attach_students_to_authorized_pickup(): REPLACE per student ─────────
-- One assigned driver per student. Re-linking a student first clears their prior
-- assignment, so "Assign driver" / "Change driver" never stack two drivers on one
-- student. Walking and DRIVER students are assignable; LEFT and bus students are
-- rejected. Idempotent: attaching the same driver twice is a no-op.
CREATE OR REPLACE FUNCTION public.attach_students_to_authorized_pickup(
  p_pickup_id TEXT,
  p_student_ids TEXT[]
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_actor_id TEXT := public.current_profile_id();
  v_role TEXT := public.current_profile_role();
  v_person RECORD;
  v_student_id TEXT;
  v_transport TEXT;
BEGIN
  IF v_actor_id IS NULL OR v_role NOT IN ('admin', 'supervisor', 'office') THEN
    RAISE EXCEPTION 'Only gate staff may manage pickup people.'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF p_pickup_id IS NULL OR p_pickup_id = '' THEN
    RAISE EXCEPTION 'Driver is required.' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF p_student_ids IS NULL OR array_length(p_student_ids, 1) IS NULL
     OR array_length(p_student_ids, 1) = 0 THEN
    RAISE EXCEPTION 'At least one student must be selected.'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  SELECT id, name, "phoneNumber", relationship, "photoPath", "addedAt"
    INTO v_person
  FROM public.authorized_pickups
  WHERE id = p_pickup_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Driver not found.' USING ERRCODE = 'no_data_found';
  END IF;

  FOREACH v_student_id IN ARRAY p_student_ids
  LOOP
    SELECT "transport" INTO v_transport
    FROM public.students s
    WHERE s.id = v_student_id;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'Student not found: %', v_student_id
        USING ERRCODE = 'no_data_found';
    END IF;

    IF v_transport = 'LEFT' THEN
      RAISE EXCEPTION 'Student has left the school: %', v_student_id
        USING ERRCODE = 'no_data_found';
    END IF;

    -- Bus students are never assigned a gate driver (server-side, not just UI).
    IF v_transport ~ '^\d+$' THEN
      RAISE EXCEPTION 'Bus students cannot be assigned a driver.'
        USING ERRCODE = 'invalid_parameter_value';
    END IF;

    -- Replace: a student has exactly one assigned driver.
    DELETE FROM public.authorized_pickup_students
      WHERE "studentId" = v_student_id;

    INSERT INTO public.authorized_pickup_students ("authorizedPickupId", "studentId")
    VALUES (p_pickup_id, v_student_id);
  END LOOP;

  INSERT INTO public.audit_logs (action, details, "createdAt")
  VALUES (
    'authorized_pickups.attach_students',
    jsonb_build_object(
      'personId', p_pickup_id,
      'staffId', v_actor_id,
      'studentIds', to_jsonb(p_student_ids),
      'replace', true
    ),
    NOW()
  );

  RETURN jsonb_build_object(
    'id', p_pickup_id,
    'name', v_person.name,
    'phoneNumber', v_person."phoneNumber",
    'relationship', v_person.relationship,
    'photoPath', v_person."photoPath",
    'addedAt', v_person."addedAt",
    'studentIds', to_jsonb(p_student_ids)
  );
END;
$$;

-- ─── 6. remove_student_driver(): clear a student's assignment ───────────────
-- Deletes the junction rows only — the registered driver record stays.
CREATE OR REPLACE FUNCTION public.remove_student_driver(p_student_id TEXT)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_actor_id TEXT := public.current_profile_id();
  v_role TEXT := public.current_profile_role();
BEGIN
  IF v_actor_id IS NULL OR v_role NOT IN ('admin', 'supervisor', 'office') THEN
    RAISE EXCEPTION 'Only gate staff may remove a pickup assignment.'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF p_student_id IS NULL OR p_student_id = '' THEN
    RAISE EXCEPTION 'Student is required.' USING ERRCODE = 'invalid_parameter_value';
  END IF;

  DELETE FROM public.authorized_pickup_students
    WHERE "studentId" = p_student_id;

  INSERT INTO public.audit_logs (action, details, "createdAt")
  VALUES (
    'authorized_pickups.remove_student_driver',
    jsonb_build_object('studentId', p_student_id, 'staffId', v_actor_id),
    NOW()
  );

  RETURN jsonb_build_object('studentId', p_student_id, 'removed', true);
END;
$$;

-- ─── 7. search_authorized_pickups(): identity-only driver search ────────────
-- Returns name/phone/photo only — NO student or family data. This is the gate's
-- "Add driver" picker data source, and it is what keeps a supervisor (who can use
-- the gate but whose students RLS is class-scoped) from cross-referencing
-- unrelated families through a shared driver.
CREATE OR REPLACE FUNCTION public.search_authorized_pickups(p_query TEXT)
RETURNS JSONB
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT COALESCE(jsonb_agg(d ORDER BY d->>'name'), '[]'::JSONB)
  FROM (
    SELECT jsonb_build_object(
      'id', ap.id,
      'name', ap.name,
      'phoneNumber', ap."phoneNumber",
      'relationship', ap.relationship,
      'photoPath', ap."photoPath",
      'addedAt', ap."addedAt"
    ) AS d
    FROM public.authorized_pickups ap
    WHERE public.current_profile_role() IN ('admin', 'supervisor', 'office')
      AND public.current_profile_id() IS NOT NULL
      AND (
        p_query IS NULL OR p_query = ''
        OR ap.name ILIKE '%' || p_query || '%'
        OR ap."phoneNumber" ILIKE '%' || p_query || '%'
      )
    LIMIT 50
  ) t;
$$;

-- ─── Grants ────────────────────────────────────────────────────────────────
-- record_release() was DROPped above (its 3-arg body changed), which also
-- dropped its EXECUTE grant — re-establish it or the gate breaks for everyone.
REVOKE ALL ON FUNCTION public.record_release(TEXT, TEXT, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.record_release(TEXT, TEXT, TEXT) TO authenticated;

REVOKE ALL ON FUNCTION public.search_authorized_pickups(TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.remove_student_driver(TEXT) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION public.search_authorized_pickups(TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.remove_student_driver(TEXT) TO authenticated;
