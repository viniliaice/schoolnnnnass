-- Assertion tests for the SAFE DUPLICATE BATCH feature.
--
-- Run against a database with the migrations applied:
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f supabase/tests/safe-duplicate-batch.sql
-- Every DO block RAISE EXCEPTION on failure, so a failing assertion fails the
-- script (exit non-zero under ON_ERROR_STOP).
--
-- These checks are read-only: they inspect definitions, grants, policies and
-- the batch contract. No student row is inserted, updated or deleted, so the
-- file is safe to run against production. The same file is executed inside
-- PGlite by src/lib/__tests__/duplicateBatch.sqlAssertions.db.test.ts.

-- ── 1. The three batch RPCs exist and are SECURITY DEFINER ─────────────────
DO $$
DECLARE
  r RECORD;
  v_missing TEXT[] := ARRAY[]::TEXT[];
BEGIN
  FOR r IN
    SELECT p.proname, p.prosecdef, p.provolatile
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public'
      AND p.proname IN ('get_safe_duplicate_batch', 'preview_safe_duplicate_batch', 'merge_safe_duplicate_batch')
  LOOP
    IF NOT r.prosecdef THEN
      RAISE EXCEPTION '% must be SECURITY DEFINER (eligibility may never run as the caller)', r.proname;
    END IF;
    IF r.provolatile = 'i' THEN
      RAISE EXCEPTION '% must not be IMMUTABLE — eligibility is recomputed from live rows', r.proname;
    END IF;
  END LOOP;

  SELECT array_agg(name) INTO v_missing
  FROM (VALUES ('get_safe_duplicate_batch'), ('preview_safe_duplicate_batch'), ('merge_safe_duplicate_batch')) AS v(name)
  WHERE NOT EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.proname = v.name
  );
  IF v_missing IS NOT NULL AND array_length(v_missing, 1) > 0 THEN
    RAISE EXCEPTION 'missing safe batch RPC(s): %', array_to_string(v_missing, ', ');
  END IF;
END $$;

-- ── 2. No public execute: only authenticated (role checked inside) ─────────
DO $$
DECLARE
  v_public INT;
BEGIN
  SELECT count(*) INTO v_public
  FROM pg_proc p
  JOIN pg_namespace n ON n.oid = p.pronamespace
  CROSS JOIN LATERAL aclexplode(COALESCE(p.proacl, acldefault('f', p.proowner))) AS a
  WHERE n.nspname = 'public'
    AND p.proname IN ('get_safe_duplicate_batch', 'preview_safe_duplicate_batch',
                      'merge_safe_duplicate_batch', '_safe_batch_evaluate_pair',
                      '_safe_batch_candidate_pairs', 'safe_duplicate_batch_policy')
    AND a.grantee = 0            -- 0 = PUBLIC
    AND a.privilege_type = 'EXECUTE';
  IF v_public > 0 THEN
    RAISE EXCEPTION '% batch function(s) are still executable by PUBLIC', v_public;
  END IF;
END $$;

-- ── 3. The batch policy documents the contract the UI shows ────────────────
DO $$
DECLARE
  v_policy JSONB := public.safe_duplicate_batch_policy();
