-- Bulk grade upload integrity and authorization.
--
-- New bulk records are identified by student + subject + exam type + assessment
-- label + term. Historical records keep nullable assessmentLabel so they can be
-- reviewed and classified before any destructive backfill is attempted.

-- Keep the application schema aligned with the columns already used by the
-- exam UI. They remain nullable for historical compatibility; the secure bulk
-- RPC below requires all three fields for every new bulk record.
ALTER TABLE public.exams ADD COLUMN IF NOT EXISTS "subjectId" TEXT REFERENCES public.subjects(id) ON DELETE RESTRICT;
ALTER TABLE public.exams ADD COLUMN IF NOT EXISTS "termId" TEXT REFERENCES public.terms(id) ON DELETE RESTRICT;
ALTER TABLE public.exams ADD COLUMN IF NOT EXISTS "assessmentLabel" TEXT;
ALTER TABLE public.exams ADD COLUMN IF NOT EXISTS "entryState" TEXT NOT NULL DEFAULT 'scored';
ALTER TABLE public.exams ADD COLUMN IF NOT EXISTS "uploadedBy" TEXT REFERENCES public.profiles(id) ON DELETE SET NULL;

-- Explicit absence/N/A records intentionally have no score. Existing score
-- rows are treated as scored; constraints are NOT VALID so historical dirty
-- rows remain reviewable while every future write is checked.
ALTER TABLE public.exams ALTER COLUMN score DROP NOT NULL;
ALTER TABLE public.exams DROP CONSTRAINT IF EXISTS exams_entry_state_check;
ALTER TABLE public.exams ADD CONSTRAINT exams_entry_state_check
  CHECK ("entryState" IN ('scored', 'absent', 'not_applicable')) NOT VALID;
ALTER TABLE public.exams DROP CONSTRAINT IF EXISTS exams_score_entry_state_check;
ALTER TABLE public.exams ADD CONSTRAINT exams_score_entry_state_check
  CHECK (
    ("entryState" = 'scored' AND score IS NOT NULL AND score >= 0 AND score <= total AND total > 0)
    OR ("entryState" IN ('absent', 'not_applicable') AND score IS NULL AND total > 0)
  ) NOT VALID;
ALTER TABLE public.exams DROP CONSTRAINT IF EXISTS exams_assessment_label_check;
ALTER TABLE public.exams ADD CONSTRAINT exams_assessment_label_check
  CHECK ("assessmentLabel" IS NULL OR "assessmentLabel" IN (
    'HW1', 'HW2', 'HW3', 'HW4',
    'CPW1', 'CPW2', 'CPW3', 'CPW4',
    'ATTENDANCE', 'MT', 'AKHLAAQ'
  )) NOT VALID;
ALTER TABLE public.exams DROP CONSTRAINT IF EXISTS exams_assessment_definition_check;
ALTER TABLE public.exams ADD CONSTRAINT exams_assessment_definition_check
  CHECK (
    "assessmentLabel" IS NULL
    OR ("assessmentLabel" IN ('HW1', 'HW2', 'HW3', 'HW4') AND "examType" = 'Homework' AND total = 5)
    OR ("assessmentLabel" IN ('CPW1', 'CPW2', 'CPW3', 'CPW4') AND "examType" = 'Classwork' AND total = 15)
    OR ("assessmentLabel" = 'ATTENDANCE' AND "examType" = 'Attendance' AND total = 20)
    OR ("assessmentLabel" = 'MT' AND "examType" = 'Quiz' AND total = 20)
    OR ("assessmentLabel" = 'AKHLAAQ' AND "examType" = 'Discipline' AND total = 10)
  ) NOT VALID;

-- The original full-schema file used a CHECK with a generated/unknown name.
-- Remove only CHECK constraints that actually constrain examType, then install
-- the named, versioned rule used by this migration.
DO $$
DECLARE
  constraint_name TEXT;
BEGIN
  FOR constraint_name IN
    SELECT c.conname
    FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public'
      AND t.relname = 'exams'
      AND c.contype = 'c'
      AND pg_get_constraintdef(c.oid) ILIKE '%examType%'
  LOOP
    EXECUTE format('ALTER TABLE public.exams DROP CONSTRAINT %I', constraint_name);
  END LOOP;
