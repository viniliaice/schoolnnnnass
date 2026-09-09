-- Admin Grade Correction.
--
-- PURPOSE
-- -----------------------------------------------------------------------------
-- Lets an authorized administrator correct a single existing grade (exam row)
-- without re-uploading a spreadsheet, while preserving the ORIGINAL value in an
-- immutable, append-only audit trail. This is an ADDITIONAL admin workflow — it
-- does not change the teacher Bulk Upload Grades pipeline, its validation, its
-- Needs-Review resolution, or the submit_bulk_grades RPC.
--
-- CORE PRINCIPLES
--   * The correction UPDATES the existing exam row (never delete+insert), so the
--     row keeps its identity, provenance (uploadedBy stays the original teacher),
--     term/subject/assessment binding, and historical class context.
--   * The correction targets the exact database row by exam.id. Client-supplied
--     student/class/subject context is NOT trusted for the mutation.
--   * Authorization is derived from the authenticated session (current_profile_
--     role() = 'admin'); the client cannot claim to be an admin.
--   * The audit trail is append-only: no UPDATE/DELETE, no direct client INSERT.
--     Only this SECURITY DEFINER RPC writes it, atomically with the exam update.
--   * Status semantics mirror the existing bulk-overwrite behavior: a corrected
--     grade is reset to 'pending' so an approved grade never silently keeps its
--     approval on a NEW value. old_status/new_status are recorded in the audit.
--   * Concurrency: the target row is locked (FOR UPDATE) and its current value is
--     compared against the value the admin reviewed (expected_old_score /
--     expected_old_entry_state). A mismatch returns a conflict instead of
--     silently overwriting another admin's newer correction.
--   * No-op corrections (same score + same entry state) are rejected and create
--     no audit record.
--
-- Idempotent (safe to re-run).

-- ─────────────────────────────────────────────────────────────────────────────
-- 1. Immutable, append-only audit table.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.grade_correction_audit (
  id TEXT PRIMARY KEY,
  -- Link to the corrected exam. ON DELETE SET NULL so the audit survives even if
  -- the exam row is later removed; the denormalized snapshot below preserves the
  -- full "who/what/when/before/after/why" independently of the live row.
  exam_id TEXT REFERENCES public.exams(id) ON DELETE SET NULL,

  -- Denormalized snapshot of the corrected grade's identity at correction time.
  student_id TEXT,
  class_name TEXT,
  subject_id TEXT,
  subject TEXT,
  assessment_label TEXT,
  exam_type TEXT,
  term_id TEXT,
  assessment_date DATE,

  -- Before / after value. NULL score with a non-scored entry state represents
  -- absent / not_applicable, distinct from a scored 0.
  old_score INTEGER,
  new_score INTEGER,
  old_entry_state TEXT,
  new_entry_state TEXT,
  old_status TEXT,
  new_status TEXT,

  reason TEXT NOT NULL,
  corrected_by TEXT NOT NULL REFERENCES public.profiles(id) ON DELETE RESTRICT,
  corrected_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  source TEXT NOT NULL DEFAULT 'admin_correction'
);

CREATE INDEX IF NOT EXISTS idx_grade_correction_audit_exam
  ON public.grade_correction_audit (exam_id, corrected_at DESC);
CREATE INDEX IF NOT EXISTS idx_grade_correction_audit_student
  ON public.grade_correction_audit (student_id, corrected_at DESC);
CREATE INDEX IF NOT EXISTS idx_grade_correction_audit_corrected_by
  ON public.grade_correction_audit (corrected_by, corrected_at DESC);

ALTER TABLE public.grade_correction_audit ENABLE ROW LEVEL SECURITY;

-- Staff may READ the correction history. There is deliberately NO INSERT/UPDATE/
-- DELETE policy: the table is append-only and written ONLY by the SECURITY
-- DEFINER RPC below (which runs as the owner and bypasses RLS). This makes the
-- trail tamper-proof from the client surface.
DROP POLICY IF EXISTS "grade_correction_audit_select_staff" ON public.grade_correction_audit;
CREATE POLICY "grade_correction_audit_select_staff" ON public.grade_correction_audit
  FOR SELECT TO authenticated
  USING (public.current_profile_role() IN ('admin', 'supervisor'));