BEGIN
  IF v_policy->>'policyId' <> 'safe_batch_parent_assigned_keeper' THEN
    RAISE EXCEPTION 'unexpected policyId: %', v_policy->>'policyId';
  END IF;
  IF v_policy->>'confirmPhrase' <> 'MERGE SAFE DUPLICATES' THEN
    RAISE EXCEPTION 'the typed confirmation phrase changed: %', v_policy->>'confirmPhrase';
  END IF;
  IF (v_policy->'chunkSize'->>'default')::INT NOT BETWEEN 25 AND 50
     OR (v_policy->'chunkSize'->>'min')::INT < 1
     OR (v_policy->'chunkSize'->>'max')::INT > 50 THEN
    RAISE EXCEPTION 'chunk size must stay inside 25..50 (min 1), got %', v_policy->'chunkSize';
  END IF;
  IF (v_policy->'chunkSize'->>'atomicPerChunk')::BOOLEAN IS NOT TRUE THEN
    RAISE EXCEPTION 'chunks must be atomic';
  END IF;
  -- The rules an administrator is promised, and the bilingual names.
  IF NOT (v_policy->'requiredConditions' ?| ARRAY[
        'same_normalized_name', 'same_current_class', 'exactly_one_parent_assigned',
        'candidate_group_has_exactly_two_records', 'no_conflicting_gov_id',
        'gov_id_not_owned_by_a_third_student', 'no_conflicting_parent_phone',
        'no_conflicting_transport', 'safe_enrollment_state', 'no_exam_conflict',
        'no_attendance_conflict', 'no_quiz_conflict', 'no_release_conflict',
        'no_report_comment_conflict', 'no_unhandled_child_dependency']) THEN
    RAISE EXCEPTION 'requiredConditions lost a documented rule: %', v_policy->'requiredConditions';
  END IF;
  IF btrim(COALESCE(v_policy->>'nameEn', '')) = '' OR btrim(COALESCE(v_policy->>'nameAr', '')) = '' THEN
    RAISE EXCEPTION 'the policy must stay bilingual (nameEn + nameAr)';
  END IF;
  IF btrim(COALESCE(v_policy->>'keeperRuleEn', '')) = '' OR btrim(COALESCE(v_policy->>'keeperRuleAr', '')) = '' THEN
    RAISE EXCEPTION 'the keeper rule must stay bilingual';
  END IF;
  IF jsonb_array_length(v_policy->'invariants') < 4 THEN
    RAISE EXCEPTION 'the post-merge invariants must be published';
  END IF;
  -- Every exclusion code the UI can render has a human explanation.
  IF jsonb_typeof(v_policy->'exclusionCodes') <> 'object'
     OR NOT (v_policy->'exclusionCodes' ?| ARRAY[
        'gov_id_conflict', 'both_parents_assigned', 'parent_phone_conflict',
        'transport_conflict', 'exam_conflict', 'multiple_open_enrollments',
        'group_has_more_than_two_records', 'candidate_changed_since_preview',
        'already_resolved', 'not_eligible_server_side', 'not_a_candidate']) THEN
    RAISE EXCEPTION 'exclusionCodes is incomplete: %', v_policy->'exclusionCodes';
  END IF;
  -- Hard conflicts must be classified blocked, ambiguous ones may be review.
  IF NOT (v_policy->'blockedCodes' ?| ARRAY[
        'gov_id_conflict', 'both_parents_assigned', 'parent_phone_conflict',
        'transport_conflict', 'family_id_conflict', 'exam_conflict',
        'attendance_conflict', 'quiz_conflict', 'release_conflict',
        'report_comment_conflict', 'multiple_open_enrollments',
        'unhandled_child_dependency']) THEN
    RAISE EXCEPTION 'blockedCodes lost a hard conflict: %', v_policy->'blockedCodes';
  END IF;
END $$;

-- ── 4. Internal helpers are admin-only and NOT callable by a JWT role ──────
-- _safe_batch_evaluate_pair returns Gov IDs, parent phones, family ids and both
-- parent profiles for ANY two student ids; _safe_batch_candidate_pairs scans
-- every name/class group in the school; _safe_batch_unhandled_child_rows counts
-- child rows for any student id. All three run as the function owner, so each
-- one carries the project's standard admin guard (current_profile_role()) and
-- none of them may be executed directly by anon/authenticated. The SECURITY
-- DEFINER batch RPCs still call them — as owner, after their own admin check.
--
-- The BEHAVIOURAL half (teacher/parent/supervisor/anon are refused with
-- insufficient_privilege and receive no PII, an administrator is served, and a
-- pair of missing students is never eligible) is executed on real PostgreSQL
-- inside PGlite by src/lib/__tests__/duplicateBatch.security.db.test.ts — this
-- file stays read-only so it remains safe to run against production.
DO $$
DECLARE
  v_fn TEXT;
  v_role TEXT;
  v_roles TEXT[] := ARRAY['anon', 'authenticated'];
  v_total INT; v_invoker INT; v_unguarded INT; v_granted INT;
  v_bad TEXT[] := ARRAY[]::TEXT[];
BEGIN
  FOREACH v_fn IN ARRAY ARRAY[
    '_safe_batch_evaluate_pair',
    '_safe_batch_candidate_pairs',
    '_safe_batch_unhandled_child_rows'
  ] LOOP
    SELECT count(*),
           count(*) FILTER (WHERE NOT p.prosecdef),
           count(*) FILTER (
             WHERE position('current_profile_role()' in pg_get_functiondef(p.oid)) = 0
                OR position('insufficient_privilege' in pg_get_functiondef(p.oid)) = 0)
      INTO v_total, v_invoker, v_unguarded
      FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public' AND p.proname = v_fn;

    IF COALESCE(v_total, 0) = 0 THEN
      v_bad := v_bad || format('%s is missing', v_fn);
    END IF;
    IF COALESCE(v_invoker, 0) > 0 THEN
      v_bad := v_bad || format('%s must stay SECURITY DEFINER (the batch RPCs call it as owner)', v_fn);
    END IF;
    IF COALESCE(v_unguarded, 0) > 0 THEN
      v_bad := v_bad || format('%s lost its admin role guard (current_profile_role() + insufficient_privilege)', v_fn);
    END IF;

    FOREACH v_role IN ARRAY v_roles LOOP
      IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = v_role) THEN
        SELECT count(*) INTO v_granted
        FROM pg_proc p
        JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'public' AND p.proname = v_fn
         AND has_function_privilege(v_role, p.oid, 'EXECUTE');
        IF COALESCE(v_granted, 0) > 0 THEN
          v_bad := v_bad || format('%s is still directly executable by %s', v_fn, v_role);
        END IF;
      END IF;
    END LOOP;
  END LOOP;

  IF COALESCE(array_length(v_bad, 1), 0) > 0 THEN
    RAISE EXCEPTION 'internal batch helper hardening failed: %', array_to_string(v_bad, '; ');
  END IF;
