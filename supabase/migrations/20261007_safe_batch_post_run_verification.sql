-- ============================================================================
-- Migration 20261007 — Duplicate Students: SAFE BATCH post-run verification
-- ============================================================================
-- The batch runner (scripts/safe-duplicate-batch-run.mjs) has to prove, AFTER
-- an execution, that the database is in the state the batch promised:
-- nothing left eligible, Needs Review untouched, history intact, no orphaned
-- child rows, one audit row per merge.
--
-- Against PGlite the runner can just run SQL. Against a LIVE project it cannot
-- — there is no SQL access from a client, only PostgREST. So the verification
-- has to be a server-side function too, otherwise "verify after the batch" is
-- something only the rehearsal can do and production cannot.
--
-- This function is READ-ONLY:
--   * declared STABLE, so PostgreSQL knows it cannot write;
--   * performs no INSERT / UPDATE / DELETE;
--   * recomputes the eligibility counts by CALLING get_safe_duplicate_batch(),
--     so the numbers it reports cannot drift from the contract that actually
--     decides what gets merged.
--
-- It does NOT change the eligibility contract, the keeper rule, the grants or
-- any policy from 20260925. It only reads.
--
-- Admin-only, matching the existing batch guard: current_profile_role() must
-- be 'admin'. It exposes counts and (deliberately) no student PII — the orphan
-- detail is table names and row counts only.
--
-- Idempotent. No production data is modified by applying this migration.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.verify_safe_duplicate_batch_state()
RETURNS JSONB
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_role TEXT := public.current_profile_role();
  v_report JSONB;
  v_summary JSONB;
  v_tbl RECORD;
  v_orphans JSONB := '{}'::jsonb;
  v_orphan_total BIGINT := 0;
  v_cnt BIGINT;
  v_rows JSONB;
BEGIN
  IF v_role IS NULL OR v_role <> 'admin' THEN
    RAISE EXCEPTION 'Only administrators may verify the safe duplicate batch state.'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  -- 1. Authoritative eligibility counts, straight from the batch contract.
  --    limit 1 / no excluded rows: we want the SUMMARY, not the pairs.
  v_report := public.get_safe_duplicate_batch(1, 0, false);
  v_summary := COALESCE(v_report->'summary', '{}'::jsonb);

  -- 2. Orphaned child rows. Every foreign key that points at public.students is
  --    discovered from the catalogue at runtime, so a table added after this
  --    migration is covered too. A row whose student id no longer resolves is
  --    data the merge lost — there must never be one.
  FOR v_tbl IN
    SELECT c.relname::TEXT AS nm,
           n.nspname::TEXT AS nsp,
           (SELECT a.attname
              FROM pg_attribute a
             WHERE a.attrelid = c.oid AND a.attnum = ANY (con.conkey)
             LIMIT 1) AS col
      FROM pg_constraint con
      JOIN pg_class c ON c.oid = con.conrelid
      JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE con.contype = 'f'
       AND con.confrelid = 'public.students'::regclass
       AND n.nspname = 'public'
  LOOP
    IF v_tbl.col IS NULL THEN
      -- Cannot prove safety → report it rather than assume it is fine.
      v_orphans := v_orphans || jsonb_build_object(v_tbl.nm, -1);
      v_orphan_total := v_orphan_total + 1;
      CONTINUE;
    END IF;
    EXECUTE format(
      'SELECT count(*) FROM %I.%I x WHERE x.%I IS NOT NULL
         AND NOT EXISTS (SELECT 1 FROM public.students s WHERE s.id = x.%I)',
      v_tbl.nsp, v_tbl.nm, v_tbl.col, v_tbl.col)
      INTO v_cnt;
    IF COALESCE(v_cnt, 0) > 0 THEN
      v_orphans := v_orphans || jsonb_build_object(v_tbl.nm, v_cnt);
      v_orphan_total := v_orphan_total + v_cnt;
    END IF;
  END LOOP;

  -- 3. Enrollment invariant the merge promises: no student left with more than
  --    one OPEN enrollment (the duplicate's is closed, never deleted).
  SELECT COALESCE(jsonb_object_agg(x."studentId", x.n), '{}'::jsonb),
         COALESCE(count(*), 0)
    INTO v_rows, v_cnt
  FROM (
    SELECT e."studentId", count(*) AS n
      FROM public.student_enrollments e
     WHERE e."effectiveTo" IS NULL
     GROUP BY e."studentId"
    HAVING count(*) > 1
  ) x;

  RETURN jsonb_build_object(
    'authoritative', jsonb_build_object(
      'candidatePairs', v_summary->'candidatePairs',
      'safeEligible', v_summary->'safeCount',
      'needsReview', v_summary->'needsReviewCount',
      'blocked', v_summary->'blockedCount',
      'excluded', v_summary->'excludedCount'),
    'students', (SELECT count(*) FROM public.students),
    'audits', jsonb_build_object(
      'total', (SELECT count(*) FROM public.student_merge_audits),
      'safeBatch', (SELECT count(*) FROM public.student_merge_audits WHERE merge_kind = 'safe_batch'),
      'individual', (SELECT count(*) FROM public.student_merge_audits WHERE merge_kind IS DISTINCT FROM 'safe_batch'),
      'distinctRemovedIds', (SELECT count(DISTINCT duplicate_id) FROM public.student_merge_audits)),
    'batches', jsonb_build_object(
      'runs', (SELECT count(*) FROM public.student_merge_batches),
      'mergedSum', (SELECT COALESCE(sum(merged_count), 0) FROM public.student_merge_batches),
      'skippedSum', (SELECT COALESCE(sum(skipped_count), 0) FROM public.student_merge_batches),
      'blockedSum', (SELECT COALESCE(sum(blocked_count), 0) FROM public.student_merge_batches)),
    'batchAuditLogs', (SELECT count(*) FROM public.audit_logs WHERE action = 'students.merge_batch'),
    'integrity', jsonb_build_object(
      'orphanedChildRows', v_orphan_total,
      'orphanDetail', v_orphans,
      'studentsWithMultipleOpenEnrollments', v_cnt,
      'multipleOpenEnrollmentDetail', v_rows),
    'generatedAt', now()
  );
END;
$$;

REVOKE ALL ON FUNCTION public.verify_safe_duplicate_batch_state() FROM PUBLIC;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    GRANT EXECUTE ON FUNCTION public.verify_safe_duplicate_batch_state() TO authenticated;
  END IF;
END $$;

COMMENT ON FUNCTION public.verify_safe_duplicate_batch_state() IS
  'READ-ONLY post-run verification for the safe duplicate batch. Admin-only. '
  'Reports the authoritative eligibility counts (recomputed via get_safe_duplicate_batch), '
  'merge audit totals by kind, batch run totals, and FK/orphan integrity across every '
  'table that references public.students. Modifies nothing.';
