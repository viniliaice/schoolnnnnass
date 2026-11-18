-- MANUAL REVIEW ARTIFACT. NOT EXECUTED AGAINST SUPABASE BY THE AUTHOR.
-- Apply this file ALONE, not both monthly identity migrations.
-- Requires a backup, paused assessment writes/merges, and compatible RPC client.
-- Existing HW1 maximum remains 5; a score of 6 is intentionally rejected.
-- Verification is in docs/investigations/verify_monthly_assessment_identity.sql.
-- No existing exam data is changed by executing this migration.
-- Existing merge routines contain their historical, explicitly invoked DML;
-- defining them does NOT execute a merge. Never use real merges as a smoke test.
-- Monthly assessment identity repair. No marks are backfilled, deleted or relabelled.
-- Apply manually only after backup, SQL review and the documented compatibility checks.
BEGIN;
SET LOCAL lock_timeout = '10s';
SET LOCAL statement_timeout = '120s';
-- Accidental second application is a SAFE ERROR, not a partial rerun/no-op.
DO $preflight$
BEGIN
 IF current_setting('server_version_num')::integer < 150000 THEN
   RAISE EXCEPTION 'PostgreSQL 15+ required for NULLS NOT DISTINCT';
 END IF;
 IF to_regclass('public.exams_bulk_assessment_identity_unique') IS NULL
 OR to_regclass('public.exams_bulk_assessment_period_unique') IS NOT NULL
 OR to_regclass('public.exams_termwide_assessment_unique') IS NOT NULL
 OR to_regclass('public.grade_upload_previews') IS NOT NULL
 OR to_regprocedure('public.guard_exam_assessment_period()') IS NOT NULL
 OR to_regprocedure('public.guard_assessed_term_year()') IS NOT NULL THEN
   RAISE EXCEPTION 'Repair already applied, partially present, or old index missing. STOP and inspect; nothing changed.';
 END IF;
 IF to_regprocedure('public.submit_bulk_grades(jsonb,text,boolean)') IS NULL THEN
   RAISE EXCEPTION 'Expected bulk RPC missing; schema review required';
 END IF;
 IF (SELECT md5(replace(prosrc,E'\r\n',E'\n')) FROM pg_proc
 WHERE oid='public.submit_bulk_grades(jsonb,text,boolean)'::regprocedure) <> '9d78b8c6068b1bc66efef7e3d8810d69' THEN
   RAISE EXCEPTION 'Bulk RPC differs from inspected deployed version; review before replacement';
 END IF;
 IF (SELECT pg_get_indexdef('public.exams_bulk_assessment_identity_unique'::regclass)) <>
 'CREATE UNIQUE INDEX exams_bulk_assessment_identity_unique ON public.exams USING btree ("studentId", "subjectId", "examType", "assessmentLabel", "termId") WHERE (("subjectId" IS NOT NULL) AND ("termId" IS NOT NULL) AND ("assessmentLabel" IS NOT NULL))' THEN
   RAISE EXCEPTION 'Old index differs from inspected definition; no unrelated index will be dropped';
 END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='public.exams'::regclass
   AND tgname='enforce_exam_status_guard_trg' AND tgenabled='O'
   AND tgfoid=to_regprocedure('public.enforce_exam_status_guard()')) THEN
   RAISE EXCEPTION 'Expected enabled exam status guard missing; STOP';
 END IF;
END $preflight$;
LOCK TABLE public.exams IN SHARE ROW EXCLUSIVE MODE;
LOCK TABLE public.terms IN SHARE ROW EXCLUSIVE MODE;
-- Transaction-local exact full-row/permission snapshots; no real marks exported.
CREATE TEMP TABLE monthly_fix_before_exams ON COMMIT DROP AS
 SELECT id,to_jsonb(e) AS row_image FROM public.exams e;
CREATE TEMP TABLE monthly_fix_before_security ON COMMIT DROP AS
 SELECT c.oid,c.relacl,c.relrowsecurity,c.relforcerowsecurity
 FROM pg_class c WHERE c.oid IN ('public.exams'::regclass,'public.terms'::regclass);
CREATE TEMP TABLE monthly_fix_before_functions ON COMMIT DROP AS
 SELECT oid,proacl,proowner,prosecdef,proconfig,pg_get_function_result(oid) AS result_type
 FROM pg_proc WHERE oid IN (
 SELECT p.oid FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public');
CREATE TEMP TABLE monthly_fix_status_guard ON COMMIT DROP AS
 SELECT pg_get_functiondef('public.enforce_exam_status_guard()'::regprocedure) AS definition,
 pg_get_triggerdef(oid) AS trigger_definition FROM pg_trigger
 WHERE tgrelid='public.exams'::regclass AND tgname='enforce_exam_status_guard_trg';

-- Fail closed: never select a winning duplicate or repair a period automatically.
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM public.exams WHERE "subjectId" IS NOT NULL AND "termId" IS NOT NULL
      AND "assessmentLabel" IS NOT NULL GROUP BY "studentId","subjectId","examType","assessmentLabel","termId",month HAVING count(*) > 1) THEN
    RAISE EXCEPTION 'Duplicate month-aware identities require manual investigation; no marks changed.';
  END IF;
  IF EXISTS (SELECT 1 FROM public.exams WHERE month IS NULL OR month NOT IN
    ('January','February','March','April','May','June','July','August','September','October','November','December')) THEN
    RAISE EXCEPTION 'Ambiguous assessment months require manual investigation; no marks changed.';
  END IF;
  IF EXISTS (SELECT 1 FROM public.terms WHERE "academicYearId" IS NULL OR "startDate" IS NULL OR "endDate" IS NULL
      OR "endDate" < "startDate" OR "endDate" >= "startDate" + interval '1 year') THEN
    RAISE EXCEPTION 'Terms must identify one academic year and span less than twelve months.';
  END IF;
END $$;

-- Check termwide conflicts explicitly, including NULL labels/subjects/terms.
DO $$ BEGIN
 IF EXISTS(SELECT 1 FROM public.exams WHERE "examType" IN ('Midterm','Final')
  GROUP BY "studentId","subjectId","examType","assessmentLabel","termId" HAVING count(*)>1) THEN
  RAISE EXCEPTION 'Conflicting term-wide assessments; no winner will be chosen.';
 END IF;
END $$;
-- Establish replacement protection before dropping the old index, atomically.
CREATE UNIQUE INDEX exams_bulk_assessment_period_unique
  ON public.exams ("studentId", "subjectId", "examType", "assessmentLabel", "termId", month)
  NULLS NOT DISTINCT
  WHERE "subjectId" IS NOT NULL AND "termId" IS NOT NULL AND "assessmentLabel" IS NOT NULL;
DROP INDEX public.exams_bulk_assessment_identity_unique;

-- Legacy non-monthly Midterm/Final are term-wide, even though the physical month
-- column is NOT NULL. NULL labels compare equal here (PostgreSQL 15+).
-- Abort instead of guessing if this index encounters any historical duplicate.
CREATE UNIQUE INDEX exams_termwide_assessment_unique
  ON public.exams ("studentId", "subjectId", "examType", "assessmentLabel", "termId")
  NULLS NOT DISTINCT WHERE "examType" IN ('Midterm', 'Final');

CREATE TABLE public.grade_upload_previews (
  id text PRIMARY KEY, "uploadedBy" text NOT NULL REFERENCES public.profiles(id),
  payload_hash text NOT NULL, snapshot_hash text NOT NULL, period jsonb NOT NULL,
  "expiresAt" timestamptz NOT NULL
);
ALTER TABLE public.grade_upload_previews ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.grade_upload_previews FROM PUBLIC;

-- An UPDATE-by-ID must never silently relocate an assessment to another period.
-- INSERT validations do not alter any existing rows. Null legacy labels stay null.
CREATE OR REPLACE FUNCTION public.guard_exam_assessment_period() RETURNS trigger
LANGUAGE plpgsql SET search_path = public AS $$
DECLARE t public.terms%ROWTYPE;
BEGIN
  IF TG_OP = 'UPDATE' AND (NEW.month, NEW."termId", NEW."examType", NEW."assessmentLabel", NEW."subjectId")
    IS DISTINCT FROM (OLD.month, OLD."termId", OLD."examType", OLD."assessmentLabel", OLD."subjectId") THEN
    RAISE EXCEPTION 'Assessment identity and period cannot be changed in place. Use a separately reviewed correction.' USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.month IS NULL OR NEW.month NOT IN ('January','February','March','April','May','June','July','August','September','October','November','December') THEN
      RAISE EXCEPTION 'A canonical assessment month is required.' USING ERRCODE = 'check_violation';
    END IF;
    SELECT * INTO t FROM public.terms WHERE id = NEW."termId";
    IF NOT FOUND OR t."academicYearId" IS NULL THEN RAISE EXCEPTION 'A term and academic year are required.'; END IF;
    IF t."endDate" >= t."startDate" + interval '1 year' THEN RAISE EXCEPTION 'Term period is ambiguous.'; END IF;
    IF NOT EXISTS (SELECT 1 FROM generate_series(date_trunc('month', t."startDate"::timestamp), date_trunc('month', t."endDate"::timestamp), interval '1 month') d WHERE trim(to_char(d, 'Month')) = NEW.month) THEN
      RAISE EXCEPTION 'Assessment month is outside the selected term.';
    END IF;
    IF cardinality(t.months) > 0 AND NOT NEW.month = ANY(t.months) THEN RAISE EXCEPTION 'Assessment month is not configured for the selected term.'; END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER guard_exam_assessment_period_trg BEFORE INSERT OR UPDATE ON public.exams
FOR EACH ROW EXECUTE FUNCTION public.guard_exam_assessment_period();

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
  v_skipped_count INTEGER := 0;
  v_snapshot TEXT;
  v_preview public.grade_upload_previews%ROWTYPE;
  v_period JSONB;
