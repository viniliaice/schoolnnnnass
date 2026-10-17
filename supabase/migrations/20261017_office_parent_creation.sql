-- Allow office staff to create parent profiles, but never staff/admin accounts.
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
  IF v_role IS NULL OR (v_role <> 'admin' AND NOT (v_role = 'office' AND p_role = 'parent')) THEN
    RAISE EXCEPTION 'Only admins may create staff profiles; office users may create parent profiles.'
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

