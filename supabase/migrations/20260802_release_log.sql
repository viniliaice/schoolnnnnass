-- Release log for the dismissal gate.
--
-- Every successful handoff is recorded: which student, matched to which
-- family, by which staff member, at what time. This is the accountability
-- record for the wrong-parent incident the project exists to prevent — the
-- NOT-FOUND audit alone only logs failures, so a wrong handoff after go-live
-- would otherwise leave no trace.
--
-- Writes go exclusively through record_release() (SECURITY DEFINER), which:
--   - allows admin / supervisor / office (the gate roles)
--   - verifies the student actually belongs to the given family (integrity)
--   - mirrors the event into audit_logs (family_ids.release)
-- There are NO direct INSERT/UPDATE/DELETE policies on release_log.

CREATE TABLE IF NOT EXISTS public.release_log (
  id BIGSERIAL PRIMARY KEY,
  "studentId" TEXT NOT NULL REFERENCES public.students(id) ON DELETE CASCADE,
  "familyId" TEXT NOT NULL,
  "staffId" TEXT NOT NULL REFERENCES public.profiles(id) ON DELETE RESTRICT,
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_release_log_student ON public.release_log ("studentId", "createdAt" DESC);
CREATE INDEX IF NOT EXISTS idx_release_log_family  ON public.release_log ("familyId", "createdAt" DESC);
CREATE INDEX IF NOT EXISTS idx_release_log_staff   ON public.release_log ("staffId", "createdAt" DESC);

ALTER TABLE public.release_log ENABLE ROW LEVEL SECURITY;

-- Staff (admin / supervisor / office) can read every release.
DROP POLICY IF EXISTS "Staff can read all releases" ON public.release_log;
CREATE POLICY "Staff can read all releases"
  ON public.release_log
  FOR SELECT
  USING (public.current_profile_role() IN ('admin', 'supervisor', 'office'));

-- Parents can read only their OWN children's releases (student → parentId).
DROP POLICY IF EXISTS "Parents can read own children releases" ON public.release_log;
CREATE POLICY "Parents can read own children releases"
  ON public.release_log
  FOR SELECT
  USING (EXISTS (
    SELECT 1 FROM public.students s
    WHERE s.id = "studentId" AND s."parentId" = public.current_profile_id()
  ));

-- No INSERT/UPDATE/DELETE policies — record_release() is the only writer.

CREATE OR REPLACE FUNCTION public.record_release(p_student_id TEXT, p_family_id TEXT)
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

  SELECT id, "familyId" INTO v_student
  FROM public.students
  WHERE id = p_student_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Student not found.' USING ERRCODE = 'no_data_found';
  END IF;

  -- Integrity: never record a release for a student who does not belong to
  -- the family being matched. This makes a logged release trustworthy.
  IF v_student."familyId" IS NULL
     OR public.normalize_family_id(v_student."familyId") <> v_norm_family THEN
    RAISE EXCEPTION 'Student does not belong to the given family.'
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;

  INSERT INTO public.release_log ("studentId", "familyId", "staffId", "createdAt")
  VALUES (p_student_id, v_student."familyId", v_actor_id, NOW())
  RETURNING id INTO v_release_id;

  INSERT INTO public.audit_logs (action, details, "createdAt")
  VALUES (
    'family_ids.release',
    jsonb_build_object(
      'releaseId', v_release_id,
      'studentId', p_student_id,
      'familyId', v_student."familyId",
      'staffId', v_actor_id
    ),
    NOW()
  );

  RETURN jsonb_build_object(
    'id', v_release_id,
    'studentId', p_student_id,
    'familyId', v_student."familyId",
    'staffId', v_actor_id,
    'createdAt', NOW()
  );
END;
$$;

REVOKE ALL ON FUNCTION public.record_release(TEXT, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.record_release(TEXT, TEXT) TO authenticated;