-- Belt-and-braces: even if a default grant exists, the authenticated role gets
-- no direct write surface on the audit table.
REVOKE INSERT, UPDATE, DELETE ON public.grade_correction_audit FROM PUBLIC;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    EXECUTE 'REVOKE INSERT, UPDATE, DELETE ON public.grade_correction_audit FROM authenticated';
    EXECUTE 'GRANT SELECT ON public.grade_correction_audit TO authenticated';
  END IF;
END $$;

-- Defense in depth: a trigger that hard-blocks UPDATE/DELETE on the audit table
-- for everyone except the table owner (migrations/service role). Even a future
-- mis-added policy or accidental grant cannot mutate history.
CREATE OR REPLACE FUNCTION public.grade_correction_audit_immutable()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  -- Block UPDATE/DELETE for any AUTHENTICATED client (auth.uid() IS NOT NULL).
  -- Anonymous / service-role / migration contexts (no JWT) are left untouched so
  -- the owner can still manage the table in future migrations. Authenticated
  -- clients already have no UPDATE/DELETE grant or policy; this is defense in
  -- depth, mirroring enforce_exam_status_guard.
  IF auth.uid() IS NOT NULL THEN
    RAISE EXCEPTION 'grade_correction_audit is append-only; % is not permitted.', TG_OP
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS grade_correction_audit_no_update ON public.grade_correction_audit;
CREATE TRIGGER grade_correction_audit_no_update
  BEFORE UPDATE OR DELETE ON public.grade_correction_audit
  FOR EACH ROW EXECUTE FUNCTION public.grade_correction_audit_immutable();