BEGIN
  IF v_actor_id IS NULL OR v_role NOT IN ('teacher', 'admin') THEN
    RAISE EXCEPTION 'Only authenticated teachers and admins may submit bulk grades.' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF p_confirm_updates IS NULL THEN RAISE EXCEPTION 'An explicit preview or confirmation flag is required.'; END IF;
  IF p_idempotency_key IS NULL OR length(trim(p_idempotency_key)) < 12 THEN
    RAISE EXCEPTION 'A valid upload idempotency key is required.' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF p_records IS NULL OR jsonb_typeof(p_records) <> 'array' OR jsonb_array_length(p_records) = 0 THEN
    RAISE EXCEPTION 'At least one grade record is required.' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF jsonb_array_length(p_records) > 10000 THEN
    RAISE EXCEPTION 'A bulk upload may contain at most 10,000 grade records.' USING ERRCODE = 'program_limit_exceeded';
  END IF;

  -- Serialize a key across preview/confirmation/retry. No assessment writes yet.
  PERFORM pg_advisory_xact_lock(hashtextextended(p_idempotency_key, 0));
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
    IF v_assessment_label IS NULL OR v_assessment_label NOT IN ('HW1', 'HW2', 'HW3', 'HW4', 'CPW1', 'CPW2', 'CPW3', 'CPW4', 'ATTENDANCE', 'MT', 'AKHLAAQ') THEN
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
    IF NOT (v_month = ANY(ARRAY['January','February','March','April','May','June','July','August','September','October','November','December'])) THEN
      RAISE EXCEPTION 'A canonical assessment month is required.' USING ERRCODE = 'check_violation';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM generate_series(date_trunc('month', v_term_start::timestamp), date_trunc('month', v_term_end::timestamp), interval '1 month') d WHERE trim(to_char(d, 'Month')) = v_month) THEN
      RAISE EXCEPTION 'Assessment month is outside the selected term.' USING ERRCODE = 'check_violation';
    END IF;
    -- The assessment date is not the upload timestamp; it must agree with the selected month.
    IF trim(to_char(v_date, 'Month')) <> v_month THEN
      RAISE EXCEPTION 'Assessment date and selected month disagree.' USING ERRCODE = 'check_violation';
    END IF;
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
        AND prior->>'month' = v_month
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

  IF (SELECT count(DISTINCT (r->>'termId', r->>'month')) FROM jsonb_array_elements(v_normalized) r) <> 1 THEN
    RAISE EXCEPTION 'One upload must contain exactly one term and assessment month.' USING ERRCODE = 'check_violation';
  END IF;
  SELECT jsonb_build_object('termId', t.id, 'termName', t.name,
      'academicYearId', t."academicYearId", 'academicYearName', (SELECT ay.name FROM public.academic_years ay WHERE ay.id = t."academicYearId"), 'month', v_month)
    INTO v_period FROM public.terms t WHERE t.id = v_term_id;
  IF v_period->>'academicYearId' IS NULL THEN
    RAISE EXCEPTION 'Selected term must identify an academic year.';
  END IF;

  -- Freeze the current assessment state while checking and applying a confirmation.
  -- Also serializes with direct writes, not merely other uploads.
  IF p_confirm_updates THEN LOCK TABLE public.exams IN SHARE ROW EXCLUSIVE MODE; END IF;

  SELECT COALESCE(jsonb_agg(change ORDER BY change->>'studentId', change->>'subjectId', change->>'assessmentLabel'), '[]'::jsonb)
  INTO v_changes FROM (
    SELECT jsonb_build_object(
      'studentId', r->>'studentId', 'studentName', s.name, 'className', s."className",
      'subject', r->>'subject', 'subjectId', r->>'subjectId',
      'assessmentLabel', r->>'assessmentLabel', 'examType', r->>'examType',
      'newMonth', r->>'month', 'existingMonth', e.month,
      'newTotal', (r->>'total')::integer, 'existingTotal', e.total,
      'newScore', (r->>'score')::numeric, 'newEntryState', r->>'entryState',
      'existingScore', e.score, 'existingEntryState', e."entryState", 'existingStatus', e.status,
      'existingId', e.id,
      'changeType', CASE WHEN e.id IS NULL THEN 'new'
        WHEN (e.score, e.total, e."entryState") IS NOT DISTINCT FROM
             ((r->>'score')::numeric, (r->>'total')::integer, r->>'entryState') THEN 'unchanged'
        ELSE 'update' END,
      'isApproved', COALESCE(e.status = 'approved' AND
        (e.score, e.total, e."entryState") IS DISTINCT FROM
        ((r->>'score')::numeric, (r->>'total')::integer, r->>'entryState'), false),
      'preservedPeriods', COALESCE((SELECT jsonb_agg(DISTINCT other.month ORDER BY other.month)
        FROM public.exams other WHERE other."studentId" = r->>'studentId'
          AND other."subjectId" = r->>'subjectId' AND other."examType" = r->>'examType'
          AND other."assessmentLabel" = r->>'assessmentLabel' AND other."termId" = r->>'termId'
          AND other.month IS DISTINCT FROM r->>'month'), '[]'::jsonb)
    ) change
    FROM jsonb_array_elements(v_normalized) r JOIN public.students s ON s.id = r->>'studentId'
    LEFT JOIN public.exams e ON e."studentId" = r->>'studentId' AND e."subjectId" = r->>'subjectId'
      AND e."examType" = r->>'examType' AND e."assessmentLabel" = r->>'assessmentLabel'
      AND e."termId" = r->>'termId' AND e.month = r->>'month'
  ) details;
  SELECT count(*) FILTER (WHERE c->>'changeType' = 'new'),
    count(*) FILTER (WHERE c->>'changeType' = 'update'),
    count(*) FILTER (WHERE c->>'changeType' = 'unchanged'),
    count(*) FILTER (WHERE (c->>'isApproved')::boolean)
    INTO v_insert_count, v_update_count, v_skipped_count, v_approved_change_count
    FROM jsonb_array_elements(v_changes) c;
  v_snapshot := md5(v_changes::text || v_period::text);

  IF NOT p_confirm_updates THEN
    INSERT INTO public.grade_upload_previews(id, "uploadedBy", payload_hash, snapshot_hash, period, "expiresAt")
    VALUES(p_idempotency_key, v_actor_id, v_payload_hash, v_snapshot, v_period, now() + interval '30 minutes')
    ON CONFLICT(id) DO UPDATE SET payload_hash = EXCLUDED.payload_hash,
      snapshot_hash = EXCLUDED.snapshot_hash, period = EXCLUDED.period, "expiresAt" = EXCLUDED."expiresAt"
    WHERE grade_upload_previews."uploadedBy" = EXCLUDED."uploadedBy";
    IF NOT FOUND THEN RAISE EXCEPTION 'Upload preview key belongs to another account.'; END IF;
    RETURN jsonb_build_object('requiresConfirmation', true, 'insertCount', v_insert_count,
      'updateCount', v_update_count, 'skippedCount', v_skipped_count,
      'approvedChangeCount', v_approved_change_count,
      'requiresApprovedAcknowledgement', v_approved_change_count > 0,
      'period', v_period, 'changes', v_changes, 'identityVersion', 2);
  END IF;
  SELECT * INTO v_preview FROM public.grade_upload_previews WHERE id = p_idempotency_key;
  IF NOT FOUND OR v_preview."uploadedBy" <> v_actor_id OR v_preview.payload_hash <> v_payload_hash
     OR v_preview.snapshot_hash <> v_snapshot OR v_preview.period <> v_period OR v_preview."expiresAt" < now() THEN
    RAISE EXCEPTION 'Upload or existing marks changed, or preview expired. Validate and review again.' USING ERRCODE = 'serialization_failure';
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
    ON CONFLICT ("studentId", "subjectId", "examType", "assessmentLabel", "termId", month)
      WHERE "subjectId" IS NOT NULL AND "termId" IS NOT NULL AND "assessmentLabel" IS NOT NULL
    DO UPDATE SET
      score = EXCLUDED.score,
      total = EXCLUDED.total,
      "entryState" = EXCLUDED."entryState",
      date = EXCLUDED.date,
      status = 'pending',
      "parentId" = EXCLUDED."parentId",
      "teacherId" = EXCLUDED."teacherId",
      "uploadedBy" = EXCLUDED."uploadedBy"
    WHERE (exams.score, exams.total, exams."entryState") IS DISTINCT FROM
          (EXCLUDED.score, EXCLUDED.total, EXCLUDED."entryState");
  END LOOP;

  v_result := jsonb_build_object(
    'requiresConfirmation', FALSE,
    'insertCount', v_insert_count,
    'updateCount', v_update_count,
    'skippedCount', v_skipped_count,
    'uploadId', p_idempotency_key,
    'period', v_period, 'identityVersion', 2,
    'message', 'Bulk grade upload completed.'
  );
  INSERT INTO public.grade_uploads (id, "uploadedBy", payload_hash, status, result)
  VALUES (p_idempotency_key, v_actor_id, v_payload_hash, 'completed', v_result);
  RETURN v_result;
END;
$$;

-- Existing submit_bulk_grades ownership/ACL retained by CREATE OR REPLACE.
-- No grant/revoke on any existing function, table, policy or exam trigger.

DO $replace_fn$
DECLARE target oid; body_hash text;
BEGIN
 SELECT p.oid,md5(replace(p.prosrc,E'\r\n',E'\n')) INTO target,body_hash
 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
 WHERE n.nspname='public' AND p.proname='preview_student_merge';
 IF target IS NOT NULL THEN
 IF body_hash='cc4dd8c5d3de634b6ce996a985b431a4' THEN
 -- Complete replacement from 20260922_duplicate_students_merge.sql; existing ACL/owner retained.
 EXECUTE $complete_definition$
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
    AND c."assessmentLabel" IS NOT DISTINCT FROM d."assessmentLabel" AND (CASE WHEN c."examType" IN ('Midterm','Final') THEN NULL ELSE c.month END) IS NOT DISTINCT FROM (CASE WHEN d."examType" IN ('Midterm','Final') THEN NULL ELSE d.month END)
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
$complete_definition$;
 ELSE RAISE EXCEPTION 'Unexpected deployed body for preview_student_merge; no changes committed'; END IF;
 END IF;
END $replace_fn$;
DO $replace_fn$
DECLARE target oid; body_hash text;
BEGIN
 SELECT p.oid,md5(replace(p.prosrc,E'\r\n',E'\n')) INTO target,body_hash
 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
 WHERE n.nspname='public' AND p.proname='merge_duplicate_students';
 IF target IS NOT NULL THEN
 IF body_hash='5b83ec1933f5689e2ba5cd4edfd192ab' THEN
 -- Complete replacement from 20260922_duplicate_students_merge.sql; existing ACL/owner retained.
 EXECUTE $complete_definition$
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
    AND c."assessmentLabel" IS NOT DISTINCT FROM d."assessmentLabel" AND (CASE WHEN c."examType" IN ('Midterm','Final') THEN NULL ELSE c.month END) IS NOT DISTINCT FROM (CASE WHEN d."examType" IN ('Midterm','Final') THEN NULL ELSE d.month END)
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
$complete_definition$;
 ELSE RAISE EXCEPTION 'Unexpected deployed body for merge_duplicate_students; no changes committed'; END IF;
 END IF;
END $replace_fn$;
DO $replace_fn$
DECLARE target oid; body_hash text;
BEGIN
 SELECT p.oid,md5(replace(p.prosrc,E'\r\n',E'\n')) INTO target,body_hash
 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
 WHERE n.nspname='public' AND p.proname='merge_duplicate_students_resolved';
 IF target IS NOT NULL THEN
 IF body_hash='3b3ed6de23190feed348b714b403745a' THEN
 -- Complete replacement from 20260924_duplicate_merge_resolution.sql; existing ACL/owner retained.
 EXECUTE $complete_definition$
CREATE OR REPLACE FUNCTION public.merge_duplicate_students_resolved(
  p_canonical_id TEXT,
  p_duplicate_id TEXT,
  p_resolution JSONB DEFAULT '{}'::jsonb,
  p_reason TEXT DEFAULT NULL
) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_role TEXT := public.current_profile_role();
  v_actor TEXT := public.current_profile_id();
  v_can RECORD; v_dup RECORD;
  v_prof JSONB;
  v_exam_res JSONB; v_att_res JSONB; v_quiz_res JSONB; v_rel_res JSONB; v_rep_res JSONB; v_enr_res JSONB;
  v_conf JSONB;
  v_final_name TEXT; v_final_gov TEXT; v_final_parent TEXT; v_final_phone TEXT; v_final_transport TEXT; v_final_class TEXT;
  v_choice TEXT;
  v_gov_match TEXT;
  v_parent_exists INT;
  v_exam_pair JSONB; v_att_pair JSONB; v_quiz_pair JSONB; v_rel_pair JSONB; v_rep_pair JSONB;
  v_i INT;
  v_keep TEXT;
  v_can_exam_id TEXT; v_dup_exam_id TEXT;
  v_can_att_id TEXT; v_dup_att_id TEXT;
  v_can_quiz_id TEXT; v_dup_quiz_id TEXT;
  v_can_rel_id TEXT; v_dup_rel_id TEXT;
  v_can_rep_id TEXT; v_dup_rep_id TEXT;
  v_open_can RECORD; v_open_dup RECORD; v_open_can_cnt INT; v_open_dup_cnt INT;
  v_enroll_action_json JSONB;
  v_before_counts JSONB; v_after JSONB;
  v_audit_id TEXT;
  v_count INT;
  v_hist_can INT; v_hist_dup INT;
  v_exams_conflicts INT; v_att_conflicts INT; v_quiz_conflicts INT; v_rel_conflicts INT; v_rep_conflicts INT;
  v_enroll_keep TEXT; v_enroll_action_text TEXT;