END $$;

-- ── 4b. The client-callable batch functions KEEP their authenticated grant ──
-- Revoking the helpers must not lock the administrator out of the feature.
DO $$
DECLARE
  v_fn TEXT;
  v_missing TEXT[] := ARRAY[]::TEXT[];
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    RETURN;
  END IF;
  FOREACH v_fn IN ARRAY ARRAY[
    'safe_duplicate_batch_policy',
    'get_safe_duplicate_batch',
    'preview_safe_duplicate_batch',
    'merge_safe_duplicate_batch'
  ] LOOP
    IF NOT EXISTS (
      SELECT 1 FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public' AND p.proname = v_fn
       AND has_function_privilege('authenticated', p.oid, 'EXECUTE')
    ) THEN
      v_missing := v_missing || v_fn;
    END IF;
  END LOOP;
  IF COALESCE(array_length(v_missing, 1), 0) > 0 THEN
    RAISE EXCEPTION 'batch RPC(s) no longer executable by authenticated: %', array_to_string(v_missing, ', ');
  END IF;
END $$;

-- ── 5. Batch metadata table + RLS (read-only for admin/supervisor) ─────────
DO $$
DECLARE
  v_rls BOOLEAN;
  v_write_policies INT;
  v_read_policies INT;
BEGIN
  IF to_regclass('public.student_merge_batches') IS NULL THEN
    RAISE EXCEPTION 'public.student_merge_batches is missing';
  END IF;
  SELECT c.relrowsecurity INTO v_rls
  FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'public' AND c.relname = 'student_merge_batches';
  IF NOT v_rls THEN
    RAISE EXCEPTION 'student_merge_batches must have RLS enabled';
  END IF;
  SELECT count(*) FILTER (WHERE cmd = 'SELECT'),
         count(*) FILTER (WHERE cmd IN ('INSERT', 'UPDATE', 'DELETE'))
    INTO v_read_policies, v_write_policies
  FROM pg_policies
  WHERE schemaname = 'public' AND tablename = 'student_merge_batches';
  IF v_read_policies < 1 THEN
    RAISE EXCEPTION 'student_merge_batches needs a SELECT policy for administrators';
  END IF;
  IF v_write_policies > 0 THEN
    RAISE EXCEPTION 'student_merge_batches must be written only through SECURITY DEFINER RPCs (% write policies found)', v_write_policies;
  END IF;
END $$;

-- ── 6. Per-merge audit keeps its detail and gains batch provenance ─────────
DO $$
DECLARE
  v_missing TEXT[] := ARRAY[]::TEXT[];
  v_default TEXT;
BEGIN
  SELECT array_agg(col) INTO v_missing
  FROM (VALUES ('batch_id'), ('batch_policy'), ('batch_size'), ('merge_kind')) AS v(col)
  WHERE NOT EXISTS (
    SELECT 1 FROM information_schema.columns c
    WHERE c.table_schema = 'public' AND c.table_name = 'student_merge_audits' AND c.column_name = v.col
  );
  IF v_missing IS NOT NULL AND array_length(v_missing, 1) > 0 THEN
    RAISE EXCEPTION 'student_merge_audits is missing batch column(s): %', array_to_string(v_missing, ', ');
  END IF;
  -- The individual workflow must keep working unchanged: existing audits and
  -- new individual merges are labelled 'individual' by default.
  SELECT column_default INTO v_default
  FROM information_schema.columns
  WHERE table_schema = 'public' AND table_name = 'student_merge_audits' AND column_name = 'merge_kind';
  IF v_default IS NULL OR position('individual' in v_default) = 0 THEN
    RAISE EXCEPTION 'merge_kind must default to individual, got %', COALESCE(v_default, 'NULL');
  END IF;
  -- The per-merge detail columns an administrator relies on are still there.
  SELECT array_agg(col) INTO v_missing
  FROM (VALUES ('canonical_id'), ('duplicate_id'), ('admin_id'), ('reason'),
               ('before_counts'), ('after_counts'), ('enrollment_action')) AS v(col)
  WHERE NOT EXISTS (
    SELECT 1 FROM information_schema.columns c
    WHERE c.table_schema = 'public' AND c.table_name = 'student_merge_audits' AND c.column_name = v.col
  );
  IF v_missing IS NOT NULL AND array_length(v_missing, 1) > 0 THEN
    RAISE EXCEPTION 'student_merge_audits lost detail column(s): %', array_to_string(v_missing, ', ');
  END IF;
