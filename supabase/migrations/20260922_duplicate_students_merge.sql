-- ============================================================================
-- Migration 20260922 — Duplicate Students: safe guided student merge
-- ============================================================================
-- Feature spec: Admin Duplicate Students — Safe Guided Student Merge
-- Provides:
--   * student_merge_audits table (merge audit trail)
--   * get_duplicate_candidates() — candidate detector (normalized name + class)
--   * preview_student_merge() — dry-run preview (zero writes)
--   * merge_duplicate_students() — transaction-safe merge RPC
--
-- Safety principles:
--   same name+class is candidate only, never identity proof.
--   Gov ID / parent assignment are strong signals.
--   Different Gov IDs → BLOCKED
--   Both have parents with different identity & no shared Gov → BLOCKED
--   Exam identity collisions → BLOCKED
--   Attendance/date collisions → BLOCKED
--   Quiz duplicate → BLOCKED
--   Only admin may merge (enforced in SQL & via RLS).
--   Zero-dependency verification before deleting duplicate.
--   Enrollment consolidation preserves history.
-- Idempotent.

-- ─── 1. Merge audit table ─────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.student_merge_audits (
  id TEXT PRIMARY KEY,
  canonical_id TEXT NOT NULL,
  duplicate_id TEXT NOT NULL,
  admin_id TEXT,
  reason TEXT,
  before_counts JSONB NOT NULL DEFAULT '{}'::jsonb,
  after_counts JSONB,
  enrollment_action JSONB,
  exam_conflicts JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_student_merge_audits_canonical ON public.student_merge_audits (canonical_id);
CREATE INDEX IF NOT EXISTS idx_student_merge_audits_duplicate ON public.student_merge_audits (duplicate_id);
CREATE INDEX IF NOT EXISTS idx_student_merge_audits_created ON public.student_merge_audits (created_at DESC);

ALTER TABLE public.student_merge_audits ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Admins can read merge audits" ON public.student_merge_audits;
CREATE POLICY "Admins can read merge audits"
  ON public.student_merge_audits FOR SELECT TO authenticated
  USING (public.current_profile_role() IN ('admin','supervisor'));

-- No INSERT/UPDATE/DELETE policies — writes only via SECURITY DEFINER RPCs.

-- ─── 2. Helper: duplicate candidate detector ───────────────────────────────
-- Groups students by normalized name + current class. Candidate only, not
-- definitive identity. Used by the UI for discovery; the preview/merge RPCs
-- enforce strong-identity checks.
-- SECURITY: admin-only. Frontend route is admin-only, but RPC must enforce
-- independently (anon and non-admin must not enumerate candidates).
CREATE OR REPLACE FUNCTION public.get_duplicate_candidates()
RETURNS TABLE(group_key TEXT, student_ids TEXT[], class_name TEXT, member_count BIGINT)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF public.current_profile_role() IS NULL OR public.current_profile_role() <> 'admin' THEN
    RAISE EXCEPTION 'Only administrators may view duplicate candidates.'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN QUERY
  SELECT
    public.name_match_key(s.name) || '|' || s."className" AS group_key,
    array_agg(s.id ORDER BY s."createdAt") AS student_ids,
    s."className" AS class_name,
    count(*)::BIGINT AS member_count
  FROM public.students s
  GROUP BY public.name_match_key(s.name), s."className"
  HAVING count(*) > 1;
END;
$$;

REVOKE ALL ON FUNCTION public.get_duplicate_candidates() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_duplicate_candidates() TO authenticated;

-- ─── 3. Preview (dry-run, zero writes) ────────────────────────────────────
CREATE OR REPLACE FUNCTION public.preview_student_merge(
  p_canonical_id TEXT,
  p_duplicate_id TEXT
) RETURNS JSONB
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_can RECORD;
  v_dup RECORD;
  v_can_gov_match TEXT;
  v_dup_gov_match TEXT;
  v_can_gov_raw TEXT;
  v_dup_gov_raw TEXT;
  v_exams_can INT; v_exams_dup INT; v_exams_conflicts INT;
  v_att_can INT; v_att_dup INT; v_att_conflicts INT;
  v_hw_can INT; v_hw_dup INT;
  v_prom_can INT; v_prom_dup INT;
  v_quiz_can INT; v_quiz_dup INT; v_quiz_conflicts INT;
  v_pick_can INT; v_pick_dup INT;
  v_rel_can INT; v_rel_dup INT; v_rel_conflicts INT;
  v_rep_can INT; v_rep_dup INT;
  v_enr_can_open RECORD; v_enr_dup_open RECORD;
  v_enr_can_hist INT; v_enr_dup_hist INT;
  v_open_can_cnt INT; v_open_dup_cnt INT;
  v_blocked TEXT[] := ARRAY[]::TEXT[];
  v_can_merge BOOLEAN := true;
  v_risk TEXT := 'low';
  v_evidence TEXT := 'possible';
  v_parent_can BOOLEAN; v_parent_dup BOOLEAN;
  v_same_gov BOOLEAN; v_conflicting_gov BOOLEAN;
BEGIN
  -- Authorization: preview is admin-only (even read preview leaks identity signals)
  IF public.current_profile_role() IS NULL OR public.current_profile_role() <> 'admin' THEN
    RAISE EXCEPTION 'Only administrators may preview student merges.'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  IF p_canonical_id IS NULL OR p_duplicate_id IS NULL OR p_canonical_id = p_duplicate_id THEN
    RAISE EXCEPTION 'Two distinct student IDs are required.'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  SELECT * INTO v_can FROM public.students WHERE id = p_canonical_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Canonical student % does not exist.', p_canonical_id USING ERRCODE = 'no_data_found'; END IF;
  SELECT * INTO v_dup FROM public.students WHERE id = p_duplicate_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Duplicate student % does not exist.', p_duplicate_id USING ERRCODE = 'no_data_found'; END IF;

  v_can_gov_raw := v_can."govId";
  v_dup_gov_raw := v_dup."govId";
  v_can_gov_match := public.gov_id_match_key(v_can_gov_raw);
  v_dup_gov_match := public.gov_id_match_key(v_dup_gov_raw);
  v_parent_can := v_can."parentId" IS NOT NULL;
  v_parent_dup := v_dup."parentId" IS NOT NULL;
  v_same_gov := v_can_gov_match IS NOT NULL AND v_can_gov_match <> '' AND v_can_gov_match = v_dup_gov_match;
  v_conflicting_gov := v_can_gov_match IS NOT NULL AND v_can_gov_match <> '' AND v_dup_gov_match IS NOT NULL AND v_dup_gov_match <> '' AND v_can_gov_match <> v_dup_gov_match;

  -- Counts
  SELECT count(*) INTO v_exams_can FROM public.exams WHERE "studentId" = p_canonical_id;
  SELECT count(*) INTO v_exams_dup FROM public.exams WHERE "studentId" = p_duplicate_id;
  SELECT count(*) INTO v_att_can FROM public.attendance WHERE "studentId" = p_canonical_id;
  SELECT count(*) INTO v_att_dup FROM public.attendance WHERE "studentId" = p_duplicate_id;
  SELECT count(*) INTO v_hw_can FROM public.homework WHERE "studentId" = p_canonical_id;
  SELECT count(*) INTO v_hw_dup FROM public.homework WHERE "studentId" = p_duplicate_id;
  SELECT count(*) INTO v_prom_can FROM public.student_promotions WHERE "studentId" = p_canonical_id;
  SELECT count(*) INTO v_prom_dup FROM public.student_promotions WHERE "studentId" = p_duplicate_id;
  SELECT count(*) INTO v_quiz_can FROM public.quiz_attempts WHERE "studentId" = p_canonical_id;
  SELECT count(*) INTO v_quiz_dup FROM public.quiz_attempts WHERE "studentId" = p_duplicate_id;
  SELECT count(*) INTO v_pick_can FROM public.authorized_pickup_students WHERE "studentId" = p_canonical_id;
  SELECT count(*) INTO v_pick_dup FROM public.authorized_pickup_students WHERE "studentId" = p_duplicate_id;
  SELECT count(*) INTO v_rel_can FROM public.release_log WHERE "studentId" = p_canonical_id;
  SELECT count(*) INTO v_rel_dup FROM public.release_log WHERE "studentId" = p_duplicate_id;
  SELECT count(*) INTO v_rep_can FROM public.report_comments WHERE "studentId" = p_canonical_id;
  SELECT count(*) INTO v_rep_dup FROM public.report_comments WHERE "studentId" = p_duplicate_id;

  SELECT * INTO v_enr_can_open FROM public.student_enrollments WHERE "studentId" = p_canonical_id AND "effectiveTo" IS NULL LIMIT 1;
  SELECT * INTO v_enr_dup_open FROM public.student_enrollments WHERE "studentId" = p_duplicate_id AND "effectiveTo" IS NULL LIMIT 1;
  SELECT count(*) INTO v_open_can_cnt FROM public.student_enrollments WHERE "studentId" = p_canonical_id AND "effectiveTo" IS NULL;
  SELECT count(*) INTO v_open_dup_cnt FROM public.student_enrollments WHERE "studentId" = p_duplicate_id AND "effectiveTo" IS NULL;
  SELECT count(*) INTO v_enr_can_hist FROM public.student_enrollments WHERE "studentId" = p_canonical_id AND "effectiveTo" IS NOT NULL;
  SELECT count(*) INTO v_enr_dup_hist FROM public.student_enrollments WHERE "studentId" = p_duplicate_id AND "effectiveTo" IS NOT NULL;

  -- Enrollment safety: multiple open enrollments → BLOCKED
  IF v_open_can_cnt > 1 OR v_open_dup_cnt > 1 THEN
    v_blocked := array_append(v_blocked, 'enrollment_conflict');
    v_can_merge := false;
    -- also flag specific reason for UI
    IF v_open_can_cnt > 1 OR v_open_dup_cnt > 1 THEN
      v_blocked := array_append(v_blocked, 'multiple_open_enrollments');
    END IF;
  END IF;

  -- Conflict detection: exams (bulk identity)
  SELECT count(*) INTO v_exams_conflicts
  FROM public.exams d
  JOIN public.exams c ON c."studentId" = p_canonical_id
    AND d."studentId" = p_duplicate_id
    AND c."subjectId" IS NOT DISTINCT FROM d."subjectId"
    AND c."examType" = d."examType"
    AND c."assessmentLabel" IS NOT DISTINCT FROM d."assessmentLabel"
    AND c."termId" IS NOT DISTINCT FROM d."termId";

  -- Attendance collisions (same date)
  SELECT count(*) INTO v_att_conflicts
  FROM public.attendance d
  JOIN public.attendance c ON c."studentId" = p_canonical_id
    AND d."studentId" = p_duplicate_id
    AND c.date = d.date;

  -- Quiz collisions (same quiz)
  SELECT count(*) INTO v_quiz_conflicts
  FROM public.quiz_attempts d
  JOIN public.quiz_attempts c ON c."studentId" = p_canonical_id
    AND d."studentId" = p_duplicate_id
    AND c."quizId" = d."quizId";

  -- Release collisions (same UTC day)
  SELECT count(*) INTO v_rel_conflicts
  FROM public.release_log d
  JOIN public.release_log c ON c."studentId" = p_canonical_id
    AND d."studentId" = p_duplicate_id
    AND (d."createdAt" AT TIME ZONE 'UTC')::date = (c."createdAt" AT TIME ZONE 'UTC')::date;

  -- Enrollment conflict: both open but different class OR different academicYear
  -- Safety-first: consolidate ONLY when same className AND same academicYearId
  IF v_enr_can_open."className" IS NOT NULL AND v_enr_dup_open."className" IS NOT NULL THEN
    IF v_enr_can_open."className" <> v_enr_dup_open."className"
       OR v_enr_can_open."academicYearId" IS DISTINCT FROM v_enr_dup_open."academicYearId" THEN
      v_blocked := array_append(v_blocked, 'enrollment_conflict');
      v_can_merge := false;
    END IF;
  END IF;

  IF v_conflicting_gov THEN
    v_blocked := array_append(v_blocked, 'gov_id_conflict');
    v_can_merge := false;
    v_risk := 'critical';
    v_evidence := 'conflicting';
  ELSIF v_same_gov THEN
    v_evidence := 'strong';
    v_risk := 'low';
  ELSIF v_parent_can AND v_parent_dup AND NOT v_same_gov THEN
    v_blocked := array_append(v_blocked, 'both_have_parents');
    v_can_merge := false;
    v_risk := 'critical';
    v_evidence := 'conflicting';
  ELSIF (v_parent_can <> v_parent_dup) THEN
    v_evidence := 'strong';
    v_risk := 'low';
  ELSIF NOT v_parent_can AND NOT v_parent_dup THEN
    v_evidence := 'possible';
    v_risk := 'high';
  END IF;

  IF v_exams_conflicts > 0 THEN
    v_blocked := array_append(v_blocked, 'exam_conflict');
    v_can_merge := false;
    IF v_risk <> 'critical' THEN v_risk := 'high'; END IF;
    IF v_evidence <> 'conflicting' THEN v_evidence := 'conflicting'; END IF;
  END IF;
  IF v_att_conflicts > 0 THEN
    v_blocked := array_append(v_blocked, 'attendance_conflict');
    v_can_merge := false;
  END IF;
  IF v_quiz_conflicts > 0 THEN
    v_blocked := array_append(v_blocked, 'quiz_conflict');
    v_can_merge := false;
  END IF;
  IF v_rel_conflicts > 0 THEN
    v_blocked := array_append(v_blocked, 'release_conflict');
    v_can_merge := false;
  END IF;

  RETURN jsonb_build_object(
    'canonical', jsonb_build_object('id', v_can.id, 'name', v_can.name, 'className', v_can."className", 'govId', v_can."govId", 'parentId', v_can."parentId", 'parentPhone', v_can."parentPhone", 'transport', v_can.transport, 'familyId', v_can."familyId", 'createdAt', v_can."createdAt"),
    'duplicate', jsonb_build_object('id', v_dup.id, 'name', v_dup.name, 'className', v_dup."className", 'govId', v_dup."govId", 'parentId', v_dup."parentId", 'parentPhone', v_dup."parentPhone", 'transport', v_dup.transport, 'familyId', v_dup."familyId", 'createdAt', v_dup."createdAt"),
    'counts', jsonb_build_object(
      'exams', jsonb_build_object('canonical', v_exams_can, 'duplicate', v_exams_dup, 'conflicts', v_exams_conflicts),
      'attendance', jsonb_build_object('canonical', v_att_can, 'duplicate', v_att_dup, 'conflicts', v_att_conflicts),
      'homework', jsonb_build_object('canonical', v_hw_can, 'duplicate', v_hw_dup),
      'promotions', jsonb_build_object('canonical', v_prom_can, 'duplicate', v_prom_dup),
      'quizAttempts', jsonb_build_object('canonical', v_quiz_can, 'duplicate', v_quiz_dup, 'conflicts', v_quiz_conflicts),
      'authorizedPickups', jsonb_build_object('canonical', v_pick_can, 'duplicate', v_pick_dup),
      'releaseLogs', jsonb_build_object('canonical', v_rel_can, 'duplicate', v_rel_dup, 'conflicts', v_rel_conflicts),
      'reportComments', jsonb_build_object('canonical', v_rep_can, 'duplicate', v_rep_dup),
      'enrollments', jsonb_build_object('canonicalOpen', CASE WHEN v_enr_can_open.id IS NOT NULL THEN jsonb_build_object('className', v_enr_can_open."className", 'academicYearId', v_enr_can_open."academicYearId", 'effectiveFrom', v_enr_can_open."effectiveFrom") ELSE NULL END,
                                        'duplicateOpen', CASE WHEN v_enr_dup_open.id IS NOT NULL THEN jsonb_build_object('className', v_enr_dup_open."className", 'academicYearId', v_enr_dup_open."academicYearId", 'effectiveFrom', v_enr_dup_open."effectiveFrom") ELSE NULL END,
                                        'canonicalHistory', v_enr_can_hist, 'duplicateHistory', v_enr_dup_hist)
    ),
    'enrollment', jsonb_build_object(
      'canonicalOpen', CASE WHEN v_enr_can_open.id IS NOT NULL THEN jsonb_build_object('className', v_enr_can_open."className", 'academicYearId', v_enr_can_open."academicYearId") ELSE NULL END,
      'duplicateOpen', CASE WHEN v_enr_dup_open.id IS NOT NULL THEN jsonb_build_object('className', v_enr_dup_open."className", 'academicYearId', v_enr_dup_open."academicYearId") ELSE NULL END,
      'action', CASE WHEN v_enr_dup_open.id IS NOT NULL AND v_enr_can_open.id IS NOT NULL AND v_enr_can_open."className" = v_enr_dup_open."className" AND v_enr_can_open."academicYearId" IS NOT DISTINCT FROM v_enr_dup_open."academicYearId" THEN 'consolidate'
                    WHEN v_enr_dup_open.id IS NOT NULL AND v_enr_can_open.id IS NULL THEN 'transfer'
                    WHEN v_enr_dup_open.id IS NULL THEN 'preserve_history'
                    ELSE 'blocked' END,
      'willConsolidate', (v_enr_dup_open.id IS NOT NULL AND v_enr_can_open.id IS NOT NULL AND v_enr_can_open."className" = v_enr_dup_open."className" AND v_enr_can_open."academicYearId" IS NOT DISTINCT FROM v_enr_dup_open."academicYearId"),
      'canMerge', v_can_merge
    ),
    'conflicts', jsonb_build_object('examConflicts', v_exams_conflicts, 'attendanceConflicts', v_att_conflicts, 'quizConflicts', v_quiz_conflicts, 'releaseConflicts', v_rel_conflicts, 'govConflict', v_conflicting_gov, 'bothHaveParents', (v_parent_can AND v_parent_dup), 'sameGov', v_same_gov),
    'canMerge', v_can_merge,
    'blockedReasons', to_jsonb(v_blocked),
    'riskLevel', v_risk,
    'evidence', v_evidence
  );
END;
$$;

REVOKE ALL ON FUNCTION public.preview_student_merge(TEXT,TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.preview_student_merge(TEXT,TEXT) TO authenticated;

-- ─── 4. Merge (transaction-safe) ──────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.merge_duplicate_students(
  p_canonical_id TEXT,
  p_duplicate_id TEXT,
  p_reason TEXT DEFAULT NULL
) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_actor TEXT := public.current_profile_id();
  v_role TEXT := public.current_profile_role();
  v_can RECORD;
  v_dup RECORD;
  v_can_gov_match TEXT;
  v_dup_gov_match TEXT;
  v_same_gov BOOLEAN;
  v_conflicting_gov BOOLEAN;
  v_parent_can BOOLEAN;
  v_parent_dup BOOLEAN;
  v_exams_conflicts INT;
  v_att_conflicts INT;
  v_quiz_conflicts INT;
  v_rel_conflicts INT;
  v_has_enrollment_conflict BOOLEAN := false;
  v_audit_id TEXT;
  v_before JSONB;
  v_after JSONB;
  v_enroll_action JSONB;
  v_exam_conflicts_json JSONB;
  v_open_can RECORD;
  v_open_dup RECORD;
  v_hist_can INT; v_hist_dup INT;
  v_before_counts JSONB;
  v_count INT;
  v_open_can_cnt INT; v_open_dup_cnt INT;
BEGIN
  IF v_role IS NULL OR v_role <> 'admin' THEN
    RAISE EXCEPTION 'Only administrators may merge students.'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  IF p_canonical_id IS NULL OR p_duplicate_id IS NULL OR p_canonical_id = p_duplicate_id THEN
    RAISE EXCEPTION 'Two distinct student IDs are required.'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  -- Lock both rows in deterministic order to avoid deadlocks
  IF p_canonical_id < p_duplicate_id THEN
    SELECT * INTO v_can FROM public.students WHERE id = p_canonical_id FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'Canonical student % does not exist.', p_canonical_id USING ERRCODE = 'no_data_found'; END IF;
    SELECT * INTO v_dup FROM public.students WHERE id = p_duplicate_id FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'Duplicate student % does not exist.', p_duplicate_id USING ERRCODE = 'no_data_found'; END IF;
  ELSE
    SELECT * INTO v_dup FROM public.students WHERE id = p_duplicate_id FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'Duplicate student % does not exist.', p_duplicate_id USING ERRCODE = 'no_data_found'; END IF;
    SELECT * INTO v_can FROM public.students WHERE id = p_canonical_id FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'Canonical student % does not exist.', p_canonical_id USING ERRCODE = 'no_data_found'; END IF;
  END IF;

  -- Revalidate Gov IDs
  v_can_gov_match := public.gov_id_match_key(v_can."govId");
  v_dup_gov_match := public.gov_id_match_key(v_dup."govId");
  v_same_gov := v_can_gov_match IS NOT NULL AND v_can_gov_match <> '' AND v_can_gov_match = v_dup_gov_match;
  v_conflicting_gov := v_can_gov_match IS NOT NULL AND v_can_gov_match <> '' AND v_dup_gov_match IS NOT NULL AND v_dup_gov_match <> '' AND v_can_gov_match <> v_dup_gov_match;
  v_parent_can := v_can."parentId" IS NOT NULL;
  v_parent_dup := v_dup."parentId" IS NOT NULL;

  IF v_conflicting_gov THEN
    RAISE EXCEPTION 'Merge blocked: different Government IDs (% vs %). Manual review required.', v_can."govId", v_dup."govId"
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;

  IF v_parent_can AND v_parent_dup AND NOT v_same_gov THEN
    RAISE EXCEPTION 'Merge blocked: both records have different parents (% vs %). Resolve parent assignment before merging.', COALESCE(v_can."parentId",'null'), COALESCE(v_dup."parentId",'null')
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;

  -- Detect exam conflicts (blocking)
  SELECT count(*) INTO v_exams_conflicts
  FROM public.exams d
  JOIN public.exams c ON c."studentId" = p_canonical_id
    AND d."studentId" = p_duplicate_id
    AND c."subjectId" IS NOT DISTINCT FROM d."subjectId"
    AND c."examType" = d."examType"
    AND c."assessmentLabel" IS NOT DISTINCT FROM d."assessmentLabel"
    AND c."termId" IS NOT DISTINCT FROM d."termId";
  IF v_exams_conflicts > 0 THEN
    RAISE EXCEPTION 'Merge blocked: % exam identity conflicts detected. No exam marks will be overwritten.', v_exams_conflicts
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;

  SELECT count(*) INTO v_att_conflicts
  FROM public.attendance d
  JOIN public.attendance c ON c."studentId" = p_canonical_id
    AND d."studentId" = p_duplicate_id
    AND c.date = d.date;
  IF v_att_conflicts > 0 THEN
    RAISE EXCEPTION 'Merge blocked: % attendance date conflicts detected.', v_att_conflicts
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;

  SELECT count(*) INTO v_quiz_conflicts
  FROM public.quiz_attempts d
  JOIN public.quiz_attempts c ON c."studentId" = p_canonical_id
    AND d."studentId" = p_duplicate_id
    AND c."quizId" = d."quizId";
  IF v_quiz_conflicts > 0 THEN
    RAISE EXCEPTION 'Merge blocked: % quiz attempt conflicts detected.', v_quiz_conflicts
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;

  SELECT count(*) INTO v_rel_conflicts
  FROM public.release_log d
  JOIN public.release_log c ON c."studentId" = p_canonical_id
    AND d."studentId" = p_duplicate_id
    AND (d."createdAt" AT TIME ZONE 'UTC')::date = (c."createdAt" AT TIME ZONE 'UTC')::date;
  IF v_rel_conflicts > 0 THEN
    RAISE EXCEPTION 'Merge blocked: % release log conflicts detected (same day).', v_rel_conflicts
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;

  -- Enrollment conflict check — academic-year safety + multiple opens
  SELECT * INTO v_open_can FROM public.student_enrollments WHERE "studentId" = p_canonical_id AND "effectiveTo" IS NULL LIMIT 1;
  SELECT * INTO v_open_dup FROM public.student_enrollments WHERE "studentId" = p_duplicate_id AND "effectiveTo" IS NULL LIMIT 1;
  SELECT count(*) INTO v_open_can_cnt FROM public.student_enrollments WHERE "studentId" = p_canonical_id AND "effectiveTo" IS NULL;
  SELECT count(*) INTO v_open_dup_cnt FROM public.student_enrollments WHERE "studentId" = p_duplicate_id AND "effectiveTo" IS NULL;
  IF v_open_can_cnt > 1 OR v_open_dup_cnt > 1 THEN
    RAISE EXCEPTION 'Merge blocked: multiple open enrollments detected (canonical % open, duplicate % open). Manual review required.', v_open_can_cnt, v_open_dup_cnt
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF v_open_can."className" IS NOT NULL AND v_open_dup."className" IS NOT NULL THEN
    IF v_open_can."className" <> v_open_dup."className"
       OR v_open_can."academicYearId" IS DISTINCT FROM v_open_dup."academicYearId" THEN
      RAISE EXCEPTION 'Merge blocked: enrollment histories are contradictory (% vs % / year % vs %). ENROLLMENT_CONFLICT.', v_open_can."className", v_open_dup."className", COALESCE(v_open_can."academicYearId",'null'), COALESCE(v_open_dup."academicYearId",'null')
        USING ERRCODE = 'integrity_constraint_violation';
    END IF;
  END IF;
  SELECT count(*) INTO v_hist_can FROM public.student_enrollments WHERE "studentId" = p_canonical_id AND "effectiveTo" IS NOT NULL;
  SELECT count(*) INTO v_hist_dup FROM public.student_enrollments WHERE "studentId" = p_duplicate_id AND "effectiveTo" IS NOT NULL;

  -- Snapshot before counts
  v_before_counts := jsonb_build_object(
    'exams', jsonb_build_object('canonical', (SELECT count(*) FROM public.exams WHERE "studentId"=p_canonical_id), 'duplicate', (SELECT count(*) FROM public.exams WHERE "studentId"=p_duplicate_id)),
    'attendance', jsonb_build_object('canonical', (SELECT count(*) FROM public.attendance WHERE "studentId"=p_canonical_id), 'duplicate', (SELECT count(*) FROM public.attendance WHERE "studentId"=p_duplicate_id)),
    'homework', jsonb_build_object('canonical', (SELECT count(*) FROM public.homework WHERE "studentId"=p_canonical_id), 'duplicate', (SELECT count(*) FROM public.homework WHERE "studentId"=p_duplicate_id)),
    'promotions', jsonb_build_object('canonical', (SELECT count(*) FROM public.student_promotions WHERE "studentId"=p_canonical_id), 'duplicate', (SELECT count(*) FROM public.student_promotions WHERE "studentId"=p_duplicate_id)),
    'quizAttempts', jsonb_build_object('canonical', (SELECT count(*) FROM public.quiz_attempts WHERE "studentId"=p_canonical_id), 'duplicate', (SELECT count(*) FROM public.quiz_attempts WHERE "studentId"=p_duplicate_id)),
    'authorizedPickups', jsonb_build_object('canonical', (SELECT count(*) FROM public.authorized_pickup_students WHERE "studentId"=p_canonical_id), 'duplicate', (SELECT count(*) FROM public.authorized_pickup_students WHERE "studentId"=p_duplicate_id)),
    'releaseLogs', jsonb_build_object('canonical', (SELECT count(*) FROM public.release_log WHERE "studentId"=p_canonical_id), 'duplicate', (SELECT count(*) FROM public.release_log WHERE "studentId"=p_duplicate_id)),
    'reportComments', jsonb_build_object('canonical', (SELECT count(*) FROM public.report_comments WHERE "studentId"=p_canonical_id), 'duplicate', (SELECT count(*) FROM public.report_comments WHERE "studentId"=p_duplicate_id)),
    'enrollments', jsonb_build_object('canonicalOpen', CASE WHEN v_open_can.id IS NOT NULL THEN jsonb_build_object('className', v_open_can."className") ELSE NULL END, 'duplicateOpen', CASE WHEN v_open_dup.id IS NOT NULL THEN jsonb_build_object('className', v_open_dup."className") ELSE NULL END, 'canonicalHistory', v_hist_can, 'duplicateHistory', v_hist_dup)
  );

  v_enroll_action := jsonb_build_object(
    'canonicalOpen', CASE WHEN v_open_can.id IS NOT NULL THEN jsonb_build_object('className', v_open_can."className", 'academicYearId', v_open_can."academicYearId") ELSE NULL END,
    'duplicateOpen', CASE WHEN v_open_dup.id IS NOT NULL THEN jsonb_build_object('className', v_open_dup."className", 'academicYearId', v_open_dup."academicYearId") ELSE NULL END,
    'action', CASE WHEN v_open_dup.id IS NOT NULL AND v_open_can.id IS NOT NULL AND v_open_can."className" = v_open_dup."className" AND v_open_can."academicYearId" IS NOT DISTINCT FROM v_open_dup."academicYearId" THEN 'consolidate'
                 WHEN v_open_dup.id IS NOT NULL AND v_open_can.id IS NULL THEN 'transfer'
                 WHEN v_open_dup.id IS NULL THEN 'preserve_history'
                 ELSE 'blocked' END,
    'willConsolidate', (v_open_dup.id IS NOT NULL AND v_open_can.id IS NOT NULL AND v_open_can."className" = v_open_dup."className" AND v_open_can."academicYearId" IS NOT DISTINCT FROM v_open_dup."academicYearId")
  );

  -- Preserve Gov ID if canonical blank and duplicate has one (avoid unique violation by nulling duplicate first)
  IF v_can."govId" IS NULL AND v_dup."govId" IS NOT NULL THEN
    UPDATE public.students SET "govId" = NULL WHERE id = p_duplicate_id;
    UPDATE public.students SET "govId" = v_dup."govId" WHERE id = p_canonical_id;
  END IF;

  -- ── Enrollment consolidation ──────────────────────────────────────────
  -- Delete duplicate open enrollment (consolidate), then transfer historical
  -- Consolidate ONLY when same className AND same academicYearId
  IF v_open_dup.id IS NOT NULL THEN
    IF v_open_can.id IS NOT NULL AND v_open_can."className" = v_open_dup."className" AND v_open_can."academicYearId" IS NOT DISTINCT FROM v_open_dup."academicYearId" THEN
      DELETE FROM public.student_enrollments WHERE "studentId" = p_duplicate_id AND "effectiveTo" IS NULL;
    ELSE
      -- If canonical has no open (should not happen for duplicate group) we can transfer open
      UPDATE public.student_enrollments SET "studentId" = p_canonical_id WHERE "studentId" = p_duplicate_id AND "effectiveTo" IS NULL;
    END IF;
  END IF;
  -- Transfer remaining historical enrollments
  UPDATE public.student_enrollments SET "studentId" = p_canonical_id WHERE "studentId" = p_duplicate_id;

  -- ── Transfer safe history ─────────────────────────────────────────────
  UPDATE public.exams SET "studentId" = p_canonical_id WHERE "studentId" = p_duplicate_id;
  UPDATE public.attendance SET "studentId" = p_canonical_id WHERE "studentId" = p_duplicate_id;
  UPDATE public.homework SET "studentId" = p_canonical_id WHERE "studentId" = p_duplicate_id;
  UPDATE public.student_promotions SET "studentId" = p_canonical_id WHERE "studentId" = p_duplicate_id;
  UPDATE public.quiz_attempts SET "studentId" = p_canonical_id WHERE "studentId" = p_duplicate_id;
  UPDATE public.report_comments SET "studentId" = p_canonical_id WHERE "studentId" = p_duplicate_id;
  UPDATE public.release_log SET "studentId" = p_canonical_id WHERE "studentId" = p_duplicate_id;

  -- Authorized pickups: avoid PK conflict
  INSERT INTO public.authorized_pickup_students ("authorizedPickupId", "studentId")
  SELECT "authorizedPickupId", p_canonical_id
  FROM public.authorized_pickup_students
  WHERE "studentId" = p_duplicate_id
  ON CONFLICT DO NOTHING;
  DELETE FROM public.authorized_pickup_students WHERE "studentId" = p_duplicate_id;

  -- ── Audit ─────────────────────────────────────────────────────────────
  v_audit_id := 'merge-' || floor(extract(epoch FROM clock_timestamp())*1000)::text || '-' || substr(md5(random()::text || p_canonical_id),1,8);

  -- Recompute after counts for audit
  v_after := jsonb_build_object(
    'exams', (SELECT count(*) FROM public.exams WHERE "studentId"=p_canonical_id),
    'attendance', (SELECT count(*) FROM public.attendance WHERE "studentId"=p_canonical_id),
    'homework', (SELECT count(*) FROM public.homework WHERE "studentId"=p_canonical_id),
    'promotions', (SELECT count(*) FROM public.student_promotions WHERE "studentId"=p_canonical_id),
    'quizAttempts', (SELECT count(*) FROM public.quiz_attempts WHERE "studentId"=p_canonical_id),
    'authorizedPickups', (SELECT count(*) FROM public.authorized_pickup_students WHERE "studentId"=p_canonical_id),
    'releaseLogs', (SELECT count(*) FROM public.release_log WHERE "studentId"=p_canonical_id),
    'reportComments', (SELECT count(*) FROM public.report_comments WHERE "studentId"=p_canonical_id),
    'enrollments', (SELECT count(*) FROM public.student_enrollments WHERE "studentId"=p_canonical_id)
  );

  INSERT INTO public.student_merge_audits (id, canonical_id, duplicate_id, admin_id, reason, before_counts, after_counts, enrollment_action, exam_conflicts, created_at)
  VALUES (v_audit_id, p_canonical_id, p_duplicate_id, v_actor, p_reason, v_before_counts, v_after, v_enroll_action, jsonb_build_object('examConflicts', v_exams_conflicts), NOW());

  INSERT INTO public.audit_logs (action, details, "createdAt")
  VALUES ('students.merge', jsonb_build_object('auditId', v_audit_id, 'canonicalId', p_canonical_id, 'duplicateId', p_duplicate_id, 'actor', v_actor, 'reason', p_reason, 'before', v_before_counts, 'after', v_after, 'enrollmentAction', v_enroll_action), NOW());

  -- ── Zero-dependency verification ──────────────────────────────────────
  SELECT count(*) INTO v_count FROM public.exams WHERE "studentId" = p_duplicate_id;
  IF v_count > 0 THEN RAISE EXCEPTION 'Post-merge verification failed: duplicate still has % exams.', v_count USING ERRCODE = 'integrity_constraint_violation'; END IF;
  SELECT count(*) INTO v_count FROM public.attendance WHERE "studentId" = p_duplicate_id;
  IF v_count > 0 THEN RAISE EXCEPTION 'Post-merge verification failed: duplicate still has % attendance.', v_count USING ERRCODE = 'integrity_constraint_violation'; END IF;
  SELECT count(*) INTO v_count FROM public.homework WHERE "studentId" = p_duplicate_id;
  IF v_count > 0 THEN RAISE EXCEPTION 'Post-merge verification failed: duplicate still has % homework.', v_count USING ERRCODE = 'integrity_constraint_violation'; END IF;
  SELECT count(*) INTO v_count FROM public.student_promotions WHERE "studentId" = p_duplicate_id;
  IF v_count > 0 THEN RAISE EXCEPTION 'Post-merge verification failed: duplicate still has % promotions.', v_count USING ERRCODE = 'integrity_constraint_violation'; END IF;
  SELECT count(*) INTO v_count FROM public.quiz_attempts WHERE "studentId" = p_duplicate_id;
  IF v_count > 0 THEN RAISE EXCEPTION 'Post-merge verification failed: duplicate still has % quiz attempts.', v_count USING ERRCODE = 'integrity_constraint_violation'; END IF;
  SELECT count(*) INTO v_count FROM public.authorized_pickup_students WHERE "studentId" = p_duplicate_id;
  IF v_count > 0 THEN RAISE EXCEPTION 'Post-merge verification failed: duplicate still has % pickup links.', v_count USING ERRCODE = 'integrity_constraint_violation'; END IF;
  SELECT count(*) INTO v_count FROM public.release_log WHERE "studentId" = p_duplicate_id;
  IF v_count > 0 THEN RAISE EXCEPTION 'Post-merge verification failed: duplicate still has % release logs.', v_count USING ERRCODE = 'integrity_constraint_violation'; END IF;
  SELECT count(*) INTO v_count FROM public.report_comments WHERE "studentId" = p_duplicate_id;
  IF v_count > 0 THEN RAISE EXCEPTION 'Post-merge verification failed: duplicate still has % report comments.', v_count USING ERRCODE = 'integrity_constraint_violation'; END IF;
  SELECT count(*) INTO v_count FROM public.student_enrollments WHERE "studentId" = p_duplicate_id;
  IF v_count > 0 THEN RAISE EXCEPTION 'Post-merge verification failed: duplicate still has % enrollments.', v_count USING ERRCODE = 'integrity_constraint_violation'; END IF;

  -- ── Delete duplicate (zero-dependency guard passed) ──────────────────
  DELETE FROM public.students WHERE id = p_duplicate_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Failed to delete duplicate student %.', p_duplicate_id USING ERRCODE = 'integrity_constraint_violation'; END IF;

  -- Post-merge verification: canonical exists, duplicate gone, one open enrollment
  PERFORM 1 FROM public.students WHERE id = p_canonical_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Post-merge verification failed: canonical % not found after merge.', p_canonical_id USING ERRCODE = 'integrity_constraint_violation'; END IF;
  PERFORM 1 FROM public.students WHERE id = p_duplicate_id;
  IF FOUND THEN RAISE EXCEPTION 'Post-merge verification failed: duplicate % still exists.', p_duplicate_id USING ERRCODE = 'integrity_constraint_violation'; END IF;

  RETURN jsonb_build_object(
    'auditId', v_audit_id,
    'canonicalId', p_canonical_id,
    'duplicateId', p_duplicate_id,
    'before', v_before_counts,
    'after', v_after,
    'enrollmentAction', v_enroll_action,
    'createdAt', NOW()
  );
END;
$$;

REVOKE ALL ON FUNCTION public.merge_duplicate_students(TEXT,TEXT,TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.merge_duplicate_students(TEXT,TEXT,TEXT) TO authenticated;

-- Also expose legacy alias for UI that may call merge_student or merge_students
CREATE OR REPLACE FUNCTION public.merge_students(
  p_canonical_id TEXT,
  p_duplicate_id TEXT,
  p_reason TEXT DEFAULT NULL
) RETURNS JSONB
LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
  SELECT public.merge_duplicate_students(p_canonical_id, p_duplicate_id, p_reason);
$$;
REVOKE ALL ON FUNCTION public.merge_students(TEXT,TEXT,TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.merge_students(TEXT,TEXT,TEXT) TO authenticated;

-- Dry-run variant that remains read-only (alias for preview, explicit name for tests)
CREATE OR REPLACE FUNCTION public.preview_merge(
  p_canonical_id TEXT,
  p_duplicate_id TEXT
) RETURNS JSONB
LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
  SELECT public.preview_student_merge(p_canonical_id, p_duplicate_id);
$$;
REVOKE ALL ON FUNCTION public.preview_merge(TEXT,TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.preview_merge(TEXT,TEXT) TO authenticated;

-- ─── 5. Grants consistency ───────────────────────────────────────────────
DO $$
DECLARE f TEXT;
BEGIN
  FOREACH f IN ARRAY ARRAY[
    'public.get_duplicate_candidates()',
    'public.preview_student_merge(TEXT,TEXT)',
    'public.merge_duplicate_students(TEXT,TEXT,TEXT)',
    'public.merge_students(TEXT,TEXT,TEXT)',
    'public.preview_merge(TEXT,TEXT)'
  ] LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', f);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO authenticated', f);
  END LOOP;
END $$;

