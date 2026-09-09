-- Half-point grade scores.
--
-- PURPOSE
-- -----------------------------------------------------------------------------
-- Allows a grade to carry a half point (e.g. 4.5 out of 5), not just whole
-- numbers. Teachers routinely award partial credit on homework/classwork, and
-- the previous INTEGER-only pipeline rejected those cells with
-- "must be a whole number from 0 to 5 …".
--
-- SCOPE
--   * exams.score becomes NUMERIC and is constrained to whole or half points
--     (steps of 0.5): score * 2 must be an integer. Quarter points (4.25) are
--     still rejected.
--   * grade_correction_audit.old_score / new_score become NUMERIC so the audit
--     trail can record half-point corrections faithfully.
--   * submit_bulk_grades accepts and stores half-point scores (its string
--     validation now permits a single ".0"/".5" fraction; the numeric cast is
--     NUMERIC, not INTEGER).
--   * admin_correct_grade takes NUMERIC score parameters and enforces the same
--     half-step rule server-side.
--
-- Everything else — authorization, identity binding, status transitions,
-- idempotency, the append-only audit, RLS/grants — is preserved exactly. This
-- migration only widens the numeric domain of a score from "integer" to
-- "integer or half".
--
-- Idempotent (safe to re-run).

-- ─────────────────────────────────────────────────────────────────────────────
-- 1. Widen the score column to NUMERIC and enforce the half-step rule.
-- ─────────────────────────────────────────────────────────────────────────────
ALTER TABLE public.exams ALTER COLUMN score TYPE NUMERIC USING score::NUMERIC;

ALTER TABLE public.exams DROP CONSTRAINT IF EXISTS exams_score_entry_state_check;
ALTER TABLE public.exams ADD CONSTRAINT exams_score_entry_state_check
  CHECK (
    ("entryState" = 'scored' AND score IS NOT NULL AND score >= 0 AND score <= total
      AND total > 0 AND score * 2 = floor(score * 2))
    OR ("entryState" IN ('absent', 'not_applicable') AND score IS NULL AND total > 0)
  ) NOT VALID;

-- Correction audit before/after values follow the same numeric domain.
ALTER TABLE IF EXISTS public.grade_correction_audit
  ALTER COLUMN old_score TYPE NUMERIC USING old_score::NUMERIC;
ALTER TABLE IF EXISTS public.grade_correction_audit
  ALTER COLUMN new_score TYPE NUMERIC USING new_score::NUMERIC;

-- ─────────────────────────────────────────────────────────────────────────────
-- 2. submit_bulk_grades — accept whole OR half-point scores.
-- ─────────────────────────────────────────────────────────────────────────────
-- Byte-for-byte identical to 20260908 except: v_score is NUMERIC, the score
-- string validation permits a single ".0"/".5" fraction, the score casts are
-- ::NUMERIC, and the scored range check additionally enforces the half step.
CREATE OR REPLACE FUNCTION public.submit_bulk_grades(
  p_records JSONB,
  p_idempotency_key TEXT,
  p_confirm_updates BOOLEAN DEFAULT FALSE
) RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_actor_id TEXT := public.current_profile_id();
  v_role TEXT := public.current_profile_role();
  v_payload_hash TEXT := md5(COALESCE(p_records::TEXT, ''));
  v_existing_result JSONB;
  v_record JSONB;
  v_normalized JSONB := '[]'::JSONB;
  v_student_id TEXT;
  v_subject_id TEXT;
  v_assessment_label TEXT;
  v_exam_type TEXT;
  v_entry_state TEXT;
  v_month TEXT;
  v_date DATE;
  v_term_id TEXT;
  v_score NUMERIC;
  v_total INTEGER;
  v_student_class TEXT;
  v_parent_id TEXT;
  v_subject_name TEXT;
  v_teacher_id TEXT;
  v_term_start DATE;
  v_term_end DATE;
  v_term_months TEXT[];
  v_insert_count INTEGER := 0;
  v_update_count INTEGER := 0;
  v_result JSONB;
  v_id TEXT;
  v_changes JSONB := '[]'::JSONB;
  v_approved_change_count INTEGER := 0;
