-- ============================================================================
-- SAFE DUPLICATE BATCH — true conflict vs one-sided missing data
--
-- PROBLEM. safe_duplicate_batch_policy() v1 treated "only the unassigned record
-- has a parent phone / transport / family ID" as an exclusion (Needs Review).
-- That conflated two different things:
--
--   * a TRUE CONFLICT  — both records populated with DIFFERENT values, which an
--                        administrator must arbitrate            → still BLOCKED
--   * ONE-SIDED DATA   — the keeper is blank and the duplicate holds the only
--                        value, which is exactly the data a merge exists to
--                        preserve                                → now TRANSFERRED
--
-- POLICY. Safe union, applied field by field:
--   keeper has value                       → preserve
--   both identical                         → keep one
--   keeper blank + duplicate has value     → TRANSFER to the keeper
--   both populated and different           → BLOCK (a real conflict)
--   both blank                             → nothing to do
--
-- Consolidation is NEVER the basis for a merge. The pair must already satisfy
-- every strong duplicate-identity condition in v1 (normalized-identical name,
-- identical class, exactly one parent-assigned keeper, no unhandled child rows,
-- no history conflict, ≤2 records in the group). This migration only changes how
-- one-sided NULLABLE PROFILE FIELDS are classified once those hold.
--
-- PER-FIELD GUARDS — no value is ever copied merely because it is present:
--   parentPhone  transferred only if no OTHER student already uses that
--                normalized phone under a DIFFERENT parent. The school's own
--                family key (20260819) is 'p:'||parentId falling back to
--                't:'||normalize_phone(parentPhone), so such a phone belongs to
--                another family and copying it would fuse two families
--                → parent_phone_belongs_to_other_family (BLOCKED).
--   transport    students.transport is a SCALAR (students_transport_check:
--                WALKER | CAR | LEFT | bus number) with no relational children;
--                the real driver↔student link is authorized_pickup_students,
--                which merge_duplicate_students_resolved() already moves with
--                ON CONFLICT DO NOTHING. So copying the scalar is the complete
--                preservation. WALKER vs bus 9 is still a conflict → BLOCKED.
--   familyId     MOST CONSERVATIVE. There is no families table — familyId is a
--                TEXT column on students (20260802_office_role.sql), grouped by
--                the family key above under the invariant "one family key → one
--                family ID for the lifetime of the key" (20260819). Transfer is
--                allowed ONLY when a sibling already assigned to the KEEPER'S OWN
--                PARENT holds exactly that family id, i.e. the database proves
--                the keeper joins a family it demonstrably belongs to. If the
--                keeper's parent already belongs to a DIFFERENT family id it is
--                a conflict → BLOCKED. Otherwise it is simply unprovable
--                → family_id_transfer_unproven (individual review). A family
--                relationship is never replaced on a guess.
--   govId        unchanged from v1: transferred when the keeper is blank and no
--                third student owns it (gov_id_from_removed_preserved), now also
--                recorded in transferred_fields.
--
-- DATA PRESERVATION. Every value copied off the removed record is recorded in
-- student_merge_audits.transferred_fields (plus field_states for the full
-- classification), so "nothing was lost" is answerable from the audit alone.
-- merge_safe_duplicate_batch() is corrected to expect the TRANSFERRED value in
-- its post-merge restoration step — previously it force-restored the keeper's
-- original phone, which would have silently undone any transfer.
--
-- Unchanged: admin guard, confirm phrase, advisory lock, per-row SELECT FOR
-- UPDATE, fingerprint re-check, atomic transaction, shared merge RPC,
-- transactional verification, per-student audit, REVOKE FROM PUBLIC.
-- ============================================================================

-- ── Audit columns for the transferred-field record ──────────────────────────
ALTER TABLE public.student_merge_audits ADD COLUMN IF NOT EXISTS transferred_fields JSONB;
ALTER TABLE public.student_merge_audits ADD COLUMN IF NOT EXISTS field_states JSONB;

