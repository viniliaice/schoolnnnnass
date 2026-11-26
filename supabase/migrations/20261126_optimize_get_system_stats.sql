-- Optimize get_system_stats() to fix "57014 canceling statement due to statement timeout"
-- on the Admin Dashboard.
--
-- Root cause: the previous definition ran 9 independent sub-queries (5 of them
-- against public.exams) under the caller's Row-Level Security. For the
-- authenticated API role (statement_timeout = 8s) each sub-query was a full
-- sequential scan of the exams table (~94 MB / 100k+ rows), and the per-row RLS
-- policy qual was evaluated on every row of every scan. On a cold/shared
-- instance that blew past the 8s statement_timeout.
--
-- Fix: scan each table at most ONCE using conditional aggregation (FILTER),
-- run SECURITY DEFINER so RLS is bypassed (consistent with promote_students
-- and other admin-only RPCs), and guard with assert_admin() so only
-- administrators can read global statistics. The returned JSONB shape and
-- value semantics are unchanged.

CREATE OR REPLACE FUNCTION public.get_system_stats()
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  result jsonb;
BEGIN
  -- Only administrators may read global system statistics.
  PERFORM public.assert_admin();

  WITH prof AS (
    SELECT
      count(*) FILTER (WHERE lower(trim(role::text)) = 'teacher') AS teachers,
      count(*) FILTER (WHERE lower(trim(role::text)) = 'parent')  AS parents
    FROM public.profiles
  ),
  stu AS (
    SELECT
      count(*) FILTER (WHERE coalesce(status, 'active') = 'active') AS active,
      count(*) FILTER (WHERE coalesce(status, 'active') = 'former') AS former
    FROM public.students
  ),
  ex AS (
    SELECT
      count(*)                                                                   AS total,
      count(*) FILTER (WHERE status = 'pending')                                 AS pending,
      count(*) FILTER (WHERE status = 'approved')                                AS approved,
      count(*) FILTER (WHERE status = 'rejected')                                AS rejected,
      avg(CASE WHEN total > 0 THEN (score::numeric / total::numeric) * 100
               ELSE NULL END)                                                     AS avg_score
    FROM public.exams
  )
  SELECT jsonb_build_object(
    'totalTeachers',  p.teachers,
    'totalParents',   p.parents,
    'totalStudents',  s.active,
    'formerStudents', s.former,
    'totalExams',     e.total,
    'pendingExams',   e.pending,
    'approvedExams',  e.approved,
    'rejectedExams',  e.rejected,
    'averageScore',   coalesce(round(e.avg_score, 2), 0)
  )
  INTO result
  FROM prof p, stu s, ex e;

  RETURN result;
END;
$$;

-- Preserve existing execute grants (CREATE OR REPLACE keeps them, but be explicit
-- so the authenticated API role can call the rewritten function).
GRANT EXECUTE ON FUNCTION public.get_system_stats() TO authenticated, anon, service_role;
