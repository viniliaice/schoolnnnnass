-- ============================================================================
-- Migration 20260925 — Duplicate Students: SAFE BATCH MERGE
-- ============================================================================
-- Adds a RESTRICTED batch action: "Merge All Safe Duplicates".
--
-- This is NOT a "Merge All" / "Delete All" / "Auto Clean" button. The database
-- decides — never the browser — which candidate pairs satisfy a strict
-- safe-merge eligibility contract. Anything ambiguous or conflicting stays in
-- the existing individual guided-review workflow (20260922 + 20260924), which
-- is untouched by this migration.
--
-- New objects
--   * student_merge_batches               — batch run metadata (who/when/policy)
--   * student_merge_audits.batch_*        — batch columns on the EXISTING
--                                           per-merge audit (one row per merge)
--   * safe_duplicate_batch_policy()       — the documented batch policy (single
--                                           source of truth for rules + UI text)
--   * _safe_batch_evaluate_pair()         — the eligibility contract for ONE pair
--   * _safe_batch_candidate_pairs()       — set-based candidate discovery
--   * _safe_batch_unhandled_child_rows()  — FK safety net (never silently delete
--                                           rows the merge logic does not move)
--   * get_safe_duplicate_batch()          — summary-first, paginated eligibility
--   * preview_safe_duplicate_batch()      — DRY RUN (zero writes) + chunk plan
--   * merge_safe_duplicate_batch()        — admin-only chunked execution
--
-- Batch policy (administrator-approved, explicit, deterministic)
--   KEEP  = the parent-assigned record.
--   MERGE = the unassigned duplicate, removed after transactional verification.
--   The keeper is NOT "Record A", NOT "the older record" and NOT "whatever the
--   caller called canonical" — it is the record that has a parent assigned.
--   The preserved Student ID is therefore the keeper's Student ID.
--
-- Safety reuse (no duplicated merge logic)
--   Execution delegates every accepted pair to the EXISTING validated
--   merge_duplicate_students_resolved() RPC, so locking, Gov-ID third-student
--   validation, parent existence, enrollment consolidation, history transfer,
--   per-merge audit, zero-dependency verification and the duplicate DELETE are
--   exactly the individual-merge behaviour.
--
-- Transaction strategy
--   One RPC call = one chunk = one atomic transaction (default 25 merges,
--   hard max 50). A pair that is stale or no longer eligible is SKIPPED/BLOCKED
--   (reported, never forced). A pair that fails while being merged aborts the
--   whole chunk: nothing in that chunk is committed. The client drives the next
--   chunk; the server recomputes eligibility from live rows every time and never
--   trusts a client-supplied list as authoritative (a client list can only
--   NARROW the scope, never widen it).
--
-- Idempotent. No production data is modified by applying this migration.
-- ============================================================================