CREATE OR REPLACE FUNCTION public.safe_duplicate_batch_policy()
RETURNS JSONB
LANGUAGE sql IMMUTABLE SET search_path = public AS $$
  SELECT jsonb_build_object(
    'policyId', 'safe_batch_parent_assigned_keeper',
    'version', 2,
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
      'parentPhone', 'safe union: keeper value wins; a phone only on the duplicate is transferred to the keeper when no other family uses it; two different non-empty phones BLOCK',
      'transport', 'safe union: keeper value wins; a transport only on the duplicate is transferred; two different non-empty transports BLOCK',
      'familyId', 'safe union, most conservative: same id keeps one; a family id only on the duplicate is transferred ONLY when the keeper''s parent provably already owns that id on a sibling; a different family id, or an unprovable one, BLOCKS or goes to review — never guessed',
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
      'parent_phone_conflict', 'Parent phone conflict — two different non-empty numbers; a human must choose',
      'parent_phone_belongs_to_other_family', 'The phone on the duplicate already belongs to a DIFFERENT parent''s family — copying it would fuse two families',
      'transport_conflict', 'Transport conflict — two different non-empty values; a human must choose',
      'family_id_conflict', 'Family ID conflict — the two records, or the keeper''s parent''s siblings, already carry a different family ID',
      'family_id_transfer_unproven', 'Only the duplicate has a family ID and the database cannot prove the keeper belongs to that family — individual review, never guessed',
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
      'parent_phone_conflict','parent_phone_belongs_to_other_family','transport_conflict',
      'family_id_conflict','student_missing',
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
    'fieldConsolidation', jsonb_build_object(
      'ruleEn', 'Safe union: keeper value → preserve; only keeper → preserve; only duplicate → transfer; identical → keep one; different → block. Missing data on one side is never treated as a conflict.',
      'ruleAr', 'الاتحاد الآمن: قيمة السجل المحتفظ به تُحفظ، والقيمة الموجودة في السجل المكرر فقط تُنقل، والمتطابقة يُحتفظ بواحدة، والمختلفة تُمنع. نقص البيانات في طرف واحد لا يُعتبر تعارضًا.',
      'precondition', 'Consolidation is NEVER the basis for a merge. Strong duplicate identity from the authoritative policy (normalized name + class, one parent-assigned keeper, no history conflict) is still required first.',
      'auditedBy', 'student_merge_audits.transferred_fields + .field_states — every value copied off the removed record is recorded with its field name'
    ),
    'invariants', jsonb_build_array(
      'keeper: exactly 1 open enrollment after the merge',
      'removed record: 0 open enrollments and 0 remaining rows before deletion',
      'removed record: deleted only after zero-dependency verification',
      'kept Student ID: unchanged and preserved'
    )
  );
$$;

CREATE OR REPLACE FUNCTION public._safe_batch_evaluate_pair(
  p_a_id TEXT,
  p_b_id TEXT,
  p_group_size INTEGER DEFAULT 2,
  p_deep BOOLEAN DEFAULT true
) RETURNS JSONB
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_role TEXT := public.current_profile_role();
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
  v_phone_third INT := 0;
  v_family_sibling INT := 0;
  v_family_other INT := 0;
  -- Safe-union bookkeeping. `transfers` records every value that will be COPIED
  -- from the removed record onto the keeper; `fieldStates` records how each
  -- nullable profile field was classified. Both land in the merge audit, so a
  -- transferred value is never an invisible side effect.
  v_transfer JSONB := '{}'::jsonb;
  v_field_states JSONB := '{}'::jsonb;
  v_group_size INT := COALESCE(p_group_size, 2);
  v_deep_eval BOOLEAN := COALESCE(p_deep, true);
  v_eligible BOOLEAN;
  v_fingerprint TEXT := NULL;
  v_class TEXT;
