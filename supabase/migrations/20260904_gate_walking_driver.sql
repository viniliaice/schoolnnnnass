-- Dismissal Gate: walking students may use a registered driver (temporary pickup).
--
-- 20260903_gate_eligibility.sql classified transport and added the double-release
-- guard. That migration made WALKER/CAR a "one-click, no driver" release. This
-- migration relaxes it per the office workflow: a walking student can be released
-- walking (no driver) OR to a registered driver the office assigns for THIS pickup
-- — without overwriting the student's PERMANENT transport classification.
--
-- Data model (already supported by the schema, no new columns):
--   students.transport            = the PERMANENT/default classification
--   authorized_pickup_students    = the CURRENT pickup arrangement (junction)
-- So "Transport: Walking + Assigned driver: ASKO" is just transport='WALKER'
-- plus one junction row. A walking student's transport is never rewritten.
--
-- Changes here (CREATE OR REPLACE — same signatures/return types, so EXECUTE
-- grants from earlier migrations are preserved):
--   1. record_release() branches on "was a driver passed?" instead of only on
--      transport:
--        no driver   -> walking release (WALKER/CAR only; a DRIVER student is
--                       rejected and must pick a driver first).
--        with driver -> driver pickup (WALKER, CAR, or DRIVER; the driver must
--                       exist and be assigned to the student).
--      Audit/return carry `mode` ('driver'|'walking') + `transport` (permanent)
--      + `driverId`, so a walking student picked up by a driver is auditable.
--   2. attach_students_to_authorized_pickup() additionally rejects bus students
--      (numeric transport) and LEFT students — a bus student can never be
--      assigned a gate driver, server-side (not just hidden in the UI).

-- ─── 1. record_release(): walking release OR driver pickup ──────────────────
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

  -- Walking release vs driver pickup:
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
  -- from 20260903 is the race-condition backstop: concurrent inserts collide,
  -- one wins, the other gets unique_violation.
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

-- ─── 2. attach_students_to_authorized_pickup(): reject bus/LEFT students ────
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