END $$;
ALTER TABLE public.exams ADD CONSTRAINT exams_exam_type_check
  CHECK ("examType" IN ('CA', 'Homework', 'Classwork', 'Quiz', 'Midterm', 'Final', 'Attendance', 'Discipline')) NOT VALID;

-- This index deliberately applies only to classified records. It protects all
-- new bulk uploads without pretending that ambiguous historical HW/CPW rows
-- can safely be auto-labelled during migration.
CREATE UNIQUE INDEX IF NOT EXISTS exams_bulk_assessment_identity_unique
  ON public.exams ("studentId", "subjectId", "examType", "assessmentLabel", "termId")
  WHERE "subjectId" IS NOT NULL
    AND "termId" IS NOT NULL
    AND "assessmentLabel" IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_exams_bulk_identity_lookup
  ON public.exams ("studentId", "subjectId", "termId", "assessmentLabel");
CREATE INDEX IF NOT EXISTS idx_exams_uploaded_by ON public.exams ("uploadedBy");

-- A non-destructive review aid for the approved one-time historical dedup
-- pass. It intentionally does not delete or relabel any record.
CREATE OR REPLACE VIEW public.exam_historical_duplicate_candidates AS
SELECT
  "studentId",
  COALESCE("subjectId", subject) AS subject_key,
  "examType",
  "termId",
  COUNT(*) AS record_count,
  ARRAY_AGG(id ORDER BY "createdAt" DESC) AS exam_ids
FROM public.exams
WHERE "assessmentLabel" IS NULL
  AND "examType" IN ('Homework', 'Classwork')
GROUP BY "studentId", COALESCE("subjectId", subject), "examType", "termId"
HAVING COUNT(*) > 1;

CREATE TABLE IF NOT EXISTS public.grade_uploads (
  id TEXT PRIMARY KEY,
  "uploadedBy" TEXT NOT NULL REFERENCES public.profiles(id) ON DELETE RESTRICT,
  payload_hash TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('completed')),
  result JSONB NOT NULL,
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_grade_uploads_uploaded_by ON public.grade_uploads ("uploadedBy", "createdAt" DESC);
ALTER TABLE public.grade_uploads ENABLE ROW LEVEL SECURITY;

-- Correctly scope direct legacy/single-result writes while the application
-- transitions to submit_bulk_grades. The RPC below is the only bulk path.
CREATE OR REPLACE FUNCTION public.can_submit_exam_target(
  p_student_id TEXT,
  p_subject_id TEXT,
  p_teacher_id TEXT
) RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.students s
    JOIN public.class_subjects cs
      ON cs."className" = s."className"
     AND cs."subjectId" = p_subject_id
     AND cs."teacherId" = p_teacher_id
    WHERE s.id = p_student_id
  );
$$;

ALTER TABLE public.exams ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Allow select on exams for all" ON public.exams;
DROP POLICY IF EXISTS "Teachers can only insert exams for their assigned subjects" ON public.exams;
DROP POLICY IF EXISTS "Teachers can only update exams for their assigned subjects" ON public.exams;
DROP POLICY IF EXISTS "exam_select_authorized" ON public.exams;
DROP POLICY IF EXISTS "exam_insert_authorized" ON public.exams;
DROP POLICY IF EXISTS "exam_update_authorized" ON public.exams;
DROP POLICY IF EXISTS "exam_delete_authorized" ON public.exams;

CREATE POLICY "exam_select_authorized" ON public.exams
  FOR SELECT TO authenticated
  USING (
    public.current_profile_role() IN ('admin', 'supervisor')
    OR "teacherId" = public.current_profile_id()
    OR "parentId" = public.current_profile_id()
  );

CREATE POLICY "exam_insert_authorized" ON public.exams
  FOR INSERT TO authenticated
  WITH CHECK (
    (
      public.current_profile_role() = 'teacher'
      AND "teacherId" = public.current_profile_id()
      AND public.can_submit_exam_target("studentId", "subjectId", "teacherId")
    )
    OR (
      public.current_profile_role() = 'admin'
      AND public.can_submit_exam_target("studentId", "subjectId", "teacherId")
    )
  );