BEGIN
  IF v_role IS NULL OR v_role <> 'admin' THEN
    RAISE EXCEPTION 'Only administrators may merge students.' USING ERRCODE='insufficient_privilege';
  END IF;
  IF p_canonical_id IS NULL OR p_duplicate_id IS NULL OR p_canonical_id = p_duplicate_id THEN
    RAISE EXCEPTION 'Two distinct student IDs required.' USING ERRCODE='invalid_parameter_value';
  END IF;
  IF p_resolution IS NULL THEN p_resolution := '{}'::jsonb; END IF;
  v_prof := COALESCE(p_resolution->'profile_resolution', p_resolution->'profileResolution', '{}'::jsonb);
  v_exam_res := COALESCE(p_resolution->'exam_resolution', p_resolution->'examResolution', '[]'::jsonb);
  v_att_res := COALESCE(p_resolution->'attendance_resolution', p_resolution->'attendanceResolution', '[]'::jsonb);
  v_quiz_res := COALESCE(p_resolution->'quiz_resolution', p_resolution->'quizResolution', '[]'::jsonb);
  v_rel_res := COALESCE(p_resolution->'release_resolution', p_resolution->'releaseResolution', '[]'::jsonb);
  v_rep_res := COALESCE(p_resolution->'report_comment_resolution', p_resolution->'reportCommentResolution', '[]'::jsonb);
  v_enr_res := COALESCE(p_resolution->'enrollment_resolution', p_resolution->'enrollmentResolution', NULL);

  -- Lock both rows deterministic
  IF p_canonical_id < p_duplicate_id THEN
    SELECT * INTO v_can FROM public.students WHERE id = p_canonical_id FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'Canonical % not found', p_canonical_id USING ERRCODE='no_data_found'; END IF;
    SELECT * INTO v_dup FROM public.students WHERE id = p_duplicate_id FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'Duplicate % not found', p_duplicate_id USING ERRCODE='no_data_found'; END IF;
  ELSE
    SELECT * INTO v_dup FROM public.students WHERE id = p_duplicate_id FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'Duplicate % not found', p_duplicate_id USING ERRCODE='no_data_found'; END IF;
    SELECT * INTO v_can FROM public.students WHERE id = p_canonical_id FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'Canonical % not found', p_canonical_id USING ERRCODE='no_data_found'; END IF;
  END IF;

  -- Fetch conflicts fresh (to validate counts)
  SELECT public.get_merge_conflicts(p_canonical_id, p_duplicate_id) INTO v_conf;

  -- ── Profile resolution validation ──────────────────────────────────────
  -- Fields: name, gov_id, parent_id, parent_phone, transport, class_name
  -- Each choice must be canonical / duplicate / remove(blank) and value must exist on that record
  -- Gov ID special: verify not belonging to third student

  -- Name
  v_choice := COALESCE(v_prof->>'name', v_prof->>'Name', 'canonical');
  IF v_choice NOT IN ('canonical','duplicate','A','B') THEN
    RAISE EXCEPTION 'Invalid name resolution %', v_choice USING ERRCODE='invalid_parameter_value';
  END IF;
  IF v_choice IN ('duplicate','B') THEN v_final_name := v_dup.name; ELSE v_final_name := v_can.name; END IF;

  -- Class
  v_choice := COALESCE(v_prof->>'class_name', v_prof->>'className', v_prof->>'class', 'canonical');
  IF v_choice NOT IN ('canonical','duplicate','A','B') THEN
    RAISE EXCEPTION 'Invalid class resolution %', v_choice USING ERRCODE='invalid_parameter_value';
  END IF;
  IF v_choice IN ('duplicate','B') THEN v_final_class := v_dup."className"; ELSE v_final_class := v_can."className"; END IF;
  IF v_final_class IS NULL OR btrim(v_final_class) = '' THEN
    RAISE EXCEPTION 'Class resolution yields empty class.' USING ERRCODE='invalid_parameter_value';
  END IF;

  -- Transport (allow remove)
  v_choice := COALESCE(v_prof->>'transport', 'canonical');
  IF v_choice NOT IN ('canonical','duplicate','remove','blank') THEN
    RAISE EXCEPTION 'Invalid transport resolution %', v_choice USING ERRCODE='invalid_parameter_value';
  END IF;
  IF v_choice = 'remove' OR v_choice = 'blank' THEN v_final_transport := NULL;
  ELSIF v_choice IN ('duplicate','B') THEN v_final_transport := v_dup.transport;
  ELSE v_final_transport := v_can.transport;
  END IF;

  -- Parent
  v_choice := COALESCE(v_prof->>'parent_id', v_prof->>'parentId', v_prof->>'parent', 'canonical');
  -- Normalize choices: canonical/duplicate/remove/unassigned/A/B
  IF v_choice IN ('A') THEN v_choice := 'canonical'; END IF;
  IF v_choice IN ('B') THEN v_choice := 'duplicate'; END IF;
  IF v_choice IN ('unassigned','remove','blank','null') THEN v_choice := 'remove'; END IF;
  IF v_choice NOT IN ('canonical','duplicate','remove') THEN
    RAISE EXCEPTION 'Invalid parent resolution %', v_choice USING ERRCODE='invalid_parameter_value';
  END IF;
  IF v_choice = 'remove' THEN v_final_parent := NULL;
  ELSIF v_choice = 'duplicate' THEN v_final_parent := v_dup."parentId";
  ELSE v_final_parent := v_can."parentId";
  END IF;
  IF v_final_parent IS NOT NULL THEN
    SELECT count(*) INTO v_parent_exists FROM public.profiles WHERE id = v_final_parent;
    IF v_parent_exists = 0 THEN
      -- Also check users table fallback
      SELECT count(*) INTO v_parent_exists FROM public.users WHERE id = v_final_parent;
      IF v_parent_exists = 0 THEN
        RAISE EXCEPTION 'Selected parent % does not exist.', v_final_parent USING ERRCODE='foreign_key_violation';
      END IF;
    END IF;
  END IF;

  -- Parent phone (allow remove)
  v_choice := COALESCE(v_prof->>'parent_phone', v_prof->>'parentPhone', 'canonical');
  IF v_choice NOT IN ('canonical','duplicate','remove','blank') THEN
    RAISE EXCEPTION 'Invalid parent phone resolution %', v_choice USING ERRCODE='invalid_parameter_value';
  END IF;
  IF v_choice = 'remove' OR v_choice = 'blank' THEN v_final_phone := NULL;
  ELSIF v_choice = 'duplicate' THEN v_final_phone := NULLIF(public.normalize_phone(v_dup."parentPhone"),'');
  ELSE v_final_phone := NULLIF(public.normalize_phone(v_can."parentPhone"),'');
  END IF;

  -- Gov ID (allow remove, must be one of the two values or blank, and not belonging to third)
  v_choice := COALESCE(v_prof->>'gov_id', v_prof->>'govId', 'canonical');
  IF v_choice NOT IN ('canonical','duplicate','remove','blank') THEN
    RAISE EXCEPTION 'Invalid gov id resolution %', v_choice USING ERRCODE='invalid_parameter_value';
  END IF;
  IF v_choice = 'remove' OR v_choice = 'blank' THEN v_final_gov := NULL;
  ELSIF v_choice = 'duplicate' THEN v_final_gov := public.gov_id_key(v_dup."govId");
  ELSE v_final_gov := public.gov_id_key(v_can."govId");
  END IF;
  -- Normalize empty gov to null
  IF v_final_gov IS NOT NULL AND btrim(v_final_gov) = '' THEN v_final_gov := NULL; END IF;
  -- Verify chosen gov is actually from canonical or duplicate (or null)
  -- If both have gov and choice is canonical, it's v_can's gov, etc. — already ensured.
  -- But also need to handle case where admin chooses 'canonical' but canonical gov is blank and duplicate has gov — that's allowed? But then chosen gov would be null, not duplicate's gov. If they want duplicate's gov they must choose duplicate.
  -- Also need to verify not belonging to third student
  IF v_final_gov IS NOT NULL THEN
    IF EXISTS (SELECT 1 FROM public.students WHERE public.gov_id_key("govId") = v_final_gov AND id NOT IN (p_canonical_id, p_duplicate_id)) THEN
      RAISE EXCEPTION 'This Government ID belongs to another student.' USING ERRCODE='unique_violation';
    END IF;
    IF EXISTS (SELECT 1 FROM public.students WHERE public.gov_id_match_key("govId") = public.gov_id_match_key(v_final_gov) AND id NOT IN (p_canonical_id, p_duplicate_id) AND public.gov_id_match_key("govId") <> '') THEN
      RAISE EXCEPTION 'This Government ID belongs to another student.' USING ERRCODE='unique_violation';
    END IF;
  END IF;
  -- Also ensure that if v_final_gov is not null, it equals one of the two original gov keys or is null (we already limited), but we should also assert that if choice=canonical and v_can gov is null, then v_final_gov should be null (which it is). Okay.

  -- ── Enrollment resolution ─────────────────────────────────────────────
  SELECT * INTO v_open_can FROM public.student_enrollments WHERE "studentId"=p_canonical_id AND "effectiveTo" IS NULL LIMIT 1;
  SELECT * INTO v_open_dup FROM public.student_enrollments WHERE "studentId"=p_duplicate_id AND "effectiveTo" IS NULL LIMIT 1;
  SELECT count(*) INTO v_open_can_cnt FROM public.student_enrollments WHERE "studentId"=p_canonical_id AND "effectiveTo" IS NULL;
  SELECT count(*) INTO v_open_dup_cnt FROM public.student_enrollments WHERE "studentId"=p_duplicate_id AND "effectiveTo" IS NULL;
  IF v_open_can_cnt > 1 OR v_open_dup_cnt > 1 THEN
    RAISE EXCEPTION 'Merge blocked: multiple open enrollments detected (% vs %). Manual review required.', v_open_can_cnt, v_open_dup_cnt USING ERRCODE='integrity_constraint_violation';
  END IF;

  IF v_enr_res IS NOT NULL AND jsonb_typeof(v_enr_res) = 'object' THEN
    v_enroll_action_text := COALESCE(v_enr_res->>'action', 'consolidate');
    v_enroll_keep := COALESCE(v_enr_res->>'keep', 'canonical');
  ELSE
    -- Default: if same class/year consolidate, else preserve
    IF v_open_can."className" IS NOT NULL AND v_open_dup."className" IS NOT NULL AND v_open_can."className" = v_open_dup."className" AND v_open_can."academicYearId" IS NOT DISTINCT FROM v_open_dup."academicYearId" THEN
      v_enroll_action_text := 'consolidate';
    ELSIF v_open_can IS NULL AND v_open_dup IS NOT NULL THEN
      v_enroll_action_text := 'transfer';
    ELSE
      v_enroll_action_text := 'preserve_history';
    END IF;
    v_enroll_keep := 'canonical';
  END IF;

  -- Validate enrollment action
  IF v_enroll_action_text NOT IN ('consolidate','transfer','preserve_history','keep_canonical','keep_duplicate','blocked') THEN
    RAISE EXCEPTION 'Invalid enrollment action %', v_enroll_action_text USING ERRCODE='invalid_parameter_value';
  END IF;
  -- For different class/year, only allow explicit resolution if provided; if not provided and they differ, block unless resolved
  IF v_open_can."className" IS NOT NULL AND v_open_dup."className" IS NOT NULL THEN
    IF v_open_can."className" <> v_open_dup."className" OR v_open_can."academicYearId" IS DISTINCT FROM v_open_dup."academicYearId" THEN
      -- Need explicit enrollment resolution to proceed
      IF v_enr_res IS NULL THEN
        RAISE EXCEPTION 'Enrollment histories are contradictory (% vs % / year % vs %). Provide explicit enrollment_resolution.', v_open_can."className", v_open_dup."className", COALESCE(v_open_can."academicYearId",'null'), COALESCE(v_open_dup."academicYearId",'null') USING ERRCODE='integrity_constraint_violation';
      END IF;
      -- If enrollments differ and action is consolidate, that's only valid when same class/year, so reject consolidate in this case
      IF v_enroll_action_text = 'consolidate' THEN
        RAISE EXCEPTION 'Cannot consolidate enrollments with different class or academic year. Choose transfer or preserve.' USING ERRCODE='invalid_parameter_value';
      END IF;
    END IF;
  END IF;

  -- ── Exam attendance quiz release report conflict validation ────────────
  SELECT count(*) INTO v_exams_conflicts FROM public.exams c JOIN public.exams d ON d."studentId"=p_duplicate_id AND c."studentId"=p_canonical_id AND c."subjectId" IS NOT DISTINCT FROM d."subjectId" AND c."examType"=d."examType" AND c."assessmentLabel" IS NOT DISTINCT FROM d."assessmentLabel" AND (CASE WHEN c."examType" IN ('Midterm','Final') THEN NULL ELSE c.month END) IS NOT DISTINCT FROM (CASE WHEN d."examType" IN ('Midterm','Final') THEN NULL ELSE d.month END) AND c."termId" IS NOT DISTINCT FROM d."termId";
  SELECT count(*) INTO v_att_conflicts FROM public.attendance c JOIN public.attendance d ON d."studentId"=p_duplicate_id AND c."studentId"=p_canonical_id AND c.date = d.date;
  SELECT count(*) INTO v_quiz_conflicts FROM public.quiz_attempts c JOIN public.quiz_attempts d ON d."studentId"=p_duplicate_id AND c."studentId"=p_canonical_id AND c."quizId"=d."quizId";
  SELECT count(*) INTO v_rel_conflicts FROM public.release_log c JOIN public.release_log d ON d."studentId"=p_duplicate_id AND c."studentId"=p_canonical_id AND (c."createdAt" AT TIME ZONE 'UTC')::date = (d."createdAt" AT TIME ZONE 'UTC')::date;
  SELECT count(*) INTO v_rep_conflicts FROM public.report_comments c JOIN public.report_comments d ON d."studentId"=p_duplicate_id AND c."studentId"=p_canonical_id AND c."termId"=d."termId";

  -- Validate each resolution array length matches conflicts and each entry is valid

  IF jsonb_typeof(v_exam_res) <> 'array' THEN RAISE EXCEPTION 'exam_resolution must be array' USING ERRCODE='invalid_parameter_value'; END IF;
  IF jsonb_array_length(v_exam_res) <> v_exams_conflicts THEN
    -- If conflicts >0 and resolution not fully provided, block
    IF v_exams_conflicts > 0 AND jsonb_array_length(v_exam_res) = 0 THEN
      RAISE EXCEPTION 'Exam conflicts require resolution: % conflicts, 0 provided', v_exams_conflicts USING ERRCODE='integrity_constraint_violation';
    END IF;
    -- Also if length mismatched, block
    IF v_exams_conflicts <> jsonb_array_length(v_exam_res) THEN
      RAISE EXCEPTION 'Exam resolution incomplete: % conflicts, % provided', v_exams_conflicts, jsonb_array_length(v_exam_res) USING ERRCODE='integrity_constraint_violation';
    END IF;
  END IF;
  FOR v_i IN 0..jsonb_array_length(v_exam_res)-1 LOOP
    v_exam_pair := v_exam_res->v_i;
    v_keep := COALESCE(v_exam_pair->>'keep', v_exam_pair->>'Keep', '');
    v_can_exam_id := COALESCE(v_exam_pair->>'canonical_exam_id', v_exam_pair->>'canonicalExamId', v_exam_pair->>'canId');
    v_dup_exam_id := COALESCE(v_exam_pair->>'duplicate_exam_id', v_exam_pair->>'duplicateExamId', v_exam_pair->>'dupId');
    -- Alternative shape: keep as 'canonical'/'duplicate' without ids — then we validate by identity
    IF v_keep NOT IN ('canonical','duplicate','A','B') THEN
      RAISE EXCEPTION 'Invalid exam keep % at index %', v_keep, v_i USING ERRCODE='invalid_parameter_value';
    END IF;
    IF v_can_exam_id IS NOT NULL AND v_dup_exam_id IS NOT NULL THEN
      -- Verify they exist and belong to correct students and share identity
      IF NOT EXISTS (SELECT 1 FROM public.exams WHERE id = v_can_exam_id AND "studentId"=p_canonical_id) THEN
        RAISE EXCEPTION 'Exam % does not belong to canonical %', v_can_exam_id, p_canonical_id USING ERRCODE='foreign_key_violation';
      END IF;
      IF NOT EXISTS (SELECT 1 FROM public.exams WHERE id = v_dup_exam_id AND "studentId"=p_duplicate_id) THEN
        RAISE EXCEPTION 'Exam % does not belong to duplicate %', v_dup_exam_id, p_duplicate_id USING ERRCODE='foreign_key_violation';
      END IF;
      -- Verify identity matches
      IF NOT EXISTS (
        SELECT 1 FROM public.exams c, public.exams d
        WHERE c.id = v_can_exam_id AND d.id = v_dup_exam_id
          AND c."subjectId" IS NOT DISTINCT FROM d."subjectId"
          AND c."examType" = d."examType"
          AND c."assessmentLabel" IS NOT DISTINCT FROM d."assessmentLabel" AND (CASE WHEN c."examType" IN ('Midterm','Final') THEN NULL ELSE c.month END) IS NOT DISTINCT FROM (CASE WHEN d."examType" IN ('Midterm','Final') THEN NULL ELSE d.month END)
          AND c."termId" IS NOT DISTINCT FROM d."termId"
      ) THEN
        RAISE EXCEPTION 'Exams % and % do not share identity', v_can_exam_id, v_dup_exam_id USING ERRCODE='invalid_parameter_value';
      END IF;
    ELSE
      -- If ids not provided, we can validate by ensuring keep choice corresponds to an actual conflict identity exists (implicit)
      -- For now, require ids when conflicts exist
      IF v_exams_conflicts > 0 AND (v_can_exam_id IS NULL OR v_dup_exam_id IS NULL) THEN
        RAISE EXCEPTION 'Exam resolution at % missing canonical/duplicate ids', v_i USING ERRCODE='invalid_parameter_value';
      END IF;
    END IF;
  END LOOP;

  -- Attendance
  IF jsonb_typeof(v_att_res) <> 'array' THEN RAISE EXCEPTION 'attendance_resolution must be array' USING ERRCODE='invalid_parameter_value'; END IF;
  IF jsonb_array_length(v_att_res) <> v_att_conflicts THEN
    IF v_att_conflicts > 0 AND jsonb_array_length(v_att_res)=0 THEN RAISE EXCEPTION 'Attendance conflicts require resolution: % conflicts', v_att_conflicts USING ERRCODE='integrity_constraint_violation'; END IF;
    IF v_att_conflicts <> jsonb_array_length(v_att_res) THEN RAISE EXCEPTION 'Attendance resolution incomplete: % vs %', v_att_conflicts, jsonb_array_length(v_att_res) USING ERRCODE='integrity_constraint_violation'; END IF;
  END IF;
  FOR v_i IN 0..jsonb_array_length(v_att_res)-1 LOOP
    v_att_pair := v_att_res->v_i;
    v_keep := COALESCE(v_att_pair->>'keep','');
    v_can_att_id := COALESCE(v_att_pair->>'canonical_id', v_att_pair->>'canonicalId');
    v_dup_att_id := COALESCE(v_att_pair->>'duplicate_id', v_att_pair->>'duplicateId');
    IF v_keep NOT IN ('canonical','duplicate','A','B') THEN RAISE EXCEPTION 'Invalid attendance keep %', v_keep USING ERRCODE='invalid_parameter_value'; END IF;
    IF v_can_att_id IS NOT NULL THEN
      IF NOT EXISTS (SELECT 1 FROM public.attendance WHERE id=v_can_att_id AND "studentId"=p_canonical_id) THEN RAISE EXCEPTION 'Attendance % not canonical', v_can_att_id USING ERRCODE='foreign_key_violation'; END IF;
    END IF;
    IF v_dup_att_id IS NOT NULL THEN
      IF NOT EXISTS (SELECT 1 FROM public.attendance WHERE id=v_dup_att_id AND "studentId"=p_duplicate_id) THEN RAISE EXCEPTION 'Attendance % not duplicate', v_dup_att_id USING ERRCODE='foreign_key_violation'; END IF;
    END IF;
    -- Verify exact conflict identity: canonical.date = duplicate.date
    IF v_can_att_id IS NOT NULL AND v_dup_att_id IS NOT NULL THEN
      IF NOT EXISTS (SELECT 1 FROM public.attendance c JOIN public.attendance d ON c.date = d.date WHERE c.id=v_can_att_id AND d.id=v_dup_att_id AND c."studentId"=p_canonical_id AND d."studentId"=p_duplicate_id) THEN
        RAISE EXCEPTION 'Attendance % and % do not share identical date', v_can_att_id, v_dup_att_id USING ERRCODE='invalid_parameter_value';
      END IF;
    END IF;
  END LOOP;

  -- Quiz
  IF jsonb_typeof(v_quiz_res) <> 'array' THEN RAISE EXCEPTION 'quiz_resolution must be array' USING ERRCODE='invalid_parameter_value'; END IF;
  IF jsonb_array_length(v_quiz_res) <> v_quiz_conflicts THEN
    IF v_quiz_conflicts >0 AND jsonb_array_length(v_quiz_res)=0 THEN RAISE EXCEPTION 'Quiz conflicts require resolution: %', v_quiz_conflicts USING ERRCODE='integrity_constraint_violation'; END IF;
    IF v_quiz_conflicts <> jsonb_array_length(v_quiz_res) THEN RAISE EXCEPTION 'Quiz resolution incomplete'; END IF;
  END IF;
  FOR v_i IN 0..jsonb_array_length(v_quiz_res)-1 LOOP
    v_quiz_pair := v_quiz_res->v_i;
    v_keep := COALESCE(v_quiz_pair->>'keep','');
    v_can_quiz_id := COALESCE(v_quiz_pair->>'canonical_id', v_quiz_pair->>'canonicalId');
    v_dup_quiz_id := COALESCE(v_quiz_pair->>'duplicate_id', v_quiz_pair->>'duplicateId');
    IF v_keep NOT IN ('canonical','duplicate','A','B') THEN RAISE EXCEPTION 'Invalid quiz keep %', v_keep USING ERRCODE='invalid_parameter_value'; END IF;
    IF v_can_quiz_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.quiz_attempts WHERE id=v_can_quiz_id AND "studentId"=p_canonical_id) THEN RAISE EXCEPTION 'Quiz attempt % not canonical', v_can_quiz_id USING ERRCODE='foreign_key_violation'; END IF;
    IF v_dup_quiz_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.quiz_attempts WHERE id=v_dup_quiz_id AND "studentId"=p_duplicate_id) THEN RAISE EXCEPTION 'Quiz attempt % not duplicate', v_dup_quiz_id USING ERRCODE='foreign_key_violation'; END IF;
    -- Verify exact conflict identity: canonical.quizId = duplicate.quizId
    IF v_can_quiz_id IS NOT NULL AND v_dup_quiz_id IS NOT NULL THEN
      IF NOT EXISTS (SELECT 1 FROM public.quiz_attempts c JOIN public.quiz_attempts d ON c."quizId"=d."quizId" WHERE c.id=v_can_quiz_id AND d.id=v_dup_quiz_id AND c."studentId"=p_canonical_id AND d."studentId"=p_duplicate_id) THEN
        RAISE EXCEPTION 'Quiz attempts % and % do not share identical quizId', v_can_quiz_id, v_dup_quiz_id USING ERRCODE='invalid_parameter_value';
      END IF;
    END IF;
  END LOOP;

  -- Release
  IF jsonb_typeof(v_rel_res) <> 'array' THEN RAISE EXCEPTION 'release_resolution must be array'; END IF;
  IF jsonb_array_length(v_rel_res) <> v_rel_conflicts THEN
    IF v_rel_conflicts>0 AND jsonb_array_length(v_rel_res)=0 THEN RAISE EXCEPTION 'Release conflicts require resolution: %', v_rel_conflicts USING ERRCODE='integrity_constraint_violation'; END IF;
    IF v_rel_conflicts <> jsonb_array_length(v_rel_res) THEN RAISE EXCEPTION 'Release resolution incomplete'; END IF;
  END IF;
  FOR v_i IN 0..jsonb_array_length(v_rel_res)-1 LOOP
    v_rel_pair := v_rel_res->v_i;
    v_keep := COALESCE(v_rel_pair->>'keep','');
    v_can_rel_id := COALESCE(v_rel_pair->>'canonical_id', v_rel_pair->>'canonicalId');
    v_dup_rel_id := COALESCE(v_rel_pair->>'duplicate_id', v_rel_pair->>'duplicateId');
    IF v_keep NOT IN ('canonical','duplicate','A','B') THEN RAISE EXCEPTION 'Invalid release keep %', v_keep USING ERRCODE='invalid_parameter_value'; END IF;
    IF v_can_rel_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.release_log WHERE id=v_can_rel_id AND "studentId"=p_canonical_id) THEN RAISE EXCEPTION 'Release % not canonical', v_can_rel_id USING ERRCODE='foreign_key_violation'; END IF;
    IF v_dup_rel_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.release_log WHERE id=v_dup_rel_id AND "studentId"=p_duplicate_id) THEN RAISE EXCEPTION 'Release % not duplicate', v_dup_rel_id USING ERRCODE='foreign_key_violation'; END IF;
    -- Verify exact conflict identity: UTC date of canonical = UTC date of duplicate
    IF v_can_rel_id IS NOT NULL AND v_dup_rel_id IS NOT NULL THEN
      IF NOT EXISTS (SELECT 1 FROM public.release_log c JOIN public.release_log d ON (c."createdAt" AT TIME ZONE 'UTC')::date = (d."createdAt" AT TIME ZONE 'UTC')::date WHERE c.id=v_can_rel_id AND d.id=v_dup_rel_id AND c."studentId"=p_canonical_id AND d."studentId"=p_duplicate_id) THEN
        RAISE EXCEPTION 'Release logs % and % do not share identical UTC date', v_can_rel_id, v_dup_rel_id USING ERRCODE='invalid_parameter_value';
      END IF;
    END IF;
  END LOOP;

  -- Report
  IF jsonb_typeof(v_rep_res) <> 'array' THEN RAISE EXCEPTION 'report_comment_resolution must be array'; END IF;
  IF jsonb_array_length(v_rep_res) <> v_rep_conflicts THEN
    IF v_rep_conflicts>0 AND jsonb_array_length(v_rep_res)=0 THEN RAISE EXCEPTION 'Report comment conflicts require resolution: %', v_rep_conflicts USING ERRCODE='integrity_constraint_violation'; END IF;
    IF v_rep_conflicts <> jsonb_array_length(v_rep_res) THEN RAISE EXCEPTION 'Report resolution incomplete'; END IF;
  END IF;
  FOR v_i IN 0..jsonb_array_length(v_rep_res)-1 LOOP
    v_rep_pair := v_rep_res->v_i;
    v_keep := COALESCE(v_rep_pair->>'keep','');
    v_can_rep_id := COALESCE(v_rep_pair->>'canonical_id', v_rep_pair->>'canonicalId');
    v_dup_rep_id := COALESCE(v_rep_pair->>'duplicate_id', v_rep_pair->>'duplicateId');
    IF v_keep NOT IN ('canonical','duplicate','A','B') THEN RAISE EXCEPTION 'Invalid report keep %', v_keep USING ERRCODE='invalid_parameter_value'; END IF;
    IF v_can_rep_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.report_comments WHERE id=v_can_rep_id AND "studentId"=p_canonical_id) THEN RAISE EXCEPTION 'Report comment % not canonical', v_can_rep_id USING ERRCODE='foreign_key_violation'; END IF;
    IF v_dup_rep_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.report_comments WHERE id=v_dup_rep_id AND "studentId"=p_duplicate_id) THEN RAISE EXCEPTION 'Report comment % not duplicate', v_dup_rep_id USING ERRCODE='foreign_key_violation'; END IF;
    -- Verify exact conflict identity: canonical.termId = duplicate.termId
    IF v_can_rep_id IS NOT NULL AND v_dup_rep_id IS NOT NULL THEN
      IF NOT EXISTS (SELECT 1 FROM public.report_comments c JOIN public.report_comments d ON c."termId"=d."termId" WHERE c.id=v_can_rep_id AND d.id=v_dup_rep_id AND c."studentId"=p_canonical_id AND d."studentId"=p_duplicate_id) THEN
        RAISE EXCEPTION 'Report comments % and % do not share identical termId', v_can_rep_id, v_dup_rep_id USING ERRCODE='invalid_parameter_value';
      END IF;
    END IF;
  END LOOP;

  -- ── Snapshot before ──────────────────────────────────────────────────
  SELECT count(*) INTO v_hist_can FROM public.student_enrollments WHERE "studentId"=p_canonical_id AND "effectiveTo" IS NOT NULL;
  SELECT count(*) INTO v_hist_dup FROM public.student_enrollments WHERE "studentId"=p_duplicate_id AND "effectiveTo" IS NOT NULL;
  v_before_counts := jsonb_build_object(
    'exams', jsonb_build_object('canonical', (SELECT count(*) FROM public.exams WHERE "studentId"=p_canonical_id), 'duplicate', (SELECT count(*) FROM public.exams WHERE "studentId"=p_duplicate_id)),
    'attendance', jsonb_build_object('canonical', (SELECT count(*) FROM public.attendance WHERE "studentId"=p_canonical_id), 'duplicate', (SELECT count(*) FROM public.attendance WHERE "studentId"=p_duplicate_id)),
    'homework', jsonb_build_object('canonical', (SELECT count(*) FROM public.homework WHERE "studentId"=p_canonical_id), 'duplicate', (SELECT count(*) FROM public.homework WHERE "studentId"=p_duplicate_id)),
    'enrollments', jsonb_build_object('canonicalOpen', CASE WHEN v_open_can.id IS NOT NULL THEN jsonb_build_object('className', v_open_can."className", 'academicYearId', v_open_can."academicYearId") ELSE NULL END, 'duplicateOpen', CASE WHEN v_open_dup.id IS NOT NULL THEN jsonb_build_object('className', v_open_dup."className", 'academicYearId', v_open_dup."academicYearId") ELSE NULL END, 'canonicalHistory', v_hist_can, 'duplicateHistory', v_hist_dup)
  );
  v_enroll_action_json := jsonb_build_object(
    'canonicalOpen', CASE WHEN v_open_can.id IS NOT NULL THEN jsonb_build_object('className', v_open_can."className", 'academicYearId', v_open_can."academicYearId") ELSE NULL END,
    'duplicateOpen', CASE WHEN v_open_dup.id IS NOT NULL THEN jsonb_build_object('className', v_open_dup."className", 'academicYearId', v_open_dup."academicYearId") ELSE NULL END,
    'action', v_enroll_action_text,
    'keep', v_enroll_keep,
    'willConsolidate', (v_enroll_action_text = 'consolidate')
  );

  -- ── Apply final profile values to canonical ───────────────────────────
  -- Gov handling with duplicate nulling to avoid unique violation
  IF v_final_gov IS DISTINCT FROM public.gov_id_key(v_can."govId") THEN
    IF v_final_gov IS NULL THEN
      UPDATE public.students SET "govId" = NULL WHERE id = p_canonical_id;
    ELSE
      -- If final gov came from duplicate, clear duplicate first
      IF v_final_gov = public.gov_id_key(v_dup."govId") AND v_dup."govId" IS NOT NULL THEN
        UPDATE public.students SET "govId" = NULL WHERE id = p_duplicate_id;
      END IF;
      UPDATE public.students SET "govId" = v_final_gov WHERE id = p_canonical_id;
    END IF;
  END IF;

  UPDATE public.students SET
    name = v_final_name,
    "className" = v_final_class,
    "parentId" = v_final_parent,
    "parentPhone" = v_final_phone,
    transport = v_final_transport
  WHERE id = p_canonical_id;

  -- If class changed, ensure enrollment ledger reflects it (record_class_assignment will handle open enrollment)
  -- But we will handle enrollment consolidation below; for class change via profile, we need to update open enrollment class if consolidate not used?
  -- We'll handle enrollment after profile.

  -- ── Enrollment consolidation per resolution (SAFE — exactly ONE open) ──
  -- Case A: same class + same year → consolidate (delete duplicate open)
  -- Case B: different class → explicit, exactly ONE open (close non-kept)
  -- Case C: same class + different year → explicit, exactly ONE open + historical preserved
  -- Case D: multiple open already blocked above
  IF v_open_can.id IS NOT NULL AND v_open_dup.id IS NOT NULL THEN
    IF v_open_can."className" = v_open_dup."className" AND v_open_can."academicYearId" IS NOT DISTINCT FROM v_open_dup."academicYearId" THEN
      -- Case A: identical
      IF v_enroll_action_text = 'consolidate' THEN
        DELETE FROM public.student_enrollments WHERE "studentId"=p_duplicate_id AND "effectiveTo" IS NULL;
      ELSIF v_enroll_action_text IN ('transfer','keep_duplicate') AND v_enroll_keep = 'duplicate' THEN
        -- Replace canonical with duplicate's enrollment (explicit)
        UPDATE public.student_enrollments SET "effectiveTo" = CURRENT_DATE WHERE "studentId"=p_canonical_id AND "effectiveTo" IS NULL;
        UPDATE public.student_enrollments SET "studentId"=p_canonical_id WHERE "studentId"=p_duplicate_id AND "effectiveTo" IS NULL;
      ELSIF v_enroll_action_text IN ('transfer','keep_canonical','preserve_history') THEN
        -- Keep canonical, close duplicate as historical (preserve provenance)
        UPDATE public.student_enrollments SET "studentId"=p_canonical_id, "effectiveTo" = CURRENT_DATE WHERE "studentId"=p_duplicate_id AND "effectiveTo" IS NULL;
      ELSE
        RAISE EXCEPTION 'Invalid enrollment action % for identical class/year', v_enroll_action_text USING ERRCODE='invalid_parameter_value';
      END IF;
    ELSE
      -- Case B/C: different class or year → explicit required, exactly ONE open must remain
      IF v_enr_res IS NULL THEN
        RAISE EXCEPTION 'Enrollment histories are contradictory (% vs % / year % vs %). Provide explicit enrollment_resolution.', v_open_can."className", v_open_dup."className", COALESCE(v_open_can."academicYearId",'null'), COALESCE(v_open_dup."academicYearId",'null') USING ERRCODE='integrity_constraint_violation';
      END IF;
      IF v_enroll_action_text = 'consolidate' THEN
        RAISE EXCEPTION 'Cannot consolidate enrollments with different class or academic year. Choose transfer or preserve.' USING ERRCODE='invalid_parameter_value';
      END IF;
      IF v_enroll_keep = 'duplicate' OR v_enroll_action_text = 'keep_duplicate' THEN
        -- Keep duplicate's enrollment, close canonical's open as historical
        UPDATE public.student_enrollments SET "effectiveTo" = CURRENT_DATE WHERE "studentId"=p_canonical_id AND "effectiveTo" IS NULL;
        UPDATE public.student_enrollments SET "studentId"=p_canonical_id WHERE "studentId"=p_duplicate_id AND "effectiveTo" IS NULL;
      ELSE
        -- Keep canonical, close duplicate as historical (preserve)
        UPDATE public.student_enrollments SET "studentId"=p_canonical_id, "effectiveTo" = CURRENT_DATE WHERE "studentId"=p_duplicate_id AND "effectiveTo" IS NULL;
      END IF;
    END IF;
  ELSIF v_open_dup.id IS NOT NULL THEN
    -- Only duplicate has open → transfer to canonical (no conflict)
    UPDATE public.student_enrollments SET "studentId"=p_canonical_id WHERE "studentId"=p_duplicate_id AND "effectiveTo" IS NULL;
  END IF;
  -- Transfer remaining historical enrollments
  UPDATE public.student_enrollments SET "studentId"=p_canonical_id WHERE "studentId"=p_duplicate_id AND "effectiveTo" IS NOT NULL;

  -- If final class differs from canonical's previous class, ensure ledger reflects new class assignment
  -- Already updated students.className; if enrollment open class doesn't match final class, update it
  IF v_open_can.id IS NOT NULL AND v_open_can."className" <> v_final_class THEN
    UPDATE public.student_enrollments SET "className"=v_final_class WHERE "studentId"=p_canonical_id AND "effectiveTo" IS NULL;
  END IF;

  -- ── Resolve conflicting history according to explicit choices ──────────
  -- Exams: for each conflict, delete the losing exam, keep winning
  FOR v_i IN 0..jsonb_array_length(v_exam_res)-1 LOOP
    v_exam_pair := v_exam_res->v_i;
    v_keep := COALESCE(v_exam_pair->>'keep','canonical');
    v_can_exam_id := COALESCE(v_exam_pair->>'canonical_exam_id', v_exam_pair->>'canonicalExamId', v_exam_pair->>'canId', v_exam_pair->>'canonical_id');
    v_dup_exam_id := COALESCE(v_exam_pair->>'duplicate_exam_id', v_exam_pair->>'duplicateExamId', v_exam_pair->>'dupId', v_exam_pair->>'duplicate_id');
    IF v_keep IN ('duplicate','B') THEN
      DELETE FROM public.exams WHERE id = v_can_exam_id;
    ELSE
      DELETE FROM public.exams WHERE id = v_dup_exam_id;
    END IF;
  END LOOP;

  -- Attendance
  FOR v_i IN 0..jsonb_array_length(v_att_res)-1 LOOP
    v_att_pair := v_att_res->v_i;
    v_keep := COALESCE(v_att_pair->>'keep','canonical');
    v_can_att_id := COALESCE(v_att_pair->>'canonical_id', v_att_pair->>'canonicalId', v_att_pair->>'canId');
    v_dup_att_id := COALESCE(v_att_pair->>'duplicate_id', v_att_pair->>'duplicateId', v_att_pair->>'dupId');
    IF v_can_att_id IS NOT NULL AND v_dup_att_id IS NOT NULL THEN
      IF v_keep IN ('duplicate','B') THEN DELETE FROM public.attendance WHERE id=v_can_att_id;
      ELSE DELETE FROM public.attendance WHERE id=v_dup_att_id;
      END IF;
    END IF;
  END LOOP;

  -- Quiz
  FOR v_i IN 0..jsonb_array_length(v_quiz_res)-1 LOOP
    v_quiz_pair := v_quiz_res->v_i;
    v_keep := COALESCE(v_quiz_pair->>'keep','canonical');
    v_can_quiz_id := COALESCE(v_quiz_pair->>'canonical_id', v_quiz_pair->>'canonicalId');
    v_dup_quiz_id := COALESCE(v_quiz_pair->>'duplicate_id', v_quiz_pair->>'duplicateId');
    IF v_can_quiz_id IS NOT NULL AND v_dup_quiz_id IS NOT NULL THEN
      IF v_keep IN ('duplicate','B') THEN DELETE FROM public.quiz_attempts WHERE id=v_can_quiz_id;
      ELSE DELETE FROM public.quiz_attempts WHERE id=v_dup_quiz_id;
      END IF;
    END IF;
  END LOOP;

  -- Release
  FOR v_i IN 0..jsonb_array_length(v_rel_res)-1 LOOP
    v_rel_pair := v_rel_res->v_i;
    v_keep := COALESCE(v_rel_pair->>'keep','canonical');
    v_can_rel_id := COALESCE(v_rel_pair->>'canonical_id', v_rel_pair->>'canonicalId');
    v_dup_rel_id := COALESCE(v_rel_pair->>'duplicate_id', v_rel_pair->>'duplicateId');
    IF v_can_rel_id IS NOT NULL AND v_dup_rel_id IS NOT NULL THEN
      IF v_keep IN ('duplicate','B') THEN DELETE FROM public.release_log WHERE id=v_can_rel_id;
      ELSE DELETE FROM public.release_log WHERE id=v_dup_rel_id;
      END IF;
    END IF;
  END LOOP;

  -- Report
  FOR v_i IN 0..jsonb_array_length(v_rep_res)-1 LOOP
    v_rep_pair := v_rep_res->v_i;
    v_keep := COALESCE(v_rep_pair->>'keep','canonical');
    v_can_rep_id := COALESCE(v_rep_pair->>'canonical_id', v_rep_pair->>'canonicalId');
    v_dup_rep_id := COALESCE(v_rep_pair->>'duplicate_id', v_rep_pair->>'duplicateId');
    IF v_can_rep_id IS NOT NULL AND v_dup_rep_id IS NOT NULL THEN
      IF v_keep IN ('duplicate','B') THEN DELETE FROM public.report_comments WHERE id=v_can_rep_id;
      ELSE DELETE FROM public.report_comments WHERE id=v_dup_rep_id;
      END IF;
    END IF;
  END LOOP;

  -- ── Transfer non-conflicting history (remaining) ─────────────────────
  UPDATE public.exams SET "studentId"=p_canonical_id WHERE "studentId"=p_duplicate_id;
  UPDATE public.attendance SET "studentId"=p_canonical_id WHERE "studentId"=p_duplicate_id;
  UPDATE public.homework SET "studentId"=p_canonical_id WHERE "studentId"=p_duplicate_id;
  UPDATE public.student_promotions SET "studentId"=p_canonical_id WHERE "studentId"=p_duplicate_id;
  UPDATE public.quiz_attempts SET "studentId"=p_canonical_id WHERE "studentId"=p_duplicate_id;
  UPDATE public.report_comments SET "studentId"=p_canonical_id WHERE "studentId"=p_duplicate_id;
  UPDATE public.release_log SET "studentId"=p_canonical_id WHERE "studentId"=p_duplicate_id;

  INSERT INTO public.authorized_pickup_students ("authorizedPickupId", "studentId")
  SELECT "authorizedPickupId", p_canonical_id FROM public.authorized_pickup_students WHERE "studentId"=p_duplicate_id
  ON CONFLICT DO NOTHING;
  DELETE FROM public.authorized_pickup_students WHERE "studentId"=p_duplicate_id;

  -- ── Audit ─────────────────────────────────────────────────────────────
  v_audit_id := 'merge-' || floor(extract(epoch FROM clock_timestamp())*1000)::text || '-' || substr(md5(random()::text || p_canonical_id),1,8);
  v_after := jsonb_build_object(
    'exams', (SELECT count(*) FROM public.exams WHERE "studentId"=p_canonical_id),
    'attendance', (SELECT count(*) FROM public.attendance WHERE "studentId"=p_canonical_id),
    'homework', (SELECT count(*) FROM public.homework WHERE "studentId"=p_canonical_id),
    'quizAttempts', (SELECT count(*) FROM public.quiz_attempts WHERE "studentId"=p_canonical_id),
    'releaseLogs', (SELECT count(*) FROM public.release_log WHERE "studentId"=p_canonical_id),
    'reportComments', (SELECT count(*) FROM public.report_comments WHERE "studentId"=p_canonical_id),
    'enrollments', (SELECT count(*) FROM public.student_enrollments WHERE "studentId"=p_canonical_id)
  );

  INSERT INTO public.student_merge_audits (id, canonical_id, duplicate_id, admin_id, reason, before_counts, after_counts, enrollment_action, exam_conflicts, created_at)
  VALUES (v_audit_id, p_canonical_id, p_duplicate_id, v_actor, p_reason, v_before_counts, v_after, v_enroll_action_json, jsonb_build_object('examConflicts', v_exams_conflicts, 'resolution', p_resolution), NOW());

  INSERT INTO public.audit_logs (action, details, "createdAt")
  VALUES ('students.merge', jsonb_build_object('auditId', v_audit_id, 'canonicalId', p_canonical_id, 'duplicateId', p_duplicate_id, 'actor', v_actor, 'reason', p_reason, 'before', v_before_counts, 'after', v_after, 'enrollmentAction', v_enroll_action_json, 'resolution', p_resolution), NOW());

  -- ── Final open-enrollment assertion (must be exactly ONE open for canonical) ──
  SELECT count(*) INTO v_count FROM public.student_enrollments WHERE "studentId"=p_canonical_id AND "effectiveTo" IS NULL;
  IF v_count <> 1 THEN
    RAISE EXCEPTION 'Post-merge verification failed: canonical must have exactly 1 open enrollment, found %', v_count USING ERRCODE='integrity_constraint_violation';
  END IF;
  SELECT count(*) INTO v_count FROM public.student_enrollments WHERE "studentId"=p_duplicate_id AND "effectiveTo" IS NULL;
  IF v_count <> 0 THEN
    RAISE EXCEPTION 'Post-merge verification failed: duplicate still has % open enrollments', v_count USING ERRCODE='integrity_constraint_violation';
  END IF;
  SELECT count(*) INTO v_count FROM public.student_enrollments WHERE "studentId"=p_duplicate_id;
  IF v_count <> 0 THEN RAISE EXCEPTION 'Post-merge verification failed: duplicate still has % enrollments', v_count USING ERRCODE='integrity_constraint_violation'; END IF;

  -- ── Zero-dependency verification ─────────────────────────────────────
  SELECT count(*) INTO v_count FROM public.exams WHERE "studentId"=p_duplicate_id;
  IF v_count>0 THEN RAISE EXCEPTION 'Post-merge verification failed: duplicate still has % exams', v_count USING ERRCODE='integrity_constraint_violation'; END IF;
  SELECT count(*) INTO v_count FROM public.attendance WHERE "studentId"=p_duplicate_id;
  IF v_count>0 THEN RAISE EXCEPTION 'Post-merge verification failed: duplicate still has % attendance', v_count USING ERRCODE='integrity_constraint_violation'; END IF;
  SELECT count(*) INTO v_count FROM public.homework WHERE "studentId"=p_duplicate_id;
  IF v_count>0 THEN RAISE EXCEPTION 'Post-merge verification failed: % homework', v_count USING ERRCODE='integrity_constraint_violation'; END IF;
  SELECT count(*) INTO v_count FROM public.student_promotions WHERE "studentId"=p_duplicate_id;
  IF v_count>0 THEN RAISE EXCEPTION 'Post-merge verification failed: % promotions', v_count USING ERRCODE='integrity_constraint_violation'; END IF;
  SELECT count(*) INTO v_count FROM public.quiz_attempts WHERE "studentId"=p_duplicate_id;
  IF v_count>0 THEN RAISE EXCEPTION 'Post-merge verification failed: % quiz', v_count USING ERRCODE='integrity_constraint_violation'; END IF;
  SELECT count(*) INTO v_count FROM public.authorized_pickup_students WHERE "studentId"=p_duplicate_id;
  IF v_count>0 THEN RAISE EXCEPTION 'Post-merge verification failed: % pickups', v_count USING ERRCODE='integrity_constraint_violation'; END IF;
  SELECT count(*) INTO v_count FROM public.release_log WHERE "studentId"=p_duplicate_id;
  IF v_count>0 THEN RAISE EXCEPTION 'Post-merge verification failed: % release', v_count USING ERRCODE='integrity_constraint_violation'; END IF;
  SELECT count(*) INTO v_count FROM public.report_comments WHERE "studentId"=p_duplicate_id;
  IF v_count>0 THEN RAISE EXCEPTION 'Post-merge verification failed: % report', v_count USING ERRCODE='integrity_constraint_violation'; END IF;


  DELETE FROM public.students WHERE id=p_duplicate_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Failed to delete duplicate %', p_duplicate_id USING ERRCODE='integrity_constraint_violation'; END IF;

  PERFORM 1 FROM public.students WHERE id=p_canonical_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Canonical % not found after merge', p_canonical_id USING ERRCODE='integrity_constraint_violation'; END IF;
  PERFORM 1 FROM public.students WHERE id=p_duplicate_id;
  IF FOUND THEN RAISE EXCEPTION 'Duplicate % still exists', p_duplicate_id USING ERRCODE='integrity_constraint_violation'; END IF;

  RETURN jsonb_build_object('auditId', v_audit_id, 'canonicalId', p_canonical_id, 'duplicateId', p_duplicate_id, 'before', v_before_counts, 'after', v_after, 'enrollmentAction', v_enroll_action_json, 'createdAt', NOW(), 'resolution', p_resolution);
