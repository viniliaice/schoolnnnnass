-- ============================================================================
-- Migration 20260920 — Safe Student Duplicate Merge + Audit
-- ============================================================================
-- Implements:
--   * student_merge_audit table
--   * merge_duplicate_student() RPC (dry_run default true, transaction-safe)
--   * list_duplicate_students() RPC to enumerate candidate duplicate groups
--   * hardening of SECURITY DEFINER surface
-- ============================================================================

-- ─── 1. Audit table ─────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.student_merge_audit (
  id TEXT PRIMARY KEY,
  canonical_student_id TEXT NOT NULL REFERENCES public.students(id) ON DELETE SET NULL,
  duplicate_student_id TEXT NOT NULL,
  performed_by TEXT REFERENCES public.profiles(id) ON DELETE SET NULL,
  merged_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  reason TEXT,
  source TEXT,
  before_counts JSONB NOT NULL DEFAULT '{}'::jsonb,
  after_counts JSONB NOT NULL DEFAULT '{}'::jsonb,
  enrollment_actions JSONB NOT NULL DEFAULT '{}'::jsonb,
  conflicts JSONB NOT NULL DEFAULT '[]'::jsonb,
  details JSONB NOT NULL DEFAULT '{}'::jsonb
);

-- Robustness for existing table with different schema (e.g., from earlier version)
DO $$
BEGIN
  -- Add missing columns if table existed with different schema
  ALTER TABLE public.student_merge_audit ADD COLUMN IF NOT EXISTS canonical_student_id TEXT;
  ALTER TABLE public.student_merge_audit ADD COLUMN IF NOT EXISTS duplicate_student_id TEXT;
  ALTER TABLE public.student_merge_audit ADD COLUMN IF NOT EXISTS performed_by TEXT;
  ALTER TABLE public.student_merge_audit ADD COLUMN IF NOT EXISTS merged_at TIMESTAMPTZ DEFAULT NOW();
  ALTER TABLE public.student_merge_audit ADD COLUMN IF NOT EXISTS reason TEXT;
  ALTER TABLE public.student_merge_audit ADD COLUMN IF NOT EXISTS source TEXT;
  ALTER TABLE public.student_merge_audit ADD COLUMN IF NOT EXISTS before_counts JSONB DEFAULT '{}'::jsonb;
  ALTER TABLE public.student_merge_audit ADD COLUMN IF NOT EXISTS after_counts JSONB DEFAULT '{}'::jsonb;
  ALTER TABLE public.student_merge_audit ADD COLUMN IF NOT EXISTS enrollment_actions JSONB DEFAULT '{}'::jsonb;
  ALTER TABLE public.student_merge_audit ADD COLUMN IF NOT EXISTS conflicts JSONB DEFAULT '[]'::jsonb;
  ALTER TABLE public.student_merge_audit ADD COLUMN IF NOT EXISTS details JSONB DEFAULT '{}'::jsonb;
EXCEPTION WHEN OTHERS THEN
  -- Ignore if table doesn't exist yet or other errors
  NULL;
END $$;

CREATE INDEX IF NOT EXISTS idx_student_merge_audit_canonical ON public.student_merge_audit (canonical_student_id);
CREATE INDEX IF NOT EXISTS idx_student_merge_audit_duplicate ON public.student_merge_audit (duplicate_student_id);
CREATE INDEX IF NOT EXISTS idx_student_merge_audit_merged_at ON public.student_merge_audit (merged_at DESC);

ALTER TABLE public.student_merge_audit ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "merge_audit_staff_read" ON public.student_merge_audit;
CREATE POLICY "merge_audit_staff_read" ON public.student_merge_audit
  FOR SELECT TO authenticated
  USING (public.current_profile_role() IN ('admin','supervisor','office'));

-- No direct INSERT/UPDATE/DELETE policies: only SECURITY DEFINER RPC writes.

-- ─── 2. Helper: class match key (same normalization as name) ───────────────
CREATE OR REPLACE FUNCTION public.class_match_key(p_t TEXT)
RETURNS TEXT LANGUAGE sql IMMUTABLE SET search_path = public AS $$
  SELECT btrim(regexp_replace(lower(COALESCE(p_t,'')), '\s+', ' ', 'g'));
$$;

DO $$
BEGIN
  EXECUTE 'REVOKE ALL ON FUNCTION public.class_match_key(TEXT) FROM PUBLIC';
END $$;

-- ─── 3. Merge RPC ───────────────────────────────────────────────────────────
-- Transaction-safe, row-locking, dry-run default.
-- Returns JSONB with can_merge, counts, actions, conflicts, enrollment_action.
-- For dry_run=false, performs the actual merge and audit, then deletes duplicate.

