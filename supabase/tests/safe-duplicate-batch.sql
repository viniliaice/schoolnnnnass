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

-- ── 4. The evaluator refuses a pair it cannot see (no fixture data needed) ─
DO $$
DECLARE
  v_eval JSONB := public._safe_batch_evaluate_pair(
    'safe-batch-assertion-missing-a', 'safe-batch-assertion-missing-b', 2, false);
BEGIN
  IF COALESCE((v_eval->>'eligible')::BOOLEAN, true) THEN
    RAISE EXCEPTION 'a pair of missing students must never be eligible';
  END IF;
  IF v_eval->>'severity' <> 'blocked' THEN
    RAISE EXCEPTION 'missing students must be severity=blocked, got %', v_eval->>'severity';
  END IF;
  IF NOT (v_eval->'exclusionCodes' ? 'student_missing') THEN
    RAISE EXCEPTION 'expected the student_missing exclusion code, got %', v_eval->'exclusionCodes';
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