END;
$$;
$complete_definition$;
 ELSE RAISE EXCEPTION 'Unexpected deployed body for merge_duplicate_students_resolved; no changes committed'; END IF;
 END IF;
END $replace_fn$;
DO $replace_fn$
DECLARE target oid; body_hash text;
BEGIN
 SELECT p.oid,md5(replace(p.prosrc,E'\r\n',E'\n')) INTO target,body_hash
 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
 WHERE n.nspname='public' AND p.proname='get_merge_conflicts';
 IF target IS NOT NULL THEN
 IF body_hash='88f131d826d9c8816e33513a8f9fe667' THEN
 -- Complete replacement from 20260926_fix_get_merge_conflicts_exam_identity.sql; existing ACL/owner retained.
 EXECUTE $complete_definition$
CREATE OR REPLACE FUNCTION public.get_merge_conflicts(
  p_canonical_id TEXT,
  p_duplicate_id TEXT
) RETURNS JSONB
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_role TEXT := public.current_profile_role();
  v_can RECORD; v_dup RECORD;
  v_exams JSONB := '[]'::jsonb;
  v_att JSONB := '[]'::jsonb;
  v_quiz JSONB := '[]'::jsonb;
  v_rel JSONB := '[]'::jsonb;
  v_rep JSONB := '[]'::jsonb;
  v_enr JSONB;
  v_gov_conflict BOOLEAN := false;
  v_parent_conflict BOOLEAN := false;
  v_name_conflict BOOLEAN := false;
  v_class_conflict BOOLEAN := false;
  v_transport_conflict BOOLEAN := false;
  v_phone_conflict BOOLEAN := false;