BEGIN
  -- 0. Authorization — the SAME guard the batch RPCs use (existing pattern).
  --    The evaluation JSONB carries Gov IDs, parent phones, family ids and both
  --    parent profiles for ANY two student ids, so it must never run for a
  --    non-admin caller. The SECURITY DEFINER batch RPCs (get / preview / merge)
  --    authorize the administrator first and then call this helper, so the
  --    shipped batch flow is unchanged.
  IF v_role IS NULL OR v_role <> 'admin' THEN
    RAISE EXCEPTION 'Only administrators may evaluate safe batch duplicate pairs.'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

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
    v_field_states := v_field_states || jsonb_build_object(
      'govId', jsonb_build_object('state','identical','action','keep'));
  ELSIF v_gk_k <> '' AND v_gk_r <> '' THEN
    v_codes := array_append(v_codes, 'gov_id_conflict'); v_blocked := true;
    v_field_states := v_field_states || jsonb_build_object(
      'govId', jsonb_build_object('state','conflict','action','block'));
  ELSIF v_gk_k <> '' THEN
    v_ok := array_append(v_ok, 'gov_id_keeper_only');
    v_gov_choice := 'canonical';
    v_field_states := v_field_states || jsonb_build_object(
      'govId', jsonb_build_object('state','keeper_only','action','keep'));
  ELSIF v_gk_r <> '' THEN
    -- Preserve the only recorded Gov ID by moving it onto the keeper through
    -- the existing validated resolution ('duplicate' choice) — never discard it.
    -- Safe because the third-student uniqueness check below still runs.
    v_ok := array_append(v_ok, 'gov_id_from_removed_preserved');
    v_gov_choice := 'duplicate';
    v_transfer := v_transfer || jsonb_build_object('govId', v_removed."govId");
    v_field_states := v_field_states || jsonb_build_object(
      'govId', jsonb_build_object('state','duplicate_only','action','transfer',
                                  'value', v_removed."govId"));
  ELSE
    v_ok := array_append(v_ok, 'no_gov_id');
    v_gov_choice := 'canonical';
    v_field_states := v_field_states || jsonb_build_object(
      'govId', jsonb_build_object('state','both_blank','action','keep'));
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

  -- ── Parent phone: true conflict vs one-sided missing data ────────────────
  -- A value present on only ONE record is NOT a conflict; two DIFFERENT
  -- non-empty values are. A one-sided phone is carried onto the keeper, but
  -- never blindly: the school's own family key (20260819) is the parent id and
  -- falls back to the normalized phone, so a phone already used by a DIFFERENT
  -- parent is a real collision — copying it would fuse two families. The same
  -- phone on a sibling of the same parent is corroboration, not a conflict.
  v_ph_k := COALESCE(public.normalize_phone(v_keeper."parentPhone"), '');
  v_ph_r := COALESCE(public.normalize_phone(v_removed."parentPhone"), '');
  IF v_ph_k <> '' AND v_ph_r <> '' AND v_ph_k = v_ph_r THEN
    v_ok := array_append(v_ok, 'same_parent_phone');
    v_field_states := v_field_states || jsonb_build_object(
      'parentPhone', jsonb_build_object('state','identical','action','keep'));
  ELSIF v_ph_k <> '' AND v_ph_r <> '' THEN
    v_codes := array_append(v_codes, 'parent_phone_conflict'); v_blocked := true;
    v_field_states := v_field_states || jsonb_build_object(
      'parentPhone', jsonb_build_object('state','conflict','action','block',
                                        'keeper', v_keeper."parentPhone",
                                        'removed', v_removed."parentPhone"));
  ELSIF v_ph_k <> '' THEN
    v_ok := array_append(v_ok, 'parent_phone_keeper_only');
    v_field_states := v_field_states || jsonb_build_object(
      'parentPhone', jsonb_build_object('state','keeper_only','action','keep'));
  ELSIF v_ph_r <> '' THEN
    SELECT count(*) INTO v_phone_third
    FROM public.students s
    WHERE s.id <> v_keeper_id AND s.id <> v_removed_id
      AND public.normalize_phone(s."parentPhone") = v_ph_r
      AND s."parentId" IS NOT NULL
      AND s."parentId" IS DISTINCT FROM v_keeper."parentId";
    IF COALESCE(v_phone_third, 0) > 0 THEN
      -- This phone already belongs to another parent's family. Copying it onto
      -- the keeper would silently merge two distinct families.
      v_codes := array_append(v_codes, 'parent_phone_belongs_to_other_family'); v_blocked := true;
      v_field_states := v_field_states || jsonb_build_object(
        'parentPhone', jsonb_build_object('state','duplicate_only','action','block',
                                          'reason','parent_phone_belongs_to_other_family',
                                          'otherFamilyStudents', v_phone_third,
                                          'value', v_removed."parentPhone"));
    ELSE
      v_ok := array_append(v_ok, 'parent_phone_from_removed_preserved');
      v_phone_choice := 'duplicate';
      v_transfer := v_transfer || jsonb_build_object('parentPhone', v_removed."parentPhone");
      v_field_states := v_field_states || jsonb_build_object(
        'parentPhone', jsonb_build_object('state','duplicate_only','action','transfer',
                                          'value', v_removed."parentPhone",
                                          'normalized', v_ph_r));
    END IF;
  ELSE
    v_ok := array_append(v_ok, 'no_parent_phone');
    v_field_states := v_field_states || jsonb_build_object(
      'parentPhone', jsonb_build_object('state','both_blank','action','keep'));
  END IF;

  -- ── Transport ───────────────────────────────────────────────────────────
  -- students.transport is a SCALAR (students_transport_check: 'WALKER', 'CAR',
  -- 'LEFT' or a bus number) with no relational child rows — the real
  -- driver↔student relationship is authorized_pickup_students, which the shared
  -- merge RPC already moves with ON CONFLICT DO NOTHING. So copying the scalar
  -- is the complete preservation; nothing relational is left behind.
  -- 'LEFT' never reaches here: student_marked_left already excluded the pair.
  v_tr_k := btrim(COALESCE(v_keeper.transport, ''));
  v_tr_r := btrim(COALESCE(v_removed.transport, ''));
  IF v_tr_k <> '' AND v_tr_r <> '' AND upper(v_tr_k) = upper(v_tr_r) THEN
    v_ok := array_append(v_ok, 'same_transport');
    v_field_states := v_field_states || jsonb_build_object(
      'transport', jsonb_build_object('state','identical','action','keep'));
  ELSIF v_tr_k <> '' AND v_tr_r <> '' THEN
    -- e.g. WALKER vs bus 9 — an administrator must choose which is correct.
    v_codes := array_append(v_codes, 'transport_conflict'); v_blocked := true;
    v_field_states := v_field_states || jsonb_build_object(
      'transport', jsonb_build_object('state','conflict','action','block',
                                      'keeper', v_keeper.transport,
                                      'removed', v_removed.transport));
  ELSIF v_tr_k <> '' THEN
    v_ok := array_append(v_ok, 'transport_keeper_only');
    v_field_states := v_field_states || jsonb_build_object(
      'transport', jsonb_build_object('state','keeper_only','action','keep'));
  ELSIF v_tr_r <> '' THEN
    -- One-sided: carry it across. The value already satisfies
    -- students_transport_check because it is stored on a live row.
    v_ok := array_append(v_ok, 'transport_from_removed_preserved');
    v_transport_choice := 'duplicate';
    v_transfer := v_transfer || jsonb_build_object('transport', v_removed.transport);
    v_field_states := v_field_states || jsonb_build_object(
      'transport', jsonb_build_object('state','duplicate_only','action','transfer',
                                      'value', v_removed.transport));
  ELSE
    v_ok := array_append(v_ok, 'no_transport');
    v_field_states := v_field_states || jsonb_build_object(
      'transport', jsonb_build_object('state','both_blank','action','keep'));
  END IF;

  -- ── Family ID (deliberately the most conservative field) ─────────────────
  -- There is NO families table: familyId is a TEXT column on students
  -- (20260802_office_role.sql) and the authoritative grouping is the family key
  -- used by generate_family_ids() — 'p:'||parentId, else 't:'||phone — under the
  -- invariant "one family key → one family ID for the lifetime of the key"
  -- (20260819). So "the same family" is provable ONLY from sibling records that
  -- share the keeper's parent. Absence of evidence is not evidence: if the
  -- database cannot prove it, the pair goes to individual review rather than
  -- being merged on a guess. A family relationship is never replaced silently.
  v_fam_k := COALESCE(public.normalize_family_id(v_keeper."familyId"), '');
  v_fam_r := COALESCE(public.normalize_family_id(v_removed."familyId"), '');
  IF v_fam_k <> '' AND v_fam_r <> '' AND v_fam_k = v_fam_r THEN
    v_ok := array_append(v_ok, 'same_family_id');
    v_field_states := v_field_states || jsonb_build_object(
      'familyId', jsonb_build_object('state','identical','action','keep'));
  ELSIF v_fam_k <> '' AND v_fam_r <> '' THEN
    v_codes := array_append(v_codes, 'family_id_conflict'); v_blocked := true;
    v_field_states := v_field_states || jsonb_build_object(
      'familyId', jsonb_build_object('state','conflict','action','block',
                                     'keeper', v_keeper."familyId",
                                     'removed', v_removed."familyId"));
  ELSIF v_fam_k <> '' THEN
    v_ok := array_append(v_ok, 'family_id_keeper_only');
    v_field_states := v_field_states || jsonb_build_object(
      'familyId', jsonb_build_object('state','keeper_only','action','keep'));
  ELSIF v_fam_r <> '' THEN
    -- Does the keeper's own parent already belong to a DIFFERENT family?
    SELECT count(*) INTO v_family_other
    FROM public.students s
    WHERE s.id <> v_keeper_id AND s.id <> v_removed_id
      AND v_keeper."parentId" IS NOT NULL
      AND s."parentId" = v_keeper."parentId"
      AND public.normalize_family_id(s."familyId") <> ''
      AND public.normalize_family_id(s."familyId") <> v_fam_r;
    -- Do siblings of the keeper's parent already hold exactly THIS family id?
    SELECT count(*) INTO v_family_sibling
    FROM public.students s
    WHERE s.id <> v_keeper_id AND s.id <> v_removed_id
      AND v_keeper."parentId" IS NOT NULL
      AND s."parentId" = v_keeper."parentId"
      AND public.normalize_family_id(s."familyId") = v_fam_r;

    IF COALESCE(v_family_other, 0) > 0 THEN
      v_codes := array_append(v_codes, 'family_id_conflict'); v_blocked := true;
      v_field_states := v_field_states || jsonb_build_object(
        'familyId', jsonb_build_object('state','duplicate_only','action','block',
                                       'reason','keeper_parent_already_in_other_family',
                                       'value', v_removed."familyId",
                                       'otherFamilyStudents', v_family_other));
    ELSIF COALESCE(v_family_sibling, 0) > 0 THEN
      -- PROVEN: the keeper's parent already owns this exact family id on a
      -- sibling, so the keeper joins a family it demonstrably belongs to.
      v_ok := array_append(v_ok, 'family_id_from_removed_preserved');
      v_transfer := v_transfer || jsonb_build_object('familyId', v_removed."familyId");
      v_field_states := v_field_states || jsonb_build_object(
        'familyId', jsonb_build_object('state','duplicate_only','action','transfer',
                                       'value', v_removed."familyId",
                                       'proof', 'keeper_parent_sibling_holds_same_family_id',
                                       'siblingCount', v_family_sibling));
    ELSE
      -- Not provable either way. Never guess at a family relationship.
      v_codes := array_append(v_codes, 'family_id_transfer_unproven'); v_review := true;
      v_field_states := v_field_states || jsonb_build_object(
        'familyId', jsonb_build_object('state','duplicate_only','action','review',
                                       'reason','family_id_transfer_unproven',
                                       'value', v_removed."familyId"));
    END IF;
  ELSE
    v_ok := array_append(v_ok, 'no_family_id');
    v_field_states := v_field_states || jsonb_build_object(
      'familyId', jsonb_build_object('state','both_blank','action','keep'));
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
      v_enroll_action, v_gov_choice, v_phone_choice, v_transport_choice,
      v_transfer::TEXT, v_field_states::TEXT
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
    'fieldStates', v_field_states,
    'transfers', v_transfer,
    'fingerprint', v_fingerprint,
    'evaluatedAt', now()
  );
