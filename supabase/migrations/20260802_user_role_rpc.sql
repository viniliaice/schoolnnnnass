-- Admin-only profile role RPCs (office-role save fix, 2026-08-02)
--
-- Diagnosis (INVESTIGATION-family-ids.md #1): the office role is assigned by
-- creating a user with role 'office' in Manage Users. createUser() wrote the
-- profile row with supabase.from('profiles').insert() using the anon-key
-- client, but profiles has RLS enabled with SELECT-only policies
-- (20260708_profiles_auth_session_rls) — no INSERT or UPDATE policy for any
-- role — so the write was denied. Same bug class as the family import
-- (students): anon-key client + no write policy → route writes through
-- admin-only SECURITY DEFINER RPCs.
--
-- create_user_profile() covers the creation path (the actual mechanism by
-- which the office role is granted today); set_user_role() covers changing a
-- role on an existing profile. Both enforce the admin check in SQL, so a
-- non-admin caller gets insufficient_privilege and can never grant
-- themselves or others an elevated role.

CREATE OR REPLACE FUNCTION public.create_user_profile(
  p_id TEXT,
  p_name TEXT,
  p_email TEXT,
  p_role TEXT,
  p_auth_id UUID,
  p_phone1 TEXT DEFAULT NULL,
  p_phone2 TEXT DEFAULT NULL,
  p_xafada TEXT DEFAULT NULL,
  p_udow TEXT DEFAULT NULL,
  p_paymentnumber TEXT DEFAULT NULL,
  p_assigned_classes JSONB DEFAULT '[]'::JSONB,
  p_assigned_subjects JSONB DEFAULT '[]'::JSONB
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_role TEXT := public.current_profile_role();
BEGIN
  IF v_role IS NULL OR v_role <> 'admin' THEN
    RAISE EXCEPTION 'Only admins may create user profiles.'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  IF p_id IS NULL OR p_id = '' OR p_name IS NULL OR p_name = '' OR p_email IS NULL OR p_email = '' THEN
    RAISE EXCEPTION 'ID, name, and email are required.' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF p_role NOT IN ('admin', 'teacher', 'parent', 'supervisor', 'office') THEN
    RAISE EXCEPTION 'Invalid role.' USING ERRCODE = 'invalid_parameter_value';
  END IF;

  INSERT INTO public.profiles (
    id, name, email, role, "auth_id", phone1, phone2, xafada, udow,
    paymentnumber, "assignedClasses", "assignedSubjects", "createdAt"
  ) VALUES (
    p_id, p_name, p_email, p_role, p_auth_id, p_phone1, p_phone2, p_xafada,
    p_udow, p_paymentnumber, p_assigned_classes, p_assigned_subjects, NOW()
  );

  INSERT INTO public.audit_logs (action, details, "createdAt")
  VALUES ('profiles.create', jsonb_build_object('userId', p_id, 'role', p_role, 'email', p_email), NOW());
END;
$$;

CREATE OR REPLACE FUNCTION public.set_user_role(p_user_id TEXT, p_role TEXT)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_role TEXT := public.current_profile_role();
BEGIN
  IF v_role IS NULL OR v_role <> 'admin' THEN
    RAISE EXCEPTION 'Only admins may change user roles.'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  IF p_user_id IS NULL OR p_user_id = '' THEN
    RAISE EXCEPTION 'User ID is required.' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF p_role NOT IN ('admin', 'teacher', 'parent', 'supervisor', 'office') THEN
    RAISE EXCEPTION 'Invalid role.' USING ERRCODE = 'invalid_parameter_value';
  END IF;

  UPDATE public.profiles SET role = p_role WHERE id = p_user_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'User not found.' USING ERRCODE = 'no_data_found';
  END IF;

  INSERT INTO public.audit_logs (action, details, "createdAt")
  VALUES ('profiles.role', jsonb_build_object('userId', p_user_id, 'role', p_role), NOW());
END;
$$;

-- ─── Grants ────────────────────────────────────────────────────────────────
REVOKE ALL ON FUNCTION public.create_user_profile(TEXT, TEXT, TEXT, TEXT, UUID, TEXT, TEXT, TEXT, TEXT, TEXT, JSONB, JSONB) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.create_user_profile(TEXT, TEXT, TEXT, TEXT, UUID, TEXT, TEXT, TEXT, TEXT, TEXT, JSONB, JSONB) TO authenticated;

REVOKE ALL ON FUNCTION public.set_user_role(TEXT, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.set_user_role(TEXT, TEXT) TO authenticated;
