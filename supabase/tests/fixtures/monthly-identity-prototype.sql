-- Monthly assessment identity repair. No marks are backfilled, deleted or relabelled.
-- Apply only with explicit production authorisation, after backup and staging tests.
BEGIN;
SET LOCAL lock_timeout = '10s';
LOCK TABLE public.exams IN SHARE ROW EXCLUSIVE MODE;

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

REVOKE ALL ON FUNCTION public.submit_bulk_grades(JSONB, TEXT, BOOLEAN) FROM PUBLIC;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    EXECUTE 'GRANT EXECUTE ON FUNCTION public.submit_bulk_grades(JSONB, TEXT, BOOLEAN) TO authenticated';
  END IF;
END $$;


-- Preserve deployed merge bodies, security, grants and unrelated resolutions.
-- Patch ONLY the exam identity predicate; fail on unexpected drift. This covers
-- both overloads of merge_duplicate_student, legacy entrypoints, resolved merges,
-- previews and batch eligibility without changing report-comment term matching.
DO $patch$
DECLARE f record; definition text; predicate text := 'c."assessmentLabel" IS NOT DISTINCT FROM d."assessmentLabel"';
BEGIN
 FOR f IN SELECT p.oid, p.proname FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
   WHERE n.nspname='public' AND p.prokind='f' AND p.proname IN
    ('merge_duplicate_student','merge_duplicate_students','merge_duplicate_students_resolved',
     'preview_student_merge','get_merge_conflicts','_safe_batch_evaluate_pair')
 LOOP
   definition := pg_get_functiondef(f.oid);
   IF position(predicate IN definition) = 0 THEN
     RAISE EXCEPTION 'Unexpected exam identity definition in %; review schema drift before applying.', f.proname;
   END IF;
   definition := replace(definition, predicate, predicate ||
     ' AND (CASE WHEN c."examType" IN (''Midterm'',''Final'') THEN NULL ELSE c.month END) IS NOT DISTINCT FROM (CASE WHEN d."examType" IN (''Midterm'',''Final'') THEN NULL ELSE d.month END)');
   definition := replace(definition, '''assessmentLabel'', c."assessmentLabel"', '''month'', c.month, ''assessmentLabel'', c."assessmentLabel"');
   definition := replace(definition, '''assessmentLabel'', d."assessmentLabel"', '''month'', d.month, ''assessmentLabel'', d."assessmentLabel"');
   EXECUTE definition;
 END LOOP;
END $patch$;

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
COMMIT;