BEGIN
  IF v_actor_id IS NULL OR v_role NOT IN ('teacher', 'admin') THEN
    RAISE EXCEPTION 'Only authenticated teachers and admins may submit bulk grades.' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF p_idempotency_key IS NULL OR length(trim(p_idempotency_key)) < 12 THEN
    RAISE EXCEPTION 'A valid upload idempotency key is required.' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF jsonb_typeof(p_records) <> 'array' OR jsonb_array_length(p_records) = 0 THEN
    RAISE EXCEPTION 'At least one grade record is required.' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF jsonb_array_length(p_records) > 10000 THEN
    RAISE EXCEPTION 'A bulk upload may contain at most 10,000 grade records.' USING ERRCODE = 'program_limit_exceeded';
  END IF;

  IF p_confirm_updates THEN
    SELECT result INTO v_existing_result
    FROM public.grade_uploads
    WHERE id = p_idempotency_key
      AND "uploadedBy" = v_actor_id
      AND payload_hash = v_payload_hash;
    IF v_existing_result IS NOT NULL THEN
      RETURN v_existing_result;
    END IF;
    IF EXISTS (SELECT 1 FROM public.grade_uploads WHERE id = p_idempotency_key) THEN
      RAISE EXCEPTION 'This upload key was already used with a different account or payload.' USING ERRCODE = 'unique_violation';
    END IF;
  END IF;

  FOR v_record IN SELECT value FROM jsonb_array_elements(p_records)
  LOOP
    v_student_id := NULLIF(trim(v_record->>'studentId'), '');
    v_subject_id := NULLIF(trim(v_record->>'subjectId'), '');
    v_assessment_label := upper(NULLIF(trim(v_record->>'assessmentLabel'), ''));
    v_exam_type := NULLIF(trim(v_record->>'examType'), '');
    v_entry_state := COALESCE(NULLIF(trim(v_record->>'entryState'), ''), 'scored');
    v_month := NULLIF(trim(v_record->>'month'), '');
    v_term_id := NULLIF(trim(v_record->>'termId'), '');

    -- Do not rely on numeric casts to decide numeric semantics: callers can
    -- invoke an RPC directly, so quarter-points and partial strings must be
    -- rejected just as strictly as they are in the browser parser. Totals stay
    -- whole; scores may carry a single ".0"/".5" fraction (a half point).
    IF COALESCE(NULLIF(v_record->>'total', ''), '') !~ '^(0|[1-9][0-9]*)$'
       OR (v_record->>'score' IS NOT NULL AND (v_record->>'score') !~ '^[0-9]+(\.[05])?$') THEN
      RAISE EXCEPTION 'Bulk upload contains an invalid score (only whole or half points are allowed) or a non-integer total.' USING ERRCODE = 'invalid_parameter_value';
    END IF;
    BEGIN
      v_date := NULLIF(v_record->>'date', '')::DATE;
      v_total := NULLIF(v_record->>'total', '')::INTEGER;
      v_score := CASE WHEN v_record->>'score' IS NULL THEN NULL ELSE (v_record->>'score')::NUMERIC END;
    EXCEPTION WHEN invalid_text_representation OR numeric_value_out_of_range OR datetime_field_overflow OR invalid_datetime_format THEN
      RAISE EXCEPTION 'Bulk upload contains an invalid date, score, or total.' USING ERRCODE = 'invalid_parameter_value';
    END;

    IF v_student_id IS NULL OR v_subject_id IS NULL OR v_term_id IS NULL OR v_month IS NULL OR v_date IS NULL THEN
      RAISE EXCEPTION 'Every bulk grade requires studentId, subjectId, termId, month, and date.' USING ERRCODE = 'not_null_violation';
    END IF;
    IF v_assessment_label NOT IN ('HW1', 'HW2', 'HW3', 'HW4', 'CPW1', 'CPW2', 'CPW3', 'CPW4', 'ATTENDANCE', 'MT', 'AKHLAAQ') THEN
      RAISE EXCEPTION 'Unsupported assessment label: %', COALESCE(v_assessment_label, 'blank') USING ERRCODE = 'check_violation';
    END IF;
    IF NOT (
      (v_assessment_label IN ('HW1', 'HW2', 'HW3', 'HW4') AND v_exam_type = 'Homework' AND v_total = 5)
      OR (v_assessment_label IN ('CPW1', 'CPW2', 'CPW3', 'CPW4') AND v_exam_type = 'Classwork' AND v_total = 15)
      OR (v_assessment_label = 'ATTENDANCE' AND v_exam_type = 'Attendance' AND v_total = 20)
      OR (v_assessment_label = 'MT' AND v_exam_type = 'Quiz' AND v_total = 20)
      OR (v_assessment_label = 'AKHLAAQ' AND v_exam_type = 'Discipline' AND v_total = 10)
    ) THEN
      RAISE EXCEPTION 'Assessment %, exam type, and maximum score do not match the approved template.', v_assessment_label USING ERRCODE = 'check_violation';
    END IF;
    IF v_entry_state NOT IN ('scored', 'absent', 'not_applicable') THEN
      RAISE EXCEPTION 'Unsupported entry state: %', v_entry_state USING ERRCODE = 'check_violation';
    END IF;
    IF (v_entry_state = 'scored' AND (v_score IS NULL OR v_score < 0 OR v_score > v_total OR v_score * 2 <> floor(v_score * 2)))
       OR (v_entry_state <> 'scored' AND v_score IS NOT NULL) THEN
      RAISE EXCEPTION 'Score/state combination is invalid for assessment % (scores must be whole or half points).', v_assessment_label USING ERRCODE = 'check_violation';
    END IF;

    SELECT "className", "parentId" INTO v_student_class, v_parent_id FROM public.students WHERE id = v_student_id;
    IF NOT FOUND THEN RAISE EXCEPTION 'Student % was not found.', v_student_id USING ERRCODE = 'foreign_key_violation'; END IF;
    SELECT name INTO v_subject_name FROM public.subjects WHERE id = v_subject_id;
    IF NOT FOUND THEN RAISE EXCEPTION 'Subject % was not found.', v_subject_id USING ERRCODE = 'foreign_key_violation'; END IF;
    SELECT "startDate", "endDate", months INTO v_term_start, v_term_end, v_term_months FROM public.terms WHERE id = v_term_id;
    IF NOT FOUND THEN RAISE EXCEPTION 'Term % was not found.', v_term_id USING ERRCODE = 'foreign_key_violation'; END IF;
    IF v_date < v_term_start OR v_date > v_term_end THEN RAISE EXCEPTION 'Assessment date must fall inside the selected term.' USING ERRCODE = 'check_violation'; END IF;
    IF COALESCE(array_length(v_term_months, 1), 0) > 0 AND NOT (v_month = ANY(v_term_months)) THEN
      RAISE EXCEPTION 'Month % is not configured for the selected term.', v_month USING ERRCODE = 'check_violation';
    END IF;

    IF v_role = 'teacher' THEN
      SELECT "teacherId" INTO v_teacher_id
      FROM public.class_subjects
      WHERE "className" = v_student_class
        AND "subjectId" = v_subject_id
        AND "teacherId" = v_actor_id
      LIMIT 1;
    ELSE
      SELECT "teacherId" INTO v_teacher_id
      FROM public.class_subjects
      WHERE "className" = v_student_class
        AND "subjectId" = v_subject_id
        AND "teacherId" IS NOT NULL
      LIMIT 1;
    END IF;
    IF v_teacher_id IS NULL THEN
      IF v_role = 'teacher' THEN
        RAISE EXCEPTION 'Teachers may upload only their assigned class subjects.' USING ERRCODE = 'insufficient_privilege';
      ELSE
        RAISE EXCEPTION 'No assigned teacher exists for this student class and subject.' USING ERRCODE = 'check_violation';
      END IF;
    END IF;

    IF EXISTS (
      SELECT 1 FROM jsonb_array_elements(v_normalized) prior
      WHERE prior->>'studentId' = v_student_id
        AND prior->>'subjectId' = v_subject_id
        AND prior->>'examType' = v_exam_type
        AND prior->>'assessmentLabel' = v_assessment_label
        AND prior->>'termId' = v_term_id
    ) THEN
      RAISE EXCEPTION 'The upload contains duplicate records for the same student, subject, assessment, and term.' USING ERRCODE = 'unique_violation';
    END IF;

    v_normalized := v_normalized || jsonb_build_array(jsonb_build_object(
      'studentId', v_student_id,
      'subjectId', v_subject_id,
      'subject', v_subject_name,
      'parentId', v_parent_id,
      'teacherId', v_teacher_id,
      'assessmentLabel', v_assessment_label,
      'examType', v_exam_type,
      'entryState', v_entry_state,
      'score', v_score,
      'total', v_total,
      'month', v_month,
      'date', v_date,
      'termId', v_term_id
    ));
  END LOOP;

  SELECT COUNT(*) INTO v_update_count
  FROM jsonb_array_elements(v_normalized) record
  JOIN public.exams e
    ON e."studentId" = record->>'studentId'
   AND e."subjectId" = record->>'subjectId'
   AND e."examType" = record->>'examType'
   AND e."assessmentLabel" = record->>'assessmentLabel'
   AND e."termId" = record->>'termId';
  v_insert_count := jsonb_array_length(v_normalized) - v_update_count;

  IF NOT p_confirm_updates THEN
    SELECT
      COALESCE(jsonb_agg(change ORDER BY change->>'studentName', change->>'subject', change->>'assessmentLabel'), '[]'::JSONB),
      COALESCE(SUM(CASE WHEN (change->>'isApproved')::BOOLEAN THEN 1 ELSE 0 END), 0)
    INTO v_changes, v_approved_change_count
    FROM (
      SELECT jsonb_build_object(
        'studentId', record->>'studentId',
        'studentName', s.name,
        'className', s."className",
        'subject', record->>'subject',
        'subjectId', record->>'subjectId',
        'assessmentLabel', record->>'assessmentLabel',
        'examType', record->>'examType',
        'newScore', CASE WHEN record->>'score' IS NULL THEN NULL ELSE (record->>'score')::NUMERIC END,
        'newEntryState', record->>'entryState',
        'existingScore', e.score,
        'existingEntryState', e."entryState",
        'existingStatus', e.status,
        'changeType', CASE WHEN e.id IS NULL THEN 'new' ELSE 'update' END,
        'isApproved', COALESCE(e.status = 'approved', FALSE)
      ) AS change
      FROM jsonb_array_elements(v_normalized) record
      LEFT JOIN public.students s ON s.id = record->>'studentId'
      LEFT JOIN public.exams e
        ON e."studentId" = record->>'studentId'
       AND e."subjectId" = record->>'subjectId'
       AND e."examType" = record->>'examType'
       AND e."assessmentLabel" = record->>'assessmentLabel'
       AND e."termId" = record->>'termId'
    ) rows;

    RETURN jsonb_build_object(
      'requiresConfirmation', v_update_count > 0,
      'insertCount', v_insert_count,
      'updateCount', v_update_count,
      'skippedCount', 0,
      'approvedChangeCount', v_approved_change_count,
      'requiresApprovedAcknowledgement', v_approved_change_count > 0,
      'changes', v_changes,
      'message', CASE WHEN v_update_count > 0 THEN 'Confirmation is required because existing grades will be updated.' ELSE 'Upload is valid and ready to submit.' END
    );
  END IF;

  FOR v_record IN SELECT value FROM jsonb_array_elements(v_normalized)
  LOOP
    v_id := format('exam-%s-%s', extract(epoch FROM clock_timestamp())::BIGINT, substr(md5(random()::TEXT || clock_timestamp()::TEXT), 1, 12));
    INSERT INTO public.exams (
      id, "studentId", "subjectId", subject, score, total, "examType", "assessmentLabel", "entryState",
      month, status, "parentId", date, "createdAt", "teacherId", "termId", "uploadedBy"
    ) VALUES (
      v_id, v_record->>'studentId', v_record->>'subjectId', v_record->>'subject',
      CASE WHEN v_record->>'score' IS NULL THEN NULL ELSE (v_record->>'score')::NUMERIC END,
      (v_record->>'total')::INTEGER, v_record->>'examType', v_record->>'assessmentLabel', v_record->>'entryState',
      v_record->>'month', 'pending', v_record->>'parentId', (v_record->>'date')::DATE, NOW(),
      v_record->>'teacherId', v_record->>'termId', v_actor_id
    )
    ON CONFLICT ("studentId", "subjectId", "examType", "assessmentLabel", "termId")
      WHERE "subjectId" IS NOT NULL AND "termId" IS NOT NULL AND "assessmentLabel" IS NOT NULL
    DO UPDATE SET
      score = EXCLUDED.score,
      total = EXCLUDED.total,
      "entryState" = EXCLUDED."entryState",
      month = EXCLUDED.month,
      date = EXCLUDED.date,
      status = 'pending',
      "parentId" = EXCLUDED."parentId",
      "teacherId" = EXCLUDED."teacherId",
      "uploadedBy" = EXCLUDED."uploadedBy";
  END LOOP;

  v_result := jsonb_build_object(
    'requiresConfirmation', FALSE,
    'insertCount', v_insert_count,
    'updateCount', v_update_count,
    'skippedCount', 0,
    'uploadId', p_idempotency_key,
    'message', 'Bulk grade upload completed.'
  );
  INSERT INTO public.grade_uploads (id, "uploadedBy", payload_hash, status, result)
  VALUES (p_idempotency_key, v_actor_id, v_payload_hash, 'completed', v_result);
  RETURN v_result;