CREATE OR REPLACE FUNCTION public.merge_duplicate_student(
  p_canonical_id TEXT,
  p_duplicate_id TEXT,
  p_dry_run BOOLEAN DEFAULT true,
  p_reason TEXT DEFAULT NULL,
  p_source TEXT DEFAULT 'admin_ui'
) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_actor TEXT;
  v_role TEXT;
  v_canonical RECORD;
  v_duplicate RECORD;
  v_canonical_name_key TEXT;
  v_duplicate_name_key TEXT;
  v_canonical_class_key TEXT;
  v_duplicate_class_key TEXT;

  -- counts
  v_exam_canonical INT; v_exam_duplicate INT;
  v_att_canonical INT; v_att_duplicate INT;
  v_hw_canonical INT; v_hw_duplicate INT;
  v_enr_canonical INT; v_enr_duplicate INT;
  v_promo_canonical INT; v_promo_duplicate INT;
  v_quiz_canonical INT; v_quiz_duplicate INT;
  v_pickup_canonical INT; v_pickup_duplicate INT;
  v_release_canonical INT; v_release_duplicate INT;
  v_report_canonical INT; v_report_duplicate INT;

  v_before_counts JSONB;
  v_after_counts JSONB;
  v_enrollment_action JSONB := '{}'::jsonb;
  v_conflicts JSONB := '[]'::jsonb;
  v_can_merge BOOLEAN := true;

  v_canonical_open RECORD;
  v_duplicate_open RECORD;
  v_canonical_open_count INT;
  v_duplicate_open_count INT;
  v_enrollment_consolidate_id TEXT;

  v_exam_conflict_rows JSONB := '[]'::jsonb;
  v_att_conflict_rows JSONB := '[]'::jsonb;
  v_quiz_conflict_rows JSONB := '[]'::jsonb;
  v_release_conflict_rows JSONB := '[]'::jsonb;
  v_report_conflict_rows JSONB := '[]'::jsonb;
  v_enrollment_conflict_detail JSONB := '{}'::jsonb;

  v_actions JSONB := '{}'::jsonb;
  v_details JSONB := '{}'::jsonb;
  v_audit_id TEXT;
  v_transferred_counts JSONB := '{}'::jsonb;
  v_consolidated_counts JSONB := '{}'::jsonb;

  r RECORD;
