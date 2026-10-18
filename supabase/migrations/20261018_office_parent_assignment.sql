-- Allow office staff to assign/unassign a parent on a student, without
-- granting access to the broader admin-only update_student RPC.
CREATE OR REPLACE FUNCTION public.assign_student_parent(
  p_student_id TEXT,
  p_parent_id TEXT
) RETURNS VOID
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_role TEXT := public.current_profile_role();
  v_actor TEXT := public.current_profile_id();
  v_old_parent_id TEXT;
BEGIN
  IF v_role IS NULL OR v_role NOT IN ('admin', 'office') THEN
    RAISE EXCEPTION 'Only administrators or office users may assign a parent.'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM public.students WHERE id = p_student_id FOR UPDATE) THEN
    RAISE EXCEPTION 'Student % does not exist.', p_student_id USING ERRCODE = 'no_data_found';
  END IF;

  IF NULLIF(btrim(p_parent_id), '') IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.profiles
    WHERE id = btrim(p_parent_id) AND role = 'parent'
  ) THEN
    RAISE EXCEPTION 'Selected account is not a parent.' USING ERRCODE = 'invalid_parameter_value';
  END IF;

  SELECT "parentId" INTO v_old_parent_id FROM public.students WHERE id = p_student_id;
  UPDATE public.students
     SET "parentId" = NULLIF(btrim(p_parent_id), '')
   WHERE id = p_student_id;

  INSERT INTO public.audit_logs (action, details, "createdAt")
  VALUES ('students.parent_assignment', jsonb_build_object(
    'actor', v_actor, 'studentId', p_student_id,
    'previousParentId', v_old_parent_id, 'parentId', NULLIF(btrim(p_parent_id), '')
  ), NOW());
END;
$$;

REVOKE ALL ON FUNCTION public.assign_student_parent(TEXT, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.assign_student_parent(TEXT, TEXT) TO authenticated;
