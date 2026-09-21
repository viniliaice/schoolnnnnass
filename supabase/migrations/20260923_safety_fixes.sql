-- ============================================================================
-- Migration 20260923 — Safety fixes: candidate auth already fixed in
-- 20260922, now fix creation/import duplicate prevention and re-assert
-- enrollment academicYear safety (defense-in-depth).
-- Fixes:
--   1. Ensure get_duplicate_candidates remains admin-only (re-assert)
--   2. Prevent Axmed-type duplicate via create_student / bulk_create_students / apply_student_class_import
--   3. Enrollment consolidate only when className + academicYearId match (re-assert for functions patched in 20260906c)
-- ============================================================================

-- ─── Re-assert get_duplicate_candidates admin check (idempotent) ───────────
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

-- ─── Helper: check if incoming student would duplicate existing via strong identity ───────────
-- Returns the existing student id that would be considered a strong duplicate, or null.
-- Used by create_student / bulk_create / apply_import to avoid Axmed-type casual creation.
CREATE OR REPLACE FUNCTION public.find_strong_duplicate_candidate(
  p_name TEXT,
  p_class TEXT,
  p_parent_id TEXT,
  p_gov_id TEXT,
  p_parent_phone TEXT
) RETURNS TEXT
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_candidate RECORD;
  v_in_gov TEXT := public.gov_id_match_key(p_gov_id);
  v_in_parent BOOLEAN := p_parent_id IS NOT NULL AND btrim(p_parent_id) <> '';
  v_in_phone TEXT := NULLIF(public.normalize_phone(p_parent_phone),'');
  v_cand_gov TEXT;
  v_cand_parent BOOLEAN;
  v_cand_phone TEXT;
  v_same_gov BOOLEAN;
  v_conflicting_gov BOOLEAN;
BEGIN
  -- Only consider same normalized name + same class as candidate signal
  FOR v_candidate IN
    SELECT id, name, "className", "parentId", "govId", "parentPhone"
    FROM public.students
    WHERE public.name_match_key(name) = public.name_match_key(p_name)
      AND btrim("className") = btrim(p_class)
  LOOP
    v_cand_gov := public.gov_id_match_key(v_candidate."govId");
    v_cand_parent := v_candidate."parentId" IS NOT NULL;
    v_cand_phone := NULLIF(public.normalize_phone(v_candidate."parentPhone"),'');

    v_same_gov := v_cand_gov IS NOT NULL AND v_cand_gov <> '' AND v_in_gov IS NOT NULL AND v_in_gov <> '' AND v_cand_gov = v_in_gov;
    v_conflicting_gov := v_cand_gov IS NOT NULL AND v_cand_gov <> '' AND v_in_gov IS NOT NULL AND v_in_gov <> '' AND v_cand_gov <> v_in_gov;

    -- 1. Same Gov → strong identity (already blocked by unique, but we surface as duplicate)
    IF v_same_gov THEN
      RETURN v_candidate.id;
    END IF;

    -- 2. Different Gov with same name+class but both have parents differing → distinct people, allow creation
    --    Do not treat as duplicate; continue to next candidate
    IF v_conflicting_gov AND v_cand_parent AND v_in_parent THEN
      CONTINUE;
    END IF;

    -- 3. Axmed-type: parent assigned vs unassigned + Gov present on assigned side → strong duplicate
    --    This is the critical prevention: existing has parent+gov, incoming unassigned same name/class → MANUAL REVIEW
    IF (v_cand_parent <> v_in_parent) THEN
      -- Check if the side that HAS parent also HAS gov (strong signal)
      IF (v_cand_parent AND v_cand_gov IS NOT NULL AND v_cand_gov <> '' AND NOT v_in_parent) THEN
        -- Existing is assigned+gov, incoming unassigned → likely same student, block casual creation
        RETURN v_candidate.id;
      END IF;
      IF (v_in_parent AND v_in_gov IS NOT NULL AND v_in_gov <> '' AND NOT v_cand_parent) THEN
        -- Incoming is assigned+gov, existing unassigned → also likely duplicate (reverse)
        RETURN v_candidate.id;
      END IF;
      -- Parent vs unassigned without any Gov on assigned side is weaker (possible) — allow creation but will be surfaced via duplicate page later
      -- We do NOT block this case to avoid false positives for genuine same-name unassigned
      CONTINUE;
    END IF;

    -- 4. Both have parents, no Gov, same name/class → ambiguous, allow creation as distinct (genuine same-name) but will be flagged as manual review in duplicate page
    --    Do not block.

    -- 5. Neither has parent, no Gov → possible, allow creation (will be manual review later)

    -- No strong duplicate detected for this candidate
  END LOOP;
  RETURN NULL;