BEGIN
  -- ── Authorization ────────────────────────────────────────────────────────
  v_actor := public.current_profile_id();
  v_role := public.current_profile_role();
  IF v_role IS NULL OR v_role NOT IN ('admin','supervisor') THEN
    RAISE EXCEPTION 'Only administrators may merge duplicate students.' USING ERRCODE='insufficient_privilege';
  END IF;

  IF p_canonical_id IS NULL OR p_duplicate_id IS NULL OR btrim(p_canonical_id)='' OR btrim(p_duplicate_id)='' THEN
    RAISE EXCEPTION 'Both canonical and duplicate student IDs are required.' USING ERRCODE='invalid_parameter_value';
  END IF;
  IF p_canonical_id = p_duplicate_id THEN
    RAISE EXCEPTION 'Canonical and duplicate IDs must differ.' USING ERRCODE='invalid_parameter_value';
  END IF;

  -- ── Lock both students in deterministic order to avoid deadlock ─────────
  PERFORM 1 FROM public.students WHERE id IN (p_canonical_id, p_duplicate_id) ORDER BY id FOR UPDATE;

  SELECT * INTO v_canonical FROM public.students WHERE id = p_canonical_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object(
      'can_merge', false,
      'canonical_student_id', p_canonical_id,
      'duplicate_student_id', p_duplicate_id,
      'reason', 'canonical_not_found',
      'conflicts', jsonb_build_array(jsonb_build_object('type','canonical_not_found','id',p_canonical_id))
    );
  END IF;

  SELECT * INTO v_duplicate FROM public.students WHERE id = p_duplicate_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object(
      'can_merge', false,
      'canonical_student_id', p_canonical_id,
      'duplicate_student_id', p_duplicate_id,
      'reason', 'duplicate_not_found',
      'conflicts', jsonb_build_array(jsonb_build_object('type','duplicate_not_found','id',p_duplicate_id))
    );
  END IF;

  -- ── Validation ───────────────────────────────────────────────────────────
  IF v_canonical."parentId" IS NULL THEN
    v_can_merge := false;
    v_conflicts := v_conflicts || jsonb_build_object('type','canonical_missing_parent','canonical_student_id',p_canonical_id);
  END IF;
  IF v_duplicate."parentId" IS NOT NULL THEN
    v_can_merge := false;
    v_conflicts := v_conflicts || jsonb_build_object('type','duplicate_has_parent','duplicate_student_id',p_duplicate_id,'parentId',v_duplicate."parentId");
  END IF;

  v_canonical_name_key := public.name_match_key(v_canonical.name);
  v_duplicate_name_key := public.name_match_key(v_duplicate.name);
  v_canonical_class_key := public.class_match_key(v_canonical."className");
  v_duplicate_class_key := public.class_match_key(v_duplicate."className");

  IF v_canonical_name_key IS DISTINCT FROM v_duplicate_name_key THEN
    v_can_merge := false;
    v_conflicts := v_conflicts || jsonb_build_object('type','name_mismatch','canonical_name',v_canonical.name,'duplicate_name',v_duplicate.name,'canonical_key',v_canonical_name_key,'duplicate_key',v_duplicate_name_key);
  END IF;
  IF v_canonical_class_key IS DISTINCT FROM v_duplicate_class_key THEN
    v_can_merge := false;
    v_conflicts := v_conflicts || jsonb_build_object('type','class_mismatch','canonical_class',v_canonical."className",'duplicate_class',v_duplicate."className");
  END IF;

  -- ── Dependent counts ─────────────────────────────────────────────────────
  SELECT count(*) INTO v_exam_canonical FROM public.exams WHERE "studentId" = p_canonical_id;
  SELECT count(*) INTO v_exam_duplicate FROM public.exams WHERE "studentId" = p_duplicate_id;
  SELECT count(*) INTO v_att_canonical FROM public.attendance WHERE "studentId" = p_canonical_id;
  SELECT count(*) INTO v_att_duplicate FROM public.attendance WHERE "studentId" = p_duplicate_id;
  SELECT count(*) INTO v_hw_canonical FROM public.homework WHERE "studentId" = p_canonical_id;
  SELECT count(*) INTO v_hw_duplicate FROM public.homework WHERE "studentId" = p_duplicate_id;
  SELECT count(*) INTO v_enr_canonical FROM public.student_enrollments WHERE "studentId" = p_canonical_id;
  SELECT count(*) INTO v_enr_duplicate FROM public.student_enrollments WHERE "studentId" = p_duplicate_id;
  SELECT count(*) INTO v_promo_canonical FROM public.student_promotions WHERE "studentId" = p_canonical_id;
  SELECT count(*) INTO v_promo_duplicate FROM public.student_promotions WHERE "studentId" = p_duplicate_id;
  SELECT count(*) INTO v_quiz_canonical FROM public.quiz_attempts WHERE "studentId" = p_canonical_id;
  SELECT count(*) INTO v_quiz_duplicate FROM public.quiz_attempts WHERE "studentId" = p_duplicate_id;
  SELECT count(*) INTO v_pickup_canonical FROM public.authorized_pickup_students WHERE "studentId" = p_canonical_id;
  SELECT count(*) INTO v_pickup_duplicate FROM public.authorized_pickup_students WHERE "studentId" = p_duplicate_id;
  SELECT count(*) INTO v_release_canonical FROM public.release_log WHERE "studentId" = p_canonical_id;
  SELECT count(*) INTO v_release_duplicate FROM public.release_log WHERE "studentId" = p_duplicate_id;
  SELECT count(*) INTO v_report_canonical FROM public.report_comments WHERE "studentId" = p_canonical_id;
  SELECT count(*) INTO v_report_duplicate FROM public.report_comments WHERE "studentId" = p_duplicate_id;

  v_before_counts := jsonb_build_object(
    'exams', jsonb_build_object('canonical', v_exam_canonical, 'duplicate', v_exam_duplicate),
    'attendance', jsonb_build_object('canonical', v_att_canonical, 'duplicate', v_att_duplicate),
    'homework', jsonb_build_object('canonical', v_hw_canonical, 'duplicate', v_hw_duplicate),
    'enrollments', jsonb_build_object('canonical', v_enr_canonical, 'duplicate', v_enr_duplicate),
    'promotions', jsonb_build_object('canonical', v_promo_canonical, 'duplicate', v_promo_duplicate),
    'quiz_attempts', jsonb_build_object('canonical', v_quiz_canonical, 'duplicate', v_quiz_duplicate),
    'authorized_pickup_students', jsonb_build_object('canonical', v_pickup_canonical, 'duplicate', v_pickup_duplicate),
    'release_log', jsonb_build_object('canonical', v_release_canonical, 'duplicate', v_release_duplicate),
    'report_comments', jsonb_build_object('canonical', v_report_canonical, 'duplicate', v_report_duplicate)
  );

  -- ── Enrollment handling ──────────────────────────────────────────────────
  SELECT count(*) INTO v_canonical_open_count FROM public.student_enrollments WHERE "studentId" = p_canonical_id AND "effectiveTo" IS NULL;
  SELECT count(*) INTO v_duplicate_open_count FROM public.student_enrollments WHERE "studentId" = p_duplicate_id AND "effectiveTo" IS NULL;

  IF v_canonical_open_count > 1 OR v_duplicate_open_count > 1 THEN
    v_can_merge := false;
    v_conflicts := v_conflicts || jsonb_build_object('type','multiple_open_enrollments','canonical_open_count',v_canonical_open_count,'duplicate_open_count',v_duplicate_open_count);
    v_enrollment_action := jsonb_build_object('type','multiple_open_conflict','canonical_open_count',v_canonical_open_count,'duplicate_open_count',v_duplicate_open_count);
  ELSE
    SELECT * INTO v_canonical_open FROM public.student_enrollments WHERE "studentId" = p_canonical_id AND "effectiveTo" IS NULL LIMIT 1;
    SELECT * INTO v_duplicate_open FROM public.student_enrollments WHERE "studentId" = p_duplicate_id AND "effectiveTo" IS NULL LIMIT 1;

    IF v_canonical_open_count = 1 AND v_duplicate_open_count = 1 THEN
      IF v_canonical_open."className" = v_duplicate_open."className"
         AND v_canonical_open."academicYearId" IS NOT DISTINCT FROM v_duplicate_open."academicYearId" THEN
        v_enrollment_action := jsonb_build_object(
          'type', 'consolidate_duplicate_open',
          'keep_enrollment_id', v_canonical_open.id,
          'consolidate_enrollment_id', v_duplicate_open.id,
          'keep', jsonb_build_object('id', v_canonical_open.id, 'className', v_canonical_open."className", 'academicYearId', v_canonical_open."academicYearId", 'effectiveFrom', v_canonical_open."effectiveFrom", 'reason', v_canonical_open.reason, 'sourceRef', v_canonical_open."sourceRef"),
          'consolidate', jsonb_build_object('id', v_duplicate_open.id, 'className', v_duplicate_open."className", 'academicYearId', v_duplicate_open."academicYearId", 'effectiveFrom', v_duplicate_open."effectiveFrom", 'effectiveTo', v_duplicate_open."effectiveTo", 'reason', v_duplicate_open.reason, 'sourceRef', v_duplicate_open."sourceRef")
        );
        v_enrollment_consolidate_id := v_duplicate_open.id;
        v_consolidated_counts := jsonb_build_object('enrollments', 1);
      ELSE
        v_can_merge := false;
        v_conflicts := v_conflicts || jsonb_build_object(
          'type','enrollment_conflict',
          'canonical_enrollment', jsonb_build_object('id', v_canonical_open.id, 'className', v_canonical_open."className", 'academicYearId', v_canonical_open."academicYearId", 'effectiveFrom', v_canonical_open."effectiveFrom"),
          'duplicate_enrollment', jsonb_build_object('id', v_duplicate_open.id, 'className', v_duplicate_open."className", 'academicYearId', v_duplicate_open."academicYearId", 'effectiveFrom', v_duplicate_open."effectiveFrom")
        );
        v_enrollment_action := jsonb_build_object('type','conflict','reason','open_enrollment_mismatch','canonical', jsonb_build_object('id', v_canonical_open.id, 'className', v_canonical_open."className", 'academicYearId', v_canonical_open."academicYearId"), 'duplicate', jsonb_build_object('id', v_duplicate_open.id, 'className', v_duplicate_open."className", 'academicYearId', v_duplicate_open."academicYearId"));
      END IF;
    ELSIF v_canonical_open_count = 0 AND v_duplicate_open_count = 1 THEN
      v_enrollment_action := jsonb_build_object('type','repoint_duplicate_open_to_canonical','enrollment_id', v_duplicate_open.id, 'enrollment', jsonb_build_object('id', v_duplicate_open.id, 'className', v_duplicate_open."className", 'academicYearId', v_duplicate_open."academicYearId"));
    ELSIF v_canonical_open_count = 1 AND v_duplicate_open_count = 0 THEN
      v_enrollment_action := jsonb_build_object('type','keep_canonical_open','enrollment_id', v_canonical_open.id);
    ELSE
      v_enrollment_action := jsonb_build_object('type','no_open_enrollment');
    END IF;
  END IF;

  -- ── Exam conflicts ───────────────────────────────────────────────────────
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'type','EXAM_CONFLICT',
    'subjectId', d."subjectId",
    'examType', d."examType",
    'assessmentLabel', d."assessmentLabel",
    'termId', d."termId",
    'canonicalExamId', c.id,
    'duplicateExamId', d.id,
    'canonicalScore', c.score,
    'duplicateScore', d.score
  )), '[]'::jsonb) INTO v_exam_conflict_rows
  FROM public.exams d
  JOIN public.exams c ON c."studentId" = p_canonical_id
    AND c."subjectId" IS NOT DISTINCT FROM d."subjectId"
    AND c."examType" = d."examType"
    AND c."assessmentLabel" IS NOT DISTINCT FROM d."assessmentLabel"
    AND c."termId" IS NOT DISTINCT FROM d."termId"
  WHERE d."studentId" = p_duplicate_id;

  IF jsonb_array_length(v_exam_conflict_rows) > 0 THEN
    v_can_merge := false;
    v_conflicts := v_conflicts || v_exam_conflict_rows;
  END IF;

  -- ── Attendance conflicts (same date) ─────────────────────────────────────
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'type','ATTENDANCE_CONFLICT',
    'date', d.date,
    'canonicalAttendanceId', c.id,
    'duplicateAttendanceId', d.id,
    'canonicalStatus', c.status,
    'duplicateStatus', d.status
  )), '[]'::jsonb) INTO v_att_conflict_rows
  FROM public.attendance d
  JOIN public.attendance c ON c."studentId" = p_canonical_id AND c.date = d.date
  WHERE d."studentId" = p_duplicate_id;

  IF jsonb_array_length(v_att_conflict_rows) > 0 THEN
    v_can_merge := false;
    v_conflicts := v_conflicts || v_att_conflict_rows;
  END IF;

  -- ── Quiz attempt conflicts ───────────────────────────────────────────────
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'type','QUIZ_CONFLICT',
    'quizId', d."quizId",
    'canonicalAttemptId', c.id,
    'duplicateAttemptId', d.id
  )), '[]'::jsonb) INTO v_quiz_conflict_rows
  FROM public.quiz_attempts d
  JOIN public.quiz_attempts c ON c."studentId" = p_canonical_id AND c."quizId" = d."quizId"
  WHERE d."studentId" = p_duplicate_id;

  IF jsonb_array_length(v_quiz_conflict_rows) > 0 THEN
    v_can_merge := false;
    v_conflicts := v_conflicts || v_quiz_conflict_rows;
  END IF;

  -- ── Release log conflicts (same UTC date) ────────────────────────────────
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'type','RELEASE_CONFLICT',
    'date', (d."createdAt" AT TIME ZONE 'UTC')::date,
    'canonicalReleaseId', c.id,
    'duplicateReleaseId', d.id
  )), '[]'::jsonb) INTO v_release_conflict_rows
  FROM public.release_log d
  JOIN public.release_log c ON c."studentId" = p_canonical_id AND (c."createdAt" AT TIME ZONE 'UTC')::date = (d."createdAt" AT TIME ZONE 'UTC')::date
  WHERE d."studentId" = p_duplicate_id;

  IF jsonb_array_length(v_release_conflict_rows) > 0 THEN
    v_can_merge := false;
    v_conflicts := v_conflicts || v_release_conflict_rows;
  END IF;

  -- ── Report comment conflicts (same term + same examId) ───────────────────
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'type','REPORT_COMMENT_CONFLICT',
    'termId', d."termId",
    'examId', d."examId",
    'canonicalCommentId', c.id,
    'duplicateCommentId', d.id
  )), '[]'::jsonb) INTO v_report_conflict_rows
  FROM public.report_comments d
  JOIN public.report_comments c ON c."studentId" = p_canonical_id
    AND c."termId" = d."termId"
    AND c."examId" IS NOT DISTINCT FROM d."examId"
  WHERE d."studentId" = p_duplicate_id;

  IF jsonb_array_length(v_report_conflict_rows) > 0 THEN
    v_can_merge := false;
    v_conflicts := v_conflicts || v_report_conflict_rows;
  END IF;

  -- ── Build actions for dry-run ────────────────────────────────────────────
  v_actions := jsonb_build_object(
    'exams_to_transfer', CASE WHEN v_can_merge THEN v_exam_duplicate - jsonb_array_length(v_exam_conflict_rows) ELSE 0 END,
    'attendance_to_transfer', CASE WHEN v_can_merge THEN v_att_duplicate - jsonb_array_length(v_att_conflict_rows) ELSE 0 END,
    'homework_to_transfer', CASE WHEN v_can_merge THEN v_hw_duplicate ELSE 0 END,
    'promotions_to_transfer', CASE WHEN v_can_merge THEN v_promo_duplicate ELSE 0 END,
    'quiz_attempts_to_transfer', CASE WHEN v_can_merge THEN v_quiz_duplicate - jsonb_array_length(v_quiz_conflict_rows) ELSE 0 END,
    'pickup_links_to_transfer', CASE WHEN v_can_merge THEN v_pickup_duplicate ELSE 0 END,
    'release_logs_to_transfer', CASE WHEN v_can_merge THEN v_release_duplicate - jsonb_array_length(v_release_conflict_rows) ELSE 0 END,
    'report_comments_to_transfer', CASE WHEN v_can_merge THEN v_report_duplicate - jsonb_array_length(v_report_conflict_rows) ELSE 0 END,
    'enrollments_to_transfer', CASE WHEN v_can_merge THEN
        CASE WHEN v_enrollment_consolidate_id IS NOT NULL THEN v_enr_duplicate - 1 ELSE v_enr_duplicate END
      ELSE 0 END,
    'enrollments_consolidated', CASE WHEN v_enrollment_consolidate_id IS NOT NULL THEN 1 ELSE 0 END
  );

  -- Projected after counts for dry-run
  IF v_can_merge THEN
    v_after_counts := jsonb_build_object(
      'exams', jsonb_build_object('canonical', v_exam_canonical + (v_exam_duplicate - jsonb_array_length(v_exam_conflict_rows)), 'duplicate', 0),
      'attendance', jsonb_build_object('canonical', v_att_canonical + (v_att_duplicate - jsonb_array_length(v_att_conflict_rows)), 'duplicate', 0),
      'homework', jsonb_build_object('canonical', v_hw_canonical + v_hw_duplicate, 'duplicate', 0),
      'enrollments', jsonb_build_object('canonical', v_enr_canonical + CASE WHEN v_enrollment_consolidate_id IS NOT NULL THEN v_enr_duplicate - 1 ELSE v_enr_duplicate END, 'duplicate', 0),
      'promotions', jsonb_build_object('canonical', v_promo_canonical + v_promo_duplicate, 'duplicate', 0),
      'quiz_attempts', jsonb_build_object('canonical', v_quiz_canonical + (v_quiz_duplicate - jsonb_array_length(v_quiz_conflict_rows)), 'duplicate', 0),
      'authorized_pickup_students', jsonb_build_object('canonical', v_pickup_canonical + v_pickup_duplicate, 'duplicate', 0),
      'release_log', jsonb_build_object('canonical', v_release_canonical + (v_release_duplicate - jsonb_array_length(v_release_conflict_rows)), 'duplicate', 0),
      'report_comments', jsonb_build_object('canonical', v_report_canonical + (v_report_duplicate - jsonb_array_length(v_report_conflict_rows)), 'duplicate', 0)
    );
  ELSE
    v_after_counts := v_before_counts;
  END IF;

  -- ── Dry run path: ZERO WRITES ────────────────────────────────────────────
  IF p_dry_run THEN
    RETURN jsonb_build_object(
      'can_merge', v_can_merge,
      'canonical_student_id', p_canonical_id,
      'duplicate_student_id', p_duplicate_id,
      'student_name', v_canonical.name,
      'class_name', v_canonical."className",
      'canonical_parent_id', v_canonical."parentId",
      'duplicate_parent_id', v_duplicate."parentId",
      'dependent_counts', v_before_counts,
      'before_counts', v_before_counts,
      'after_counts', v_after_counts,
      'actions', v_actions,
      'enrollment_action', v_enrollment_action,
      'conflicts', v_conflicts,
      'dry_run', true
    );
  END IF;

  -- ── Actual merge path ────────────────────────────────────────────────────
  IF NOT v_can_merge THEN
    RAISE EXCEPTION 'Merge blocked due to conflicts: %', v_conflicts::text USING ERRCODE='integrity_constraint_violation';
  END IF;

  -- Enrollment consolidation
  IF v_enrollment_consolidate_id IS NOT NULL THEN
    -- Delete the duplicate open enrollment (its provenance is in v_enrollment_action)
    DELETE FROM public.student_enrollments WHERE id = v_enrollment_consolidate_id AND "studentId" = p_duplicate_id;
  END IF;

  -- Transfer remaining enrollments (closed ones, or open when canonical had none)
  UPDATE public.student_enrollments SET "studentId" = p_canonical_id WHERE "studentId" = p_duplicate_id;

  -- Transfer exams (non-conflicting, we already blocked if any conflict, so all)
  UPDATE public.exams SET "studentId" = p_canonical_id WHERE "studentId" = p_duplicate_id;

  -- Attendance
  UPDATE public.attendance SET "studentId" = p_canonical_id WHERE "studentId" = p_duplicate_id;

  -- Homework
  UPDATE public.homework SET "studentId" = p_canonical_id WHERE "studentId" = p_duplicate_id;

  -- Promotions
  UPDATE public.student_promotions SET "studentId" = p_canonical_id WHERE "studentId" = p_duplicate_id;

  -- Quiz attempts
  UPDATE public.quiz_attempts SET "studentId" = p_canonical_id WHERE "studentId" = p_duplicate_id;

  -- Authorized pickup students: handle duplicate pickup links
  -- First, delete duplicate links where canonical already has same pickup
  DELETE FROM public.authorized_pickup_students
  WHERE "studentId" = p_duplicate_id
    AND "authorizedPickupId" IN (
      SELECT "authorizedPickupId" FROM public.authorized_pickup_students WHERE "studentId" = p_canonical_id
    );

  -- Then repoint remaining
  UPDATE public.authorized_pickup_students SET "studentId" = p_canonical_id WHERE "studentId" = p_duplicate_id;

  -- Release log
  UPDATE public.release_log SET "studentId" = p_canonical_id WHERE "studentId" = p_duplicate_id;

  -- Report comments
  UPDATE public.report_comments SET "studentId" = p_canonical_id WHERE "studentId" = p_duplicate_id;

  -- Recompute after counts for audit (actual)
  SELECT count(*) INTO v_exam_canonical FROM public.exams WHERE "studentId" = p_canonical_id;
  SELECT count(*) INTO v_att_canonical FROM public.attendance WHERE "studentId" = p_canonical_id;
  SELECT count(*) INTO v_hw_canonical FROM public.homework WHERE "studentId" = p_canonical_id;
  SELECT count(*) INTO v_enr_canonical FROM public.student_enrollments WHERE "studentId" = p_canonical_id;
  SELECT count(*) INTO v_promo_canonical FROM public.student_promotions WHERE "studentId" = p_canonical_id;
  SELECT count(*) INTO v_quiz_canonical FROM public.quiz_attempts WHERE "studentId" = p_canonical_id;
  SELECT count(*) INTO v_pickup_canonical FROM public.authorized_pickup_students WHERE "studentId" = p_canonical_id;
  SELECT count(*) INTO v_release_canonical FROM public.release_log WHERE "studentId" = p_canonical_id;
  SELECT count(*) INTO v_report_canonical FROM public.report_comments WHERE "studentId" = p_canonical_id;

  v_after_counts := jsonb_build_object(
    'exams', jsonb_build_object('canonical', v_exam_canonical, 'duplicate', 0),
    'attendance', jsonb_build_object('canonical', v_att_canonical, 'duplicate', 0),
    'homework', jsonb_build_object('canonical', v_hw_canonical, 'duplicate', 0),
    'enrollments', jsonb_build_object('canonical', v_enr_canonical, 'duplicate', 0),
    'promotions', jsonb_build_object('canonical', v_promo_canonical, 'duplicate', 0),
    'quiz_attempts', jsonb_build_object('canonical', v_quiz_canonical, 'duplicate', 0),
    'authorized_pickup_students', jsonb_build_object('canonical', v_pickup_canonical, 'duplicate', 0),
    'release_log', jsonb_build_object('canonical', v_release_canonical, 'duplicate', 0),
    'report_comments', jsonb_build_object('canonical', v_report_canonical, 'duplicate', 0)
  );

  -- ── Zero-dependency guard before delete ──────────────────────────────────
  IF EXISTS (SELECT 1 FROM public.exams WHERE "studentId" = p_duplicate_id) THEN
    RAISE EXCEPTION 'Duplicate still has exams after transfer.' USING ERRCODE='integrity_constraint_violation';
  END IF;
  IF EXISTS (SELECT 1 FROM public.attendance WHERE "studentId" = p_duplicate_id) THEN
    RAISE EXCEPTION 'Duplicate still has attendance after transfer.' USING ERRCODE='integrity_constraint_violation';
  END IF;
  IF EXISTS (SELECT 1 FROM public.homework WHERE "studentId" = p_duplicate_id) THEN
    RAISE EXCEPTION 'Duplicate still has homework after transfer.' USING ERRCODE='integrity_constraint_violation';
  END IF;
  IF EXISTS (SELECT 1 FROM public.student_enrollments WHERE "studentId" = p_duplicate_id) THEN
    RAISE EXCEPTION 'Duplicate still has enrollments after transfer.' USING ERRCODE='integrity_constraint_violation';
  END IF;
  IF EXISTS (SELECT 1 FROM public.student_promotions WHERE "studentId" = p_duplicate_id) THEN
    RAISE EXCEPTION 'Duplicate still has promotions after transfer.' USING ERRCODE='integrity_constraint_violation';
  END IF;
  IF EXISTS (SELECT 1 FROM public.quiz_attempts WHERE "studentId" = p_duplicate_id) THEN
    RAISE EXCEPTION 'Duplicate still has quiz attempts after transfer.' USING ERRCODE='integrity_constraint_violation';
  END IF;
  IF EXISTS (SELECT 1 FROM public.authorized_pickup_students WHERE "studentId" = p_duplicate_id) THEN
    RAISE EXCEPTION 'Duplicate still has pickup links after transfer.' USING ERRCODE='integrity_constraint_violation';
  END IF;
  IF EXISTS (SELECT 1 FROM public.release_log WHERE "studentId" = p_duplicate_id) THEN
    RAISE EXCEPTION 'Duplicate still has release logs after transfer.' USING ERRCODE='integrity_constraint_violation';
  END IF;
  IF EXISTS (SELECT 1 FROM public.report_comments WHERE "studentId" = p_duplicate_id) THEN
    RAISE EXCEPTION 'Duplicate still has report comments after transfer.' USING ERRCODE='integrity_constraint_violation';
  END IF;

  -- ── Audit ────────────────────────────────────────────────────────────────
  v_audit_id := 'merge-' || floor(extract(epoch FROM clock_timestamp())*1000)::text || '-' || substr(md5(random()::text || p_duplicate_id),1,6);

  INSERT INTO public.student_merge_audit
    (id, canonical_student_id, duplicate_student_id, performed_by, merged_at, reason, source, before_counts, after_counts, enrollment_actions, conflicts, details)
  VALUES
    (v_audit_id, p_canonical_id, p_duplicate_id, v_actor, NOW(), p_reason, p_source, v_before_counts, v_after_counts, v_enrollment_action, v_conflicts,
     jsonb_build_object(
       'canonical_name', v_canonical.name,
       'canonical_class', v_canonical."className",
       'duplicate_name', v_duplicate.name,
       'duplicate_class', v_duplicate."className",
       'actions', v_actions,
       'enrollment_consolidated_id', v_enrollment_consolidate_id
     ));

  INSERT INTO public.audit_logs (action, details, "createdAt")
  VALUES ('students.merge_duplicate',
    jsonb_build_object(
      'auditId', v_audit_id,
      'actor', v_actor,
      'canonicalId', p_canonical_id,
      'duplicateId', p_duplicate_id,
      'reason', p_reason,
      'source', p_source,
      'before', v_before_counts,
      'after', v_after_counts,
      'enrollmentAction', v_enrollment_action
    ), NOW());

  -- ── Delete duplicate student (now zero dependents) ───────────────────────
  DELETE FROM public.students WHERE id = p_duplicate_id;

  RETURN jsonb_build_object(
    'can_merge', true,
    'canonical_student_id', p_canonical_id,
    'duplicate_student_id', p_duplicate_id,
    'student_name', v_canonical.name,
    'class_name', v_canonical."className",
    'before_counts', v_before_counts,
    'after_counts', v_after_counts,
    'actions', v_actions,
    'enrollment_action', v_enrollment_action,
    'conflicts', v_conflicts,
    'audit_id', v_audit_id,
    'dry_run', false
  );
