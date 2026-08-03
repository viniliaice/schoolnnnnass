-- Generate-family-ids with optional transport filter (2026-08-02).
--
-- p_transport_filter: 'bus' (digits), 'walker' (WALKER/CAR), 'empty' (NULL/blank),
-- NULL or 'all' = no filter (keep existing behaviour). Only unassigned,
-- non-LEFT students are candidates. Idempotency unchanged.

CREATE OR REPLACE FUNCTION public.generate_family_ids(p_transport_filter TEXT DEFAULT NULL)
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

  SELECT COALESCE(MAX(NULLIF(public.normalize_family_id("familyId"), '')::INTEGER), 0)
    INTO v_next_id
    FROM public.students
   WHERE "familyId" IS NOT NULL AND public.normalize_family_id("familyId") ~ '^\d+$';

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
      AND COALESCE(s."transport", '') <> 'LEFT'
      AND CASE
        WHEN p_transport_filter IS NULL OR p_transport_filter = 'all' THEN TRUE
        WHEN p_transport_filter = 'bus' THEN COALESCE(s."transport", '') ~ '^\d+$'
        WHEN p_transport_filter = 'walker' THEN COALESCE(s."transport", '') IN ('WALKER', 'CAR')
        WHEN p_transport_filter = 'empty' THEN s."transport" IS NULL OR s."transport" = ''
        ELSE TRUE
      END
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
      'totalFamilies', v_total_families,
      'filter', p_transport_filter
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