BEGIN
  IF v_role IS NULL OR v_role <> 'admin' THEN
    RAISE EXCEPTION 'Only administrators may view merge conflicts.'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF p_canonical_id IS NULL OR p_duplicate_id IS NULL OR p_canonical_id = p_duplicate_id THEN
    RAISE EXCEPTION 'Two distinct student IDs required.' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  SELECT * INTO v_can FROM public.students WHERE id = p_canonical_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Canonical % not found', p_canonical_id USING ERRCODE='no_data_found'; END IF;
  SELECT * INTO v_dup FROM public.students WHERE id = p_duplicate_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Duplicate % not found', p_duplicate_id USING ERRCODE='no_data_found'; END IF;

  -- Profile conflicts booleans
  IF public.gov_id_match_key(v_can."govId") IS DISTINCT FROM public.gov_id_match_key(v_dup."govId") THEN
    -- Show conflict when both present and different, or one blank one present (choice still needed)
    -- But treat as conflict if values differ at all (including blank vs value)
    IF v_can."govId" IS DISTINCT FROM v_dup."govId" THEN
      v_gov_conflict := true;
    END IF;
  END IF;
  -- Better: direct compare raw or match key
  IF COALESCE(v_can."govId",'') IS DISTINCT FROM COALESCE(v_dup."govId",'') THEN
    v_gov_conflict := true;
  END IF;
  IF v_can."parentId" IS DISTINCT FROM v_dup."parentId" THEN v_parent_conflict := true; END IF;
  IF v_can.name IS DISTINCT FROM v_dup.name THEN v_name_conflict := true; END IF;
  IF v_can."className" IS DISTINCT FROM v_dup."className" THEN v_class_conflict := true; END IF;
  IF COALESCE(v_can.transport,'') IS DISTINCT FROM COALESCE(v_dup.transport,'') THEN v_transport_conflict := true; END IF;
  IF COALESCE(v_can."parentPhone",'') IS DISTINCT FROM COALESCE(v_dup."parentPhone",'') THEN v_phone_conflict := true; END IF;

  -- Exams: identity = subjectId, examType, assessmentLabel, termId
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'identity', jsonb_build_object('subjectId', c."subjectId", 'examType', c."examType", 'month', c.month, 'assessmentLabel', c."assessmentLabel", 'termId', c."termId", 'subject', c.subject),
    'canonical', jsonb_build_object('id', c.id, 'score', c.score, 'total', c.total, 'status', c.status, 'createdAt', c."createdAt", 'date', c.date, 'subjectId', c."subjectId", 'examType', c."examType", 'month', c.month, 'assessmentLabel', c."assessmentLabel", 'termId', c."termId"),
    'duplicate', jsonb_build_object('id', d.id, 'score', d.score, 'total', d.total, 'status', d.status, 'createdAt', d."createdAt", 'date', d.date, 'subjectId', d."subjectId", 'examType', d."examType", 'month', d.month, 'assessmentLabel', d."assessmentLabel", 'termId', d."termId"),
    'identical', (c.score IS NOT DISTINCT FROM d.score AND c.total IS NOT DISTINCT FROM d.total AND c."subjectId" IS NOT DISTINCT FROM d."subjectId")
  )), '[]'::jsonb) INTO v_exams
  FROM public.exams c
  JOIN public.exams d ON d."studentId" = p_duplicate_id
    AND c."studentId" = p_canonical_id
    AND c."subjectId" IS NOT DISTINCT FROM d."subjectId"
    AND c."examType" = d."examType"
    AND c."assessmentLabel" IS NOT DISTINCT FROM d."assessmentLabel" AND (CASE WHEN c."examType" IN ('Midterm','Final') THEN NULL ELSE c.month END) IS NOT DISTINCT FROM (CASE WHEN d."examType" IN ('Midterm','Final') THEN NULL ELSE d.month END)
    AND c."termId" IS NOT DISTINCT FROM d."termId";

  -- Attendance same date
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'identity', jsonb_build_object('date', c.date),
    'canonical', jsonb_build_object('id', c.id, 'status', c.status, 'date', c.date, 'className', c."className", 'createdAt', c."createdAt"),
    'duplicate', jsonb_build_object('id', d.id, 'status', d.status, 'date', d.date, 'className', d."className", 'createdAt', d."createdAt")
  )), '[]'::jsonb) INTO v_att
  FROM public.attendance c
  JOIN public.attendance d ON d."studentId" = p_duplicate_id
    AND c."studentId" = p_canonical_id
    AND c.date = d.date;

  -- Quiz same quizId
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'identity', jsonb_build_object('quizId', c."quizId"),
    'canonical', jsonb_build_object('id', c.id, 'quizId', c."quizId", 'totalEarned', c."totalEarned", 'status', c.status, 'submittedAt', c."submittedAt"),
    'duplicate', jsonb_build_object('id', d.id, 'quizId', d."quizId", 'totalEarned', d."totalEarned", 'status', d.status, 'submittedAt', d."submittedAt")
  )), '[]'::jsonb) INTO v_quiz
  FROM public.quiz_attempts c
  JOIN public.quiz_attempts d ON d."studentId" = p_duplicate_id
    AND c."studentId" = p_canonical_id
    AND c."quizId" = d."quizId";

  -- Release same UTC day
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'identity', jsonb_build_object('day', (c."createdAt" AT TIME ZONE 'UTC')::date),
    'canonical', jsonb_build_object('id', c.id, 'createdAt', c."createdAt", 'studentId', c."studentId"),
    'duplicate', jsonb_build_object('id', d.id, 'createdAt', d."createdAt", 'studentId', d."studentId")
  )), '[]'::jsonb) INTO v_rel
  FROM public.release_log c
  JOIN public.release_log d ON d."studentId" = p_duplicate_id
    AND c."studentId" = p_canonical_id
    AND (c."createdAt" AT TIME ZONE 'UTC')::date = (d."createdAt" AT TIME ZONE 'UTC')::date;

  -- Report comments same termId
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'identity', jsonb_build_object('termId', c."termId"),
    'canonical', jsonb_build_object('id', c.id, 'termId', c."termId", 'teacherComment', c."teacherComment", 'principalComment', c."principalComment"),
    'duplicate', jsonb_build_object('id', d.id, 'termId', d."termId", 'teacherComment', d."teacherComment", 'principalComment', d."principalComment")
  )), '[]'::jsonb) INTO v_rep
  FROM public.report_comments c
  JOIN public.report_comments d ON d."studentId" = p_duplicate_id
    AND c."studentId" = p_canonical_id
    AND c."termId" = d."termId";

  -- Enrollments open
  SELECT jsonb_build_object(
    'canonicalOpen', CASE WHEN ce.id IS NOT NULL THEN jsonb_build_object('id', ce.id, 'className', ce."className", 'academicYearId', ce."academicYearId", 'effectiveFrom', ce."effectiveFrom") ELSE NULL END,
    'duplicateOpen', CASE WHEN de.id IS NOT NULL THEN jsonb_build_object('id', de.id, 'className', de."className", 'academicYearId', de."academicYearId", 'effectiveFrom', de."effectiveFrom") ELSE NULL END,
    'canonicalHistory', (SELECT count(*) FROM public.student_enrollments WHERE "studentId"=p_canonical_id AND "effectiveTo" IS NOT NULL),
    'duplicateHistory', (SELECT count(*) FROM public.student_enrollments WHERE "studentId"=p_duplicate_id AND "effectiveTo" IS NOT NULL)
  ) INTO v_enr
  FROM (SELECT * FROM public.student_enrollments WHERE "studentId"=p_canonical_id AND "effectiveTo" IS NULL LIMIT 1) ce
  FULL JOIN (SELECT * FROM public.student_enrollments WHERE "studentId"=p_duplicate_id AND "effectiveTo" IS NULL LIMIT 1) de ON true;

  RETURN jsonb_build_object(
    'profile', jsonb_build_object(
      'govIdConflict', v_gov_conflict,
      'parentConflict', v_parent_conflict,
      'nameConflict', v_name_conflict,
      'classConflict', v_class_conflict,
      'transportConflict', v_transport_conflict,
      'phoneConflict', v_phone_conflict,
      'canonical', jsonb_build_object('id', v_can.id, 'name', v_can.name, 'className', v_can."className", 'govId', v_can."govId", 'parentId', v_can."parentId", 'parentPhone', v_can."parentPhone", 'transport', v_can.transport, 'familyId', v_can."familyId"),
      'duplicate', jsonb_build_object('id', v_dup.id, 'name', v_dup.name, 'className', v_dup."className", 'govId', v_dup."govId", 'parentId', v_dup."parentId", 'parentPhone', v_dup."parentPhone", 'transport', v_dup.transport, 'familyId', v_dup."familyId")
    ),
    'exams', v_exams,
    'attendance', v_att,
    'quizAttempts', v_quiz,
    'releaseLogs', v_rel,
    'reportComments', v_rep,
    'enrollments', v_enr,
    'counts', jsonb_build_object(
      'exams', jsonb_array_length(v_exams),
      'attendance', jsonb_array_length(v_att),
      'quizAttempts', jsonb_array_length(v_quiz),
      'releaseLogs', jsonb_array_length(v_rel),
      'reportComments', jsonb_array_length(v_rep)
    )
  );