END;
$$;

DO $$
DECLARE f TEXT;
BEGIN
  FOREACH f IN ARRAY ARRAY[
    'public.merge_duplicate_student(TEXT,TEXT,BOOLEAN,TEXT,TEXT)',
    'public.class_match_key(TEXT)'
  ] LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', f);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO authenticated', f);
  END LOOP;
END $$;

-- ─── 4. List duplicate groups ───────────────────────────────────────────────
-- Returns candidate duplicate groups: normalized name + class, with one parent-assigned and one unassigned.
-- Used by admin UI and dry-run report.

CREATE OR REPLACE FUNCTION public.list_duplicate_students()
RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_role TEXT := public.current_profile_role();
  v_result JSONB;
BEGIN
  IF v_role IS NULL OR v_role NOT IN ('admin','supervisor','office') THEN
    RAISE EXCEPTION 'Only staff may list duplicate students.' USING ERRCODE='insufficient_privilege';
  END IF;

  WITH normalized AS (
    SELECT
      id,
      name,
      "className",
      "parentId",
      public.name_match_key(name) AS name_key,
      public.class_match_key("className") AS class_key
    FROM public.students
  ),
  grouped AS (
    SELECT name_key, class_key
    FROM normalized
    GROUP BY name_key, class_key
    HAVING count(*) > 1
  ),
  pairs AS (
    SELECT
      n.name_key,
      n.class_key,
      max(n.name) AS display_name,
      max(n."className") AS display_class,
      count(*) AS total,
      count(*) FILTER (WHERE n."parentId" IS NOT NULL) AS assigned_count,
      count(*) FILTER (WHERE n."parentId" IS NULL) AS unassigned_count,
      jsonb_agg(jsonb_build_object('id', n.id, 'name', n.name, 'className', n."className", 'parentId', n."parentId") ORDER BY (n."parentId" IS NOT NULL) DESC, n.id) AS members
    FROM normalized n
    JOIN grouped g ON g.name_key = n.name_key AND g.class_key = n.class_key
    GROUP BY n.name_key, n.class_key
  )
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'name_key', name_key,
    'class_key', class_key,
    'display_name', display_name,
    'display_class', display_class,
    'total', total,
    'assigned_count', assigned_count,
    'unassigned_count', unassigned_count,
    'members', members
  ) ORDER BY display_name), '[]'::jsonb) INTO v_result FROM pairs;

  RETURN v_result;
