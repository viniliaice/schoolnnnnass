-- Driver management surface (independent of the gate) + phone de-dupe.
--
-- The junction model (authorized_pickups -> authorized_pickup_students) already
-- lets ONE driver be authorized for students across MULTIPLE families. What was
-- missing was the workflow to attach an existing driver to students outside a
-- gate lookup, and any protection against creating duplicate driver rows for
-- the same person at each family's gate session.
--
-- This migration adds:
--   1. find_authorized_pickup_by_phone()  — de-dupe lookup (gate + management UI)
--   2. list_authorized_pickups()          — full driver list with linked students
--                                            grouped for the management screen
--   3. attach_students_to_authorized_pickup()  — link an EXISTING driver to
--                                            students anywhere in the school
--   4. remove_student_from_authorized_pickup() — unlink one student (hard delete
--                                            of the junction row; no soft-delete
--                                            pattern exists anywhere in the
--                                            schema, and the junction is a pure
--                                            link with ON DELETE CASCADE)
--   5. create_authorized_pickup() gains a de-dupe guard: it refuses a NEW row
--      whose normalized phone matches an existing driver, unless the caller
--      explicitly passes p_allow_duplicate_phone = true (two distinct people
--      can legitimately share a number — the family-ID code already documents
--      that case — so the override stays, but it is explicit and audited).
--
-- Role model (decision, documented for review):
--   - create / attach  -> admin, supervisor, office. attach is STRICTLY LESS
--     powerful than create (it only links an existing person), and supervisor
--     already holds create_authorized_pickup at the gate — so attach must not
--     be narrower or a supervisor on gate duty would be pushed back into
--     creating duplicates (the exact problem this feature removes).
--   - list / remove    -> admin, office ONLY. The management screen is a
--     back-office data-entry surface. supervisor is deliberately excluded from
--     list_authorized_pickups(): a supervisor's students RLS is class-scoped
--     ("Teachers can read assigned class students"), so a whole-school
--     driver->student->family browse would leak student/family mappings beyond
--     their assigned classes. Their dismissal-oversight view stays the gate's
--     per-family lookup.
--   - office gains driver management and NOTHING else: family-ID writes
--     (generate/override/mark-left/import) stay admin-only. Verified by
--     supabase/tests/rls-manage-drivers.sql (the same narrow-widening invariant
--     rls-office-transport.sql enforces for transport editing).
--
-- All functions are SECURITY DEFINER with a pinned search_path and an explicit
-- role check, matching the repo convention (tables are SELECT-only under RLS).

-- ─── 1. find_authorized_pickup_by_phone(): de-dupe lookup ──────────────────
-- Returns the most-recently-added driver whose NORMALIZED phone matches, or
-- NULL. Normalization is the same normalize_phone() used for family grouping,
-- so '+252 61 2345678' and '0612345678' resolve to the same person.
CREATE OR REPLACE FUNCTION public.find_authorized_pickup_by_phone(p_phone TEXT)
RETURNS JSONB
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT jsonb_build_object(
    'id', ap.id,
    'name', ap.name,
    'phoneNumber', ap."phoneNumber",
    'relationship', ap.relationship,
    'photoPath', ap."photoPath",
    'addedAt', ap."addedAt"
  )
  FROM public.authorized_pickups ap
  WHERE public.normalize_phone(ap."phoneNumber") = public.normalize_phone(p_phone)
    AND public.normalize_phone(p_phone) <> ''
    AND public.current_profile_role() IN ('admin', 'supervisor', 'office')
    AND public.current_profile_id() IS NOT NULL
  ORDER BY ap."addedAt" DESC
  LIMIT 1;
$$;

-- ─── 2. list_authorized_pickups(): the management screen's dataset ─────────
-- One row per driver with the linked students (id, name, class, family) and the
-- counts the list view shows. Admin + office only (see the role-model note at
-- the top — supervisor is excluded on purpose, not by omission).
CREATE OR REPLACE FUNCTION public.list_authorized_pickups()
RETURNS JSONB
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT COALESCE(jsonb_agg(drv ORDER BY drv->>'name'), '[]'::JSONB)
  FROM (
    SELECT jsonb_build_object(
      'id', ap.id,
      'name', ap.name,
      'phoneNumber', ap."phoneNumber",
      'relationship', ap.relationship,
      'photoPath', ap."photoPath",
      'addedAt', ap."addedAt",
      'studentCount', COUNT(aps."studentId"),
      'familyCount', COUNT(DISTINCT s."familyId") FILTER (WHERE s."familyId" IS NOT NULL),
      'students', COALESCE(
        jsonb_agg(
          jsonb_build_object(
            'id', s.id,
            'name', s.name,
            'className', s."className",
            'familyId', s."familyId",
            'transport', s."transport"
          ) ORDER BY s."familyId", s.name
        ) FILTER (WHERE s.id IS NOT NULL),
        '[]'::JSONB
      )
    ) AS drv
    FROM public.authorized_pickups ap
    LEFT JOIN public.authorized_pickup_students aps ON aps."authorizedPickupId" = ap.id
    LEFT JOIN public.students s ON s.id = aps."studentId"
    WHERE public.current_profile_role() IN ('admin', 'office')
      AND public.current_profile_id() IS NOT NULL
    GROUP BY ap.id
  ) t;