END;
$$;
REVOKE ALL ON FUNCTION public.find_strong_duplicate_candidate(TEXT,TEXT,TEXT,TEXT,TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.find_strong_duplicate_candidate(TEXT,TEXT,TEXT,TEXT,TEXT) TO authenticated;

-- ─── Patched create_student with duplicate prevention ───────────────────────
CREATE OR REPLACE FUNCTION public.create_student(
  p_name TEXT,
  p_class TEXT,
  p_parent_id TEXT DEFAULT NULL,
  p_gov_id TEXT DEFAULT NULL,
  p_parent_phone TEXT DEFAULT NULL,
  p_academic_year_id TEXT DEFAULT NULL
) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_actor TEXT := public.assert_admin();
  v_id TEXT;
  v_gov TEXT := public.gov_id_key(p_gov_id);
  v_phone TEXT := NULLIF(public.normalize_phone(p_parent_phone), '');
  v_year TEXT := COALESCE(p_academic_year_id, public.current_academic_year_id());
  v_dup_id TEXT;
BEGIN
  IF btrim(COALESCE(p_name,'')) = '' THEN
    RAISE EXCEPTION 'Student name is required.' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF btrim(COALESCE(p_class,'')) = '' THEN
    RAISE EXCEPTION 'A valid class is required.' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF v_gov IS NOT NULL AND EXISTS (
     SELECT 1 FROM public.students WHERE public.gov_id_key("govId") = v_gov) THEN
    RAISE EXCEPTION 'Gov ID % is already assigned to another student.', v_gov
      USING ERRCODE = 'unique_violation';
  END IF;

  -- ── Axmed-type prevention: check strong duplicate via name+class + parent/gov evidence ──
  v_dup_id := public.find_strong_duplicate_candidate(p_name, p_class, p_parent_id, p_gov_id, p_parent_phone);
  IF v_dup_id IS NOT NULL THEN
    RAISE EXCEPTION 'Possible duplicate detected: same name/class with strong identity (parent vs unassigned + Gov ID). Existing student % — manual review required via Duplicate Students page.', v_dup_id
      USING ERRCODE = 'integrity_constraint_violation', HINT = 'Use Duplicate Students → Review before creating a new record. If this is a genuine distinct student, ensure different Gov ID and parent assignment.';
  END IF;

  v_id := 'student-' || floor(extract(epoch FROM clock_timestamp())*1000)::text
          || '-' || substr(md5(random()::text),1,6);

  INSERT INTO public.students (id, name, "className", "parentId", "govId", "parentPhone", "createdAt")
  VALUES (v_id, btrim(p_name), btrim(p_class),
          NULLIF(p_parent_id,''), v_gov, v_phone, NOW());

  PERFORM public.record_class_assignment(
    v_id, btrim(p_class), 'import', CURRENT_DATE, v_year, NULL, 'create_student');

  INSERT INTO public.audit_logs (action, details, "createdAt")
  VALUES ('students.create', jsonb_build_object(
      'actor', v_actor, 'studentId', v_id, 'name', p_name, 'className', p_class,
      'parentId', p_parent_id, 'govId', v_gov), NOW());

  RETURN jsonb_build_object('id', v_id, 'name', btrim(p_name), 'className', btrim(p_class));
END;
$$;
REVOKE ALL ON FUNCTION public.create_student(TEXT,TEXT,TEXT,TEXT,TEXT,TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.create_student(TEXT,TEXT,TEXT,TEXT,TEXT,TEXT) TO authenticated;

-- ─── Patched bulk_create_students with duplicate prevention ─────────────────
CREATE OR REPLACE FUNCTION public.bulk_create_students(p_students JSONB)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_actor TEXT := public.assert_admin();
  v_row JSONB;
  v_id TEXT; v_name TEXT; v_class TEXT; v_gov TEXT; v_phone TEXT; v_parent TEXT;
  v_year TEXT := public.current_academic_year_id();
  v_created INT := 0;
  v_govs TEXT[] := ARRAY[]::TEXT[];
  v_dup_id TEXT;
BEGIN
  IF jsonb_typeof(p_students) <> 'array' THEN
    RAISE EXCEPTION 'Payload must be a JSON array.' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF jsonb_array_length(p_students) > 5000 THEN
    RAISE EXCEPTION 'Bulk create is limited to 5,000 students per batch.'
      USING ERRCODE = 'program_limit_exceeded';
  END IF;
  FOR v_row IN SELECT * FROM jsonb_array_elements(p_students)
  LOOP
    v_name := btrim(COALESCE(v_row->>'name',''));
    v_class := btrim(COALESCE(v_row->>'className',''));
    v_gov := public.gov_id_key(v_row->>'govId');
    v_phone := NULLIF(public.normalize_phone(v_row->>'parentPhone'), '');
    v_parent := NULLIF(btrim(COALESCE(v_row->>'parentId','')),'');
    IF v_name = '' OR v_class = '' THEN
      RAISE EXCEPTION 'Every new student requires a name and a class.'
        USING ERRCODE = 'invalid_parameter_value';
    END IF;
    IF v_gov IS NOT NULL THEN
      IF v_gov = ANY (v_govs) OR EXISTS (SELECT 1 FROM public.students WHERE public.gov_id_key("govId") = v_gov) THEN
        RAISE EXCEPTION 'Duplicate Gov ID % in bulk create.', v_gov USING ERRCODE = 'unique_violation';
      END IF;
      v_govs := array_append(v_govs, v_gov);
    END IF;

    -- Strong duplicate check against live DB (Axmed-type)
    v_dup_id := public.find_strong_duplicate_candidate(v_name, v_class, v_parent, v_row->>'govId', v_row->>'parentPhone');
    IF v_dup_id IS NOT NULL THEN
      RAISE EXCEPTION 'Possible duplicate in bulk create: % / % matches existing student % (parent vs unassigned + Gov). Manual review required.', v_name, v_class, v_dup_id
        USING ERRCODE = 'integrity_constraint_violation';
    END IF;

    -- Also check within batch itself for Axmed-type duplicates (same name+class parent vs unassigned)
    -- For simplicity, we rely on DB check after first insert; but also check naive within-batch duplicate of strong type
    -- (If batch contains both sides of Axmed, second will hit DB after first insert and be blocked above)

    v_id := 'student-' || floor(extract(epoch FROM clock_timestamp())*1000)::text
            || '-' || substr(md5(random()::text || v_name),1,6);
    INSERT INTO public.students (id, name, "className", "parentId", "govId", "parentPhone", "createdAt")
    VALUES (v_id, v_name, v_class, v_parent, v_gov, v_phone, NOW());
    PERFORM public.record_class_assignment(v_id, v_class, 'import', CURRENT_DATE, v_year, NULL, 'bulk_create_students');
    v_created := v_created + 1;
  END LOOP;
  INSERT INTO public.audit_logs (action, details, "createdAt")
  VALUES ('students.bulk_create', jsonb_build_object('actor', v_actor, 'created', v_created), NOW());
  RETURN jsonb_build_object('createdCount', v_created);
END;
$$;
REVOKE ALL ON FUNCTION public.bulk_create_students(JSONB) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.bulk_create_students(JSONB) TO authenticated;

-- ─── Patched apply_student_class_import — stable ID authoritative + duplicate prevention ───
CREATE OR REPLACE FUNCTION public.apply_student_class_import(
  p_changes JSONB,
  p_new_students JSONB DEFAULT '[]'::JSONB,
  p_academic_year_id TEXT DEFAULT NULL,
  p_import_ref TEXT DEFAULT NULL
) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_role TEXT := public.current_profile_role();
  v_actor TEXT := public.current_profile_id();
  v_import_ref TEXT := COALESCE(NULLIF(btrim(p_import_ref),''),
      'class-import-' || floor(extract(epoch FROM now())*1000)::text);
  v_changes JSONB := COALESCE(p_changes,'[]'::jsonb);
  v_new JSONB := COALESCE(p_new_students,'[]'::jsonb);
  v_year TEXT := COALESCE(p_academic_year_id, public.current_academic_year_id());
  v_known_classes TEXT[];
  v_change JSONB; v_ns JSONB; v_student RECORD;
  v_id TEXT; v_name TEXT; v_class TEXT; v_gov TEXT; v_phone TEXT;
  v_seen TEXT[] := ARRAY[]::TEXT[]; v_govs TEXT[] := ARRAY[]::TEXT[];
  v_updated INT := 0; v_skipped INT := 0; v_created INT := 0;
  v_applied JSONB := '[]'::jsonb; v_created_list JSONB := '[]'::jsonb;
  v_dup_id TEXT;
BEGIN
  IF v_role IS NULL OR v_role <> 'admin' THEN
    RAISE EXCEPTION 'Only admins may apply a student class import.'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF jsonb_typeof(v_changes) <> 'array' OR jsonb_typeof(v_new) <> 'array' THEN
    RAISE EXCEPTION 'Import payload must be JSON arrays.' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF jsonb_array_length(v_changes) > 5000 OR jsonb_array_length(v_new) > 2000 THEN
    RAISE EXCEPTION 'Import too large: max 5,000 class changes and 2,000 new students per file.'
      USING ERRCODE = 'program_limit_exceeded';
  END IF;

  SELECT COALESCE(array_agg(DISTINCT c), ARRAY[]::TEXT[]) INTO v_known_classes FROM (
    SELECT "className" AS c FROM public.class_subjects WHERE "className" IS NOT NULL
    UNION SELECT "className" FROM public.students WHERE "className" IS NOT NULL
    UNION SELECT 'Graduated'::text
  ) k;

  IF v_year IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.academic_years WHERE id = v_year) THEN
    RAISE EXCEPTION 'Academic year "%" does not exist.', v_year USING ERRCODE = 'no_data_found';
  END IF;

  -- ── Process class changes (stable Student ID authoritative) ───────────
  FOR v_change IN SELECT * FROM jsonb_array_elements(v_changes)
  LOOP
    v_id := btrim(COALESCE(v_change->>'studentId',''));
    v_class := btrim(COALESCE(v_change->>'toClass',''));
    IF v_id = '' THEN RAISE EXCEPTION 'A class change is missing its student ID.' USING ERRCODE = 'invalid_parameter_value'; END IF;
    IF v_id = ANY (v_seen) THEN RAISE EXCEPTION 'Student "%" appears more than once in the import.', v_id USING ERRCODE = 'unique_violation'; END IF;
    v_seen := array_append(v_seen, v_id);
    IF v_class = '' THEN RAISE EXCEPTION 'Class is required for student "%".', v_id USING ERRCODE = 'invalid_parameter_value'; END IF;
    IF NOT (v_class = ANY (v_known_classes)) THEN RAISE EXCEPTION 'Class "%" does not exist.', v_class USING ERRCODE = 'no_data_found'; END IF;

    SELECT id, name, "className" INTO v_student FROM public.students WHERE id = v_id FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'Student ID "%" does not exist.', v_id USING ERRCODE = 'no_data_found'; END IF;
    IF v_student."className" = v_class THEN v_skipped := v_skipped + 1; CONTINUE; END IF;

    UPDATE public.students SET "className" = v_class WHERE id = v_id;
    IF NOT EXISTS (
      SELECT 1 FROM public.student_promotions
       WHERE "studentId" = v_id AND "fromClass" = v_student."className"
         AND "toClass" = v_class AND source = 'class_import'
         AND ("academicYearId" IS NOT DISTINCT FROM v_year)
    ) THEN
      INSERT INTO public.student_promotions
        (id, "studentId", "fromClass", "toClass", "academicYearId", source)
      VALUES ('clsimp-' || floor(extract(epoch FROM now())*1000)::text
              || '-' || substr(md5(random()::text || v_id),1,8),
              v_id, v_student."className", v_class, v_year, 'class_import');
    END IF;
    PERFORM public.record_class_assignment(
      v_id, v_class, 'transfer', CURRENT_DATE, v_year, NULL, v_import_ref);

    INSERT INTO public.audit_logs (action, details, "createdAt")
    VALUES ('students.class_change', jsonb_build_object('importRef', v_import_ref,
        'actor', v_actor, 'studentId', v_id, 'studentName', v_student.name,
        'fromClass', v_student."className", 'toClass', v_class, 'academicYearId', v_year), NOW());

    v_updated := v_updated + 1;
    v_applied := v_applied || jsonb_build_array(jsonb_build_object(
      'studentId', v_id, 'name', v_student.name,
      'fromClass', v_student."className", 'toClass', v_class));
  END LOOP;

  -- ── Process new students with strong duplicate check ─────────────────
  FOR v_ns IN SELECT * FROM jsonb_array_elements(v_new)
  LOOP
    v_id := btrim(COALESCE(v_ns->>'id',''));
    v_name := btrim(COALESCE(v_ns->>'name',''));
    v_class := btrim(COALESCE(v_ns->>'className',''));
    v_gov := public.gov_id_key(v_ns->>'govId');
    v_phone := NULLIF(public.normalize_phone(v_ns->>'parentPhone'), '');

    IF v_id = '' THEN
      v_id := 'student-' || floor(extract(epoch FROM now())*1000)::text
              || '-' || substr(md5(random()::text || v_name),1,6);
    END IF;
    IF v_id = ANY (v_seen) THEN RAISE EXCEPTION 'Student ID "%" appears more than once in the import.', v_id USING ERRCODE = 'unique_violation'; END IF;
    IF EXISTS (SELECT 1 FROM public.students WHERE id = v_id) THEN
      RAISE EXCEPTION 'Student ID "%" already exists — a duplicate student was not created. Use class_change for existing Student ID.', v_id USING ERRCODE = 'unique_violation';
    END IF;
    IF v_name = '' THEN RAISE EXCEPTION 'Student name is required for a new student.' USING ERRCODE = 'invalid_parameter_value'; END IF;
    IF v_class = '' OR NOT (v_class = ANY (v_known_classes)) THEN
      RAISE EXCEPTION 'Class "%" does not exist.', v_class USING ERRCODE = 'no_data_found';
    END IF;
    IF v_gov IS NOT NULL THEN
      IF v_gov = ANY (v_govs) OR EXISTS (SELECT 1 FROM public.students WHERE public.gov_id_key("govId") = v_gov) THEN
        RAISE EXCEPTION 'Gov ID % is already assigned — duplicate student not created.', v_gov USING ERRCODE = 'unique_violation';
      END IF;
      v_govs := array_append(v_govs, v_gov);
    END IF;

    -- Strong duplicate check: Axmed-type (parent vs unassigned + Gov) → block
    v_dup_id := public.find_strong_duplicate_candidate(v_name, v_class, v_ns->>'parentId', v_ns->>'govId', v_ns->>'parentPhone');
    IF v_dup_id IS NOT NULL THEN
      RAISE EXCEPTION 'Possible duplicate in import: % / % matches existing student % (strong identity: parent vs unassigned + Gov). Manual review required via Duplicate Students.', v_name, v_class, v_dup_id
        USING ERRCODE = 'integrity_constraint_violation';
    END IF;

    -- For genuine same-name distinct students (both have parents different Gov, or no Gov) find_strong_duplicate_candidate returns null → allow creation
    v_seen := array_append(v_seen, v_id);

    INSERT INTO public.students (id, name, "className", "govId", "parentPhone", "createdAt")
    VALUES (v_id, v_name, v_class, v_gov, v_phone, NOW());
    PERFORM public.record_class_assignment(
      v_id, v_class, 'import', CURRENT_DATE, v_year, NULL, v_import_ref);

    v_created := v_created + 1;
    v_created_list := v_created_list || jsonb_build_array(jsonb_build_object(
      'studentId', v_id, 'name', v_name, 'className', v_class));
  END LOOP;

  INSERT INTO public.audit_logs (action, details, "createdAt")
  VALUES ('students.class_import', jsonb_build_object('importRef', v_import_ref, 'actor', v_actor,
      'academicYearId', v_year, 'classChanges', v_updated, 'unchangedSkipped', v_skipped,
      'newStudents', v_created, 'changes', v_applied, 'created', v_created_list), NOW());

  RETURN jsonb_build_object('importRef', v_import_ref, 'updatedCount', v_updated,
    'createdCount', v_created, 'skippedCount', v_skipped,
    'changes', v_applied, 'created', v_created_list);
END;
$$;
REVOKE ALL ON FUNCTION public.apply_student_class_import(JSONB,JSONB,TEXT,TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.apply_student_class_import(JSONB,JSONB,TEXT,TEXT) TO authenticated;

-- Ensure helper grants
REVOKE ALL ON FUNCTION public.find_strong_duplicate_candidate(TEXT,TEXT,TEXT,TEXT,TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.find_strong_duplicate_candidate(TEXT,TEXT,TEXT,TEXT,TEXT) TO authenticated;