END;
$$;

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
  v_batch_exists BOOLEAN := FALSE;
  v_batch_owner TEXT;
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
  v_expected_transport TEXT;
  v_expected_family TEXT;
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

  -- 2b. Batch id ownership --------------------------------------------------
  -- The client supplies the batch id so the UI can accumulate several chunks of
  -- ONE run into ONE aggregate row. That must never let a second administrator
  -- append to (or overwrite) a batch that belongs to someone else, so an
  -- existing id is accepted ONLY from the administrator who created it. The id
  -- itself stays a bound value (never concatenated into SQL) and keeps its
  -- trim/length checks above.
  --
  -- This runs BEFORE the eligibility scan and BEFORE any merge, so a refused
  -- caller has written nothing at all.
  --
  -- The advisory lock is taken first and keyed on the batch id. It serialises
  -- two concurrent chunks that chose the SAME fresh id: the second one waits,
  -- then sees the committed row and is refused (or, if it is the same admin,
  -- accumulates) instead of racing into the upsert below.
  PERFORM pg_advisory_xact_lock(hashtext(v_batch)::BIGINT);

  SELECT TRUE, b.admin_id
    INTO v_batch_exists, v_batch_owner
    FROM public.student_merge_batches b
   WHERE b.id = v_batch;

  IF COALESCE(v_batch_exists, FALSE) THEN
    IF v_actor IS NULL OR v_batch_owner IS DISTINCT FROM v_actor THEN
      RAISE EXCEPTION 'batch_id_not_owned: batch "%" was created by another administrator. Re-run with a new batch id.', v_batch
        USING ERRCODE = 'insufficient_privilege';
    END IF;
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
    -- The keeper's SURVIVING profile bytes. For a field the policy transfers,
    -- the surviving value is the removed record's own bytes (copied verbatim,
    -- never re-normalized); for every other field it is the keeper's. This is
    -- what stops the shared RPC's normalization from quietly rewriting a value
    -- the policy promised to keep — and what makes a transfer actually stick.
    v_expected_phone := CASE
      WHEN COALESCE(v_eval->'fieldStates'->'parentPhone'->>'action','') = 'transfer'
        THEN v_removed."parentPhone" ELSE v_keeper."parentPhone" END;
    v_expected_transport := CASE
      WHEN COALESCE(v_eval->'fieldStates'->'transport'->>'action','') = 'transfer'
        THEN v_removed.transport ELSE v_keeper.transport END;
    -- familyId is NOT written by merge_duplicate_students_resolved at all, so
    -- this statement is the only place a proven family consolidation happens.
    v_expected_family := CASE
      WHEN COALESCE(v_eval->'fieldStates'->'familyId'->>'action','') = 'transfer'
        THEN v_removed."familyId" ELSE v_keeper."familyId" END;
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
             "parentPhone" = v_expected_phone,
             transport = v_expected_transport,
             "familyId" = v_expected_family
       WHERE id = v_keeper_id
         AND ("govId" IS DISTINCT FROM v_expected_gov
              OR "parentPhone" IS DISTINCT FROM v_expected_phone
              OR transport IS DISTINCT FROM v_expected_transport
              OR "familyId" IS DISTINCT FROM v_expected_family);

      -- Batch provenance on THIS merge's own audit row (per-student traceability)
      UPDATE public.student_merge_audits
         SET batch_id = v_batch,
             batch_policy = v_policy->>'policyId',
             batch_size = v_chunk,
             merge_kind = 'safe_batch',
             -- Every value copied off the removed record, with its field name.
             -- "Nothing was lost" must be answerable from the audit alone.
             transferred_fields = COALESCE(v_eval->'transfers', '{}'::jsonb),
             field_states = COALESCE(v_eval->'fieldStates', '{}'::jsonb)
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
        'transfers', COALESCE(v_eval->'transfers', '{}'::jsonb),
        'fieldStates', COALESCE(v_eval->'fieldStates', '{}'::jsonb),
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
    updated_at = NOW()
    -- Accumulation is for the SAME administrator's chunks only. admin_id and
    -- created_at are deliberately never rewritten: ownership is immutable.
    WHERE public.student_merge_batches.admin_id IS NOT DISTINCT FROM v_actor;

  -- Defence in depth: the aggregate row this chunk just touched must belong to
  -- the acting administrator. If the guarded upsert skipped (someone else owns
  -- the id) this raises, and because the chunk is one transaction EVERY write
  -- it made — merges, per-merge audits, audit_logs — rolls back with it. A
  -- batch row is therefore never silently overwritten or shared between admins.
  IF EXISTS (
    SELECT 1 FROM public.student_merge_batches b
     WHERE b.id = v_batch
       AND b.admin_id IS DISTINCT FROM v_actor
  ) THEN
    RAISE EXCEPTION 'batch_id_not_owned: batch "%" is not owned by the acting administrator.', v_batch
      USING ERRCODE = 'insufficient_privilege';
  END IF;

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

