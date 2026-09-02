-- Authorized pickup people ("drivers") for the dismissal gate.
--
-- Staff scan a family card at /gate, see the family's authorized pickup people,
-- and can add a new one on the spot when the adult who arrives isn't listed.
-- The driver's photo is captured ONCE at creation and is a permanent part of
-- the record (required, not skippable — there is no photo-pending lifecycle).
--
-- Data model decision (from requirement review): a driver is NOT per-family.
-- A driver may be authorized for a subset of students across MULTIPLE families
-- ("taking 2+ families, and some of the students in those families won't go
-- with him"). So a driver is a person record, linked to individual students:
--
--   authorized_pickups         — the person (name, phone, relationship, photo)
--   authorized_pickup_students — which students this person may pick up
--
-- The photo is stored at authorized-pickups/{person_id}.jpg (NOT
-- {family_id}/{person_id}.jpg) because one person spans many families.
--
-- Writes go exclusively through SECURITY DEFINER RPCs (repo convention:
-- tables are SELECT-only under RLS for the gate roles):
--   create_authorized_pickup() — admin/supervisor/office, logs the staff actor
--   get_family_pickups()       — read-only, role-independent complete list
-- record_release() requires a specific staff-selected driver that is actually
-- authorized for the student — a release can never succeed without a driver
-- (or with a wrong one) on record.
--
-- Storage: Supabase bucket 'authorized-pickups' is PRIVATE. Photos are served
-- via short-lived signed URLs generated client-side
-- (supabase.storage.from('authorized-pickups').createSignedUrl(path, 3600)) by
-- gate staff; storage.objects SELECT is restricted to gate roles for signing.

-- ─── authorized_pickups (the person / driver) ──────────────────────────────
CREATE TABLE IF NOT EXISTS public.authorized_pickups (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  "phoneNumber" TEXT NOT NULL,
  relationship TEXT,
  "photoPath" TEXT NOT NULL,
  "addedByStaffId" TEXT NOT NULL,
  "addedAt" TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ─── authorized_pickup_students (person -> students they may pick up) ──────
CREATE TABLE IF NOT EXISTS public.authorized_pickup_students (
  "authorizedPickupId" TEXT NOT NULL REFERENCES public.authorized_pickups(id) ON DELETE CASCADE,
  "studentId" TEXT NOT NULL REFERENCES public.students(id) ON DELETE CASCADE,
  PRIMARY KEY ("authorizedPickupId", "studentId")
);

CREATE INDEX IF NOT EXISTS idx_authorized_pickup_students_student
  ON public.authorized_pickup_students ("studentId");
CREATE INDEX IF NOT EXISTS idx_authorized_pickups_added_at
  ON public.authorized_pickups ("addedAt" DESC);

ALTER TABLE public.authorized_pickups ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.authorized_pickup_students ENABLE ROW LEVEL SECURITY;

-- Gate roles can read (SELECT-only). There are NO INSERT/UPDATE/DELETE
-- policies — all writes go through create_authorized_pickup().
DROP POLICY IF EXISTS "Gate staff can read authorized pickups" ON public.authorized_pickups;
CREATE POLICY "Gate staff can read authorized pickups"
  ON public.authorized_pickups
  FOR SELECT
  USING (public.current_profile_role() IN ('admin', 'supervisor', 'office'));

DROP POLICY IF EXISTS "Gate staff can read pickup authorizations" ON public.authorized_pickup_students;
CREATE POLICY "Gate staff can read pickup authorizations"
  ON public.authorized_pickup_students
  FOR SELECT
  USING (public.current_profile_role() IN ('admin', 'supervisor', 'office'));

-- ─── create_authorized_pickup(): the only writer ───────────────────────────
CREATE OR REPLACE FUNCTION public.create_authorized_pickup(
  p_id TEXT,
  p_name TEXT,
  p_phone_number TEXT,
  p_relationship TEXT,
  p_photo_path TEXT,
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
      'photoPath', p_photo_path
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

-- ─── get_family_pickups(): authorized people for ONE family ────────────────
-- Returns each person authorized for any active student in the family, with
-- the family's student ids they may pick up. STABLE (no writes possible).
-- photoPath is the private-bucket object key; the client signs it for display.
CREATE OR REPLACE FUNCTION public.get_family_pickups(p_family_id TEXT)
RETURNS JSONB
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT COALESCE(jsonb_agg(fam ORDER BY fam->>'name'), '[]'::JSONB)
  FROM (
    SELECT jsonb_build_object(
      'id', ap.id,
      'name', ap.name,
      'phoneNumber', ap."phoneNumber",
      'relationship', ap.relationship,
      'photoPath', ap."photoPath",
      'addedAt', ap."addedAt",
      'studentIds', jsonb_agg(aps."studentId" ORDER BY aps."studentId")
    ) AS fam
    FROM public.authorized_pickups ap
    JOIN public.authorized_pickup_students aps ON aps."authorizedPickupId" = ap.id
    JOIN public.students s ON s.id = aps."studentId"
    WHERE s."familyId" = public.normalize_family_id(p_family_id)
      AND COALESCE(s."transport", '') <> 'LEFT'
      AND public.current_profile_role() IN ('admin', 'supervisor', 'office')
      AND public.current_profile_id() IS NOT NULL
    GROUP BY ap.id
  ) t;
$$;

-- ─── release_log gains a pickup person ─────────────────────────────────────
ALTER TABLE public.release_log ADD COLUMN IF NOT EXISTS "pickupPersonId" TEXT;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'release_log_pickuppersonid_fkey'
      AND conrelid = 'public.release_log'::regclass
  ) THEN
    ALTER TABLE public.release_log
      ADD CONSTRAINT release_log_pickuppersonid_fkey
      FOREIGN KEY ("pickupPersonId") REFERENCES public.authorized_pickups(id) ON DELETE SET NULL;
  END IF;
END $$;

-- Recreate record_release with a REQUIRED pickup person. The old 2-arg body
-- is dropped first (same overload discipline as generate_family_ids — never
-- leave two bindable definitions). There is no DEFAULT on p_pickup_person_id,
-- so a 2-argument call cannot bind; and a NULL/empty driver is rejected
-- outright — a release can never silently succeed without a specific,
-- staff-selected driver tied to the student.
DROP FUNCTION IF EXISTS public.record_release(TEXT, TEXT);

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
  -- A specific driver is REQUIRED — no release without a selected driver.
  IF p_pickup_person_id IS NULL OR p_pickup_person_id = '' THEN
    RAISE EXCEPTION 'A driver must be selected before releasing a student.'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  SELECT id, "familyId" INTO v_student
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

  -- The named driver must actually be authorized for THIS student — otherwise
  -- a release could be attributed to the wrong adult.
  IF NOT EXISTS (
    SELECT 1 FROM public.authorized_pickup_students
    WHERE "authorizedPickupId" = p_pickup_person_id
      AND "studentId" = p_student_id
  ) THEN
    RAISE EXCEPTION 'Driver is not authorized to pick up this student.'
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;

  INSERT INTO public.release_log
    ("studentId", "familyId", "staffId", "pickupPersonId", "createdAt")
  VALUES
    (p_student_id, v_student."familyId", v_actor_id, p_pickup_person_id, NOW())
  RETURNING id INTO v_release_id;

  INSERT INTO public.audit_logs (action, details, "createdAt")
  VALUES (
    'family_ids.release',
    jsonb_build_object(
      'releaseId', v_release_id,
      'studentId', p_student_id,
      'familyId', v_student."familyId",
      'staffId', v_actor_id,
      'pickupPersonId', p_pickup_person_id
    ),
    NOW()
  );

  RETURN jsonb_build_object(
    'id', v_release_id,
    'studentId', p_student_id,
    'familyId', v_student."familyId",
    'staffId', v_actor_id,
    'pickupPersonId', p_pickup_person_id,
    'createdAt', NOW()
  );
END;
$$;

-- ─── Grants ────────────────────────────────────────────────────────────────
REVOKE ALL ON FUNCTION public.create_authorized_pickup(TEXT, TEXT, TEXT, TEXT, TEXT, TEXT[]) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.get_family_pickups(TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.record_release(TEXT, TEXT, TEXT) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION public.create_authorized_pickup(TEXT, TEXT, TEXT, TEXT, TEXT, TEXT[]) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_family_pickups(TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.record_release(TEXT, TEXT, TEXT) TO authenticated;

-- ─── Storage: authorized-pickups bucket — PRIVATE ──────────────────────────
-- Photos are personal data, so the bucket is NOT public. Display goes through
-- short-lived signed URLs (createSignedUrl) generated by gate staff. The
-- SELECT policy below is what lets a staff member SIGN a photo URL.
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES ('authorized-pickups', 'authorized-pickups', false, 5242880, ARRAY['image/jpeg', 'image/png', 'image/webp'])
ON CONFLICT (id) DO NOTHING;

DROP POLICY IF EXISTS "authorized-pickups staff upload" ON storage.objects;
CREATE POLICY "authorized-pickups staff upload"
  ON storage.objects FOR INSERT TO authenticated
  WITH CHECK (
    bucket_id = 'authorized-pickups'
    AND public.current_profile_role() IN ('admin', 'supervisor', 'office')
  );

DROP POLICY IF EXISTS "authorized-pickups staff update" ON storage.objects;
CREATE POLICY "authorized-pickups staff update"
  ON storage.objects FOR UPDATE TO authenticated
  USING (
    bucket_id = 'authorized-pickups'
    AND public.current_profile_role() IN ('admin', 'supervisor', 'office')
  );

-- Required to generate signed URLs against the private bucket.
DROP POLICY IF EXISTS "authorized-pickups staff read" ON storage.objects;
CREATE POLICY "authorized-pickups staff read"
  ON storage.objects FOR SELECT TO authenticated
  USING (
    bucket_id = 'authorized-pickups'
    AND public.current_profile_role() IN ('admin', 'supervisor', 'office')
  );
