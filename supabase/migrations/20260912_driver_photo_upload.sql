-- Driver photo upload + optional photo (20260912).
--
-- Two changes that together power the "Take Photo | Upload Photo" driver form:
--
--   1. The driver photo becomes OPTIONAL. Before this migration, a photo was
--      captured once at creation and could never be empty ("photoPath" TEXT
--      NOT NULL + a hard "A photo is required." guard in create). The new form
--      lets staff save a driver without a photo, so the column is made
--      nullable and the guard is removed. There is still exactly ONE photo
--      field per driver — the same "photoPath" column — whether the photo came
--      from the camera or from a gallery upload. No new columns are added.
--
--   2. update_authorized_pickup_photo() lets back-office staff (admin/office —
--      the same roles as list_authorized_pickups) REPLACE or REMOVE an existing
--      driver's photo from the management screen's driver detail view.
--
-- Writes still go exclusively through SECURITY DEFINER RPCs (repo convention).
-- The private 'authorized-pickups' bucket and its policies are unchanged.

-- ─── 1. photoPath becomes nullable ──────────────────────────────────────────
ALTER TABLE public.authorized_pickups ALTER COLUMN "photoPath" DROP NOT NULL;

-- ─── 2. create_authorized_pickup(): photo is now optional ───────────────────
-- Same signature as the 20260902 definition (so CREATE OR REPLACE keeps the
-- existing EXECUTE grant); only the body changes. An empty/absent photo is
-- stored as NULL instead of being rejected.
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
  v_photo TEXT := NULLIF(trim(COALESCE(p_photo_path, '')), '');
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
     v_photo, v_actor_id, NOW());

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
      'photoCaptured', v_photo IS NOT NULL,
      'photoPath', v_photo,
      'duplicatePhoneOverride', p_allow_duplicate_phone
    ),
    NOW()
  );

  RETURN jsonb_build_object(
    'id', p_id,
    'name', trim(p_name),
    'phoneNumber', trim(p_phone_number),
    'relationship', NULLIF(trim(p_relationship), ''),
    'photoPath', v_photo,
    'addedByStaffId', v_actor_id,
    'addedAt', NOW(),
    'studentIds', to_jsonb(p_student_ids)
  );
END;
$$;

-- ─── 3. update_authorized_pickup_photo(): replace/remove a driver photo ─────
-- Back-office (admin + office) only, matching list_authorized_pickups() — the
-- management screen where editing happens. supervisor is oversight, not data
-- entry. A NULL/empty p_photo_path removes the photo.
CREATE OR REPLACE FUNCTION public.update_authorized_pickup_photo(
  p_pickup_id TEXT,
  p_photo_path TEXT
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
  v_photo TEXT := NULLIF(trim(COALESCE(p_photo_path, '')), '');
BEGIN
  IF v_actor_id IS NULL OR v_role NOT IN ('admin', 'office') THEN
    RAISE EXCEPTION 'Only admins and office staff may edit a driver photo.'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF p_pickup_id IS NULL OR p_pickup_id = '' THEN
    RAISE EXCEPTION 'Driver is required.' USING ERRCODE = 'invalid_parameter_value';
  END IF;

  SELECT id, name, "phoneNumber", relationship, "photoPath", "addedAt"
    INTO v_person
  FROM public.authorized_pickups
  WHERE id = p_pickup_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Driver not found.' USING ERRCODE = 'no_data_found';
  END IF;

  UPDATE public.authorized_pickups
     SET "photoPath" = v_photo
   WHERE id = p_pickup_id;

  INSERT INTO public.audit_logs (action, details, "createdAt")
  VALUES (
    'authorized_pickups.update_photo',
    jsonb_build_object(
      'personId', p_pickup_id,
      'staffId', v_actor_id,
      'previousPhotoPath', v_person."photoPath",
      'newPhotoPath', v_photo,
      'photoRemoved', v_photo IS NULL
    ),
    NOW()
  );

  RETURN jsonb_build_object(
    'id', p_pickup_id,
    'name', v_person.name,
    'phoneNumber', v_person."phoneNumber",
    'relationship', v_person.relationship,
    'photoPath', v_photo,
    'addedAt', v_person."addedAt"
  );
END;
$$;

-- ─── Grants ────────────────────────────────────────────────────────────────
REVOKE ALL ON FUNCTION public.create_authorized_pickup(TEXT, TEXT, TEXT, TEXT, TEXT, TEXT[], BOOLEAN) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.create_authorized_pickup(TEXT, TEXT, TEXT, TEXT, TEXT, TEXT[], BOOLEAN) TO authenticated;

REVOKE ALL ON FUNCTION public.update_authorized_pickup_photo(TEXT, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.update_authorized_pickup_photo(TEXT, TEXT) TO authenticated;
