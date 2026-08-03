-- Live-DB drift fix (2026-08-02): the live profiles table kept the legacy
-- check constraint name `users_role_check` (no 'office'), so
-- 20260802_office_role.sql's `DROP CONSTRAINT IF EXISTS profiles_role_check`
-- was a no-op and create_user_profile(..., 'office') violated
-- `users_role_check`. Recreate the constraint under the canonical name with
-- 'office' allowed, and apply the office read/lookup pieces of
-- 20260802_office_role.sql that depend on it.
--
-- Same drift class as 20260708_profiles_auth_session_rls.sql (legacy
-- current_profile_role() comparing profiles.id to auth.uid()) — verify live
-- definitions with pg_get_functiondef before assuming migrations are applied.

-- 1. role check: drop both names, keep the canonical one allowing office
ALTER TABLE public.profiles DROP CONSTRAINT IF EXISTS users_role_check;
ALTER TABLE public.profiles DROP CONSTRAINT IF EXISTS profiles_role_check;
ALTER TABLE public.profiles ADD CONSTRAINT profiles_role_check
  CHECK (role IN ('admin', 'teacher', 'parent', 'supervisor', 'office'));

-- 2. RLS: office reads all students (read-only gate lookup data)
DROP POLICY IF EXISTS "Office can read all students" ON public.students;
CREATE POLICY "Office can read all students"
  ON public.students
  FOR SELECT
  USING (public.current_profile_role() = 'office');

-- 3. Widen lookup_family to office (duplicate of the 20260802_office_role.sql
--    definition, idempotent CREATE OR REPLACE)
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
    AND public.current_profile_role() IN ('admin', 'supervisor', 'office')
    AND public.current_profile_id() IS NOT NULL;
$$;

REVOKE ALL ON FUNCTION public.lookup_family(TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.lookup_family(TEXT) TO authenticated;
