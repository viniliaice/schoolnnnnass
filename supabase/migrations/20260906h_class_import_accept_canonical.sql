-- ============================================================================
-- Migration 20260906h — class import accepts the full canonical class catalogue.
-- ============================================================================
-- The known-class list for validation was derived only from classes that
-- currently have students or subject assignments. A real catalogue class with
-- no loaded student (e.g. KG-A in a sheet that imports into it) was rejected as
-- "class does not exist". This adds a canonical-name helper (matching the app's
-- CLASSES catalogue: Foundation X, KG-X, Grade N-X, Year N-X) and treats such a
-- canonical, sectioned class name as valid even if it has no students yet.
-- Bare grades without a section ("Grade 3", "KG") are still rejected.
-- Idempotent.

CREATE OR REPLACE FUNCTION public.is_canonical_class(p_class TEXT)
RETURNS BOOLEAN LANGUAGE sql IMMUTABLE SET search_path = public AS $$
  SELECT btrim(COALESCE(p_class,'')) ~
    '^(Foundation [A-Z]|KG-[A-Z]|Grade [0-9]{1,2}-[A-Z]|Year [0-9]{1,2}-[A-Z]|Graduated)$';
$$;

DO $$
BEGIN
  EXECUTE 'REVOKE ALL ON FUNCTION public.is_canonical_class(TEXT) FROM PUBLIC';
END $$;

-- ── Recreate the preflight validator ───────────────────────────────────────
CREATE OR REPLACE FUNCTION public.check_class_import_payload(
  p_changes JSONB,
  p_new_students JSONB DEFAULT '[]'::JSONB
) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_role TEXT := public.current_profile_role();
  v_changes JSONB := COALESCE(p_changes,'[]'::jsonb);
  v_new JSONB := COALESCE(p_new_students,'[]'::jsonb);
  v_known_classes TEXT[];
  v_problems JSONB := '[]'::jsonb;
  v_row JSONB;
  v_id TEXT; v_class TEXT; v_gov TEXT; v_name TEXT; v_transport TEXT;
  v_existing RECORD;
  v_seen_id TEXT[] := ARRAY[]::TEXT[];
  v_seen_gov TEXT[] := ARRAY[]::TEXT[];
