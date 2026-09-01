-- Authorized pickup people for the dismissal gate.
--
-- A driver's photo is required before the record is inserted. The browser
-- uploads a resized JPEG first, then calls create_authorized_pickup() with the
-- returned URL. That makes every row complete and immediately usable at the
-- gate; there is no approval or photo-pending state.

CREATE TABLE IF NOT EXISTS public.authorized_pickups (
  person_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  family_id TEXT NOT NULL,
  name TEXT NOT NULL,
  phone_number TEXT NOT NULL,
  relationship TEXT,
  photo_url TEXT NOT NULL,
  added_by_staff_id TEXT NOT NULL REFERENCES public.profiles(id) ON DELETE RESTRICT,
  added_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_authorized_pickups_family
  ON public.authorized_pickups (family_id, added_at DESC);

ALTER TABLE public.authorized_pickups ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Gate staff can read authorized pickups" ON public.authorized_pickups;
CREATE POLICY "Gate staff can read authorized pickups"
  ON public.authorized_pickups FOR SELECT
  USING (public.current_profile_role() IN ('admin', 'supervisor', 'office'));

-- There are intentionally no direct INSERT/UPDATE/DELETE policies. The RPC
-- below is the only write path and always records current_profile_id().

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
  v_actor_id TEXT := public.current_profile_id();
  v_role TEXT := public.current_profile_role();
  v_family_id TEXT := lpad(public.normalize_family_id(p_family_id), 4, '0');
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
  IF v_family_id = '0000' OR NOT EXISTS (
    SELECT 1 FROM public.students s
    WHERE s."familyId" = v_family_id
      AND COALESCE(s."transport", '') <> 'LEFT'
  ) THEN
    RAISE EXCEPTION 'An active family is required.' USING ERRCODE = 'no_data_found';
  END IF;

  INSERT INTO public.authorized_pickups (
    person_id, family_id, name, phone_number, relationship, photo_url,
    added_by_staff_id, added_at
  )
  VALUES (
    p_person_id, v_family_id, trim(p_name), trim(p_phone_number),
    NULLIF(trim(p_relationship), ''), trim(p_photo_url), v_actor_id, NOW()
  )
  RETURNING * INTO v_row;

  INSERT INTO public.audit_logs (action, details, "createdAt")
  VALUES (
    'authorized_pickups.created',
    jsonb_build_object(
      'personId', v_row.person_id,
      'familyId', v_row.family_id,
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
    'name', v_row.name,
    'phoneNumber', v_row.phone_number,
    'relationship', v_row.relationship,
    'photoUrl', v_row.photo_url,
    'addedByStaffId', v_row.added_by_staff_id,
    'addedAt', v_row.added_at
  );
END;
$$;

-- Returns the full family pickup list, including a linked student for office
-- context. No photo is required for release logic: every row returned here is
-- already complete because the insert RPC enforces photo_url NOT NULL.
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
      'name', ap.name,
      'phoneNumber', ap.phone_number,
      'relationship', ap.relationship,
      'photoUrl', ap.photo_url,
      'addedByStaffId', ap.added_by_staff_id,
      'addedAt', ap.added_at,
      'studentName', student.name,
      'studentClassName', student."className"
    ) ORDER BY ap.added_at DESC
  ), '[]'::JSONB)
  FROM public.authorized_pickups ap
  LEFT JOIN LATERAL (
    SELECT s.name, s."className"
    FROM public.students s
    WHERE s."familyId" = ap.family_id
      AND COALESCE(s."transport", '') <> 'LEFT'
    ORDER BY s.name
    LIMIT 1
  ) student ON TRUE
  WHERE ap.family_id = lpad(public.normalize_family_id(p_family_id), 4, '0')
    AND public.current_profile_role() IN ('admin', 'supervisor', 'office')
    AND public.current_profile_id() IS NOT NULL;
$$;

REVOKE ALL ON FUNCTION public.create_authorized_pickup(UUID, TEXT, TEXT, TEXT, TEXT, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.get_authorized_pickups(TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.create_authorized_pickup(UUID, TEXT, TEXT, TEXT, TEXT, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_authorized_pickups(TEXT) TO authenticated;

-- Keep the selected driver attached to the existing release record when staff
-- choose one. The two-argument record_release() remains unchanged for older
-- clients and for the existing gate path without a pickup selection.
ALTER TABLE public.release_log
  ADD COLUMN IF NOT EXISTS authorized_pickup_id UUID
  REFERENCES public.authorized_pickups(person_id) ON DELETE SET NULL;

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
  ) THEN
    RAISE EXCEPTION 'Selected pickup person does not belong to the given family.'
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;

  v_release := public.record_release(p_student_id, p_family_id);
  UPDATE public.release_log
     SET authorized_pickup_id = p_pickup_person_id
   WHERE id = (v_release->>'id')::BIGINT;

  RETURN jsonb_set(v_release, '{pickupPersonId}', to_jsonb(p_pickup_person_id), true);
END;
$$;

REVOKE ALL ON FUNCTION public.record_release_with_pickup(TEXT, TEXT, UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.record_release_with_pickup(TEXT, TEXT, UUID) TO authenticated;

-- The object key is family_id/person_id.jpg inside this bucket, yielding the
-- required authorized-pickups/{family_id}/{person_id}.jpg Storage URL.
INSERT INTO storage.buckets (id, name, public)
VALUES ('authorized-pickups', 'authorized-pickups', true)
ON CONFLICT (id) DO UPDATE SET public = true;

DROP POLICY IF EXISTS "Gate staff can upload authorized pickup photos" ON storage.objects;
CREATE POLICY "Gate staff can upload authorized pickup photos"
  ON storage.objects FOR INSERT TO authenticated
  WITH CHECK (
    bucket_id = 'authorized-pickups'
    AND public.current_profile_role() IN ('admin', 'supervisor', 'office')
  );

-- There is no UPDATE policy: the photo is captured once and is permanent
-- after the authorized_pickups row is created. The client uses upsert=false.
DROP POLICY IF EXISTS "Gate staff can update authorized pickup photos" ON storage.objects;

DROP POLICY IF EXISTS "Gate staff can delete orphaned authorized pickup photos" ON storage.objects;
CREATE POLICY "Gate staff can delete orphaned authorized pickup photos"
  ON storage.objects FOR DELETE TO authenticated
  USING (
    bucket_id = 'authorized-pickups'
    AND public.current_profile_role() IN ('admin', 'supervisor', 'office')
  );

DROP POLICY IF EXISTS "Gate staff can read authorized pickup photos" ON storage.objects;
CREATE POLICY "Gate staff can read authorized pickup photos"
  ON storage.objects FOR SELECT TO authenticated
  USING (
    bucket_id = 'authorized-pickups'
    AND public.current_profile_role() IN ('admin', 'supervisor', 'office')
  );