END $$;

-- ── 7. The batch reuses the existing merge RPC (no second delete path) ─────
DO $$
DECLARE
  v_body TEXT;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO v_body
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public' AND p.proname = 'merge_safe_duplicate_batch'
  LIMIT 1;
  IF position('merge_duplicate_students_resolved' in v_body) = 0 THEN
    RAISE EXCEPTION 'the batch must delegate to merge_duplicate_students_resolved()';
  END IF;
  IF position('FOR UPDATE' in v_body) = 0 THEN
    RAISE EXCEPTION 'the batch must lock the pair rows before revalidating';
  END IF;
  IF position('DELETE FROM public.students' in v_body) > 0 THEN
    RAISE EXCEPTION 'the batch must not contain its own student DELETE — the shared merge RPC owns deletion';
  END IF;
END $$;

-- ── 8. get_merge_conflicts no longer references an unquoted camelCase column ─
-- 20260924 shipped `c.subjectId` (unquoted) inside the exam identity check, so
-- PostgreSQL folded it to c.subjectid and EVERY call failed with
-- "column c.subjectid does not exist" — breaking the guided individual merge
-- and, with it, the batch that reuses it. 20260926 restored the quoted column.
DO $$
DECLARE
  v_body TEXT;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO v_body
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public' AND p.proname = 'get_merge_conflicts'
  LIMIT 1;
  IF v_body IS NULL THEN
    RAISE EXCEPTION 'public.get_merge_conflicts is missing';
  END IF;
  IF position('c.subjectId' in v_body) > 0 THEN
    RAISE EXCEPTION 'get_merge_conflicts still contains an unquoted c.subjectId (20260926 regression)';
  END IF;
  IF position('c."subjectId"' in v_body) = 0 THEN
    RAISE EXCEPTION 'get_merge_conflicts must compare the quoted c."subjectId" column';
  END IF;
END $$;

-- ── 9. A batch id can never be hijacked by a second administrator ──────────
-- The client supplies p_batch_id so one run can accumulate several chunks into
-- one aggregate row. An existing id must therefore be accepted ONLY from the
-- administrator who created it: the guard runs before any merge, is serialised
-- with an advisory lock (two concurrent chunks that picked the same fresh id),
-- and the aggregate upsert may only accumulate for the acting administrator.
DO $$
DECLARE
  v_body TEXT;
  v_guard_pos INT;
  v_merge_pos INT;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO v_body
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public' AND p.proname = 'merge_safe_duplicate_batch'
  LIMIT 1;
  IF v_body IS NULL THEN
    RAISE EXCEPTION 'public.merge_safe_duplicate_batch is missing';
  END IF;
  IF position('batch_id_not_owned' in v_body) = 0 THEN
    RAISE EXCEPTION 'merge_safe_duplicate_batch lost the batch_id_not_owned ownership guard';
  END IF;
  IF position('pg_advisory_xact_lock' in v_body) = 0 THEN
    RAISE EXCEPTION 'the batch id ownership check must be serialised (advisory lock) to close the creation race';
  END IF;
  IF position('admin_id IS NOT DISTINCT FROM v_actor' in v_body) = 0 THEN
    RAISE EXCEPTION 'the aggregate batch upsert must only accumulate for the acting administrator';
  END IF;
  v_guard_pos := position('batch_id_not_owned' in v_body);
  v_merge_pos := position('merge_duplicate_students_resolved' in v_body);
  IF v_merge_pos > 0 AND v_guard_pos > v_merge_pos THEN
    RAISE EXCEPTION 'the ownership guard must run BEFORE any merge is attempted';
  END IF;
  -- The lock must be taken BEFORE the ownership read, otherwise two concurrent
  -- chunks that picked the same fresh id can both see "no row yet" and one of
  -- them accumulates into the other's batch.
  IF position('pg_advisory_xact_lock' in v_body) > v_guard_pos THEN
    RAISE EXCEPTION 'the advisory lock must be taken before the batch id ownership check';
  END IF;
  -- Ownership is immutable: the accumulate path must never rewrite admin_id.
  IF position('admin_id = EXCLUDED.admin_id' in v_body) > 0
     OR position('admin_id = v_actor' in v_body) > 0 THEN
    RAISE EXCEPTION 'an existing batch row must never change owner';
  END IF;
END $$;
