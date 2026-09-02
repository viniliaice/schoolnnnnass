-- A family card can cover siblings who are not all travelling with the same
-- driver. Keep the driver profile family-scoped for Storage, but authorize it
-- only for the selected students in that family.

ALTER TABLE public.authorized_pickups
  ADD COLUMN IF NOT EXISTS student_ids TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];

-- Existing rows from the first driver-profile migration represented a whole
-- family. Preserve that behavior for old records while new records choose
-- their students explicitly in the gate form.
UPDATE public.authorized_pickups ap
SET student_ids = COALESCE((
  SELECT array_agg(s.id ORDER BY s.name)
  FROM public.students s
  WHERE s."familyId" = ap.family_id
    AND COALESCE(s."transport", '') <> 'LEFT'
), ARRAY[]::TEXT[])
WHERE cardinality(ap.student_ids) = 0;

ALTER TABLE public.authorized_pickups
  DROP CONSTRAINT IF EXISTS authorized_pickups_student_ids_check;
ALTER TABLE public.authorized_pickups
  ADD CONSTRAINT authorized_pickups_student_ids_check
  CHECK (cardinality(student_ids) > 0) NOT VALID;

CREATE INDEX IF NOT EXISTS idx_authorized_pickups_student_ids
  ON public.authorized_pickups USING GIN (student_ids);

