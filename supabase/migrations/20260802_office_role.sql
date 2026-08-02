-- Office role for gate staff (Umal Kharye Xuseen, Maxamed Aden, Abdurahman
-- Aw Nuux) — read/lookup only. They get no write access to grades, exams,
-- or promotions: those tables' policies/RPCs only name teacher/admin roles,
-- which is verified by supabase/tests/rls-office-role.sql.
--
-- Design: DESIGN-family-id-generator.md (office-role addendum).

-- 1. Add 'office' as a valid role on profiles.
ALTER TABLE public.profiles DROP CONSTRAINT IF EXISTS profiles_role_check;
ALTER TABLE public.profiles ADD CONSTRAINT profiles_role_check
  CHECK (role IN ('admin', 'teacher', 'parent', 'supervisor', 'office'));

-- 2. RLS: office reads all students (name, grade, transport, familyId).
--    There is no family_ids table — familyId lives on students, so this
--    policy is what gates family data. Read-only: SELECT only.
DROP POLICY IF EXISTS "Office can read all students" ON public.students;
CREATE POLICY "Office can read all students"
  ON public.students
  FOR SELECT
  USING (public.current_profile_role() = 'office');

-- 3. Gate audit table: audit_logs already has
--    "Allow all authenticated users to read audit_logs" and
--    "Allow all authenticated users to insert audit_logs" policies, so
--    office (an authenticated role) is already covered for reading
--    family_ids.gate_not_found entries and for nothing else. No change
--    needed; the RLS test asserts this explicitly.

-- 4. Office must NOT write grades/exams/promotions. The exams table has
--    no policy naming 'office' (exam_insert/update/delete_authorized only
--    name teacher/admin paths), grade_uploads and student_promotions writes
--    go through role-checked RPCs (submit_bulk_grades requires
--    teacher/admin), and students has no INSERT/UPDATE/DELETE policy naming
--    office. Blocked by construction; verified in the RLS test below.

-- 5. Office can use the gate lookup RPC. lookup_family() (20260802_family_ids)
--    currently requires admin/supervisor — widen to office.
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

-- Generate, transport-edit, and family-override stay ADMIN-only — office is
-- read/lookup only ("unless told otherwise"). No grant changes needed.