END;
$$;

REVOKE ALL ON FUNCTION public.list_duplicate_students() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.list_duplicate_students() TO authenticated;

-- ─── 5. Detailed duplicate info with counts (for UI) ───────────────────────
CREATE OR REPLACE FUNCTION public.get_duplicate_student_details(p_canonical_id TEXT, p_duplicate_id TEXT)
RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_role TEXT := public.current_profile_role();
  v_canonical RECORD;
  v_duplicate RECORD;
  v_counts JSONB;
BEGIN
  -- Fixed authorization mismatch: merge RPC allows only admin/supervisor, so details must also be restricted to same roles
  -- Do NOT broaden merge to office; restrict details to admin/supervisor for internal consistency
  IF v_role IS NULL OR v_role NOT IN ('admin','supervisor') THEN
    RAISE EXCEPTION 'Only staff may view duplicate details.' USING ERRCODE='insufficient_privilege';
  END IF;

  SELECT * INTO v_canonical FROM public.students WHERE id = p_canonical_id;
  SELECT * INTO v_duplicate FROM public.students WHERE id = p_duplicate_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Student not found.' USING ERRCODE='no_data_found';
  END IF;

  SELECT jsonb_build_object(
    'canonical', jsonb_build_object(
      'id', p_canonical_id,
      'name', v_canonical.name,
      'className', v_canonical."className",
      'parentId', v_canonical."parentId",
      'exams', (SELECT count(*) FROM public.exams WHERE "studentId" = p_canonical_id),
      'attendance', (SELECT count(*) FROM public.attendance WHERE "studentId" = p_canonical_id),
      'homework', (SELECT count(*) FROM public.homework WHERE "studentId" = p_canonical_id),
      'enrollments', (SELECT count(*) FROM public.student_enrollments WHERE "studentId" = p_canonical_id),
      'promotions', (SELECT count(*) FROM public.student_promotions WHERE "studentId" = p_canonical_id),
      'quiz_attempts', (SELECT count(*) FROM public.quiz_attempts WHERE "studentId" = p_canonical_id),
      'pickups', (SELECT count(*) FROM public.authorized_pickup_students WHERE "studentId" = p_canonical_id),
      'release_logs', (SELECT count(*) FROM public.release_log WHERE "studentId" = p_canonical_id),
      'report_comments', (SELECT count(*) FROM public.report_comments WHERE "studentId" = p_canonical_id)
    ),
    'duplicate', jsonb_build_object(
      'id', p_duplicate_id,
      'name', v_duplicate.name,
      'className', v_duplicate."className",
      'parentId', v_duplicate."parentId",
      'exams', (SELECT count(*) FROM public.exams WHERE "studentId" = p_duplicate_id),
      'attendance', (SELECT count(*) FROM public.attendance WHERE "studentId" = p_duplicate_id),
      'homework', (SELECT count(*) FROM public.homework WHERE "studentId" = p_duplicate_id),
      'enrollments', (SELECT count(*) FROM public.student_enrollments WHERE "studentId" = p_duplicate_id),
      'promotions', (SELECT count(*) FROM public.student_promotions WHERE "studentId" = p_duplicate_id),
      'quiz_attempts', (SELECT count(*) FROM public.quiz_attempts WHERE "studentId" = p_duplicate_id),
      'pickups', (SELECT count(*) FROM public.authorized_pickup_students WHERE "studentId" = p_duplicate_id),
      'release_logs', (SELECT count(*) FROM public.release_log WHERE "studentId" = p_duplicate_id),
      'report_comments', (SELECT count(*) FROM public.report_comments WHERE "studentId" = p_duplicate_id)
    )
  ) INTO v_counts;

  RETURN jsonb_build_object(
    'canonical', jsonb_build_object('id', v_canonical.id, 'name', v_canonical.name, 'className', v_canonical."className", 'parentId', v_canonical."parentId"),
    'duplicate', jsonb_build_object('id', v_duplicate.id, 'name', v_duplicate.name, 'className', v_duplicate."className", 'parentId', v_duplicate."parentId"),
    'counts', v_counts,
    'dry_run', public.merge_duplicate_student(p_canonical_id, p_duplicate_id, true)
  );
END;
$$;

REVOKE ALL ON FUNCTION public.get_duplicate_student_details(TEXT,TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_duplicate_student_details(TEXT,TEXT) TO authenticated;
