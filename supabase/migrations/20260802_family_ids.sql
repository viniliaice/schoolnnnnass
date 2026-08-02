-- Family ID generator for the dismissal gate (design: DESIGN-family-id-generator.md)
--
-- Adds transport columns to students and a transactional, idempotent ID
-- generator. All writes go through SECURITY DEFINER RPCs because students has
-- no UPDATE policy (RLS is SELECT-only today).
--
-- familyId format: zero-padded 4-digit numeric string ('0421'). The gate
-- types digits; the 'MBK-' prefix is added only when printing. Lookups
-- normalize input to digits, so '0421', 'MBK-0421', and '0421' all match.
--
-- Grouping (approved premise #2): parentId first, else normalized parentPhone
-- (the sheet's SECOND NUMBER, persisted in students.parentPhone at import).
-- Students with neither stay unattached (familyId NULL) and surface in the
-- admin UI bucket for manual assignment.

ALTER TABLE public.students ADD COLUMN IF NOT EXISTS "govId" TEXT;
ALTER TABLE public.students ADD COLUMN IF NOT EXISTS "transport" TEXT;
ALTER TABLE public.students ADD COLUMN IF NOT EXISTS "parentPhone" TEXT;
ALTER TABLE public.students ADD COLUMN IF NOT EXISTS "familyId" TEXT;

-- transport: bus number (e.g. '9'), 'WALKER', 'CAR'. Historical/odd values
-- stay reviewable; every future write is checked NOT VALID (repo pattern).
ALTER TABLE public.students DROP CONSTRAINT IF EXISTS students_transport_check;
ALTER TABLE public.students ADD CONSTRAINT students_transport_check
  CHECK ("transport" IS NULL OR "transport" = 'WALKER' OR "transport" = 'CAR' OR "transport" ~ '^\d+$')
  NOT VALID;

CREATE INDEX IF NOT EXISTS idx_students_family_id ON public.students ("familyId");
CREATE INDEX IF NOT EXISTS idx_students_parent_phone ON public.students ("parentPhone");
CREATE INDEX IF NOT EXISTS idx_students_gov_id ON public.students ("govId");

-- ─── Helpers ───────────────────────────────────────────────────────────────

-- Normalize a phone string to a comparable form: digits only; strips the
-- +252 country prefix when present (Somali numbers are 9 digits after 252).
CREATE OR REPLACE FUNCTION public.normalize_phone(p_raw TEXT)
RETURNS TEXT
LANGUAGE sql
IMMUTABLE
SET search_path = public
AS $$
  SELECT CASE
    WHEN p_raw IS NULL THEN ''
    ELSE regexp_replace(regexp_replace(p_raw, '\D', '', 'g'), '^252(\d{9})$', '\1')
  END;
$$;

-- Normalize a family-ID input to its canonical stored form (4+ digits).
CREATE OR REPLACE FUNCTION public.normalize_family_id(p_raw TEXT)
RETURNS TEXT
LANGUAGE sql
IMMUTABLE
SET search_path = public
AS $$
  SELECT regexp_replace(COALESCE(p_raw, ''), '\D', '', 'g');
$$;

-- ─── generate_family_ids(): transactional, idempotent generator ───────────
CREATE OR REPLACE FUNCTION public.generate_family_ids()
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_actor_id TEXT := public.current_profile_id();
  v_role TEXT := public.current_profile_role();
  v_next_id INTEGER;
  v_created INTEGER := 0;
  v_assigned INTEGER := 0;
  v_unattached JSONB := '[]'::JSONB;
  v_group RECORD;
  v_student RECORD;
  v_family_id TEXT;
  v_total_families INTEGER;
BEGIN
  IF v_actor_id IS NULL OR v_role <> 'admin' THEN
    RAISE EXCEPTION 'Only admins may generate family IDs.' USING ERRCODE = 'insufficient_privilege';
  END IF;

  -- Idempotency: only students with no familyId are candidates. Existing
  -- IDs are never reassigned; numbering continues after the current max.
  SELECT COALESCE(MAX(NULLIF(public.normalize_family_id("familyId"), '')::INTEGER), 0)
    INTO v_next_id
    FROM public.students
   WHERE "familyId" IS NOT NULL AND public.normalize_family_id("familyId") ~ '^\d+$';

  -- Group candidates: parentId first, else normalized parentPhone. Each group
  -- becomes one family; singletons without either key are unattached.
  FOR v_group IN
    SELECT
      CASE
        WHEN s."parentId" IS NOT NULL THEN 'p:' || s."parentId"
        WHEN public.normalize_phone(s."parentPhone") <> '' THEN 't:' || public.normalize_phone(s."parentPhone")
        ELSE NULL
      END AS family_key,
      array_agg(s.id ORDER BY s.name) AS student_ids
    FROM public.students s
    WHERE s."familyId" IS NULL
    GROUP BY family_key
  LOOP
    IF v_group.family_key IS NULL THEN
      v_unattached := v_unattached || to_jsonb(v_group.student_ids);
      CONTINUE;
    END IF;

    v_next_id := v_next_id + 1;
    v_family_id := lpad(v_next_id::TEXT, 4, '0');
    v_created := v_created + 1;

    FOREACH v_student.id IN ARRAY v_group.student_ids
    LOOP
      UPDATE public.students
         SET "familyId" = v_family_id
       WHERE id = v_student.id AND "familyId" IS NULL;
      IF FOUND THEN
        v_assigned := v_assigned + 1;
      END IF;
    END LOOP;
  END LOOP;

  SELECT COUNT(DISTINCT "familyId") INTO v_total_families FROM public.students WHERE "familyId" IS NOT NULL;

  INSERT INTO public.audit_logs (action, details, "createdAt")
  VALUES (
    'family_ids.generate',
    jsonb_build_object(
      'by', v_actor_id,
      'familiesCreated', v_created,
      'studentsAssigned', v_assigned,
      'unattached', jsonb_array_length(v_unattached),
      'totalFamilies', v_total_families
    ),
    NOW()
  );

  RETURN jsonb_build_object(
    'familiesCreated', v_created,
    'studentsAssigned', v_assigned,
    'unattached', v_unattached,
    'totalFamilies', v_total_families
  );
END;
$$;

-- ─── lookup_family(): gate lookup, admin + supervisor only ─────────────────
-- Returns every student in a family with transport + reachable parent phone
-- (profile phones first, then the sheet-imported parentPhone).
CREATE OR REPLACE FUNCTION public.lookup_family(p_family_id TEXT)
RETURNS JSONB
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT coalesce(jsonb_agg(
    jsonb_build_object(
      'id', s.id,
      'name', s.name,
      'className', s."className",
      'transport', s."transport",
      'familyId', s."familyId",
      'parentPhone', COALESCE(
        NULLIF(public.normalize_phone(pr."phone1"), ''),
        NULLIF(public.normalize_phone(pr."phone2"), ''),
        NULLIF(public.normalize_phone(s."parentPhone"), ''),
        s."parentPhone"
      )
    ) ORDER BY s.name
  ), '[]'::JSONB)
  FROM public.students s
  LEFT JOIN public.profiles pr ON pr.id = s."parentId"
  WHERE s."familyId" = public.normalize_family_id(p_family_id)
    AND public.current_profile_role() IN ('admin', 'supervisor')
    AND public.current_profile_id() IS NOT NULL;
$$;

-- ─── set_student_transport(): admin quick-edit (WALKER / CAR / bus no.) ─────
CREATE OR REPLACE FUNCTION public.set_student_transport(p_student_id TEXT, p_transport TEXT)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_role TEXT := public.current_profile_role();
BEGIN
  IF v_role IS NULL OR v_role <> 'admin' THEN
    RAISE EXCEPTION 'Only admins may change transport.' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF p_transport IS NULL OR trim(p_transport) = '' THEN
    RAISE EXCEPTION 'Transport value is required.' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF p_transport NOT IN ('WALKER', 'CAR') AND p_transport !~ '^\d+$' THEN
    RAISE EXCEPTION 'Transport must be WALKER, CAR, or a bus number.' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  UPDATE public.students SET "transport" = p_transport WHERE id = p_student_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Student not found.' USING ERRCODE = 'no_data_found';
  END IF;
  INSERT INTO public.audit_logs (action, details, "createdAt")
  VALUES ('family_ids.transport', jsonb_build_object('studentId', p_student_id, 'transport', p_transport), NOW());
END;
$$;

-- ─── assign_family_override(): admin manual assignment / merge / split ──────
-- familyId may be an existing family (merge a student in) or a new ID.
CREATE OR REPLACE FUNCTION public.assign_family_override(p_student_id TEXT, p_family_id TEXT)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_role TEXT := public.current_profile_role();
  v_norm TEXT;
BEGIN
  IF v_role IS NULL OR v_role <> 'admin' THEN
    RAISE EXCEPTION 'Only admins may override family assignment.' USING ERRCODE = 'insufficient_privilege';
  END IF;
  v_norm := public.normalize_family_id(p_family_id);
  IF v_norm = '' THEN
    RAISE EXCEPTION 'A family ID is required.' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  UPDATE public.students SET "familyId" = lpad(v_norm, 4, '0') WHERE id = p_student_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Student not found.' USING ERRCODE = 'no_data_found';
  END IF;
  INSERT INTO public.audit_logs (action, details, "createdAt")
  VALUES ('family_ids.override', jsonb_build_object('studentId', p_student_id, 'familyId', lpad(v_norm, 4, '0')), NOW());
END;
$$;

-- ─── Grants ────────────────────────────────────────────────────────────────
REVOKE ALL ON FUNCTION public.generate_family_ids() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.lookup_family(TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.set_student_transport(TEXT, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.assign_family_override(TEXT, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.normalize_phone(TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.normalize_family_id(TEXT) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION public.generate_family_ids() TO authenticated;
GRANT EXECUTE ON FUNCTION public.lookup_family(TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.set_student_transport(TEXT, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.assign_family_override(TEXT, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.normalize_phone(TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.normalize_family_id(TEXT) TO authenticated;
