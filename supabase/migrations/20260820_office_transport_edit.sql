-- Allow office staff to change a student's transport.
--
-- WHY: transport corrections are front-desk work. A parent calls to say Ahmed
-- now takes bus 9, and the office is who answers that phone. Requiring an
-- admin for a routine correction means the change is either delayed or the
-- office is handed an admin login, which is worse for security than granting
-- this one narrow write.
--
-- SCOPE OF THE WIDENING — deliberately minimal:
--   set_student_transport() only.  Office does NOT gain:
--     - generate_family_ids()        (Family ID creation stays admin-only)
--     - assign_family_override()     (merge/split stays admin-only)
--     - mark_student_left()          (enrolment status stays admin-only)
--     - set_student_import_fields()  (bulk sheet import stays admin-only)
--   This function updates exactly one column on one row. It cannot create,
--   change, split or merge a Family ID.
--
-- supervisor is intentionally NOT added: supervisors are a gate/oversight
-- role here, not a data-entry role. Add them later if the school asks.
--
-- Also adds actor attribution. Widening a write from one role to two makes
-- "who changed this?" a real question, and the previous audit row recorded
-- only the studentId and the new value. Now it records the actor and the
-- previous value, so a wrong change is traceable and reversible.

-- ─── set_student_transport(): admin + office ────────────────────────────────
CREATE OR REPLACE FUNCTION public.set_student_transport(p_student_id TEXT, p_transport TEXT)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_role     TEXT := public.current_profile_role();
  v_actor    TEXT := public.current_profile_id();
  v_previous TEXT;
BEGIN
  IF v_role IS NULL OR v_role NOT IN ('admin', 'office') THEN
    RAISE EXCEPTION 'Only admins and office staff may change transport.'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  IF p_transport IS NULL OR trim(p_transport) = '' THEN
    RAISE EXCEPTION 'Transport value is required.'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  -- Unchanged from the original: WALKER, CAR, or a bus number. 'LEFT' is NOT
  -- settable here — leaving the school goes through mark_student_left(),
  -- which stays admin-only.
  IF p_transport NOT IN ('WALKER', 'CAR') AND p_transport !~ '^\d+$' THEN
    RAISE EXCEPTION 'Transport must be WALKER, CAR, or a bus number.'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  SELECT "transport" INTO v_previous FROM public.students WHERE id = p_student_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Student not found.' USING ERRCODE = 'no_data_found';
  END IF;

  -- Guard the one thing office must never do by accident: revive a student
  -- who has left. Changing transport is not an enrolment decision.
  IF COALESCE(v_previous, '') = 'LEFT' AND v_role <> 'admin' THEN
    RAISE EXCEPTION 'This student is marked as LEFT. An admin must re-enrol them first.'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  UPDATE public.students SET "transport" = p_transport WHERE id = p_student_id;

  INSERT INTO public.audit_logs (action, details, "createdAt")
  VALUES (
    'family_ids.transport',
    jsonb_build_object(
      'studentId', p_student_id,
      'transport', p_transport,
      'previous',  v_previous,
      'actorId',   v_actor,
      'actorRole', v_role
    ),
    NOW()
  );
END;
$$;

REVOKE ALL ON FUNCTION public.set_student_transport(TEXT, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.set_student_transport(TEXT, TEXT) TO authenticated;

-- ─── RLS: office already has "Office can read all students" from
-- 20260802_fix_live_role_check.sql. No new table policy is needed: the write
-- goes through this SECURITY DEFINER function, so office never receives a
-- direct UPDATE grant on public.students.