$$;

-- ─── 3. attach_students_to_authorized_pickup(): link an EXISTING driver ────
-- Same non-empty student-id rule create_authorized_pickup() enforces (item #0):
-- staff must explicitly pick students; there is no implicit "all family".
-- Idempotent per link (ON CONFLICT DO NOTHING), so re-attaching is a no-op.
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
    -- Same guard as create_authorized_pickup(): only real, enrolled students.
    IF NOT EXISTS (
      SELECT 1 FROM public.students s
      WHERE s.id = v_student_id AND COALESCE(s."transport", '') <> 'LEFT'
    ) THEN
      RAISE EXCEPTION 'Student not found or has left the school: %', v_student_id
        USING ERRCODE = 'no_data_found';
    END IF;

    INSERT INTO public.authorized_pickup_students ("authorizedPickupId", "studentId")
    VALUES (p_pickup_id, v_student_id)
    ON CONFLICT DO NOTHING;
  END LOOP;

  INSERT INTO public.audit_logs (action, details, "createdAt")
  VALUES (
    'authorized_pickups.attach_students',
    jsonb_build_object(
      'personId', p_pickup_id,
      'staffId', v_actor_id,
      'studentIds', to_jsonb(p_student_ids)
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

-- ─── 4. remove_student_from_authorized_pickup(): unlink one student ────────
-- Hard delete of the junction row. There is no soft-delete/active pattern in
-- this schema (verified: no active/isActive/deletedAt column anywhere), and
-- the junction is a pure many-to-many link with ON DELETE CASCADE — "removed"
-- is simply "no longer linked". Admin + office only (supervisor is oversight).
CREATE OR REPLACE FUNCTION public.remove_student_from_authorized_pickup(
  p_pickup_id TEXT,
  p_student_id TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_actor_id TEXT := public.current_profile_id();
  v_role TEXT := public.current_profile_role();
BEGIN
  IF v_actor_id IS NULL OR v_role NOT IN ('admin', 'office') THEN
    RAISE EXCEPTION 'Only admins and office staff may remove a pickup authorization.'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF p_pickup_id IS NULL OR p_pickup_id = '' OR p_student_id IS NULL OR p_student_id = '' THEN
    RAISE EXCEPTION 'Driver and student are required.' USING ERRCODE = 'invalid_parameter_value';
  END IF;

  DELETE FROM public.authorized_pickup_students
  WHERE "authorizedPickupId" = p_pickup_id
    AND "studentId" = p_student_id;

  INSERT INTO public.audit_logs (action, details, "createdAt")
  VALUES (
    'authorized_pickups.remove_student',
    jsonb_build_object(
      'personId', p_pickup_id,
      'studentId', p_student_id,
      'staffId', v_actor_id
    ),
    NOW()
  );

  RETURN jsonb_build_object('personId', p_pickup_id, 'studentId', p_student_id, 'removed', true);
END;
$$;

-- ─── 5. create_authorized_pickup(): add the phone de-dupe guard ────────────
-- The argument list gains p_allow_duplicate_phone (DEFAULT false), so the old
-- 6-arg definition must be dropped first — CREATE OR REPLACE cannot change an
-- argument list. Old clients calling without the flag bind the DEFAULT and
-- therefore refuse a duplicate phone, which is the safe behavior.
DROP FUNCTION IF EXISTS public.create_authorized_pickup(TEXT, TEXT, TEXT, TEXT, TEXT, TEXT[]);

CREATE OR REPLACE FUNCTION public.create_authorized_pickup(
  p_id TEXT,
  p_name TEXT,
  p_phone_number TEXT,
  p_relationship TEXT,
  p_photo_path TEXT,
  p_student_ids TEXT[],
  p_allow_duplicate_phone BOOLEAN DEFAULT false
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_actor_id TEXT := public.current_profile_id();
  v_role TEXT := public.current_profile_role();
  v_student_id TEXT;
  v_linked INTEGER := 0;
BEGIN
  IF v_actor_id IS NULL OR v_role NOT IN ('admin', 'supervisor', 'office') THEN
    RAISE EXCEPTION 'Only gate staff may add pickup people.'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  IF p_id IS NULL OR p_id = '' THEN
    RAISE EXCEPTION 'ID is required.' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF p_name IS NULL OR trim(p_name) = '' THEN
    RAISE EXCEPTION 'Name is required.' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF p_phone_number IS NULL OR trim(p_phone_number) = '' THEN
    RAISE EXCEPTION 'Phone number is required.' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  -- Photo is REQUIRED at creation (captured once, permanent).
  IF p_photo_path IS NULL OR trim(p_photo_path) = '' THEN
    RAISE EXCEPTION 'A photo is required.' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF p_student_ids IS NULL OR array_length(p_student_ids, 1) IS NULL
     OR array_length(p_student_ids, 1) = 0 THEN
    RAISE EXCEPTION 'At least one student must be selected.'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  -- De-dupe: one driver per normalized phone, unless the caller explicitly
  -- overrides (two distinct people sharing a number). The client offers
  -- "attach to existing" via attach_students_to_authorized_pickup() first, so
  -- this guard is the backstop against accidental duplicates (and races).
  IF NOT p_allow_duplicate_phone THEN
    IF EXISTS (
      SELECT 1 FROM public.authorized_pickups ap
      WHERE public.normalize_phone(ap."phoneNumber") = public.normalize_phone(p_phone_number)
        AND public.normalize_phone(p_phone_number) <> ''
    ) THEN
      RAISE EXCEPTION 'A driver with this phone number already exists.'
        USING ERRCODE = 'invalid_parameter_value';
    END IF;
  END IF;

  INSERT INTO public.authorized_pickups
    (id, name, "phoneNumber", relationship, "photoPath", "addedByStaffId", "addedAt")
  VALUES
    (p_id, trim(p_name), trim(p_phone_number), NULLIF(trim(p_relationship), ''),
     p_photo_path, v_actor_id, NOW());

  FOREACH v_student_id IN ARRAY p_student_ids
  LOOP
    -- Only real, currently-enrolled students may be linked.
    IF NOT EXISTS (
      SELECT 1 FROM public.students s
      WHERE s.id = v_student_id AND COALESCE(s."transport", '') <> 'LEFT'
    ) THEN
      RAISE EXCEPTION 'Student not found or has left the school: %', v_student_id
        USING ERRCODE = 'no_data_found';
    END IF;
    INSERT INTO public.authorized_pickup_students ("authorizedPickupId", "studentId")
    VALUES (p_id, v_student_id);
    v_linked := v_linked + 1;
  END LOOP;

  INSERT INTO public.audit_logs (action, details, "createdAt")
  VALUES (
    'authorized_pickups.create',
    jsonb_build_object(
      'personId', p_id,
      'name', trim(p_name),
      'staffId', v_actor_id,
      'studentIds', to_jsonb(p_student_ids),
      'photoCaptured', true,
      'photoPath', p_photo_path,
      'duplicatePhoneOverride', p_allow_duplicate_phone
    ),
    NOW()
  );

  RETURN jsonb_build_object(
    'id', p_id,
    'name', trim(p_name),
    'phoneNumber', trim(p_phone_number),
    'relationship', NULLIF(trim(p_relationship), ''),
    'photoPath', p_photo_path,
    'addedByStaffId', v_actor_id,
    'addedAt', NOW(),
    'studentIds', to_jsonb(p_student_ids)
  );
END;
$$;

-- ─── Grants ────────────────────────────────────────────────────────────────
REVOKE ALL ON FUNCTION public.find_authorized_pickup_by_phone(TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.list_authorized_pickups() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.attach_students_to_authorized_pickup(TEXT, TEXT[]) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.remove_student_from_authorized_pickup(TEXT, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.create_authorized_pickup(TEXT, TEXT, TEXT, TEXT, TEXT, TEXT[], BOOLEAN) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION public.find_authorized_pickup_by_phone(TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.list_authorized_pickups() TO authenticated;
GRANT EXECUTE ON FUNCTION public.attach_students_to_authorized_pickup(TEXT, TEXT[]) TO authenticated;
GRANT EXECUTE ON FUNCTION public.remove_student_from_authorized_pickup(TEXT, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.create_authorized_pickup(TEXT, TEXT, TEXT, TEXT, TEXT, TEXT[], BOOLEAN) TO authenticated;