-- ─── 1. Batch metadata + per-merge batch audit columns ──────────────────────
CREATE TABLE IF NOT EXISTS public.student_merge_batches (
  id TEXT PRIMARY KEY,
  admin_id TEXT,
  policy TEXT NOT NULL DEFAULT 'safe_batch_parent_assigned_keeper',
  chunk_size INTEGER NOT NULL,
  chunks_run INTEGER NOT NULL DEFAULT 1,
  reason TEXT,
  requested_pairs INTEGER NOT NULL DEFAULT 0,
  merged_count INTEGER NOT NULL DEFAULT 0,
  skipped_count INTEGER NOT NULL DEFAULT 0,
  blocked_count INTEGER NOT NULL DEFAULT 0,
  failed_count INTEGER NOT NULL DEFAULT 0,
  remaining_eligible INTEGER,
  chunk_results JSONB NOT NULL DEFAULT '[]'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_student_merge_batches_admin ON public.student_merge_batches (admin_id);
CREATE INDEX IF NOT EXISTS idx_student_merge_batches_created ON public.student_merge_batches (created_at DESC);

ALTER TABLE public.student_merge_batches ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Admins can read merge batches" ON public.student_merge_batches;
CREATE POLICY "Admins can read merge batches"
  ON public.student_merge_batches FOR SELECT TO authenticated
  USING (public.current_profile_role() IN ('admin','supervisor'));

-- No INSERT/UPDATE/DELETE policies: writes only through SECURITY DEFINER RPCs.

-- Per-merge audit keeps its full individual detail; these columns add the batch
-- provenance so an administrator can answer "which students did THIS batch
-- merge, under which policy, approved by whom, and which Student ID survived?"
ALTER TABLE public.student_merge_audits ADD COLUMN IF NOT EXISTS batch_id TEXT;
ALTER TABLE public.student_merge_audits ADD COLUMN IF NOT EXISTS batch_policy TEXT;
ALTER TABLE public.student_merge_audits ADD COLUMN IF NOT EXISTS batch_size INTEGER;
ALTER TABLE public.student_merge_audits ADD COLUMN IF NOT EXISTS merge_kind TEXT NOT NULL DEFAULT 'individual';

CREATE INDEX IF NOT EXISTS idx_student_merge_audits_batch ON public.student_merge_audits (batch_id);

-- Candidate discovery support: grouping key used by every duplicate RPC.
CREATE INDEX IF NOT EXISTS idx_students_name_match_key_class
  ON public.students (public.name_match_key(name), "className");

-- ─── 2. The documented batch policy (single source of truth) ────────────────
CREATE OR REPLACE FUNCTION public.safe_duplicate_batch_policy()
RETURNS JSONB
LANGUAGE sql IMMUTABLE SET search_path = public AS $$
  SELECT jsonb_build_object(
    'policyId', 'safe_batch_parent_assigned_keeper',
    'version', 1,
    'nameEn', 'Merge All Safe Duplicates',
    'nameAr', 'دمج جميع سجلات الطلاب الآمنة المكررة',
    'keeperRuleEn', 'The parent-assigned record will be kept. The unassigned duplicate will be merged into it.',
    'keeperRuleAr', 'يُحتفظ بالسجل الذي لديه ولي أمر معيّن، ويُدمج فيه السجل المكرر غير المعیَّن.',
    'keeperRule', 'KEEP the parent-assigned record; MERGE the unassigned duplicate into it and remove it only after transactional verification. The keeper is never chosen by record order, age, or the caller''s "canonical" label.',
    'confirmPhrase', 'MERGE SAFE DUPLICATES',
    'chunkSize', jsonb_build_object('default', 25, 'min', 1, 'max', 50, 'atomicPerChunk', true),
    'requiredConditions', jsonb_build_array(
      'same_normalized_name',
      'same_current_class',
      'exactly_one_parent_assigned',
      'candidate_group_has_exactly_two_records',
      'no_conflicting_gov_id',
      'gov_id_not_owned_by_a_third_student',
      'no_conflicting_parent_phone',
      'no_conflicting_transport',
      'no_conflicting_family_id',
      'assigned_parent_profile_exists',
      'neither_record_marked_left',
      'safe_enrollment_state',
      'no_exam_conflict',
      'no_attendance_conflict',
      'no_quiz_conflict',
      'no_release_conflict',
      'no_report_comment_conflict',
      'no_unhandled_child_dependency'
    ),
    'fieldResolutions', jsonb_build_object(
      'name', 'keeper value (names are normalized-identical by contract)',
      'className', 'keeper value (identical by contract — the stable Student ID keeps its class)',
      'govId', 'keeper value; if the keeper is blank the removed record''s Gov ID is moved onto the keeper (never discarded), only when no third student owns it',
      'parentId', 'keeper value (the parent-assigned record is the keeper)',
      'parentPhone', 'keeper value; the pair is excluded when the two phones differ, and excluded when only the unassigned record has a phone',
      'transport', 'keeper value; the pair is excluded when the two transports differ, and excluded when only the unassigned record has a transport',
      'familyId', 'keeper value; excluded when both records carry different family IDs',
      'history', 'transferred with the existing individual-merge logic; excluded when any conflict would require an administrator choice',
      'enrollment', 'consolidate (same class + same academic year) / transfer (only the duplicate has an open enrollment) / preserve_history (duplicate has no open enrollment)'
    ),
    'exclusionCodes', jsonb_build_object(
      'group_has_more_than_two_records', 'More than two records share this name and class — ambiguous, individual review',
      'student_missing', 'One of the two records no longer exists',
      'name_conflict', 'Normalized names differ',
      'name_blank', 'Name is blank',
      'class_conflict', 'Current class differs — class changes must preserve the stable Student ID',
      'class_blank', 'Class is blank',
      'both_parents_assigned', 'Parent conflict — both records have a parent assigned',
      'parent_conflict', 'Parent conflict — both records point at different parents',
      'both_parents_unassigned', 'Neither record has a parent assigned — no keeper under the batch rule',
      'parent_profile_missing', 'The assigned parent profile does not exist',
      'student_marked_left', 'One record is marked LEFT — ambiguous enrollment state',
      'gov_id_conflict', 'Gov ID conflict — two different Government IDs',
      'gov_id_belongs_to_third_student', 'Gov ID could belong to a third student',
      'parent_phone_conflict', 'Parent phone conflict',
      'parent_phone_only_on_unassigned', 'Only the unassigned record has a parent phone — not authoritative for the batch',
      'transport_conflict', 'Transport conflict',
      'transport_only_on_unassigned', 'Only the unassigned record has a transport value — not authoritative for the batch',
      'family_id_conflict', 'Family ID conflict',
      'family_id_only_on_unassigned', 'Only the unassigned record has a family ID',
      'multiple_open_enrollments', 'Ambiguous enrollment state — more than one open enrollment',
      'no_open_enrollment', 'Ambiguous enrollment state — no open enrollment to keep',
      'enrollment_class_conflict', 'Enrollment class differs from the current class',
      'enrollment_year_conflict', 'Enrollment academic year differs',
      'exam_conflict', 'Exam identity conflict — an administrator must choose which result survives',
      'attendance_conflict', 'Attendance date conflict — an administrator must choose',
      'quiz_conflict', 'Quiz attempt conflict — an administrator must choose',
      'release_conflict', 'Release log conflict (same UTC day) — an administrator must choose',
      'report_comment_conflict', 'Report comment conflict (same term) — an administrator must choose',
      'unhandled_child_dependency', 'The duplicate has rows in a student relationship the merge logic does not move — refusing to delete them silently',
      'candidate_changed_since_preview', 'Candidate changed since preview',
      'candidate_changed_during_batch', 'Candidate changed while the batch was running',
      'already_resolved', 'Already resolved (another administrator merged it, or the record is gone)',
      'not_eligible_server_side', 'Not eligible on the server — a client list can never authorize a merge',
      'not_a_candidate', 'Not a duplicate candidate at all'
    ),
    'blockedCodes', jsonb_build_array(
      'gov_id_conflict','gov_id_belongs_to_third_student','both_parents_assigned','parent_conflict',
      'parent_phone_conflict','transport_conflict','family_id_conflict','student_missing',
      'parent_profile_missing','multiple_open_enrollments','enrollment_class_conflict',
      'enrollment_year_conflict','exam_conflict','attendance_conflict','quiz_conflict',
      'release_conflict','report_comment_conflict','unhandled_child_dependency','name_conflict',
      'class_conflict','not_eligible_server_side'
    ),
    'reuses', jsonb_build_array(
      'get_duplicate_candidates() grouping rule (normalized name + current class)',
      'merge_duplicate_students_resolved() — validation, resolution, audit, verification, delete',
      'student_merge_audits — one detailed audit row per merged student',
      'audit_logs — students.merge per merge, students.merge_batch per chunk'
    ),
    'invariants', jsonb_build_array(
      'keeper: exactly 1 open enrollment after the merge',
      'removed record: 0 open enrollments and 0 remaining rows before deletion',
      'removed record: deleted only after zero-dependency verification',
      'kept Student ID: unchanged and preserved'
    )
  );
$$;

REVOKE ALL ON FUNCTION public.safe_duplicate_batch_policy() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.safe_duplicate_batch_policy() TO authenticated;

-- ─── 3. FK safety net ───────────────────────────────────────────────────────
-- The merge moves rows out of the nine student relationships it knows about.
-- Any OTHER table that references students(id) would either block the delete
-- or (with ON DELETE CASCADE) silently destroy data. Discover those tables at
-- runtime so the guard keeps working when the schema grows.
CREATE OR REPLACE FUNCTION public._safe_batch_unhandled_child_rows(p_student_id TEXT)
RETURNS TABLE(table_name TEXT, row_count BIGINT)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_tbl RECORD;
  v_cnt BIGINT;
BEGIN
  IF p_student_id IS NULL THEN RETURN; END IF;
  FOR v_tbl IN
    SELECT format('%I.%I', n.nspname, c.relname) AS qual,
           c.relname::TEXT AS nm,
           (SELECT a.attname
              FROM pg_attribute a
             WHERE a.attrelid = c.oid AND a.attnum = ANY (con.conkey)
             LIMIT 1) AS col
      FROM pg_constraint con
      JOIN pg_class c ON c.oid = con.conrelid
      JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE con.contype = 'f'
       AND con.confrelid = 'public.students'::regclass
       AND c.relname <> ALL (ARRAY[
             'exams','attendance','homework','student_promotions','quiz_attempts',
             'report_comments','release_log','authorized_pickup_students','student_enrollments'])
       AND n.nspname = 'public'
  LOOP
    IF v_tbl.col IS NULL THEN
      -- Cannot prove safety → treat as a dependency.
      RETURN QUERY SELECT v_tbl.nm, (-1)::BIGINT;
      CONTINUE;
    END IF;
    EXECUTE format('SELECT count(*) FROM %s WHERE %I = $1', v_tbl.qual, v_tbl.col)
      INTO v_cnt USING p_student_id;
    IF COALESCE(v_cnt, 0) > 0 THEN
      RETURN QUERY SELECT v_tbl.nm, v_cnt;
    END IF;
  END LOOP;
END;
$$;

REVOKE ALL ON FUNCTION public._safe_batch_unhandled_child_rows(TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public._safe_batch_unhandled_child_rows(TEXT) TO authenticated;

-- ─── 4. The eligibility contract for ONE pair ───────────────────────────────
-- p_a_id / p_b_id are unordered: the function decides which record is the
-- keeper from the batch rule (the parent-assigned record), never from argument
-- order, record age, or a caller-supplied "canonical" label.
--
-- Cheap profile gates run first. Only when every profile gate passes does the
-- function pay for enrollment/history/conflict scans, so a page of hundreds of
-- candidates stays summary-fast.
CREATE OR REPLACE FUNCTION public._safe_batch_evaluate_pair(
  p_a_id TEXT,
  p_b_id TEXT,
  p_group_size INTEGER DEFAULT 2,
  p_deep BOOLEAN DEFAULT true
) RETURNS JSONB
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_a RECORD; v_b RECORD;
  v_keeper RECORD; v_removed RECORD;
  v_keeper_id TEXT; v_removed_id TEXT;
  v_keeper_is_a BOOLEAN;
  v_codes TEXT[] := ARRAY[]::TEXT[];
  v_ok TEXT[] := ARRAY[]::TEXT[];
  v_blocked BOOLEAN := false;
  v_review BOOLEAN := false;
  v_gk_k TEXT; v_gk_r TEXT;
  v_ph_k TEXT; v_ph_r TEXT;
  v_tr_k TEXT; v_tr_r TEXT;
  v_fam_k TEXT; v_fam_r TEXT;
  v_gov_choice TEXT := 'canonical';
  v_phone_choice TEXT := 'canonical';
  v_transport_choice TEXT := 'canonical';
  v_enroll_action TEXT := NULL;
  v_enroll_keep TEXT := 'canonical';
  v_open_k INT := 0; v_open_r INT := 0; v_hist_k INT := 0; v_hist_r INT := 0;
  v_enr_k RECORD; v_enr_r RECORD;
  v_exams_k INT := 0; v_exams_r INT := 0; v_exam_conf INT := 0;
  v_att_k INT := 0; v_att_r INT := 0; v_att_conf INT := 0;
  v_hw_k INT := 0; v_hw_r INT := 0;
  v_prom_k INT := 0; v_prom_r INT := 0;
  v_quiz_k INT := 0; v_quiz_r INT := 0; v_quiz_conf INT := 0;
  v_pick_k INT := 0; v_pick_r INT := 0;
  v_rel_k INT := 0; v_rel_r INT := 0; v_rel_conf INT := 0;
  v_rep_k INT := 0; v_rep_r INT := 0; v_rep_conf INT := 0;
  v_child RECORD;
  v_child_tables TEXT[] := ARRAY[]::TEXT[];
  v_child_rows INT := 0;
  v_parent_exists INT := 0;
  v_third_gov INT := 0;
  v_group_size INT := COALESCE(p_group_size, 2);
  v_deep_eval BOOLEAN := COALESCE(p_deep, true);
  v_eligible BOOLEAN;
  v_fingerprint TEXT := NULL;
  v_class TEXT;
BEGIN
  SELECT * INTO v_a FROM public.students WHERE id = p_a_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object(
      'pairKey', COALESCE(p_a_id,'?') || '>' || COALESCE(p_b_id,'?'),
      'keeperId', p_a_id, 'removedId', p_b_id,
      'eligible', false, 'severity', 'blocked',
      'exclusionCodes', to_jsonb(ARRAY['student_missing']::TEXT[]),
      'eligibilityCodes', '[]'::jsonb);
  END IF;
  SELECT * INTO v_b FROM public.students WHERE id = p_b_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object(
      'pairKey', COALESCE(p_a_id,'?') || '>' || COALESCE(p_b_id,'?'),
      'keeperId', p_a_id, 'removedId', p_b_id,
      'eligible', false, 'severity', 'blocked',
      'exclusionCodes', to_jsonb(ARRAY['student_missing']::TEXT[]),
      'eligibilityCodes', '[]'::jsonb);
  END IF;

  -- ── Keeper selection: THE parent-assigned record (explicit batch policy) ──
  v_keeper_is_a := (v_a."parentId" IS NOT NULL AND v_b."parentId" IS NULL);
  IF v_keeper_is_a THEN
    v_keeper_id := p_a_id; v_removed_id := p_b_id;
  ELSIF (v_b."parentId" IS NOT NULL AND v_a."parentId" IS NULL) THEN
    v_keeper_id := p_b_id; v_removed_id := p_a_id;
  ELSE
    -- Both assigned or both unassigned: excluded. Order only affects reporting.
    IF v_a."createdAt" IS NOT DISTINCT FROM v_b."createdAt" THEN
      v_keeper_id := LEAST(p_a_id, p_b_id); v_removed_id := GREATEST(p_a_id, p_b_id);
    ELSIF v_a."createdAt" < v_b."createdAt" THEN
      v_keeper_id := p_a_id; v_removed_id := p_b_id;
    ELSE
      v_keeper_id := p_b_id; v_removed_id := p_a_id;
    END IF;
  END IF;

  SELECT * INTO v_keeper FROM public.students WHERE id = v_keeper_id;
  SELECT * INTO v_removed FROM public.students WHERE id = v_removed_id;
  v_class := v_keeper."className";

  -- ── Identity ────────────────────────────────────────────────────────────
  IF v_group_size > 2 THEN
    v_codes := array_append(v_codes, 'group_has_more_than_two_records'); v_review := true;
  ELSE
    v_ok := array_append(v_ok, 'candidate_group_has_exactly_two_records');
  END IF;

  IF btrim(COALESCE(public.name_match_key(v_keeper.name), '')) = '' THEN
    v_codes := array_append(v_codes, 'name_blank'); v_blocked := true;
  ELSIF public.name_match_key(v_keeper.name) IS DISTINCT FROM public.name_match_key(v_removed.name) THEN
    v_codes := array_append(v_codes, 'name_conflict'); v_blocked := true;
  ELSE
    v_ok := array_append(v_ok, 'same_normalized_name');
  END IF;

  IF btrim(COALESCE(v_keeper."className", '')) = '' OR btrim(COALESCE(v_removed."className", '')) = '' THEN
    v_codes := array_append(v_codes, 'class_blank'); v_blocked := true;
  ELSIF v_keeper."className" IS DISTINCT FROM v_removed."className" THEN
    v_codes := array_append(v_codes, 'class_conflict'); v_blocked := true;
  ELSE
    v_ok := array_append(v_ok, 'same_current_class');
  END IF;

  -- ── Parent: exactly one assigned ────────────────────────────────────────
  IF v_keeper."parentId" IS NOT NULL AND v_removed."parentId" IS NOT NULL THEN
    v_codes := array_append(v_codes, 'both_parents_assigned'); v_blocked := true;
    IF v_keeper."parentId" IS DISTINCT FROM v_removed."parentId" THEN
      v_codes := array_append(v_codes, 'parent_conflict');
    END IF;
  ELSIF v_keeper."parentId" IS NULL AND v_removed."parentId" IS NULL THEN
    v_codes := array_append(v_codes, 'both_parents_unassigned'); v_review := true;
  ELSE
    v_ok := array_append(v_ok, 'exactly_one_parent_assigned');
    v_ok := array_append(v_ok, 'keeper_is_parent_assigned');
  END IF;

  -- A LEFT student has no gate card / family grouping: ambiguous state.
  IF upper(btrim(COALESCE(v_keeper.transport, ''))) = 'LEFT'
     OR upper(btrim(COALESCE(v_removed.transport, ''))) = 'LEFT' THEN
    v_codes := array_append(v_codes, 'student_marked_left'); v_review := true;
  END IF;

  -- ── Gov ID ──────────────────────────────────────────────────────────────
  v_gk_k := COALESCE(public.gov_id_match_key(v_keeper."govId"), '');
  v_gk_r := COALESCE(public.gov_id_match_key(v_removed."govId"), '');
  IF v_gk_k <> '' AND v_gk_r <> '' AND v_gk_k = v_gk_r THEN
    v_ok := array_append(v_ok, 'same_gov_id');
    v_gov_choice := 'canonical';
  ELSIF v_gk_k <> '' AND v_gk_r <> '' THEN
    v_codes := array_append(v_codes, 'gov_id_conflict'); v_blocked := true;
  ELSIF v_gk_k <> '' THEN
    v_ok := array_append(v_ok, 'gov_id_keeper_only');
    v_gov_choice := 'canonical';
  ELSIF v_gk_r <> '' THEN
    -- Preserve the only recorded Gov ID by moving it onto the keeper through
    -- the existing validated resolution ('duplicate' choice) — never discard it.
    v_ok := array_append(v_ok, 'gov_id_from_removed_preserved');
    v_gov_choice := 'duplicate';
  ELSE
    v_ok := array_append(v_ok, 'no_gov_id');
    v_gov_choice := 'canonical';
  END IF;

  IF v_gk_k <> '' OR v_gk_r <> '' THEN
    SELECT count(*) INTO v_third_gov
    FROM public.students s
    WHERE s.id <> v_keeper_id AND s.id <> v_removed_id
      AND public.gov_id_match_key(s."govId") <> ''
      AND public.gov_id_match_key(s."govId") = GREATEST(v_gk_k, v_gk_r);
    IF COALESCE(v_third_gov, 0) > 0 THEN
      v_codes := array_append(v_codes, 'gov_id_belongs_to_third_student'); v_blocked := true;
    END IF;
  END IF;

  -- ── Parent phone (never silently discard a conflicting number) ──────────
  v_ph_k := COALESCE(public.normalize_phone(v_keeper."parentPhone"), '');
  v_ph_r := COALESCE(public.normalize_phone(v_removed."parentPhone"), '');
  IF v_ph_k <> '' AND v_ph_r <> '' AND v_ph_k = v_ph_r THEN
    v_ok := array_append(v_ok, 'same_parent_phone');
  ELSIF v_ph_k <> '' AND v_ph_r <> '' THEN
    v_codes := array_append(v_codes, 'parent_phone_conflict'); v_blocked := true;
  ELSIF v_ph_k <> '' THEN
    v_ok := array_append(v_ok, 'parent_phone_keeper_only');
  ELSIF v_ph_r <> '' THEN
    -- The unassigned record's phone is not authoritative for the keeper's
    -- parent, and the batch must not invent that rule → individual review.
    v_codes := array_append(v_codes, 'parent_phone_only_on_unassigned'); v_review := true;
  ELSE
    v_ok := array_append(v_ok, 'no_parent_phone');
  END IF;
  v_phone_choice := 'canonical';

  -- ── Transport ───────────────────────────────────────────────────────────
  v_tr_k := btrim(COALESCE(v_keeper.transport, ''));
  v_tr_r := btrim(COALESCE(v_removed.transport, ''));
  IF v_tr_k <> '' AND v_tr_r <> '' AND v_tr_k = v_tr_r THEN
    v_ok := array_append(v_ok, 'same_transport');
  ELSIF v_tr_k <> '' AND v_tr_r <> '' THEN
    v_codes := array_append(v_codes, 'transport_conflict'); v_blocked := true;
  ELSIF v_tr_k <> '' THEN
    v_ok := array_append(v_ok, 'transport_keeper_only');
  ELSIF v_tr_r <> '' THEN
    v_codes := array_append(v_codes, 'transport_only_on_unassigned'); v_review := true;
  ELSE
    v_ok := array_append(v_ok, 'no_transport');
  END IF;
  v_transport_choice := 'canonical';

  -- ── Family ID ───────────────────────────────────────────────────────────
  v_fam_k := COALESCE(public.normalize_family_id(v_keeper."familyId"), '');
  v_fam_r := COALESCE(public.normalize_family_id(v_removed."familyId"), '');
  IF v_fam_k <> '' AND v_fam_r <> '' AND v_fam_k = v_fam_r THEN
    v_ok := array_append(v_ok, 'same_family_id');
  ELSIF v_fam_k <> '' AND v_fam_r <> '' THEN
    v_codes := array_append(v_codes, 'family_id_conflict'); v_blocked := true;
  ELSIF v_fam_k <> '' THEN
    v_ok := array_append(v_ok, 'family_id_keeper_only');
  ELSIF v_fam_r <> '' THEN
    v_codes := array_append(v_codes, 'family_id_only_on_unassigned'); v_review := true;
  ELSE
    v_ok := array_append(v_ok, 'no_family_id');
  END IF;

  -- ── Assigned parent must actually exist (the merge RPC validates it) ────
  IF v_keeper."parentId" IS NOT NULL THEN
    SELECT count(*) INTO v_parent_exists FROM public.profiles WHERE id = v_keeper."parentId";
    IF COALESCE(v_parent_exists, 0) = 0 THEN
      SELECT count(*) INTO v_parent_exists FROM public.users WHERE id = v_keeper."parentId";
    END IF;
    IF COALESCE(v_parent_exists, 0) = 0 THEN
      v_codes := array_append(v_codes, 'parent_profile_missing'); v_blocked := true;
    ELSE
      v_ok := array_append(v_ok, 'parent_profile_exists');
    END IF;
  END IF;

  -- ── Deep evaluation: enrollment + history (only when profile is clean) ──
  IF v_deep_eval AND array_length(v_codes, 1) IS NULL THEN
    SELECT count(*) INTO v_open_k FROM public.student_enrollments WHERE "studentId" = v_keeper_id AND "effectiveTo" IS NULL;
    SELECT count(*) INTO v_open_r FROM public.student_enrollments WHERE "studentId" = v_removed_id AND "effectiveTo" IS NULL;
    SELECT count(*) INTO v_hist_k FROM public.student_enrollments WHERE "studentId" = v_keeper_id AND "effectiveTo" IS NOT NULL;
    SELECT count(*) INTO v_hist_r FROM public.student_enrollments WHERE "studentId" = v_removed_id AND "effectiveTo" IS NOT NULL;
    SELECT * INTO v_enr_k FROM public.student_enrollments WHERE "studentId" = v_keeper_id AND "effectiveTo" IS NULL LIMIT 1;
    SELECT * INTO v_enr_r FROM public.student_enrollments WHERE "studentId" = v_removed_id AND "effectiveTo" IS NULL LIMIT 1;

    IF v_open_k > 1 OR v_open_r > 1 THEN
      v_codes := array_append(v_codes, 'multiple_open_enrollments'); v_blocked := true;
    ELSIF v_open_k = 0 AND v_open_r = 0 THEN
      -- The final invariant needs exactly one open enrollment on the keeper.
      v_codes := array_append(v_codes, 'no_open_enrollment'); v_review := true;
    ELSIF v_open_k = 0 AND v_open_r = 1 THEN
      v_enroll_action := 'transfer';
      IF v_enr_r."className" IS DISTINCT FROM v_keeper."className" THEN
        v_codes := array_append(v_codes, 'enrollment_class_conflict'); v_blocked := true;
        v_enroll_action := NULL;
      ELSE
        v_ok := array_append(v_ok, 'enrollment_transfer');
      END IF;
    ELSIF v_open_r = 0 THEN
      v_enroll_action := 'preserve_history';
      IF v_enr_k."className" IS DISTINCT FROM v_keeper."className" THEN
        v_codes := array_append(v_codes, 'enrollment_class_conflict'); v_blocked := true;
        v_enroll_action := NULL;
      ELSE
        v_ok := array_append(v_ok, 'enrollment_preserve_history');
      END IF;
    ELSE
      -- exactly one open on each side
      IF v_enr_k."className" IS DISTINCT FROM v_enr_r."className" THEN
        v_codes := array_append(v_codes, 'enrollment_class_conflict'); v_blocked := true;
      ELSIF v_enr_k."academicYearId" IS DISTINCT FROM v_enr_r."academicYearId" THEN
        v_codes := array_append(v_codes, 'enrollment_year_conflict'); v_blocked := true;
      ELSIF v_enr_k."className" IS DISTINCT FROM v_keeper."className" THEN
        v_codes := array_append(v_codes, 'enrollment_class_conflict'); v_blocked := true;
      ELSE
        v_enroll_action := 'consolidate';
        v_ok := array_append(v_ok, 'enrollment_consolidate');
      END IF;
    END IF;

    -- History counts (transferred with the existing individual-merge logic)
    SELECT count(*) INTO v_exams_k FROM public.exams WHERE "studentId" = v_keeper_id;
    SELECT count(*) INTO v_exams_r FROM public.exams WHERE "studentId" = v_removed_id;
    SELECT count(*) INTO v_att_k FROM public.attendance WHERE "studentId" = v_keeper_id;
    SELECT count(*) INTO v_att_r FROM public.attendance WHERE "studentId" = v_removed_id;
    SELECT count(*) INTO v_hw_k FROM public.homework WHERE "studentId" = v_keeper_id;
    SELECT count(*) INTO v_hw_r FROM public.homework WHERE "studentId" = v_removed_id;
    SELECT count(*) INTO v_prom_k FROM public.student_promotions WHERE "studentId" = v_keeper_id;
    SELECT count(*) INTO v_prom_r FROM public.student_promotions WHERE "studentId" = v_removed_id;
    SELECT count(*) INTO v_quiz_k FROM public.quiz_attempts WHERE "studentId" = v_keeper_id;
    SELECT count(*) INTO v_quiz_r FROM public.quiz_attempts WHERE "studentId" = v_removed_id;
    SELECT count(*) INTO v_pick_k FROM public.authorized_pickup_students WHERE "studentId" = v_keeper_id;
    SELECT count(*) INTO v_pick_r FROM public.authorized_pickup_students WHERE "studentId" = v_removed_id;
    SELECT count(*) INTO v_rel_k FROM public.release_log WHERE "studentId" = v_keeper_id;
    SELECT count(*) INTO v_rel_r FROM public.release_log WHERE "studentId" = v_removed_id;
    SELECT count(*) INTO v_rep_k FROM public.report_comments WHERE "studentId" = v_keeper_id;
    SELECT count(*) INTO v_rep_r FROM public.report_comments WHERE "studentId" = v_removed_id;

    -- Conflicts: anything that would force an administrator to choose.
    SELECT count(*) INTO v_exam_conf
    FROM public.exams d
    JOIN public.exams c ON c."studentId" = v_keeper_id
      AND d."studentId" = v_removed_id
      AND c."subjectId" IS NOT DISTINCT FROM d."subjectId"
      AND c."examType" = d."examType"
      AND c."assessmentLabel" IS NOT DISTINCT FROM d."assessmentLabel"
      AND c."termId" IS NOT DISTINCT FROM d."termId";
    IF COALESCE(v_exam_conf,0) > 0 THEN
      v_codes := array_append(v_codes, 'exam_conflict'); v_blocked := true;
    END IF;

    SELECT count(*) INTO v_att_conf
    FROM public.attendance d
    JOIN public.attendance c ON c."studentId" = v_keeper_id
      AND d."studentId" = v_removed_id AND c.date = d.date;
    IF COALESCE(v_att_conf,0) > 0 THEN
      v_codes := array_append(v_codes, 'attendance_conflict'); v_blocked := true;
    END IF;

    SELECT count(*) INTO v_quiz_conf
    FROM public.quiz_attempts d
    JOIN public.quiz_attempts c ON c."studentId" = v_keeper_id
      AND d."studentId" = v_removed_id AND c."quizId" = d."quizId";
    IF COALESCE(v_quiz_conf,0) > 0 THEN
      v_codes := array_append(v_codes, 'quiz_conflict'); v_blocked := true;
    END IF;

    SELECT count(*) INTO v_rel_conf
    FROM public.release_log d
    JOIN public.release_log c ON c."studentId" = v_keeper_id
      AND d."studentId" = v_removed_id
      AND (d."createdAt" AT TIME ZONE 'UTC')::date = (c."createdAt" AT TIME ZONE 'UTC')::date;
    IF COALESCE(v_rel_conf,0) > 0 THEN
      v_codes := array_append(v_codes, 'release_conflict'); v_blocked := true;
    END IF;

    SELECT count(*) INTO v_rep_conf
    FROM public.report_comments d
    JOIN public.report_comments c ON c."studentId" = v_keeper_id
      AND d."studentId" = v_removed_id AND c."termId" = d."termId";
    IF COALESCE(v_rep_conf,0) > 0 THEN
      v_codes := array_append(v_codes, 'report_comment_conflict'); v_blocked := true;
    END IF;

    IF array_length(v_codes, 1) IS NULL THEN
      v_ok := array_append(v_ok, 'no_history_conflicts');
      v_ok := array_append(v_ok, 'history_transfer_safe');
    END IF;

    -- FK safety net: rows the merge logic does not move must never be deleted.
    FOR v_child IN SELECT * FROM public._safe_batch_unhandled_child_rows(v_removed_id) LOOP
      v_child_rows := v_child_rows + GREATEST(v_child.row_count, 0);
      v_child_tables := array_append(v_child_tables, v_child.table_name);
    END LOOP;
    IF v_child_rows > 0 OR array_length(v_child_tables, 1) > 0 THEN
      v_codes := array_append(v_codes, 'unhandled_child_dependency'); v_blocked := true;
    END IF;
  END IF;

  v_eligible := array_length(v_codes, 1) IS NULL AND v_deep_eval;

  -- Staleness fingerprint: every field the contract depends on. Compared again
  -- after row locks at execution time, so a changed candidate is never merged.
  IF v_deep_eval AND v_eligible THEN
    v_fingerprint := md5(concat_ws('|',
      v_keeper_id, v_removed_id,
      COALESCE(v_keeper.name,''), COALESCE(v_removed.name,''),
      COALESCE(v_keeper."className",''), COALESCE(v_removed."className",''),
      COALESCE(v_keeper."govId",''), COALESCE(v_removed."govId",''),
      COALESCE(v_keeper."parentId",''), COALESCE(v_removed."parentId",''),
      COALESCE(v_keeper."parentPhone",''), COALESCE(v_removed."parentPhone",''),
      COALESCE(v_keeper.transport,''), COALESCE(v_removed.transport,''),
      COALESCE(v_keeper."familyId",''), COALESCE(v_removed."familyId",''),
      v_group_size::TEXT,
      v_open_k::TEXT, v_open_r::TEXT, v_hist_k::TEXT, v_hist_r::TEXT,
      COALESCE(v_enr_k.id,''), COALESCE(v_enr_r.id,''),
      COALESCE(v_enr_k."className",''), COALESCE(v_enr_r."className",''),
      COALESCE(v_enr_k."academicYearId",''), COALESCE(v_enr_r."academicYearId",''),
      v_exams_k::TEXT, v_exams_r::TEXT, v_exam_conf::TEXT,
      v_att_k::TEXT, v_att_r::TEXT, v_att_conf::TEXT,
      v_hw_k::TEXT, v_hw_r::TEXT,
      v_prom_k::TEXT, v_prom_r::TEXT,
      v_quiz_k::TEXT, v_quiz_r::TEXT, v_quiz_conf::TEXT,
      v_pick_k::TEXT, v_pick_r::TEXT,
      v_rel_k::TEXT, v_rel_r::TEXT, v_rel_conf::TEXT,
      v_rep_k::TEXT, v_rep_r::TEXT, v_rep_conf::TEXT,
      v_enroll_action, v_gov_choice, v_phone_choice, v_transport_choice
    ));
  END IF;

  RETURN jsonb_build_object(
    'pairKey', v_keeper_id || '>' || v_removed_id,
    'groupKey', COALESCE(public.name_match_key(v_keeper.name),'') || '|' || COALESCE(v_class,''),
    'groupSize', v_group_size,
    'keeperId', v_keeper_id,
    'removedId', v_removed_id,
    'studentName', v_keeper.name,
    'className', v_class,
    'eligible', v_eligible,
    'severity', CASE WHEN v_eligible THEN NULL WHEN v_blocked THEN 'blocked' ELSE 'review' END,
    'exclusionCodes', to_jsonb(v_codes),
    'eligibilityCodes', to_jsonb(v_ok),
    'keeperIsParentAssigned', (v_keeper."parentId" IS NOT NULL),
    'keeper', jsonb_build_object(
      'id', v_keeper.id, 'name', v_keeper.name, 'className', v_keeper."className",
      'govId', v_keeper."govId", 'parentId', v_keeper."parentId",
      'parentName', (SELECT p.name FROM public.profiles p WHERE p.id = v_keeper."parentId" LIMIT 1),
      'parentPhone', v_keeper."parentPhone", 'transport', v_keeper.transport,
      'familyId', v_keeper."familyId", 'createdAt', v_keeper."createdAt"),
    'removed', jsonb_build_object(
      'id', v_removed.id, 'name', v_removed.name, 'className', v_removed."className",
      'govId', v_removed."govId", 'parentId', v_removed."parentId",
      'parentName', (SELECT p.name FROM public.profiles p WHERE p.id = v_removed."parentId" LIMIT 1),
      'parentPhone', v_removed."parentPhone", 'transport', v_removed.transport,
      'familyId', v_removed."familyId", 'createdAt', v_removed."createdAt"),
    'resolution', jsonb_build_object(
      'summary', jsonb_build_object(
        'govId', v_gov_choice, 'parentPhone', v_phone_choice,
        'transport', v_transport_choice, 'enrollment', COALESCE(v_enroll_action,'none')),
      -- Exactly the payload merge_duplicate_students_resolved() validates.
      'mergeResolution', jsonb_build_object(
        'profile_resolution', jsonb_build_object(
          'name', 'canonical',
          'class_name', 'canonical',
          'gov_id', v_gov_choice,
          'parent_id', 'canonical',
          'parent_phone', v_phone_choice,
          'transport', v_transport_choice),
        'exam_resolution', '[]'::jsonb,
        'attendance_resolution', '[]'::jsonb,
        'quiz_resolution', '[]'::jsonb,
        'release_resolution', '[]'::jsonb,
        'report_comment_resolution', '[]'::jsonb,
        'enrollment_resolution', CASE
          WHEN v_enroll_action IS NULL THEN NULL
          ELSE jsonb_build_object('action', v_enroll_action, 'keep', v_enroll_keep) END)
    ),
    'enrollmentAction', v_enroll_action,
    'history', jsonb_build_object(
      'exams', jsonb_build_object('keeper', v_exams_k, 'removed', v_exams_r, 'conflicts', v_exam_conf),
      'attendance', jsonb_build_object('keeper', v_att_k, 'removed', v_att_r, 'conflicts', v_att_conf),
      'homework', jsonb_build_object('keeper', v_hw_k, 'removed', v_hw_r),
      'promotions', jsonb_build_object('keeper', v_prom_k, 'removed', v_prom_r),
      'quizAttempts', jsonb_build_object('keeper', v_quiz_k, 'removed', v_quiz_r, 'conflicts', v_quiz_conf),
      'authorizedPickups', jsonb_build_object('keeper', v_pick_k, 'removed', v_pick_r),
      'releaseLogs', jsonb_build_object('keeper', v_rel_k, 'removed', v_rel_r, 'conflicts', v_rel_conf),
      'reportComments', jsonb_build_object('keeper', v_rep_k, 'removed', v_rep_r, 'conflicts', v_rep_conf),
      'enrollments', jsonb_build_object('keeperOpen', v_open_k, 'removedOpen', v_open_r, 'keeperHistory', v_hist_k, 'removedHistory', v_hist_r),
      'unhandledChildRows', v_child_rows,
      'unhandledChildTables', to_jsonb(v_child_tables)),
    'fingerprint', v_fingerprint,
    'evaluatedAt', now()
  );
END;
$$;

REVOKE ALL ON FUNCTION public._safe_batch_evaluate_pair(TEXT,TEXT,INTEGER,BOOLEAN) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public._safe_batch_evaluate_pair(TEXT,TEXT,INTEGER,BOOLEAN) TO authenticated;

-- ─── 5. Candidate discovery (same grouping rule as get_duplicate_candidates) ─
CREATE OR REPLACE FUNCTION public._safe_batch_candidate_pairs(p_deep BOOLEAN DEFAULT true)
RETURNS TABLE(pair_key TEXT, evaluation JSONB)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE
  r RECORD;
BEGIN
  FOR r IN
    WITH grp AS (
      SELECT public.name_match_key(s.name) AS nkey,
             s."className" AS cls,
             count(*) AS n,
             (array_agg(s.id ORDER BY s."createdAt" NULLS LAST, s.id))[1] AS id1,
             (array_agg(s.id ORDER BY s."createdAt" NULLS LAST, s.id))[2] AS id2
      FROM public.students s
      WHERE s.name IS NOT NULL AND btrim(s.name) <> ''
        AND s."className" IS NOT NULL AND btrim(s."className") <> ''
      GROUP BY 1, 2
      HAVING count(*) >= 2
    )
    SELECT nkey, cls, n, id1, id2 FROM grp ORDER BY cls, nkey
  LOOP
    evaluation := public._safe_batch_evaluate_pair(r.id1, r.id2, r.n::INTEGER, p_deep);
    pair_key := COALESCE(evaluation->>'pairKey', r.id1 || '>' || r.id2);
    RETURN NEXT;
  END LOOP;
END;
$$;

REVOKE ALL ON FUNCTION public._safe_batch_candidate_pairs(BOOLEAN) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public._safe_batch_candidate_pairs(BOOLEAN) TO authenticated;

-- ─── 6. Eligibility report (summary-first, paginated) ───────────────────────
CREATE OR REPLACE FUNCTION public.get_safe_duplicate_batch(
  p_limit INTEGER DEFAULT 50,
  p_offset INTEGER DEFAULT 0,
  p_include_excluded BOOLEAN DEFAULT true
) RETURNS JSONB
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_role TEXT := public.current_profile_role();
  v_t0 TIMESTAMPTZ := clock_timestamp();
  v_t1 TIMESTAMPTZ;
  v_limit INT := GREATEST(1, LEAST(COALESCE(p_limit, 50), 500));
  v_offset INT := GREATEST(0, COALESCE(p_offset, 0));
  v_result JSONB;
BEGIN
  IF v_role IS NULL OR v_role <> 'admin' THEN
    RAISE EXCEPTION 'Only administrators may view the safe duplicate batch.'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  WITH pairs AS MATERIALIZED (
    SELECT pair_key, evaluation FROM public._safe_batch_candidate_pairs(true)
  ),
  flagged AS MATERIALIZED (
    SELECT pair_key,
           evaluation,
           (evaluation->>'eligible')::BOOLEAN AS eligible,
           COALESCE(evaluation->>'severity', 'review') AS severity
    FROM pairs
  ),
  ranked AS MATERIALIZED (
    SELECT pair_key, evaluation, eligible, severity,
           row_number() OVER (
             PARTITION BY eligible
             ORDER BY evaluation->>'className', evaluation->>'studentName',
                      evaluation->'keeper'->>'createdAt', evaluation->>'keeperId'
           ) AS rn
    FROM flagged
  )
  SELECT jsonb_build_object(
    'policy', public.safe_duplicate_batch_policy(),
    'summary', (
      SELECT jsonb_build_object(
        'candidatePairs', count(*),
        'safeCount', count(*) FILTER (WHERE eligible),
        'excludedCount', count(*) FILTER (WHERE NOT eligible),
        'blockedCount', count(*) FILTER (WHERE NOT eligible AND severity = 'blocked'),
        'needsReviewCount', count(*) FILTER (WHERE NOT eligible AND severity = 'review'),
        'studentsToMerge', count(*) FILTER (WHERE eligible),
        'recordsToRemove', count(*) FILTER (WHERE eligible),
        'studentIdsPreserved', count(*) FILTER (WHERE eligible)
      ) FROM ranked
    ),
    'exclusionReasons', (
      SELECT COALESCE(jsonb_object_agg(code, cnt), '{}'::jsonb)
      FROM (
        SELECT code, count(*) AS cnt
        FROM flagged, jsonb_array_elements_text(flagged.evaluation->'exclusionCodes') AS code
        WHERE NOT flagged.eligible
        GROUP BY code
      ) z
    ),
    'rows', (
      SELECT COALESCE(jsonb_agg(evaluation ORDER BY rn), '[]'::jsonb)
      FROM ranked
      WHERE eligible AND rn > v_offset AND rn <= v_offset + v_limit
    ),
    'excludedRows', CASE WHEN COALESCE(p_include_excluded, true) THEN (
      SELECT COALESCE(jsonb_agg(
        jsonb_build_object(
          'pairKey', evaluation->>'pairKey',
          'keeperId', evaluation->>'keeperId',
          'removedId', evaluation->>'removedId',
          'studentName', evaluation->>'studentName',
          'className', evaluation->>'className',
          'severity', severity,
          'exclusionCodes', evaluation->'exclusionCodes',
          'keeper', evaluation->'keeper',
          'removed', evaluation->'removed'
        ) ORDER BY rn), '[]'::jsonb)
      FROM ranked
      WHERE NOT eligible AND rn > v_offset AND rn <= v_offset + v_limit
    ) ELSE '[]'::jsonb END,
    'paging', jsonb_build_object('limit', v_limit, 'offset', v_offset, 'includeExcluded', COALESCE(p_include_excluded, true)),
    'generatedAt', now()
  ) INTO v_result;

  v_t1 := clock_timestamp();
  RETURN v_result || jsonb_build_object(
    'timings', jsonb_build_object('evaluateMs', ROUND(EXTRACT(EPOCH FROM (v_t1 - v_t0)) * 1000)::INT)
  );
END;
$$;

REVOKE ALL ON FUNCTION public.get_safe_duplicate_batch(INTEGER,INTEGER,BOOLEAN) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_safe_duplicate_batch(INTEGER,INTEGER,BOOLEAN) TO authenticated;

-- ─── 7. DRY RUN preview (zero writes) ───────────────────────────────────────
CREATE OR REPLACE FUNCTION public.preview_safe_duplicate_batch(p_limit INTEGER DEFAULT 500)
RETURNS JSONB
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_role TEXT := public.current_profile_role();
  v_t0 TIMESTAMPTZ := clock_timestamp();
  v_limit INT := GREATEST(1, LEAST(COALESCE(p_limit, 500), 2000));
  v_base JSONB;
  v_rows JSONB;
  v_safe INT;
  v_chunk INT := COALESCE((public.safe_duplicate_batch_policy()->'chunkSize'->>'default')::INT, 25);
  v_token TEXT;
  v_assert JSONB;
BEGIN
  IF v_role IS NULL OR v_role <> 'admin' THEN
    RAISE EXCEPTION 'Only administrators may preview the safe duplicate batch.'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  v_base := public.get_safe_duplicate_batch(v_limit, 0, true);
  v_rows := COALESCE(v_base->'rows', '[]'::jsonb);
  v_safe := jsonb_array_length(v_rows);

  -- Verified (not asserted) claims: re-scan the eligible rows for any code that
  -- would make the batch unsafe. An empty set yields true.
  SELECT jsonb_build_object(
    'noGovIdConflicts', COALESCE(bool_and(NOT (r->'exclusionCodes' ?| ARRAY['gov_id_conflict','gov_id_belongs_to_third_student'])), true),
    'noParentConflicts', COALESCE(bool_and(NOT (r->'exclusionCodes' ?| ARRAY['both_parents_assigned','parent_conflict','both_parents_unassigned','parent_profile_missing'])), true),
    'noPhoneConflicts', COALESCE(bool_and(NOT (r->'exclusionCodes' ?| ARRAY['parent_phone_conflict','parent_phone_only_on_unassigned'])), true),
    'noTransportConflicts', COALESCE(bool_and(NOT (r->'exclusionCodes' ?| ARRAY['transport_conflict','transport_only_on_unassigned'])), true),
    'noClassConflicts', COALESCE(bool_and(NOT (r->'exclusionCodes' ?| ARRAY['class_conflict','enrollment_class_conflict'])), true),
    'noExamConflicts', COALESCE(bool_and(NOT (r->'exclusionCodes' ?| ARRAY['exam_conflict'])), true),
    'noAttendanceConflicts', COALESCE(bool_and(NOT (r->'exclusionCodes' ?| ARRAY['attendance_conflict'])), true),
    'noQuizConflicts', COALESCE(bool_and(NOT (r->'exclusionCodes' ?| ARRAY['quiz_conflict'])), true),
    'noReleaseConflicts', COALESCE(bool_and(NOT (r->'exclusionCodes' ?| ARRAY['release_conflict'])), true),
    'noReportConflicts', COALESCE(bool_and(NOT (r->'exclusionCodes' ?| ARRAY['report_comment_conflict'])), true),
    'noEnrollmentConflicts', COALESCE(bool_and(NOT (r->'exclusionCodes' ?| ARRAY['multiple_open_enrollments','no_open_enrollment','enrollment_year_conflict'])), true),
    'noUnhandledChildDependencies', COALESCE(bool_and(NOT (r->'exclusionCodes' ?| ARRAY['unhandled_child_dependency'])), true),
    'everyKeeperIsParentAssigned', COALESCE(bool_and((r->>'keeperIsParentAssigned')::BOOLEAN), true),
    'everyRemovedIsUnassigned', COALESCE(bool_and((r->'removed'->>'parentId') IS NULL), true)
  ) INTO v_assert
  FROM jsonb_array_elements(v_rows) AS r;

  SELECT md5(COALESCE(string_agg((x->>'pairKey') || ':' || COALESCE(x->>'fingerprint',''), '|' ORDER BY x->>'pairKey'), ''))
    INTO v_token
  FROM jsonb_array_elements(v_rows) AS x;

  RETURN v_base || jsonb_build_object(
    'dryRun', true,
    'writesPerformed', 0,
    'batchId', 'batch-' || floor(extract(epoch FROM clock_timestamp()) * 1000)::TEXT || '-' || substr(md5(random()::TEXT), 1, 8),
    'previewToken', v_token,
    'ready', jsonb_build_object(
      'studentsToMerge', v_safe,
      'recordsToBeRemoved', v_safe,
      'studentIdsPreserved', v_safe),
    'chunkPlan', jsonb_build_object(
      'chunkSize', v_chunk,
      'chunks', CASE WHEN v_safe = 0 THEN 0 ELSE CEIL(v_safe::NUMERIC / v_chunk)::INT END,
      'atomicPerChunk', true,
      'strategy', 'One RPC call = one chunk = one atomic transaction. The client asks for the next chunk; the server recomputes eligibility every time.'),
    'assertions', v_assert,
    'confirmPhrase', public.safe_duplicate_batch_policy()->>'confirmPhrase',
    'timings', (v_base->'timings') || jsonb_build_object('previewMs', ROUND(EXTRACT(EPOCH FROM (clock_timestamp() - v_t0)) * 1000)::INT)
  );
END;
$$;

REVOKE ALL ON FUNCTION public.preview_safe_duplicate_batch(INTEGER) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.preview_safe_duplicate_batch(INTEGER) TO authenticated;

-- ─── 8. Execution: one atomic chunk per call ────────────────────────────────
--  1. verify admin authorization
--  2. require the typed confirmation phrase (server-side)
--  3. RECOMPUTE eligibility from live rows — a client list is advisory only and
--     can narrow the scope, never widen it
--  4. lock each pair deterministically (ordered by Student ID)
--  5. revalidate after locking; refuse anything stale or no longer eligible
--  6. apply the EXISTING safe merge logic (merge_duplicate_students_resolved)
--  7. preserve the keeper's stored profile bytes (the batch policy never
--     rewrites a value it promised to keep)
--  8. stamp batch metadata onto that merge's own audit row
--  9. verify invariants (done inside the reused RPC) and delete the duplicate
-- 10. return a per-pair result: merged / skipped / blocked
CREATE OR REPLACE FUNCTION public.merge_safe_duplicate_batch(
  p_pairs JSONB DEFAULT NULL,
  p_chunk_size INTEGER DEFAULT 25,
  p_confirm_phrase TEXT DEFAULT NULL,
  p_reason TEXT DEFAULT NULL,
  p_batch_id TEXT DEFAULT NULL
) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_role TEXT := public.current_profile_role();
  v_actor TEXT := public.current_profile_id();
  v_policy JSONB := public.safe_duplicate_batch_policy();
  v_started TIMESTAMPTZ := clock_timestamp();
  v_chunk INT;
  v_batch TEXT;
  v_reason TEXT;
  v_req_keys TEXT[] := NULL;
  v_req_fps TEXT[] := NULL;
  v_eligible JSONB := '[]'::jsonb;
  v_eligible_keys TEXT[] := ARRAY[]::TEXT[];
  v_ineligible JSONB := '{}'::jsonb;
  v_total_eligible INT := 0;
  v_examined INT := 0;
  v_max_examine INT;
  v_n_merged INT := 0; v_n_skipped INT := 0; v_n_blocked INT := 0;
  v_merged JSONB := '[]'::jsonb;
  v_skipped JSONB := '[]'::jsonb;
  v_blocked JSONB := '[]'::jsonb;
  v_remaining INT := 0;
  v_seen_keys TEXT[] := ARRAY[]::TEXT[];
  i INT;
  v_item JSONB;
  v_eval JSONB;
  v_prev_eval JSONB;
  v_pair_key TEXT;
  v_keeper_id TEXT; v_removed_id TEXT;
  v_keeper public.students%ROWTYPE;
  v_removed public.students%ROWTYPE;
  v_found_keeper BOOLEAN;
  v_found_removed BOOLEAN;
  v_group_size INT;
  v_res JSONB;
  v_audit TEXT;
  v_expected_gov TEXT;
  v_expected_phone TEXT;
  v_fp TEXT;
  v_merge_reason TEXT;
  v_ids TEXT[];
  v_keeper_exists BOOLEAN;
  v_removed_exists BOOLEAN;
BEGIN
  -- 1. Authorization -------------------------------------------------------
  IF v_role IS NULL OR v_role <> 'admin' THEN
    RAISE EXCEPTION 'Only administrators may run the safe duplicate batch merge.'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  -- 2. Typed confirmation (server-enforced; one accidental click is not enough)
  IF upper(btrim(COALESCE(p_confirm_phrase, ''))) <> 'MERGE SAFE DUPLICATES' THEN
    RAISE EXCEPTION 'Batch confirmation phrase required: type MERGE SAFE DUPLICATES to run the safe batch merge.'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  -- Chunk size: 25 merges per atomic transaction by default, hard max 50.
  v_chunk := GREATEST(1, LEAST(COALESCE(p_chunk_size, 25), 50));
  v_max_examine := v_chunk * 20;

  v_batch := NULLIF(btrim(COALESCE(p_batch_id, '')), '');
  IF v_batch IS NULL THEN
    v_batch := 'batch-' || floor(extract(epoch FROM clock_timestamp()) * 1000)::TEXT || '-' || substr(md5(random()::TEXT), 1, 8);
  END IF;
  IF length(v_batch) > 100 THEN
    RAISE EXCEPTION 'Batch id must be 100 characters or fewer.' USING ERRCODE = 'invalid_parameter_value';
  END IF;

  v_reason := NULLIF(btrim(COALESCE(p_reason, '')), '');

  -- 3. Advisory reviewed list — may only NARROW the scope -------------------
  -- The server never merges a pair just because the client listed it.
  IF p_pairs IS NOT NULL THEN
    IF jsonb_typeof(p_pairs) <> 'array' THEN
      RAISE EXCEPTION 'p_pairs must be a JSON array of reviewed pairs.' USING ERRCODE = 'invalid_parameter_value';
    END IF;
    IF jsonb_array_length(p_pairs) > 5000 THEN
      RAISE EXCEPTION 'Too many pairs in one batch request (max 5000).' USING ERRCODE = 'program_limit_exceeded';
    END IF;
    -- A malformed entry (missing keeperId/removedId — e.g. a raw "delete this
    -- student" request) must never widen the scope of the batch. Reject it.
    IF EXISTS (
      SELECT 1 FROM jsonb_array_elements(p_pairs) AS x
       WHERE jsonb_typeof(x) <> 'object'
          OR NULLIF(btrim(COALESCE(x->>'keeperId', '')), '') IS NULL
          OR NULLIF(btrim(COALESCE(x->>'removedId', '')), '') IS NULL
    ) THEN
      RAISE EXCEPTION
        'Every reviewed pair must provide both keeperId and removedId. The safe batch never accepts a bare student id or a delete request.'
        USING ERRCODE = 'invalid_parameter_value';
    END IF;
    -- Defense in depth: keys and fingerprints stay index-aligned and NULL-free,
    -- so a NULL key can never turn the advisory filter into "everything".
    SELECT COALESCE(array_agg(s.k), ARRAY[]::TEXT[]),
           COALESCE(array_agg(s.fp), ARRAY[]::TEXT[])
      INTO v_req_keys, v_req_fps
    FROM (
      SELECT NULLIF(btrim(x->>'keeperId'), '') || '>' || NULLIF(btrim(x->>'removedId'), '') AS k,
             NULLIF(btrim(x->>'fingerprint'), '') AS fp
      FROM jsonb_array_elements(p_pairs) AS x
    ) AS s
    WHERE s.k IS NOT NULL;
  END IF;

  -- 4. RECOMPUTE eligibility from live rows (one scan for this chunk) -------
  WITH cand AS MATERIALIZED (
    SELECT p.pair_key, p.evaluation, (p.evaluation->>'eligible')::BOOLEAN AS eligible
    FROM public._safe_batch_candidate_pairs(true) AS p
  )
  SELECT
    COALESCE(jsonb_agg(
      jsonb_build_object('pairKey', c.pair_key, 'evaluation', c.evaluation)
      ORDER BY c.evaluation->>'className', c.evaluation->>'studentName',
               c.evaluation->'keeper'->>'createdAt', c.pair_key)
      FILTER (WHERE c.eligible), '[]'::jsonb),
    COALESCE(jsonb_object_agg(c.pair_key, jsonb_build_object(
        'pairKey', c.pair_key,
        'keeperId', c.evaluation->>'keeperId',
        'removedId', c.evaluation->>'removedId',
        'studentName', c.evaluation->>'studentName',
        'className', c.evaluation->>'className',
        'severity', c.evaluation->>'severity',
        'exclusionCodes', c.evaluation->'exclusionCodes'))
      FILTER (WHERE NOT c.eligible), '{}'::jsonb),
    count(*) FILTER (WHERE c.eligible AND (v_req_keys IS NULL OR c.pair_key = ANY (v_req_keys)))
    INTO v_eligible, v_ineligible, v_total_eligible
  FROM cand c;

  SELECT COALESCE(array_agg(x->>'pairKey'), ARRAY[]::TEXT[])
    INTO v_eligible_keys
  FROM jsonb_array_elements(v_eligible) AS x;

  -- 5. Walk the eligible queue in deterministic order — ONE chunk only ------
  FOR i IN 0 .. jsonb_array_length(v_eligible) - 1 LOOP
    EXIT WHEN v_n_merged >= v_chunk OR v_examined >= v_max_examine;
    v_item := v_eligible->i;
    v_prev_eval := v_item->'evaluation';
    v_keeper_id := v_prev_eval->>'keeperId';
    v_removed_id := v_prev_eval->>'removedId';
    v_pair_key := v_keeper_id || '>' || v_removed_id;

    IF v_req_keys IS NOT NULL AND NOT (v_pair_key = ANY (v_req_keys)) THEN
      CONTINUE;  -- not part of the reviewed batch: never touched, never counted
    END IF;

    v_examined := v_examined + 1;
    v_seen_keys := array_append(v_seen_keys, v_pair_key);

    -- 5a. Stale preview guard (fingerprint the administrator actually reviewed)
    IF v_req_keys IS NOT NULL THEN
      v_fp := v_req_fps[array_position(v_req_keys, v_pair_key)];
      IF v_fp IS NOT NULL AND v_fp <> '' AND v_fp IS DISTINCT FROM (v_prev_eval->>'fingerprint') THEN
        v_skipped := v_skipped || jsonb_build_object(
          'pairKey', v_pair_key, 'keeperId', v_keeper_id, 'removedId', v_removed_id,
          'studentName', v_prev_eval->>'studentName', 'className', v_prev_eval->>'className',
          'reason', 'candidate_changed_since_preview',
          'codes', to_jsonb(ARRAY['candidate_changed_since_preview']::TEXT[]));
        v_n_skipped := v_n_skipped + 1;
        CONTINUE;
      END IF;
    END IF;

    -- 5b. Lock both rows in deterministic (Student ID) order — same order the
    --     individual merge RPCs use, so a batch and a single review cannot
    --     deadlock each other.
    IF v_keeper_id < v_removed_id THEN
      SELECT * INTO v_keeper FROM public.students WHERE id = v_keeper_id FOR UPDATE;
      v_found_keeper := FOUND;
      SELECT * INTO v_removed FROM public.students WHERE id = v_removed_id FOR UPDATE;
      v_found_removed := FOUND;
    ELSE
      SELECT * INTO v_removed FROM public.students WHERE id = v_removed_id FOR UPDATE;
      v_found_removed := FOUND;
      SELECT * INTO v_keeper FROM public.students WHERE id = v_keeper_id FOR UPDATE;
      v_found_keeper := FOUND;
    END IF;

    IF NOT COALESCE(v_found_keeper, false) OR NOT COALESCE(v_found_removed, false) THEN
      v_skipped := v_skipped || jsonb_build_object(
        'pairKey', v_pair_key, 'keeperId', v_keeper_id, 'removedId', v_removed_id,
        'reason', 'already_resolved',
        'codes', to_jsonb(ARRAY['already_resolved']::TEXT[]));
      v_n_skipped := v_n_skipped + 1;
      CONTINUE;
    END IF;

    -- 5c. Revalidate against the CURRENT database state, after locking ------
    SELECT count(*) INTO v_group_size
    FROM public.students s
    WHERE public.name_match_key(s.name) = public.name_match_key(v_keeper.name)
      AND s."className" = v_keeper."className";

    v_eval := public._safe_batch_evaluate_pair(v_keeper_id, v_removed_id, v_group_size, true);

    IF (v_eval->>'fingerprint') IS DISTINCT FROM (v_prev_eval->>'fingerprint') THEN
      v_skipped := v_skipped || jsonb_build_object(
        'pairKey', v_pair_key, 'keeperId', v_keeper_id, 'removedId', v_removed_id,
        'studentName', v_eval->>'studentName', 'className', v_eval->>'className',
        'reason', 'candidate_changed_during_batch',
        'codes', to_jsonb(ARRAY['candidate_changed_during_batch']::TEXT[]));
      v_n_skipped := v_n_skipped + 1;
      CONTINUE;
    END IF;

    IF NOT COALESCE((v_eval->>'eligible')::BOOLEAN, false) THEN
      v_blocked := v_blocked || jsonb_build_object(
        'pairKey', v_pair_key, 'keeperId', v_keeper_id, 'removedId', v_removed_id,
        'studentName', v_eval->>'studentName', 'className', v_eval->>'className',
        'reason', 'no_longer_eligible', 'severity', v_eval->>'severity',
        'codes', v_eval->'exclusionCodes');
      v_n_blocked := v_n_blocked + 1;
      CONTINUE;
    END IF;

    -- 5d. Apply the EXISTING safe merge logic ------------------------------
    v_expected_gov := CASE
      WHEN btrim(COALESCE(v_keeper."govId", '')) <> '' THEN v_keeper."govId"
      ELSE v_removed."govId" END;
    v_expected_phone := v_keeper."parentPhone";
    v_merge_reason := 'Safe batch merge (' || v_batch || '): kept the parent-assigned record '
      || v_keeper_id || ', merged the unassigned duplicate ' || v_removed_id
      || '. Policy: ' || COALESCE(v_policy->>'policyId', 'safe_batch')
      || CASE WHEN v_reason IS NULL THEN '' ELSE '. Administrator note: ' || v_reason END;

    BEGIN
      v_res := public.merge_duplicate_students_resolved(
        v_keeper_id, v_removed_id,
        COALESCE(v_eval->'resolution'->'mergeResolution', '{}'::jsonb),
        v_merge_reason);

      v_audit := v_res->>'auditId';

      -- The batch policy never rewrites a keeper value it promised to keep.
      -- The shared RPC stores Gov ID / phone in normalized form; restore the
      -- keeper's own bytes (identical normalized key ⇒ same unique index entry).
      UPDATE public.students
         SET "govId" = v_expected_gov,
             "parentPhone" = v_expected_phone
       WHERE id = v_keeper_id
         AND ("govId" IS DISTINCT FROM v_expected_gov
              OR "parentPhone" IS DISTINCT FROM v_expected_phone);

      -- Batch provenance on THIS merge's own audit row (per-student traceability)
      UPDATE public.student_merge_audits
         SET batch_id = v_batch,
             batch_policy = v_policy->>'policyId',
             batch_size = v_chunk,
             merge_kind = 'safe_batch'
       WHERE id = v_audit;

      v_merged := v_merged || jsonb_build_object(
        'pairKey', v_pair_key,
        'keeperId', v_keeper_id,
        'removedId', v_removed_id,
        'studentName', v_eval->>'studentName',
        'className', v_eval->>'className',
        'auditId', v_audit,
        'preservedStudentId', v_keeper_id,
        'removedStudentId', v_removed_id,
        'enrollmentAction', v_res->'enrollmentAction',
        'before', v_res->'before',
        'after', v_res->'after');
      v_n_merged := v_n_merged + 1;
    EXCEPTION WHEN OTHERS THEN
      -- No silent continuation: the whole chunk rolls back, naming the pair.
      RAISE EXCEPTION
        'SAFE BATCH CHUNK ABORTED on pair % -> % (%): %. The entire chunk rolled back; no student was modified by this chunk.',
        v_keeper_id, v_removed_id, COALESCE(v_eval->>'studentName', ''), SQLERRM
        USING ERRCODE = 'integrity_constraint_violation';
    END;
  END LOOP;

  -- 6. Report requested pairs the server refuses to merge -------------------
  IF v_req_keys IS NOT NULL THEN
    FOR i IN 1 .. COALESCE(array_length(v_req_keys, 1), 0) LOOP
      IF v_req_keys[i] IS NULL THEN CONTINUE; END IF;
      IF v_req_keys[i] = ANY (v_seen_keys) THEN CONTINUE; END IF;        -- reported above
      IF v_req_keys[i] = ANY (v_eligible_keys) THEN CONTINUE; END IF;    -- queued for a later chunk
      v_ids := string_to_array(v_req_keys[i], '>');
      -- Already merged by an earlier chunk of THIS batch → nothing to report.
      IF array_length(v_ids, 1) = 2 AND EXISTS (
           SELECT 1 FROM public.student_merge_audits a
            WHERE a.batch_id = v_batch
              AND ((a.canonical_id = v_ids[1] AND a.duplicate_id = v_ids[2])
                OR (a.canonical_id = v_ids[2] AND a.duplicate_id = v_ids[1]))) THEN
        CONTINUE;
      END IF;
      IF v_ineligible ? v_req_keys[i] THEN
        v_blocked := v_blocked || ((v_ineligible->v_req_keys[i]) || jsonb_build_object(
          'reason', 'not_eligible_server_side',
          'codes', COALESCE(v_ineligible->v_req_keys[i]->'exclusionCodes', '[]'::jsonb)
                   || to_jsonb(ARRAY['not_eligible_server_side']::TEXT[])));
        v_n_blocked := v_n_blocked + 1;
      ELSIF array_length(v_ids, 1) = 2 THEN
        SELECT EXISTS (SELECT 1 FROM public.students WHERE id = v_ids[1]),
               EXISTS (SELECT 1 FROM public.students WHERE id = v_ids[2])
          INTO v_keeper_exists, v_removed_exists;
        IF v_keeper_exists AND NOT v_removed_exists THEN
          -- The duplicate record is gone: another administrator (or an earlier
          -- chunk of this batch) already resolved the pair. Safe, reported no-op.
          v_skipped := v_skipped || jsonb_build_object(
            'pairKey', v_req_keys[i], 'keeperId', v_ids[1], 'removedId', v_ids[2],
            'reason', 'already_resolved',
            'codes', to_jsonb(ARRAY['already_resolved']::TEXT[]));
          v_n_skipped := v_n_skipped + 1;
        ELSE
          -- Both ids unknown, or two real students the server never paired:
          -- a client-invented pair. Refused, never merged, never deleted.
          v_blocked := v_blocked || jsonb_build_object(
            'pairKey', v_req_keys[i], 'reason', 'not_a_candidate',
            'codes', to_jsonb(ARRAY['not_a_candidate']::TEXT[]));
          v_n_blocked := v_n_blocked + 1;
        END IF;
      ELSE
        v_blocked := v_blocked || jsonb_build_object(
          'pairKey', v_req_keys[i], 'reason', 'not_a_candidate',
          'codes', to_jsonb(ARRAY['not_a_candidate']::TEXT[]));
        v_n_blocked := v_n_blocked + 1;
      END IF;
    END LOOP;
  END IF;

  v_remaining := GREATEST(0, v_total_eligible - v_examined);

  -- 7. Batch metadata + chunk audit ----------------------------------------
  INSERT INTO public.student_merge_batches
    (id, admin_id, policy, chunk_size, chunks_run, reason, requested_pairs,
     merged_count, skipped_count, blocked_count, failed_count, remaining_eligible,
     chunk_results, created_at, updated_at)
  VALUES
    (v_batch, v_actor, COALESCE(v_policy->>'policyId', 'safe_batch'), v_chunk, 1, v_reason,
     COALESCE(jsonb_array_length(p_pairs), 0),
     v_n_merged, v_n_skipped, v_n_blocked, 0, v_remaining,
     jsonb_build_array(jsonb_build_object(
       'chunkSize', v_chunk, 'merged', v_merged, 'skipped', v_skipped, 'blocked', v_blocked,
       'startedAt', v_started, 'completedAt', now())),
     NOW(), NOW())
  ON CONFLICT (id) DO UPDATE SET
    chunks_run = public.student_merge_batches.chunks_run + 1,
    merged_count = public.student_merge_batches.merged_count + EXCLUDED.merged_count,
    skipped_count = public.student_merge_batches.skipped_count + EXCLUDED.skipped_count,
    blocked_count = public.student_merge_batches.blocked_count + EXCLUDED.blocked_count,
    remaining_eligible = EXCLUDED.remaining_eligible,
    chunk_results = public.student_merge_batches.chunk_results || EXCLUDED.chunk_results,
    updated_at = NOW();

  INSERT INTO public.audit_logs (action, details, "createdAt")
  VALUES ('students.merge_batch', jsonb_build_object(
    'batchId', v_batch, 'actor', v_actor, 'policy', v_policy->>'policyId',
    'chunkSize', v_chunk, 'reason', v_reason,
    'merged', v_n_merged, 'skipped', v_n_skipped, 'blocked', v_n_blocked, 'failed', 0,
    'remainingEligible', v_remaining,
    'preservedStudentIds', (SELECT COALESCE(jsonb_agg(m->>'preservedStudentId'), '[]'::jsonb) FROM jsonb_array_elements(v_merged) AS m),
    'removedStudentIds', (SELECT COALESCE(jsonb_agg(m->>'removedStudentId'), '[]'::jsonb) FROM jsonb_array_elements(v_merged) AS m),
    'auditIds', (SELECT COALESCE(jsonb_agg(m->>'auditId'), '[]'::jsonb) FROM jsonb_array_elements(v_merged) AS m)), NOW());

  RETURN jsonb_build_object(
    'batchId', v_batch,
    'adminId', v_actor,
    'policy', v_policy->>'policyId',
    'policyDetail', v_policy,
    'chunkSize', v_chunk,
    'atomicChunk', true,
    'committed', true,
    'merged', v_merged,
    'skipped', v_skipped,
    'blocked', v_blocked,
    'failed', '[]'::jsonb,
    'totals', jsonb_build_object(
      'eligibleAtStart', v_total_eligible,
      'examined', v_examined,
      'merged', v_n_merged,
      'skipped', v_n_skipped,
      'blocked', v_n_blocked,
      'failed', 0,
      'remaining', v_remaining),
    'invariants', v_policy->'invariants',
    'durationMs', ROUND(EXTRACT(EPOCH FROM (clock_timestamp() - v_started)) * 1000)::INT,
    'startedAt', v_started,
    'completedAt', now()
  );
END;
$$;

REVOKE ALL ON FUNCTION public.merge_safe_duplicate_batch(JSONB,INTEGER,TEXT,TEXT,TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.merge_safe_duplicate_batch(JSONB,INTEGER,TEXT,TEXT,TEXT) TO authenticated;

-- ─── 9. Grants consistency (matches 20260922 style) ─────────────────────────
DO $$
DECLARE f TEXT;
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    FOREACH f IN ARRAY ARRAY[
      'public.safe_duplicate_batch_policy()',
      'public._safe_batch_unhandled_child_rows(TEXT)',
      'public._safe_batch_evaluate_pair(TEXT,TEXT,INTEGER,BOOLEAN)',
      'public._safe_batch_candidate_pairs(BOOLEAN)',
      'public.get_safe_duplicate_batch(INTEGER,INTEGER,BOOLEAN)',
      'public.preview_safe_duplicate_batch(INTEGER)',
      'public.merge_safe_duplicate_batch(JSONB,INTEGER,TEXT,TEXT,TEXT)'
    ] LOOP
      EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', f);
      EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO authenticated', f);
    END LOOP;
  END IF;
END $$;
