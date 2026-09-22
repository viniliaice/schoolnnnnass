-- ────────────────────────────────────────────────────────────────────────────
-- 20260926 — FIX: get_merge_conflicts() crashed on the exam "identical" flag
--
-- Migration 20260924 introduced the guided (resolution-aware) duplicate merge
-- and its conflict reader. Inside the exam conflict query the identity
-- comparison referenced `c.subjectId` WITHOUT quotes, so PostgreSQL folded it
-- to `c.subjectid`, a column that does not exist:
--
--   ERROR: column c.subjectid does not exist
--
-- Every call to get_merge_conflicts() therefore failed — which in turn made
-- merge_duplicate_students_resolved() (and merge_with_resolution) unusable for
-- administrators reviewing a duplicate pair. The safe batch merge introduced in
-- 20260925 delegates to that same RPC, so this fix is a prerequisite for the
-- batch feature: the individual review workflow and the batch share one code
-- path and one set of rules.
--
-- The fix is surgical: the function body below is byte-identical to the one
-- created in 20260924 except for the single quoted identifier. No rule, no
-- conflict identity, no permission and no return shape changes.
-- ────────────────────────────────────────────────────────────────────────────

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
    'identity', jsonb_build_object('subjectId', c."subjectId", 'examType', c."examType", 'assessmentLabel', c."assessmentLabel", 'termId', c."termId", 'subject', c.subject),
    'canonical', jsonb_build_object('id', c.id, 'score', c.score, 'total', c.total, 'status', c.status, 'createdAt', c."createdAt", 'date', c.date, 'subjectId', c."subjectId", 'examType', c."examType", 'assessmentLabel', c."assessmentLabel", 'termId', c."termId"),
    'duplicate', jsonb_build_object('id', d.id, 'score', d.score, 'total', d.total, 'status', d.status, 'createdAt', d."createdAt", 'date', d.date, 'subjectId', d."subjectId", 'examType', d."examType", 'assessmentLabel', d."assessmentLabel", 'termId', d."termId"),
    'identical', (c.score IS NOT DISTINCT FROM d.score AND c.total IS NOT DISTINCT FROM d.total AND c."subjectId" IS NOT DISTINCT FROM d."subjectId")
  )), '[]'::jsonb) INTO v_exams
  FROM public.exams c
  JOIN public.exams d ON d."studentId" = p_duplicate_id
    AND c."studentId" = p_canonical_id
    AND c."subjectId" IS NOT DISTINCT FROM d."subjectId"
    AND c."examType" = d."examType"
    AND c."assessmentLabel" IS NOT DISTINCT FROM d."assessmentLabel"
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
REVOKE ALL ON FUNCTION public.get_merge_conflicts(TEXT,TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_merge_conflicts(TEXT,TEXT) TO authenticated;


-- Same permissions as the original definition: administrators only, enforced
-- inside the function body (role check) and by RLS on the underlying tables.
COMMENT ON FUNCTION public.get_merge_conflicts(TEXT, TEXT) IS
  'Conflict reader for the guided duplicate merge. 20260926 restores the quoted "subjectId" identifier so the exam identity comparison resolves.';
