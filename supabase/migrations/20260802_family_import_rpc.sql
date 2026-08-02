-- Family-ID import + override hardening (investigation fixes, 2026-08-02)
--
-- Two fixes from INVESTIGATION-family-ids.md:
--
-- 1. set_student_import_fields(): admin-only SECURITY DEFINER write path for
--    the transport-sheet import. The previous implementation called
--    supabase.from('students').update() with the anon-key client, but
--    students is SELECT-only under RLS (20260708_profiles_auth_session_rls)
--    — no UPDATE policy exists for any role — so every row was denied and
--    Apply silently reported "0 applied". Same pattern as
--    set_student_transport(): role check in SQL, validated write, audit log.
--
-- 2. assign_family_override() re-created with a 4-digit cap. Without it a
--    manual ID like '999999999999' was stored as-is (lpad never truncates),
--    and the next generate_family_ids() run overflowed its
--    MAX(normalize_family_id(...)::INTEGER) — permanently bricking the
--    generator until the row was fixed manually in SQL.

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
         "transport" = v_transport,
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

-- Override guard: manual family IDs are 4-digit zero-padded ('0043').
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
    RAISE EXCEPTION 'Only admins may override family assignment.'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  v_norm := public.normalize_family_id(p_family_id);
  IF v_norm = '' THEN
    RAISE EXCEPTION 'A family ID is required.' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF char_length(v_norm) > 4 THEN
    RAISE EXCEPTION 'Family ID must be at most 4 digits (0001-9999).'
      USING ERRCODE = 'invalid_parameter_value';
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
REVOKE ALL ON FUNCTION public.set_student_import_fields(TEXT, TEXT, TEXT, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.set_student_import_fields(TEXT, TEXT, TEXT, TEXT) TO authenticated;

REVOKE ALL ON FUNCTION public.assign_family_override(TEXT, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.assign_family_override(TEXT, TEXT) TO authenticated;