-- New write path: one profile/photo, scoped to one or more selected children.
CREATE OR REPLACE FUNCTION public.create_authorized_pickup(
  p_person_id UUID,
  p_family_id TEXT,
  p_name TEXT,
  p_phone_number TEXT,
  p_relationship TEXT,
  p_photo_url TEXT,
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
  v_family_id TEXT := lpad(public.normalize_family_id(p_family_id), 4, '0');
  v_student_ids TEXT[];
  v_row public.authorized_pickups%ROWTYPE;
BEGIN
  IF v_actor_id IS NULL OR v_role NOT IN ('admin', 'supervisor', 'office') THEN
    RAISE EXCEPTION 'Only gate staff may add authorized pickup people.'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF p_person_id IS NULL THEN
    RAISE EXCEPTION 'Pickup person ID is required.' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF NULLIF(trim(p_name), '') IS NULL THEN
    RAISE EXCEPTION 'Driver name is required.' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF NULLIF(trim(p_phone_number), '') IS NULL THEN
    RAISE EXCEPTION 'Driver phone number is required.' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF NULLIF(trim(p_photo_url), '') IS NULL THEN
    RAISE EXCEPTION 'A driver photo is required.' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF v_family_id = '0000' OR p_student_ids IS NULL OR cardinality(p_student_ids) = 0 THEN
    RAISE EXCEPTION 'Select at least one student for this driver.' USING ERRCODE = 'invalid_parameter_value';
  END IF;

  SELECT array_agg(DISTINCT trim(student_id) ORDER BY trim(student_id))
    INTO v_student_ids
  FROM unnest(p_student_ids) AS student_id
  WHERE NULLIF(trim(student_id), '') IS NOT NULL;

  IF v_student_ids IS NULL OR cardinality(v_student_ids) = 0 THEN
    RAISE EXCEPTION 'Select at least one student for this driver.' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF EXISTS (
    SELECT 1
    FROM unnest(v_student_ids) AS selected_student_id
    WHERE NOT EXISTS (
      SELECT 1 FROM public.students s
      WHERE s.id = selected_student_id
        AND s."familyId" = v_family_id
        AND COALESCE(s."transport", '') <> 'LEFT'
    )
  ) THEN
    RAISE EXCEPTION 'Every selected student must belong to the active family.'
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;

  INSERT INTO public.authorized_pickups (
    person_id, family_id, student_ids, name, phone_number, relationship, photo_url,
    added_by_staff_id, added_at
  )
  VALUES (
    p_person_id, v_family_id, v_student_ids, trim(p_name), trim(p_phone_number),
    NULLIF(trim(p_relationship), ''), trim(p_photo_url), v_actor_id, NOW()
  )
  RETURNING * INTO v_row;

  INSERT INTO public.audit_logs (action, details, "createdAt")
  VALUES (
    'authorized_pickups.created',
    jsonb_build_object(
      'personId', v_row.person_id,
      'familyId', v_row.family_id,
      'studentIds', v_row.student_ids,
      'name', v_row.name,
      'addedByStaffId', v_actor_id,
      'addedAt', v_row.added_at,
      'photoCaptured', true
    ),
    NOW()
  );

  RETURN jsonb_build_object(
    'personId', v_row.person_id,
    'familyId', v_row.family_id,
    'studentIds', v_row.student_ids,
    'name', v_row.name,
    'phoneNumber', v_row.phone_number,
    'relationship', v_row.relationship,
    'photoUrl', v_row.photo_url,
    'addedByStaffId', v_row.added_by_staff_id,
    'addedAt', v_row.added_at
  );
END;
$$;

-- Keep six-argument callers safe during rollout: old callers mean all active
-- students in that family. The new gate UI always supplies a selected list.
CREATE OR REPLACE FUNCTION public.create_authorized_pickup(
  p_person_id UUID,
  p_family_id TEXT,
  p_name TEXT,
  p_phone_number TEXT,
  p_relationship TEXT DEFAULT NULL,
  p_photo_url TEXT DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_family_id TEXT := lpad(public.normalize_family_id(p_family_id), 4, '0');
  v_student_ids TEXT[];
BEGIN
  SELECT COALESCE(array_agg(s.id ORDER BY s.name), ARRAY[]::TEXT[])
    INTO v_student_ids
  FROM public.students s
  WHERE s."familyId" = v_family_id
    AND COALESCE(s."transport", '') <> 'LEFT';

  RETURN public.create_authorized_pickup(
    p_person_id, p_family_id, p_name, p_phone_number,
    p_relationship, p_photo_url, v_student_ids
  );
END;
$$;

-- Read one row per driver, with the exact children this driver is authorized
-- to collect. This prevents the gate from treating the family as a blanket
-- authorization when siblings are travelling separately.
CREATE OR REPLACE FUNCTION public.get_authorized_pickups(p_family_id TEXT)
RETURNS JSONB
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT COALESCE(jsonb_agg(
    jsonb_build_object(
      'personId', ap.person_id,
      'familyId', ap.family_id,
      'studentIds', ap.student_ids,
      'studentNames', COALESCE(student.names, ARRAY[]::TEXT[]),
      'name', ap.name,
      'phoneNumber', ap.phone_number,
      'relationship', ap.relationship,
      'photoUrl', ap.photo_url,
      'addedByStaffId', ap.added_by_staff_id,
      'addedAt', ap.added_at
    ) ORDER BY ap.added_at DESC
  ), '[]'::JSONB)
  FROM public.authorized_pickups ap
  LEFT JOIN LATERAL (
    SELECT array_agg(s.name ORDER BY s.name) AS names
    FROM public.students s
    WHERE s.id = ANY(ap.student_ids)
      AND s."familyId" = ap.family_id
      AND COALESCE(s."transport", '') <> 'LEFT'
  ) student ON TRUE
  WHERE ap.family_id = lpad(public.normalize_family_id(p_family_id), 4, '0')
    AND public.current_profile_role() IN ('admin', 'supervisor', 'office')
    AND public.current_profile_id() IS NOT NULL;
$$;

-- Validate the selected driver is authorized for this exact child, not merely
-- for a family containing that child.
CREATE OR REPLACE FUNCTION public.record_release_with_pickup(
  p_student_id TEXT,
  p_family_id TEXT,
  p_pickup_person_id UUID
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_family_id TEXT := lpad(public.normalize_family_id(p_family_id), 4, '0');
  v_release JSONB;
BEGIN
  IF public.current_profile_id() IS NULL
     OR public.current_profile_role() NOT IN ('admin', 'supervisor', 'office') THEN
    RAISE EXCEPTION 'Only admins, supervisors, and office staff may record releases.'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF p_pickup_person_id IS NULL OR NOT EXISTS (
    SELECT 1 FROM public.authorized_pickups ap
    WHERE ap.person_id = p_pickup_person_id
      AND ap.family_id = v_family_id
      AND p_student_id = ANY(ap.student_ids)
  ) THEN
    RAISE EXCEPTION 'Selected pickup person is not authorized for this student.'
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;

  v_release := public.record_release(p_student_id, p_family_id);
  UPDATE public.release_log
     SET authorized_pickup_id = p_pickup_person_id
   WHERE id = (v_release->>'id')::BIGINT;

  RETURN jsonb_set(v_release, '{pickupPersonId}', to_jsonb(p_pickup_person_id), true);
END;
$$;

REVOKE ALL ON FUNCTION public.create_authorized_pickup(UUID, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT[]) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.create_authorized_pickup(UUID, TEXT, TEXT, TEXT, TEXT, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.get_authorized_pickups(TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.record_release_with_pickup(TEXT, TEXT, UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.create_authorized_pickup(UUID, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT[]) TO authenticated;
GRANT EXECUTE ON FUNCTION public.create_authorized_pickup(UUID, TEXT, TEXT, TEXT, TEXT, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_authorized_pickups(TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.record_release_with_pickup(TEXT, TEXT, UUID) TO authenticated;