-- ── Surface the per-field classification on excluded rows too ───────────────
-- The safe `rows` already carry the whole evaluation object, so they inherit
-- fieldStates/transfers for free (and preview_safe_duplicate_batch reuses
-- those rows). excludedRows picks explicit keys, so it needs them added to
-- explain WHY a pair was held back — conflict vs unprovable one-sided data.
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
          -- Per-field classification of an excluded pair, so an administrator
          -- can see WHICH field caused it and whether it is a true conflict or
          -- merely one-sided data the database could not prove transferable.
          'fieldStates', COALESCE(evaluation->'fieldStates', '{}'::jsonb),
          'eligibilityCodes', evaluation->'eligibilityCodes',
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

-- ── Privileges ──────────────────────────────────────────────────────────────
-- CREATE OR REPLACE preserves a function's existing ACL, so nothing below is
-- strictly required. These lines re-assert the EXACT privilege set that
-- 20260925 installed (same signatures, same verbs) so the new file is also
-- correct if it is ever applied on its own. Note that the evaluator stays
-- un-granted to authenticated: it is an internal helper reached only through
-- the four client RPCs, exactly as before.
REVOKE ALL ON FUNCTION public.safe_duplicate_batch_policy() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.safe_duplicate_batch_policy() TO authenticated;

