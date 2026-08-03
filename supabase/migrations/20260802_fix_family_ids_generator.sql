-- Family-ID live fixes (2026-08-02 investigation) — new migration, never edit applied ones.
--
-- 1. generate_family_ids() raised 55000 "record v_student is not assigned yet"
--    on every run: the loop variable was a RECORD with only one field ever
--    assigned, which plpgsql rejects. Loop over a plain TEXT id instead.
--
-- 2. set_student_import_fields() now keeps the existing transport value when
--    the import supplies NULL (LEFT / unrecognized bus value) instead of
--    wiping it. Signature, admin gating, and grants are unchanged, so the
--    client wrapper and RLS tests keep working.

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
  v_student_id TEXT;
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

    FOREACH v_student_id IN ARRAY v_group.student_ids
    LOOP
      UPDATE public.students
         SET "familyId" = v_family_id
       WHERE id = v_student_id AND "familyId" IS NULL;
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

-- NULL transport now means "leave the stored value alone", so unknown or LEFT
-- rows from the sheet never destroy an existing bus number.
CREATE OR REPLACE FUNCTION public.set_student_import_fields(
  p_student_id TEXT,
  p_gov_id TEXT,
  p_transport TEXT,
  p_parent_phone TEXT
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_role TEXT := public.current_profile_role();
  v_transport TEXT;
BEGIN
  IF v_role IS NULL OR v_role <> 'admin' THEN
    RAISE EXCEPTION 'Only admins may apply the transport import.'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  -- Transport validation mirrors set_student_transport: WALKER / CAR / bus number.
  IF p_transport IS NOT NULL AND trim(p_transport) <> '' THEN
    v_transport := p_transport;
    IF v_transport NOT IN ('WALKER', 'CAR') AND v_transport !~ '^\d+$' THEN
      RAISE EXCEPTION 'Transport must be WALKER, CAR, or a bus number.'
        USING ERRCODE = 'invalid_parameter_value';
    END IF;
  END IF;

  UPDATE public.students
     SET "govId" = NULLIF(p_gov_id, ''),
         "transport" = COALESCE(v_transport, "transport"),
         "parentPhone" = NULLIF(public.normalize_phone(p_parent_phone), '')
   WHERE id = p_student_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Student not found.' USING ERRCODE = 'no_data_found';
  END IF;

  INSERT INTO public.audit_logs (action, details, "createdAt")
  VALUES (
    'family_ids.import',
    jsonb_build_object(
      'studentId', p_student_id,
      'govId', NULLIF(p_gov_id, ''),
      'transport', v_transport,
      'parentPhone', NULLIF(public.normalize_phone(p_parent_phone), '')
    ),
    NOW()
  );
END;
$$;