END;
$$;

REVOKE ALL ON FUNCTION public.submit_bulk_grades(JSONB, TEXT, BOOLEAN) FROM PUBLIC;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    EXECUTE 'GRANT EXECUTE ON FUNCTION public.submit_bulk_grades(JSONB, TEXT, BOOLEAN) TO authenticated';
  END IF;
END $$;

-- ─────────────────────────────────────────────────────────────────────────────
-- 3. admin_correct_grade — accept whole OR half-point NUMERIC scores.
-- ─────────────────────────────────────────────────────────────────────────────
-- The score parameters change type (INTEGER → NUMERIC), so the old overload is
-- dropped before the new one is created. Body is identical to 20260910 except
-- for the NUMERIC parameters and the added half-step validation.
DROP FUNCTION IF EXISTS public.admin_correct_grade(TEXT, INTEGER, INTEGER, TEXT, TEXT, TEXT);

CREATE OR REPLACE FUNCTION public.admin_correct_grade(
  p_exam_id TEXT,
  p_expected_old_score NUMERIC,
  p_new_score NUMERIC,
  p_reason TEXT,
  p_expected_old_entry_state TEXT DEFAULT 'scored',
  p_new_entry_state TEXT DEFAULT 'scored'
) RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_actor_id TEXT := public.current_profile_id();
  v_role TEXT := public.current_profile_role();
  v_exam RECORD;
  v_reason TEXT := btrim(COALESCE(p_reason, ''));
  v_new_status TEXT := 'pending';
  v_audit_id TEXT;
