-- Lock down audit_logs RLS (issue #3 from the family-ID audit).
--
-- Previously audit_logs had two open policies:
--   FOR SELECT  USING (true)          -> any authenticated user (parents,
--                                        teachers) could read every audit row
--   FOR INSERT  WITH CHECK (true)     -> any authenticated user could forge
--                                        audit rows (spoiling the trail)
--
-- This migration replaces them with:
--   - SELECT scoped to staff roles (admin / supervisor / office) — the same
--     gate/office role check used everywhere else.
--   - No open INSERT policy: client-side audit writes now go through the
--     SECURITY DEFINER create_audit_log() function, gated to staff.
--
-- Existing SECURITY DEFINER RPCs that INSERT INTO audit_logs directly (the
-- family-ID RPCs, user-role RPCs, record_release, create_authorized_pickup,
-- etc.) are unaffected: they run as the function owner (postgres) and RLS
-- does not apply to the table owner.
--
-- Verified callers of the client write path before changing it (all staff):
--   src/lib/db/gate.ts                -> family_ids.gate_not_found (gate staff)
--   src/pages/admin/.../AcademicWorkspace.tsx -> admin-only CRUD audit writes

DROP POLICY IF EXISTS "Allow all authenticated users to read audit_logs" ON public.audit_logs;
DROP POLICY IF EXISTS "Allow all authenticated users to insert audit_logs" ON public.audit_logs;

DROP POLICY IF EXISTS "Staff can read audit_logs" ON public.audit_logs;
CREATE POLICY "Staff can read audit_logs"
  ON public.audit_logs
  FOR SELECT
  USING (public.current_profile_role() IN ('admin', 'supervisor', 'office'));

-- The only client-side audit write path. SECURITY DEFINER so the insert
-- happens as the owner (bypasses the absence of an INSERT policy), role-gated
-- to staff so a parent/teacher cannot forge an audit row.
CREATE OR REPLACE FUNCTION public.create_audit_log(
  p_action TEXT,
  p_details JSONB DEFAULT '{}'::JSONB
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_role TEXT := public.current_profile_role();
BEGIN
  IF v_role IS NULL OR v_role NOT IN ('admin', 'supervisor', 'office') THEN
    RAISE EXCEPTION 'Only staff may write audit logs.'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  INSERT INTO public.audit_logs (action, details, "createdAt")
  VALUES (p_action, p_details, NOW());
END;
$$;

REVOKE ALL ON FUNCTION public.create_audit_log(TEXT, JSONB) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.create_audit_log(TEXT, JSONB) TO authenticated;