END;
$$;
$complete_definition$;
 ELSE RAISE EXCEPTION 'Unexpected deployed body for get_merge_conflicts; no changes committed'; END IF;
 END IF;
END $replace_fn$;
DO $replace_fn$
DECLARE target oid; body_hash text;
BEGIN
 SELECT p.oid,md5(replace(p.prosrc,E'\r\n',E'\n')) INTO target,body_hash
 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
 WHERE n.nspname='public' AND p.proname='_safe_batch_evaluate_pair';
 IF target IS NOT NULL THEN
 IF body_hash='53a1876b492dbb1c7d0c020062ed8591' THEN
 -- Complete replacement from 20261008_safe_batch_field_consolidation.sql; existing ACL/owner retained.
 EXECUTE $complete_definition$
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
  -- The RAW stored values, kept separately because normalize_family_id() can
  -- erase them: a raw id with no digit at all normalizes to ''. Comparing only
  -- the normalized values would make a populated field look blank.
  v_fam_raw_k TEXT; v_fam_raw_r TEXT;
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
  v_fam_raw_k := btrim(COALESCE(v_keeper."familyId", ''));
  v_fam_raw_r := btrim(COALESCE(v_removed."familyId", ''));

  -- ── GUARD: normalization must never silently erase a family ID ───────────
  -- normalize_family_id() is regexp_replace(raw, '\D', '', 'g') (20260802:55),
  -- so a raw family id containing no digit — 'HOUSE-RED', 'FAM-ABC' — normalizes
  -- to ''. Without this guard the chain below sees '' on that side, classifies
  -- the pair "both_blank", marks it SAFE, transfers nothing, and then the merge
  -- DELETES the duplicate: the value is destroyed and never appears in
  -- transferred_fields, so the usual "nothing was lost" check passes vacuously.
  --
  -- The policy cannot reason about a family relationship it cannot read, so the
  -- pair goes to INDIVIDUAL REVIEW. Not SAFE. Not blocked either — this is not a
  -- proven family conflict, the information is simply unreadable. Every existing
  -- family rule below (same → keep, proven → transfer, conflicting → blocked,
  -- unprovable → review) is unchanged and still runs for readable values.
  IF (v_fam_raw_k <> '' AND v_fam_k = '') OR (v_fam_raw_r <> '' AND v_fam_r = '') THEN
    IF v_fam_raw_k <> '' AND v_fam_raw_k = v_fam_raw_r THEN
      -- Both sides hold byte-identical raw values. The keeper survives holding
      -- them, so nothing can be lost and there is nothing to compare: this is
      -- the same-family case, reached by raw comparison instead of normalized.
      -- Without this, the individual-review workflow could never merge a pair it
      -- had just corrected by copying the value across.
      v_ok := array_append(v_ok, 'same_family_id');
      v_field_states := v_field_states || jsonb_build_object(
        'familyId', jsonb_build_object('state','identical','action','keep',
          'raw', v_fam_raw_k, 'comparedBy','raw'));
    ELSE
      v_codes := array_append(v_codes, 'family_id_invalid_normalization'); v_review := true;
      v_field_states := v_field_states || jsonb_build_object(
        'familyId', jsonb_build_object(
          'state','invalid_normalization','action','review',
          'reason','family_id_invalid_normalization',
          'keeperRaw', NULLIF(v_fam_raw_k, ''), 'removedRaw', NULLIF(v_fam_raw_r, ''),
          'keeperNormalized', NULLIF(v_fam_k, ''), 'removedNormalized', NULLIF(v_fam_r, '')));
    END IF;
  ELSIF v_fam_k <> '' AND v_fam_r <> '' AND v_fam_k = v_fam_r THEN
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
      AND c."assessmentLabel" IS NOT DISTINCT FROM d."assessmentLabel" AND (CASE WHEN c."examType" IN ('Midterm','Final') THEN NULL ELSE c.month END) IS NOT DISTINCT FROM (CASE WHEN d."examType" IN ('Midterm','Final') THEN NULL ELSE d.month END)
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
$complete_definition$;
 ELSIF body_hash='14355a6545a69ebee70721e0a8738c35' THEN
 -- Complete replacement from 20261009_authoritative_parent_phone_registry.sql; existing ACL/owner retained.
 EXECUTE $complete_definition$
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
  -- Registry endorsement flags for the true-conflict case (20261009).
  v_auth_k BOOLEAN := false; v_auth_r BOOLEAN := false;
  v_tr_k TEXT; v_tr_r TEXT;
  v_fam_k TEXT; v_fam_r TEXT;
  -- The RAW stored values, kept separately because normalize_family_id() can
  -- erase them: a raw id with no digit at all normalizes to ''. Comparing only
  -- the normalized values would make a populated field look blank.
  v_fam_raw_k TEXT; v_fam_raw_r TEXT;
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
    -- A TRUE conflict: two different non-empty numbers. The batch cannot choose
    -- between them on its own — but the school may already have settled which
    -- number is correct. public.authoritative_parent_phones is that answer.
    -- It is deliberately narrow: it only RESOLVES a conflict that already
    -- exists, it never makes a pair a duplicate candidate, and it never speaks
    -- for any other field.
    --   exactly one side endorsed -> that number wins, recorded in the audit
    --   both sides endorsed       -> registry is ambiguous, BLOCKED
    --   neither side endorsed     -> unchanged, BLOCKED for a human
    SELECT EXISTS (SELECT 1 FROM public.authoritative_parent_phones a WHERE a.phone = v_ph_k),
           EXISTS (SELECT 1 FROM public.authoritative_parent_phones a WHERE a.phone = v_ph_r)
      INTO v_auth_k, v_auth_r;

    IF v_auth_k AND NOT v_auth_r THEN
      -- The endorsed number is already the keeper's, so nothing moves.
      v_ok := array_append(v_ok, 'parent_phone_conflict_resolved_by_registry_keeper');
      v_phone_choice := 'canonical';
      v_field_states := v_field_states || jsonb_build_object(
        'parentPhone', jsonb_build_object('state','conflict_resolved','action','keep',
                                          'authority','registry_keeper',
                                          'keeper', v_keeper."parentPhone",
                                          'removed', v_removed."parentPhone",
                                          'value', v_keeper."parentPhone",
                                          'normalized', v_ph_k));
    ELSIF v_auth_r AND NOT v_auth_k THEN
      -- The endorsed number is on the duplicate, so it must MOVE onto the
      -- keeper. The third-party family check still applies: an authoritative
      -- number that already belongs to a DIFFERENT parent's family would still
      -- fuse two families, and the registry does not license that.
      SELECT count(*) INTO v_phone_third
      FROM public.students s
      WHERE s.id <> v_keeper_id AND s.id <> v_removed_id
        AND public.normalize_phone(s."parentPhone") = v_ph_r
        AND s."parentId" IS NOT NULL
        AND s."parentId" IS DISTINCT FROM v_keeper."parentId";
      IF COALESCE(v_phone_third, 0) > 0 THEN
        v_codes := array_append(v_codes, 'parent_phone_belongs_to_other_family'); v_blocked := true;
        v_field_states := v_field_states || jsonb_build_object(
          'parentPhone', jsonb_build_object('state','conflict_resolved','action','block',
                                            'reason','parent_phone_belongs_to_other_family',
                                            'authority','registry_duplicate',
                                            'otherFamilyStudents', v_phone_third,
                                            'keeper', v_keeper."parentPhone",
                                            'removed', v_removed."parentPhone"));
      ELSE
        v_ok := array_append(v_ok, 'parent_phone_conflict_resolved_by_registry_duplicate');
        v_phone_choice := 'duplicate';
        v_transfer := v_transfer || jsonb_build_object('parentPhone', v_removed."parentPhone");
        v_field_states := v_field_states || jsonb_build_object(
          'parentPhone', jsonb_build_object('state','conflict_resolved','action','transfer',
                                            'authority','registry_duplicate',
                                            'keeper', v_keeper."parentPhone",
                                            'removed', v_removed."parentPhone",
                                            'value', v_removed."parentPhone",
                                            'normalized', v_ph_r));
      END IF;
    ELSIF v_auth_k AND v_auth_r THEN
      v_codes := array_append(v_codes, 'parent_phone_registry_ambiguous'); v_blocked := true;
      v_field_states := v_field_states || jsonb_build_object(
        'parentPhone', jsonb_build_object('state','conflict','action','block',
                                          'reason','parent_phone_registry_ambiguous',
                                          'keeper', v_keeper."parentPhone",
                                          'removed', v_removed."parentPhone"));
    ELSE
      v_codes := array_append(v_codes, 'parent_phone_conflict'); v_blocked := true;
      v_field_states := v_field_states || jsonb_build_object(
        'parentPhone', jsonb_build_object('state','conflict','action','block',
                                          'keeper', v_keeper."parentPhone",
                                          'removed', v_removed."parentPhone"));
    END IF;
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
  v_fam_raw_k := btrim(COALESCE(v_keeper."familyId", ''));
  v_fam_raw_r := btrim(COALESCE(v_removed."familyId", ''));

  -- ── GUARD: normalization must never silently erase a family ID ───────────
  -- normalize_family_id() is regexp_replace(raw, '\D', '', 'g') (20260802:55),
  -- so a raw family id containing no digit — 'HOUSE-RED', 'FAM-ABC' — normalizes
  -- to ''. Without this guard the chain below sees '' on that side, classifies
  -- the pair "both_blank", marks it SAFE, transfers nothing, and then the merge
  -- DELETES the duplicate: the value is destroyed and never appears in
  -- transferred_fields, so the usual "nothing was lost" check passes vacuously.
  --
  -- The policy cannot reason about a family relationship it cannot read, so the
  -- pair goes to INDIVIDUAL REVIEW. Not SAFE. Not blocked either — this is not a
  -- proven family conflict, the information is simply unreadable. Every existing
  -- family rule below (same → keep, proven → transfer, conflicting → blocked,
  -- unprovable → review) is unchanged and still runs for readable values.
  IF (v_fam_raw_k <> '' AND v_fam_k = '') OR (v_fam_raw_r <> '' AND v_fam_r = '') THEN
    IF v_fam_raw_k <> '' AND v_fam_raw_k = v_fam_raw_r THEN
      -- Both sides hold byte-identical raw values. The keeper survives holding
      -- them, so nothing can be lost and there is nothing to compare: this is
      -- the same-family case, reached by raw comparison instead of normalized.
      -- Without this, the individual-review workflow could never merge a pair it
      -- had just corrected by copying the value across.
      v_ok := array_append(v_ok, 'same_family_id');
      v_field_states := v_field_states || jsonb_build_object(
        'familyId', jsonb_build_object('state','identical','action','keep',
          'raw', v_fam_raw_k, 'comparedBy','raw'));
    ELSE
      v_codes := array_append(v_codes, 'family_id_invalid_normalization'); v_review := true;
      v_field_states := v_field_states || jsonb_build_object(
        'familyId', jsonb_build_object(
          'state','invalid_normalization','action','review',
          'reason','family_id_invalid_normalization',
          'keeperRaw', NULLIF(v_fam_raw_k, ''), 'removedRaw', NULLIF(v_fam_raw_r, ''),
          'keeperNormalized', NULLIF(v_fam_k, ''), 'removedNormalized', NULLIF(v_fam_r, '')));
    END IF;
  ELSIF v_fam_k <> '' AND v_fam_r <> '' AND v_fam_k = v_fam_r THEN
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
      AND c."assessmentLabel" IS NOT DISTINCT FROM d."assessmentLabel" AND (CASE WHEN c."examType" IN ('Midterm','Final') THEN NULL ELSE c.month END) IS NOT DISTINCT FROM (CASE WHEN d."examType" IN ('Midterm','Final') THEN NULL ELSE d.month END)
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
$complete_definition$;
 ELSE RAISE EXCEPTION 'Unexpected deployed body for _safe_batch_evaluate_pair; no changes committed'; END IF;
 END IF;
