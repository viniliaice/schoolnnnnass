-- Bulk-approve pending exams server-side.
--
-- The client previously approved exams by issuing one PATCH per ~1k-row id list
-- (exams?id=in.(exam-...,exam-...,...)). Supabase sits behind Cloudflare, whose
-- request-line limit (~8KB) rejects those long URLs with HTTP 400 — which is why
-- "Approve All Pending" failed even after the statement-timeout fix.
--
-- Doing the UPDATE inside a SECURITY DEFINER function sidesteps the URL entirely
-- (a single fast statement, no RETURNING of millions of rows) and lets us disable
-- the statement_timeout for the duration so very large queues (tens of thousands
-- of rows) cannot trip the API timeout either.
--
-- p_class_names:
--   NULL / empty  -> global approve of every pending exam (admin).
--   provided      -> approve pending exams for students in those classes (supervisor).
CREATE OR REPLACE FUNCTION public.approve_all_pending_exams(p_class_names text[] DEFAULT NULL)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_role text := public.current_profile_role();
  v_count integer := 0;
BEGIN
  -- Only privileged roles may approve. RLS no longer applies to the UPDATE (the
  -- function runs as the definer), so this guard is what keeps teachers out.
  IF v_role IS DISTINCT FROM 'admin' AND v_role IS DISTINCT FROM 'supervisor' THEN
    RAISE EXCEPTION 'Only admins or supervisors may approve exams'
      USING ERRCODE = '42501';
  END IF;

  -- Allow very large bulk updates without hitting the API statement_timeout.
  SET LOCAL statement_timeout = '0';

  IF p_class_names IS NULL OR array_length(p_class_names, 1) IS NULL THEN
    UPDATE public.exams SET status = 'approved' WHERE status = 'pending';
  ELSE
    UPDATE public.exams e
    SET status = 'approved'
    FROM public.students s
    WHERE e.status = 'pending'
      AND e."studentId" = s.id
      AND s."className" = ANY(p_class_names);
  END IF;

  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END;
$$;

REVOKE ALL ON FUNCTION public.approve_all_pending_exams(text[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.approve_all_pending_exams(text[]) TO authenticated;