BEGIN
  IF v_actor_id IS NULL OR v_role IS NULL THEN
    RAISE EXCEPTION 'You are not authorized to correct grades.' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF v_role <> 'admin' THEN
    RAISE EXCEPTION 'You are not authorized to correct grades.' USING ERRCODE = 'insufficient_privilege';
  END IF;

  IF length(v_reason) = 0 THEN
    RAISE EXCEPTION 'A correction reason is required.' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF length(v_reason) > 1000 THEN
    RAISE EXCEPTION 'The correction reason must be 1000 characters or fewer.' USING ERRCODE = 'invalid_parameter_value';
  END IF;

  IF p_new_entry_state NOT IN ('scored', 'absent', 'not_applicable') THEN
    RAISE EXCEPTION 'Unsupported entry state: %.', p_new_entry_state USING ERRCODE = 'check_violation';
  END IF;

  SELECT * INTO v_exam FROM public.exams WHERE id = p_exam_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'The selected grade no longer exists.' USING ERRCODE = 'no_data_found';
  END IF;

  IF p_new_entry_state = 'scored' THEN
    IF p_new_score IS NULL THEN
      RAISE EXCEPTION 'A score is required for a scored grade.' USING ERRCODE = 'check_violation';
    END IF;
    IF p_new_score < 0 OR p_new_score > v_exam.total THEN
      RAISE EXCEPTION 'The score must be between 0 and %.', v_exam.total USING ERRCODE = 'check_violation';
    END IF;
    IF p_new_score * 2 <> floor(p_new_score * 2) THEN
      RAISE EXCEPTION 'The score must be a whole or half point (e.g. 4 or 4.5).' USING ERRCODE = 'check_violation';
    END IF;
  ELSE
    IF p_new_score IS NOT NULL THEN
      RAISE EXCEPTION 'An absent or not-applicable grade cannot have a score.' USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  IF (v_exam.score IS DISTINCT FROM p_expected_old_score)
     OR (v_exam."entryState" IS DISTINCT FROM COALESCE(p_expected_old_entry_state, 'scored')) THEN
    RAISE EXCEPTION 'This grade was changed by another administrator. Refresh the record before correcting it.'
      USING ERRCODE = 'serialization_failure';
  END IF;

  IF (v_exam.score IS NOT DISTINCT FROM p_new_score)
     AND (v_exam."entryState" IS NOT DISTINCT FROM p_new_entry_state) THEN
    RAISE EXCEPTION 'No correction was made because the new score matches the current score.'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  UPDATE public.exams
  SET score = p_new_score,
      "entryState" = p_new_entry_state,
      status = v_new_status
  WHERE id = p_exam_id;

  v_audit_id := format('gca-%s-%s',
    extract(epoch FROM clock_timestamp())::BIGINT,
    substr(md5(random()::TEXT || clock_timestamp()::TEXT), 1, 12));

  INSERT INTO public.grade_correction_audit (
    id, exam_id, student_id, class_name, subject_id, subject, assessment_label,
    exam_type, term_id, assessment_date,
    old_score, new_score, old_entry_state, new_entry_state, old_status, new_status,
    reason, corrected_by, corrected_at, source
  ) VALUES (
    v_audit_id, v_exam.id, v_exam."studentId",
    (SELECT "className" FROM public.students WHERE id = v_exam."studentId"),
    v_exam."subjectId", v_exam.subject, v_exam."assessmentLabel",
    v_exam."examType", v_exam."termId", v_exam.date,
    v_exam.score, p_new_score, v_exam."entryState", p_new_entry_state, v_exam.status, v_new_status,
    v_reason, v_actor_id, NOW(), 'admin_correction'
  );

  RETURN jsonb_build_object(
    'auditId', v_audit_id,
    'examId', v_exam.id,
    'studentId', v_exam."studentId",
    'subject', v_exam.subject,
    'assessmentLabel', v_exam."assessmentLabel",
    'oldScore', v_exam.score,
    'newScore', p_new_score,
    'oldEntryState', v_exam."entryState",
    'newEntryState', p_new_entry_state,
    'oldStatus', v_exam.status,
    'newStatus', v_new_status,
    'total', v_exam.total,
    'reason', v_reason,
    'correctedBy', v_actor_id,
    'message', 'Grade corrected successfully.'
  );
END;
$$;

REVOKE ALL ON FUNCTION public.admin_correct_grade(TEXT, NUMERIC, NUMERIC, TEXT, TEXT, TEXT) FROM PUBLIC;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    EXECUTE 'GRANT EXECUTE ON FUNCTION public.admin_correct_grade(TEXT, NUMERIC, NUMERIC, TEXT, TEXT, TEXT) TO authenticated';
  END IF;
END $$;