-- ─────────────────────────────────────────────────────────────────────────────
-- 2. The secure correction RPC.
-- ─────────────────────────────────────────────────────────────────────────────
-- The client submits ONLY: exam_id, the value it reviewed (expected_old_score /
-- expected_old_entry_state), the new value, and the reason. Everything else —
-- corrector identity, timestamps, old value, status transition — is derived
-- server-side from the locked database row.
CREATE OR REPLACE FUNCTION public.admin_correct_grade(
  p_exam_id TEXT,
  p_expected_old_score INTEGER,
  p_new_score INTEGER,
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
  -- Authorization: admin only, derived from the session (never from the client).
  IF v_actor_id IS NULL OR v_role IS NULL THEN
    RAISE EXCEPTION 'You are not authorized to correct grades.' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF v_role <> 'admin' THEN
    RAISE EXCEPTION 'You are not authorized to correct grades.' USING ERRCODE = 'insufficient_privilege';
  END IF;

  -- Reason is mandatory and meaningful.
  IF length(v_reason) = 0 THEN
    RAISE EXCEPTION 'A correction reason is required.' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF length(v_reason) > 1000 THEN
    RAISE EXCEPTION 'The correction reason must be 1000 characters or fewer.' USING ERRCODE = 'invalid_parameter_value';
  END IF;

  -- Validate the requested entry state.
  IF p_new_entry_state NOT IN ('scored', 'absent', 'not_applicable') THEN
    RAISE EXCEPTION 'Unsupported entry state: %.', p_new_entry_state USING ERRCODE = 'check_violation';
  END IF;

  -- Lock the exact target row (concurrency protection). We identify the grade by
  -- its database primary key only — never by client-supplied student/class/subject.
  SELECT * INTO v_exam FROM public.exams WHERE id = p_exam_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'The selected grade no longer exists.' USING ERRCODE = 'no_data_found';
  END IF;

  -- Validate the NEW value against the row's own maximum and the entry state.
  IF p_new_entry_state = 'scored' THEN
    IF p_new_score IS NULL THEN
      RAISE EXCEPTION 'A score is required for a scored grade.' USING ERRCODE = 'check_violation';
    END IF;
    IF p_new_score < 0 OR p_new_score > v_exam.total THEN
      RAISE EXCEPTION 'The score must be between 0 and %.', v_exam.total USING ERRCODE = 'check_violation';
    END IF;
  ELSE
    -- absent / not_applicable carry no score.
    IF p_new_score IS NOT NULL THEN
      RAISE EXCEPTION 'An absent or not-applicable grade cannot have a score.' USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  -- Optimistic concurrency: the row must still hold the value the admin reviewed.
  -- IS DISTINCT FROM handles NULL scores (absent / N/A) correctly.
  IF (v_exam.score IS DISTINCT FROM p_expected_old_score)
     OR (v_exam."entryState" IS DISTINCT FROM COALESCE(p_expected_old_entry_state, 'scored')) THEN
    RAISE EXCEPTION 'This grade was changed by another administrator. Refresh the record before correcting it.'
      USING ERRCODE = 'serialization_failure';
  END IF;

  -- No-op guard: nothing actually changes → no audit record.
  IF (v_exam.score IS NOT DISTINCT FROM p_new_score)
     AND (v_exam."entryState" IS NOT DISTINCT FROM p_new_entry_state) THEN
    RAISE EXCEPTION 'No correction was made because the new score matches the current score.'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  -- Apply the correction to the existing row. Provenance (uploadedBy, teacherId),
  -- identity (student/subject/assessment/term), and dates are all preserved. A
  -- corrected grade returns to 'pending' so approval is re-earned for the new
  -- value (mirrors the bulk-overwrite behavior).
  UPDATE public.exams
  SET score = p_new_score,
      "entryState" = p_new_entry_state,
      status = v_new_status
  WHERE id = p_exam_id;

  -- Append the immutable audit record atomically with the update.
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

REVOKE ALL ON FUNCTION public.admin_correct_grade(TEXT, INTEGER, INTEGER, TEXT, TEXT, TEXT) FROM PUBLIC;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    EXECUTE 'GRANT EXECUTE ON FUNCTION public.admin_correct_grade(TEXT, INTEGER, INTEGER, TEXT, TEXT, TEXT) TO authenticated';
  END IF;
END $$;

-- ─────────────────────────────────────────────────────────────────────────────
-- 3. Correction history reader (staff only).
-- ─────────────────────────────────────────────────────────────────────────────
-- Returns the full chronological correction history for an exam, newest first,
-- with the corrector's display name. Staff-gated; SECURITY DEFINER so it can
-- read the audit table + profile name without a broad profiles read grant.
CREATE OR REPLACE FUNCTION public.get_grade_correction_history(
  p_exam_id TEXT
) RETURNS JSONB
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_role TEXT := public.current_profile_role();
  v_rows JSONB;
BEGIN
  IF v_role IS NULL OR v_role NOT IN ('admin', 'supervisor') THEN
    RAISE EXCEPTION 'You are not authorized to view grade correction history.' USING ERRCODE = 'insufficient_privilege';
  END IF;

  SELECT COALESCE(jsonb_agg(row ORDER BY row->>'correctedAt' DESC), '[]'::jsonb)
  INTO v_rows
  FROM (
    SELECT jsonb_build_object(
      'id', a.id,
      'examId', a.exam_id,
      'oldScore', a.old_score,
      'newScore', a.new_score,
      'oldEntryState', a.old_entry_state,
      'newEntryState', a.new_entry_state,
      'oldStatus', a.old_status,
      'newStatus', a.new_status,
      'reason', a.reason,
      'correctedBy', a.corrected_by,
      'correctedByName', p.name,
      'correctedAt', a.corrected_at,
      'source', a.source
    ) AS row
    FROM public.grade_correction_audit a
    LEFT JOIN public.profiles p ON p.id = a.corrected_by
    WHERE a.exam_id = p_exam_id
  ) sub;

  RETURN v_rows;
END;
$$;

REVOKE ALL ON FUNCTION public.get_grade_correction_history(TEXT) FROM PUBLIC;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    EXECUTE 'GRANT EXECUTE ON FUNCTION public.get_grade_correction_history(TEXT) TO authenticated';
  END IF;
END $$;