REVOKE ALL ON FUNCTION public._safe_batch_evaluate_pair(TEXT,TEXT,INTEGER,BOOLEAN) FROM PUBLIC;

REVOKE ALL ON FUNCTION public.merge_safe_duplicate_batch(JSONB,INTEGER,TEXT,TEXT,TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.merge_safe_duplicate_batch(JSONB,INTEGER,TEXT,TEXT,TEXT) TO authenticated;

-- ── Assertions ──────────────────────────────────────────────────────────────
DO $$
DECLARE v_p JSONB;
BEGIN
  v_p := public.safe_duplicate_batch_policy();
  IF (v_p->>'policyId') <> 'safe_batch_parent_assigned_keeper'
     OR (v_p->>'version')::int <> 2 THEN
    RAISE EXCEPTION 'safe_batch: unexpected policy identity %', v_p->>'policyId';
  END IF;
  IF NOT (v_p->'blockedCodes' @> '["parent_phone_belongs_to_other_family"]'::jsonb) THEN
    RAISE EXCEPTION 'safe_batch: family-collision phone code must be a blocked code';
  END IF;
  IF (v_p->'exclusionCodes' ? 'parent_phone_only_on_unassigned')
     OR (v_p->'exclusionCodes' ? 'transport_only_on_unassigned')
     OR (v_p->'exclusionCodes' ? 'family_id_only_on_unassigned') THEN
    RAISE EXCEPTION 'safe_batch: one-sided-data exclusion codes must be retired';
  END IF;
  IF NOT (v_p->'exclusionCodes' ? 'family_id_transfer_unproven')
     OR NOT (v_p->'blockedCodes' @> '["family_id_conflict"]'::jsonb) THEN
    RAISE EXCEPTION 'safe_batch: conservative family-id codes must be present';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                  WHERE table_schema='public' AND table_name='student_merge_audits'
                    AND column_name='transferred_fields') THEN
    RAISE EXCEPTION 'safe_batch: transferred_fields audit column missing';
  END IF;
  RAISE NOTICE 'safe_batch field consolidation: policy v2 installed';
END $$;