BEGIN
  IF v_role IS NULL OR v_role <> 'admin' THEN
    RAISE EXCEPTION 'Only admins may validate a student class import.'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF jsonb_typeof(v_changes) <> 'array' OR jsonb_typeof(v_new) <> 'array' THEN
    RAISE EXCEPTION 'Import payload must be JSON arrays.' USING ERRCODE = 'invalid_parameter_value';
  END IF;

  SELECT COALESCE(array_agg(DISTINCT c), ARRAY[]::TEXT[]) INTO v_known_classes FROM (
    SELECT "className" AS c FROM public.class_subjects WHERE "className" IS NOT NULL
    UNION SELECT "className" FROM public.students WHERE "className" IS NOT NULL
    UNION SELECT 'Graduated'::text
  ) k;

  FOR v_row IN SELECT * FROM jsonb_array_elements(v_changes)
  LOOP
    v_id := btrim(COALESCE(v_row->>'studentId',''));
    v_class := btrim(COALESCE(v_row->>'toClass',''));
    IF v_id = '' THEN
      v_problems := v_problems || jsonb_build_object('kind','change_missing_id','message','A class change is missing its student ID.');
      CONTINUE;
    END IF;
    IF v_id = ANY (v_seen_id) THEN
      v_problems := v_problems || jsonb_build_object('kind','duplicate_in_file','studentId',v_id,
        'message', format('Student %s appears more than once in the import.', v_id));
    END IF;
    v_seen_id := array_append(v_seen_id, v_id);

    SELECT id, name INTO v_existing FROM public.students WHERE id = v_id;
    IF NOT FOUND THEN
      v_problems := v_problems || jsonb_build_object('kind','change_student_missing','studentId',v_id,
        'message', format('Class change targets student ID %s which does not exist.', v_id));
      CONTINUE;
    END IF;
    IF v_class = '' OR NOT ((v_class = ANY (v_known_classes)) OR public.is_canonical_class(v_class)) THEN
      v_problems := v_problems || jsonb_build_object('kind','bad_class','studentId',v_id,'className',v_class,
        'message', format('Class "%s" does not exist (student %s). Use a sectioned class such as "Grade 9-B" or "KG-A".', v_class, v_id));
    END IF;
    v_transport := NULLIF(btrim(COALESCE(v_row->>'transport','')), '');
    IF v_transport IS NOT NULL AND NOT public.valid_transport(v_transport) THEN
      v_problems := v_problems || jsonb_build_object('kind','bad_transport','studentId',v_id,'transport',v_transport,
        'message', format('Invalid bus/transport "%s" for student %s.', v_transport, v_id));
    END IF;
  END LOOP;

  FOR v_row IN SELECT * FROM jsonb_array_elements(v_new)
  LOOP
    v_id := btrim(COALESCE(v_row->>'id',''));
    v_name := btrim(COALESCE(v_row->>'name',''));
    v_class := btrim(COALESCE(v_row->>'className',''));
    v_gov := public.gov_id_key(v_row->>'govId');
    v_transport := COALESCE(NULLIF(btrim(COALESCE(v_row->>'transport','')), ''), 'WALKER');

    SELECT id, name INTO v_existing FROM public.students WHERE id = v_id;
    IF FOUND THEN
      v_problems := v_problems || jsonb_build_object(
        'kind','already_exists_id','studentId',v_id,'existingName',v_existing.name,
        'existingClassName',v_existing."className",'claimedAs','new',
        'message', format('%s already exists as "%s" (ID %s). The spreadsheet row was classified as a new student — nothing will be created; match it to the existing record.',
                          COALESCE(NULLIF(v_name,''), 'This student'), v_existing.name, v_id));
      CONTINUE;
    END IF;

    IF v_gov IS NOT NULL THEN
      SELECT id, name, "className" INTO v_existing FROM public.students WHERE public.gov_id_key("govId") = v_gov;
      IF NOT FOUND AND public.gov_id_match_key(v_gov) <> '' THEN
        SELECT id, name, "className" INTO v_existing FROM public.students
         WHERE public.gov_id_match_key("govId") = public.gov_id_match_key(v_gov);
      END IF;
      IF FOUND THEN
        v_problems := v_problems || jsonb_build_object(
          'kind','already_exists_gov','govId',v_gov,'existingId',v_existing.id,'existingName',v_existing.name,
          'existingClassName',v_existing."className",'studentId',v_id,'name',v_name,'claimedAs','new',
          'message', format('%s (ID %s) uses Gov ID %s, which already belongs to "%s" (ID %s). Match the existing student instead of creating a duplicate.',
                            COALESCE(NULLIF(v_name,''), 'This student'), COALESCE(NULLIF(v_id,''), '—'),
                            v_gov, v_existing.name, v_existing.id));
        CONTINUE;
      END IF;
      IF v_gov = ANY (v_seen_gov) THEN
        v_problems := v_problems || jsonb_build_object('kind','duplicate_gov_in_file','govId',v_gov,
          'message', format('Gov ID %s is used by more than one new student in this file.', v_gov));
      END IF;
      v_seen_gov := array_append(v_seen_gov, v_gov);
    END IF;

    IF v_name = '' THEN
      v_problems := v_problems || jsonb_build_object('kind','new_missing_name','studentId',v_id,
        'message','A new student is missing a name.');
    END IF;
    IF v_class = '' OR NOT ((v_class = ANY (v_known_classes)) OR public.is_canonical_class(v_class)) THEN
      v_problems := v_problems || jsonb_build_object('kind','bad_class','name',v_name,'className',v_class,
        'message', format('Class "%s" does not exist (new student %s). Use a sectioned class such as "Grade 9-B" or "KG-A".', v_class, v_name));
    END IF;
    IF NOT public.valid_transport(v_transport) THEN
      v_problems := v_problems || jsonb_build_object('kind','bad_transport','name',v_name,'transport',v_transport,
        'message', format('Invalid bus/transport "%s" for new student %s.', v_transport, v_name));
    END IF;
  END LOOP;

  RETURN jsonb_build_object('ok', jsonb_array_length(v_problems) = 0, 'problems', v_problems,
                            'problemCount', jsonb_array_length(v_problems));
END;
$$;

DO $$
BEGIN
  EXECUTE 'REVOKE ALL ON FUNCTION public.check_class_import_payload(JSONB,JSONB) FROM PUBLIC';
  EXECUTE 'GRANT EXECUTE ON FUNCTION public.check_class_import_payload(JSONB,JSONB) TO authenticated';
END $$;

-- ── Recreate apply with canonical-class acceptance and the loose gov guard ──
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
  v_change JSONB; v_ns JSONB; v_student RECORD; v_existing RECORD;
  v_id TEXT; v_name TEXT; v_class TEXT; v_gov TEXT; v_phone TEXT;
  v_transport TEXT; v_stored_transport TEXT;
  v_class_changed BOOLEAN; v_transport_changed BOOLEAN;
  v_seen TEXT[] := ARRAY[]::TEXT[]; v_govs TEXT[] := ARRAY[]::TEXT[];
  v_updated INT := 0; v_skipped INT := 0; v_created INT := 0;
  v_applied JSONB := '[]'::jsonb; v_created_list JSONB := '[]'::jsonb;
