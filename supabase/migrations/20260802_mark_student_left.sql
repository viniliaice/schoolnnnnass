-- Mark a student as LEFT the school (2026-08-02 investigation feature).
--
-- The transport column already treats 'LEFT' as a first-class value
-- (parseTransportCell kind 'left', sheet STATUS/Bus LEFT marker), but the
-- RPCs and the column CHECK reject it. This migration:
--
-- 1. Relaxes students_transport_check so 'LEFT' can be stored.
-- 2. Adds mark_student_left(p_student_id, p_left): admin-only SECURITY
--    DEFINER write path (students is SELECT-only under RLS, so a direct
--    UPDATE is denied). Marking sets transport = 'LEFT' and clears
--    familyId — a left student gets no gate card and no family grouping.
--    Restoring sets transport = NULL and keeps familyId NULL (re-generate
--    to reassign).
-- 3. Regenerates generate_family_ids() so LEFT students are never
--    candidates, even when they have a parentId or phone.

ALTER TABLE public.students DROP CONSTRAINT IF EXISTS students_transport_check;
ALTER TABLE public.students ADD CONSTRAINT students_transport_check
  CHECK ("transport" IS NULL OR "transport" IN ('WALKER', 'CAR', 'LEFT') OR "transport" ~ '^\d+$')
  NOT VALID;

CREATE OR REPLACE FUNCTION public.mark_student_left(p_student_id TEXT, p_left BOOLEAN)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_role TEXT := public.current_profile_role();
BEGIN
  IF v_role IS NULL OR v_role <> 'admin' THEN
    RAISE EXCEPTION 'Only admins may mark students as left.'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  IF p_left THEN
    UPDATE public.students
       SET "transport" = 'LEFT',
           "familyId" = NULL
     WHERE id = p_student_id;
  ELSE
    UPDATE public.students
       SET "transport" = NULL
     WHERE id = p_student_id;
  END IF;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Student not found.' USING ERRCODE = 'no_data_found';
  END IF;

  INSERT INTO public.audit_logs (action, details, "createdAt")
  VALUES ('family_ids.left', jsonb_build_object('studentId', p_student_id, 'left', p_left), NOW());
END;
$$;

-- LEFT students are never family-ID candidates: no gate card for them.
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

REVOKE ALL ON FUNCTION public.mark_student_left(TEXT, BOOLEAN) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.mark_student_left(TEXT, BOOLEAN) TO authenticated;