END $replace_fn$;

-- LIVE-ONLY OVERLOADS: complete source is fetched from PostgreSQL's catalog
-- within THIS transaction; it is not reconstructed from an older repository body.
-- Strict inspected-body hashes prevent replacing an unreviewed function version.
-- CREATE OR REPLACE retains return type, security configuration, owner and ACL.
DO $legacy_merge$
DECLARE f record; definition text;
 predicate text := 'c."assessmentLabel" IS NOT DISTINCT FROM d."assessmentLabel"';
BEGIN
 FOR f IN SELECT p.oid,md5(p.prosrc) body_hash FROM pg_proc p
 JOIN pg_namespace n ON n.oid=p.pronamespace
 WHERE n.nspname='public' AND p.proname='merge_duplicate_student' AND p.prokind='f'
 LOOP
  IF f.body_hash NOT IN ('d8fcaf4b25df8118395e7e3ee4bdb54f','8d0f6efb0388327e81436b646e50a785') THEN
   RAISE EXCEPTION 'Live-only merge overload changed; obtain complete reviewed source before applying';
  END IF;
  definition := pg_get_functiondef(f.oid);
  IF position(predicate IN definition)=0 THEN RAISE EXCEPTION 'Unexpected legacy merge predicate'; END IF;
  definition := replace(definition,predicate,predicate ||
   ' AND (CASE WHEN c."examType" IN (''Midterm'',''Final'') THEN NULL ELSE c.month END) IS NOT DISTINCT FROM (CASE WHEN d."examType" IN (''Midterm'',''Final'') THEN NULL ELSE d.month END)');
  definition := replace(definition,'''assessmentLabel'', c."assessmentLabel"','''month'', c.month, ''assessmentLabel'', c."assessmentLabel"');
  definition := replace(definition,'''assessmentLabel'', d."assessmentLabel"','''month'', d.month, ''assessmentLabel'', d."assessmentLabel"');
  EXECUTE definition;
 END LOOP;
END $legacy_merge$;

-- The older supervisor widgets have no term selector: scope them to the single
-- current term rather than combining e.g. October from multiple academic years.
DO $reads$
DECLARE definition text; target regprocedure;
BEGIN
 target := to_regprocedure('public.get_class_student_subject_progress(text,text)');
 IF target IS NOT NULL THEN
   definition := pg_get_functiondef(target);
   IF position('e.month = p_month' IN definition) = 0 THEN RAISE EXCEPTION 'Unexpected class-progress definition'; END IF;
   EXECUTE replace(definition, 'e.month = p_month', 'e.month = p_month AND e."termId" = (SELECT t.id FROM public.terms t WHERE t."isCurrent")');
 END IF;
 IF to_regclass('public.teacher_exam_progress') IS NOT NULL THEN
   definition := pg_get_viewdef('public.teacher_exam_progress'::regclass, true);
   IF position('e.month IS NOT NULL' IN definition) = 0 THEN RAISE EXCEPTION 'Unexpected teacher-progress definition'; END IF;
   EXECUTE 'CREATE OR REPLACE VIEW public.teacher_exam_progress AS ' ||
     replace(definition, 'e.month IS NOT NULL', 'e.month IS NOT NULL AND e."termId" = (SELECT t.id FROM public.terms t WHERE t."isCurrent")');
 END IF;
END $reads$;

-- Keep an established term's academic year identity immutable. No existing row
-- is changed; operators must not reassign a referenced term to a different year.
CREATE OR REPLACE FUNCTION public.guard_assessed_term_year() RETURNS trigger
LANGUAGE plpgsql SET search_path = public AS $$
BEGIN
 IF NEW."academicYearId" IS DISTINCT FROM OLD."academicYearId" AND EXISTS (SELECT 1 FROM public.exams WHERE "termId"=OLD.id) THEN
   RAISE EXCEPTION 'An assessed term cannot be reassigned to another academic year.';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER guard_assessed_term_year_trg BEFORE UPDATE ON public.terms
FOR EACH ROW EXECUTE FUNCTION public.guard_assessed_term_year();
-- Abort the entire migration if ANY existing exam field changed, any existing
-- function ACL/owner/security/return type changed, or status protections drifted.
DO $verify$
BEGIN
 IF EXISTS((SELECT id,row_image FROM monthly_fix_before_exams EXCEPT SELECT id,to_jsonb(e) FROM public.exams e)
 UNION ALL (SELECT id,to_jsonb(e) FROM public.exams e EXCEPT SELECT id,row_image FROM monthly_fix_before_exams)) THEN
  RAISE EXCEPTION 'Existing exam rows changed; rolling back entire repair';
 END IF;
 IF EXISTS(SELECT 1 FROM monthly_fix_before_security b JOIN pg_class c USING(oid)
 WHERE (b.relacl,b.relrowsecurity,b.relforcerowsecurity) IS DISTINCT FROM (c.relacl,c.relrowsecurity,c.relforcerowsecurity)) THEN
  RAISE EXCEPTION 'Existing table permissions/RLS changed';
 END IF;
 IF EXISTS(SELECT 1 FROM monthly_fix_before_functions b LEFT JOIN pg_proc p USING(oid)
 WHERE p.oid IS NULL OR (b.proacl,b.proowner,b.prosecdef,b.proconfig,b.result_type)
 IS DISTINCT FROM (p.proacl,p.proowner,p.prosecdef,p.proconfig,pg_get_function_result(p.oid))) THEN
  RAISE EXCEPTION 'Existing function permissions/security/signature changed';
 END IF;
 IF EXISTS(SELECT 1 FROM monthly_fix_status_guard b WHERE
 b.definition IS DISTINCT FROM pg_get_functiondef('public.enforce_exam_status_guard()'::regprocedure)
 OR b.trigger_definition IS DISTINCT FROM (SELECT pg_get_triggerdef(oid) FROM pg_trigger WHERE
 tgrelid='public.exams'::regclass AND tgname='enforce_exam_status_guard_trg')) THEN
  RAISE EXCEPTION 'Original exam status guard changed';
 END IF;
END $verify$;
-- Refresh RPC metadata only upon successful COMMIT. Does not call any webhook.
NOTIFY pgrst, 'reload schema';
COMMIT;
-- SUCCESS means transaction committed, every original exam row unchanged.
-- Run the separate verification file BEFORE reopening writes or testing uploads.