BEGIN
  IF v_role IS NULL OR v_role <> 'admin' THEN
    RAISE EXCEPTION 'Only admins may apply a student class import.' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF jsonb_typeof(v_changes) <> 'array' OR jsonb_typeof(v_new) <> 'array' THEN
    RAISE EXCEPTION 'Import payload must be JSON arrays.' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF jsonb_array_length(v_changes) > 5000 OR jsonb_array_length(v_new) > 2000 THEN
    RAISE EXCEPTION 'Import too large: max 5,000 class changes and 2,000 new students per file.' USING ERRCODE = 'program_limit_exceeded';
  END IF;

  SELECT COALESCE(array_agg(DISTINCT c), ARRAY[]::TEXT[]) INTO v_known_classes FROM (
    SELECT "className" AS c FROM public.class_subjects WHERE "className" IS NOT NULL
    UNION SELECT "className" FROM public.students WHERE "className" IS NOT NULL
    UNION SELECT 'Graduated'::text
  ) k;

  IF v_year IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.academic_years WHERE id = v_year) THEN
    RAISE EXCEPTION 'Academic year "%" does not exist.', v_year USING ERRCODE = 'no_data_found';
  END IF;

  FOR v_change IN SELECT * FROM jsonb_array_elements(v_changes)
  LOOP
    v_id := btrim(COALESCE(v_change->>'studentId',''));
    v_class := btrim(COALESCE(v_change->>'toClass',''));
    v_transport := NULLIF(btrim(COALESCE(v_change->>'transport','')), '');
    IF v_id = '' THEN RAISE EXCEPTION 'A class change is missing its student ID.' USING ERRCODE = 'invalid_parameter_value'; END IF;
    IF v_id = ANY (v_seen) THEN RAISE EXCEPTION 'Student "%" appears more than once in the import.', v_id USING ERRCODE = 'unique_violation'; END IF;
    v_seen := array_append(v_seen, v_id);
    IF v_class = '' THEN RAISE EXCEPTION 'Class is required for student "%".', v_id USING ERRCODE = 'invalid_parameter_value'; END IF;
    IF NOT ((v_class = ANY (v_known_classes)) OR public.is_canonical_class(v_class)) THEN RAISE EXCEPTION 'Class "%" does not exist. Use a sectioned class such as "Grade 9-B" or "KG-A".', v_class USING ERRCODE = 'no_data_found'; END IF;
    IF v_transport IS NOT NULL AND NOT public.valid_transport(v_transport) THEN
      RAISE EXCEPTION 'Invalid bus/transport value "%" for student "%". Use a route number, WALKER, CAR, or DRIVER.', v_transport, v_id USING ERRCODE = 'check_violation';
    END IF;

    SELECT id, name, "className", transport INTO v_student FROM public.students WHERE id = v_id FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'Student ID "%" does not exist.', v_id USING ERRCODE = 'no_data_found'; END IF;

    v_class_changed := (v_student."className" <> v_class);
    v_stored_transport := public.norm_transport(v_student.transport);
    v_transport_changed := (v_transport IS NOT NULL AND v_transport <> v_stored_transport);

    IF NOT v_class_changed AND NOT v_transport_changed THEN
      v_skipped := v_skipped + 1; CONTINUE;
    END IF;
    IF v_transport_changed THEN UPDATE public.students SET transport = v_transport WHERE id = v_id; END IF;
    IF v_class_changed THEN
      UPDATE public.students SET "className" = v_class WHERE id = v_id;
      IF NOT EXISTS (SELECT 1 FROM public.student_promotions
         WHERE "studentId" = v_id AND "fromClass" = v_student."className"
           AND "toClass" = v_class AND source = 'class_import'
           AND ("academicYearId" IS NOT DISTINCT FROM v_year)) THEN
        INSERT INTO public.student_promotions (id, "studentId", "fromClass", "toClass", "academicYearId", source)
        VALUES ('clsimp-' || floor(extract(epoch FROM now())*1000)::text || '-' || substr(md5(random()::text || v_id),1,8),
                v_id, v_student."className", v_class, v_year, 'class_import');
      END IF;
      PERFORM public.record_class_assignment(v_id, v_class, 'transfer', CURRENT_DATE, v_year, NULL, v_import_ref);
    END IF;

    INSERT INTO public.audit_logs (action, details, "createdAt")
    VALUES ('students.class_change', jsonb_build_object('importRef', v_import_ref, 'actor', v_actor,
        'studentId', v_id, 'studentName', v_student.name,
        'fromClass', v_student."className", 'toClass', v_class,
        'fromTransport', v_stored_transport,
        'toTransport', CASE WHEN v_transport_changed THEN v_transport ELSE v_stored_transport END,
        'classChanged', v_class_changed, 'transportChanged', v_transport_changed, 'academicYearId', v_year), NOW());

    v_updated := v_updated + 1;
    v_applied := v_applied || jsonb_build_array(jsonb_build_object(
      'studentId', v_id, 'name', v_student.name,
      'fromClass', v_student."className", 'toClass', v_class,
      'transport', CASE WHEN v_transport_changed THEN v_transport ELSE v_stored_transport END));
  END LOOP;

  FOR v_ns IN SELECT * FROM jsonb_array_elements(v_new)
  LOOP
    v_id := btrim(COALESCE(v_ns->>'id',''));
    v_name := btrim(COALESCE(v_ns->>'name',''));
    v_class := btrim(COALESCE(v_ns->>'className',''));
    v_gov := public.gov_id_key(v_ns->>'govId');
    v_phone := NULLIF(public.normalize_phone(v_ns->>'parentPhone'), '');
    v_transport := COALESCE(NULLIF(btrim(COALESCE(v_ns->>'transport','')), ''), 'WALKER');

    IF NOT public.valid_transport(v_transport) THEN
      RAISE EXCEPTION 'Invalid bus/transport value "%" for new student "%".', v_transport, v_name USING ERRCODE = 'check_violation';
    END IF;
    IF v_id = '' THEN
      v_id := 'student-' || floor(extract(epoch FROM now())*1000)::text || '-' || substr(md5(random()::text || v_name),1,6);
    END IF;
    IF v_id = ANY (v_seen) THEN RAISE EXCEPTION 'Student ID "%" appears more than once in the import.', v_id USING ERRCODE = 'unique_violation'; END IF;

    SELECT id, name INTO v_existing FROM public.students WHERE id = v_id;
    IF FOUND THEN
      RAISE EXCEPTION '% already exists as "%". The spreadsheet row (ID %) was classified as a new student but matches an existing record — nothing was changed. Match the row to the existing student instead of creating a duplicate.',
        COALESCE(NULLIF(v_name,''), 'This student'), v_existing.name, v_id USING ERRCODE = 'unique_violation';
    END IF;

    IF v_gov IS NOT NULL THEN
      SELECT id, name INTO v_existing FROM public.students WHERE public.gov_id_key("govId") = v_gov;
      IF NOT FOUND AND public.gov_id_match_key(v_gov) <> '' THEN
        SELECT id, name INTO v_existing FROM public.students
         WHERE public.gov_id_match_key("govId") = public.gov_id_match_key(v_gov);
      END IF;
      IF FOUND THEN
        RAISE EXCEPTION 'Gov ID % already belongs to "%". The row for "%" was classified as a new student but that ID already exists — nothing was changed. Match the existing student instead.',
          v_gov, v_existing.name, COALESCE(NULLIF(v_name,''), 'a student') USING ERRCODE = 'unique_violation';
      END IF;
      IF v_gov = ANY (v_govs) THEN
        RAISE EXCEPTION 'Gov ID % is used by more than one new student in this import — nothing was changed.', v_gov USING ERRCODE = 'unique_violation';
      END IF;
      v_govs := array_append(v_govs, v_gov);
    END IF;
    v_seen := array_append(v_seen, v_id);

    IF v_name = '' THEN RAISE EXCEPTION 'Student name is required for a new student.' USING ERRCODE = 'invalid_parameter_value'; END IF;
    IF v_class = '' OR NOT ((v_class = ANY (v_known_classes)) OR public.is_canonical_class(v_class)) THEN
      RAISE EXCEPTION 'Class "%" does not exist. Use a sectioned class such as "Grade 9-B" or "KG-A".', v_class USING ERRCODE = 'no_data_found';
    END IF;

    INSERT INTO public.students (id, name, "className", "govId", "parentPhone", transport, "createdAt")
    VALUES (v_id, v_name, v_class, v_gov, v_phone, v_transport, NOW());
    PERFORM public.record_class_assignment(v_id, v_class, 'import', CURRENT_DATE, v_year, NULL, v_import_ref);

    v_created := v_created + 1;
    v_created_list := v_created_list || jsonb_build_array(jsonb_build_object(
      'studentId', v_id, 'name', v_name, 'className', v_class, 'transport', v_transport));
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

DO $$
BEGIN
  EXECUTE 'REVOKE ALL ON FUNCTION public.apply_student_class_import(JSONB,JSONB,TEXT,TEXT) FROM PUBLIC';
  EXECUTE 'GRANT EXECUTE ON FUNCTION public.apply_student_class_import(JSONB,JSONB,TEXT,TEXT) TO authenticated';
END $$;