CREATE POLICY "exam_update_authorized" ON public.exams
  FOR UPDATE TO authenticated
  USING (
    public.current_profile_role() IN ('admin', 'supervisor')
    OR ("teacherId" = public.current_profile_id() AND public.current_profile_role() = 'teacher')
  )
  WITH CHECK (
    public.current_profile_role() IN ('admin', 'supervisor')
    OR (
      public.current_profile_role() = 'teacher'
      AND "teacherId" = public.current_profile_id()
      AND public.can_submit_exam_target("studentId", "subjectId", "teacherId")
    )
  );

CREATE POLICY "exam_delete_authorized" ON public.exams
  FOR DELETE TO authenticated
  USING (
    public.current_profile_role() = 'admin'
    OR ("teacherId" = public.current_profile_id() AND public.current_profile_role() = 'teacher')
  );

-- Preview and atomic upsert endpoint. It takes only normalized grade data;
-- teacher ownership, parent, subject display name, and approval status are
-- derived on the server. p_confirm_updates=false performs no writes.
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
  v_score INTEGER;
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

    -- Do not rely on integer casts to decide numeric semantics: callers can
    -- invoke an RPC directly, so decimal and partial strings must be rejected
    -- just as strictly as they are in the browser parser.
    IF COALESCE(NULLIF(v_record->>'total', ''), '') !~ '^(0|[1-9][0-9]*)$'
       OR (v_record->>'score' IS NOT NULL AND (v_record->>'score') !~ '^(0|[1-9][0-9]*)$') THEN
      RAISE EXCEPTION 'Bulk upload contains a non-integer score or total.' USING ERRCODE = 'invalid_parameter_value';
    END IF;
    BEGIN
      v_date := NULLIF(v_record->>'date', '')::DATE;
      v_total := NULLIF(v_record->>'total', '')::INTEGER;
      v_score := CASE WHEN v_record->>'score' IS NULL THEN NULL ELSE (v_record->>'score')::INTEGER END;
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
    IF (v_entry_state = 'scored' AND (v_score IS NULL OR v_score < 0 OR v_score > v_total))
       OR (v_entry_state <> 'scored' AND v_score IS NOT NULL) THEN
      RAISE EXCEPTION 'Score/state combination is invalid for assessment %.', v_assessment_label USING ERRCODE = 'check_violation';
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

    SELECT "teacherId" INTO v_teacher_id
    FROM public.class_subjects
    WHERE "className" = v_student_class
      AND "subjectId" = v_subject_id
      AND "teacherId" IS NOT NULL
    LIMIT 1;
    IF v_teacher_id IS NULL THEN
      RAISE EXCEPTION 'No assigned teacher exists for this student class and subject.' USING ERRCODE = 'check_violation';
    END IF;
    IF v_role = 'teacher' AND v_teacher_id <> v_actor_id THEN
      RAISE EXCEPTION 'Teachers may upload only their assigned class subjects.' USING ERRCODE = 'insufficient_privilege';
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
    RETURN jsonb_build_object(
      'requiresConfirmation', v_update_count > 0,
      'insertCount', v_insert_count,
      'updateCount', v_update_count,
      'skippedCount', 0,
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
      CASE WHEN v_record->>'score' IS NULL THEN NULL ELSE (v_record->>'score')::INTEGER END,
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
GRANT EXECUTE ON FUNCTION public.submit_bulk_grades(JSONB, TEXT, BOOLEAN) TO authenticated;

-- Absence/N/A entries are recorded for auditability but must never enter
-- academic calculations. Replace the existing midterm and system-stat RPCs
-- after entryState exists.
CREATE OR REPLACE FUNCTION public.get_midterm_report(
  p_student_id TEXT,
  p_term_id TEXT
) RETURNS JSONB
LANGUAGE sql
STABLE
AS $$
  WITH target_student AS (
    SELECT id, "className" FROM public.students WHERE id = p_student_id
  ), class_students AS (
    SELECT s.id FROM public.students s JOIN target_student ts ON ts."className" = s."className"
  ), class_midterms AS (
    SELECT e.id, e."studentId" AS student_id, e.subject, e.score, e.total,
      CASE WHEN e.total > 0 THEN round((e.score::numeric / e.total::numeric) * 100)::INT ELSE 0 END AS percentage
    FROM public.exams e JOIN class_students cs ON cs.id = e."studentId"
    WHERE e."termId" = p_term_id AND e."examType" = 'Midterm'
      AND e.status = 'approved' AND e."entryState" = 'scored'
  ), student_midterms AS (
    SELECT * FROM class_midterms WHERE student_id = p_student_id
  ), subject_scores AS (
    SELECT sm.id AS exam_id, sm.subject, sm.score, sm.total, sm.percentage,
      CASE WHEN sm.percentage >= 90 THEN 'A' WHEN sm.percentage >= 80 THEN 'B' WHEN sm.percentage >= 70 THEN 'C' WHEN sm.percentage >= 60 THEN 'D' ELSE 'F' END AS grade,
      CASE WHEN sm.percentage >= 90 THEN 'Excellent' WHEN sm.percentage >= 80 THEN 'Very Good' WHEN sm.percentage >= 70 THEN 'Good' WHEN sm.percentage >= 60 THEN 'Satisfactory' ELSE 'Needs Improvement' END AS remark,
      (SELECT count(*) + 1 FROM class_midterms cm WHERE cm.subject = sm.subject AND cm.percentage > sm.percentage) AS subject_rank,
      (SELECT coalesce(round(avg(cm.percentage))::INT, 0) FROM class_midterms cm WHERE cm.subject = sm.subject) AS class_average,
      (SELECT coalesce(max(cm.percentage), 0) FROM class_midterms cm WHERE cm.subject = sm.subject) AS highest_in_class
    FROM student_midterms sm
  ), student_averages AS (
    SELECT cm.student_id, round(avg(cm.percentage))::INT AS average_percentage FROM class_midterms cm GROUP BY cm.student_id
  ), target_average AS (
    SELECT coalesce((SELECT average_percentage FROM student_averages WHERE student_id = p_student_id), 0) AS average_percentage
  )
  SELECT jsonb_build_object(
    'scores', coalesce((SELECT jsonb_agg(jsonb_build_object(
      'subject', ss.subject, 'score', ss.score, 'total', ss.total, 'percentage', ss.percentage,
      'grade', ss.grade, 'remark', ss.remark, 'subject_rank', ss.subject_rank,
      'class_average', ss.class_average, 'highest_in_class', ss.highest_in_class, 'examId', ss.exam_id
    ) ORDER BY ss.subject) FROM subject_scores ss), '[]'::jsonb),
    'overall_rank', coalesce((SELECT count(*) + 1 FROM student_averages sa, target_average ta WHERE sa.average_percentage > ta.average_percentage), 0),
    'total_students', (SELECT count(*) FROM student_averages)
  );
$$;

CREATE OR REPLACE FUNCTION public.get_system_stats()
RETURNS JSONB
LANGUAGE sql
STABLE
AS $$
  SELECT jsonb_build_object(
    'totalTeachers', (SELECT count(*) FROM public.profiles WHERE lower(trim(role::text)) = 'teacher'),
    'totalParents', (SELECT count(*) FROM public.profiles WHERE lower(trim(role::text)) = 'parent'),
    'totalStudents', (SELECT count(*) FROM public.students),
    'totalExams', (SELECT count(*) FROM public.exams),
    'pendingExams', (SELECT count(*) FROM public.exams WHERE status = 'pending'),
    'approvedExams', (SELECT count(*) FROM public.exams WHERE status = 'approved'),
    'rejectedExams', (SELECT count(*) FROM public.exams WHERE status = 'rejected'),
    'averageScore', (
      SELECT coalesce(round(avg((score::numeric / NULLIF(total, 0)::numeric) * 100), 2), 0)
      FROM public.exams WHERE "entryState" = 'scored'
    )
  );
$$;
