-- ============================================================================
-- Migration 20260906g — authoritative server-side identity resolution for the
-- student class import.
-- ============================================================================
-- The preview was classifying rows against the browser-downloaded roster, so an
-- existing student whose Gov ID did not match locally (formatting variance, a
-- record present in the DB but reconciled server-side, or a sheet with NO
-- internal Student ID column) fell through to NEW STUDENT. Gov ID is the
-- school's authoritative external identifier, so identity must be resolved
-- against the LIVE database before the preview is trusted.
--
-- resolve_class_import_rows(p_rows) is admin-only and READ-ONLY. It returns,
-- for every uploaded row, an authoritative decision:
--   matched   → matchedStudentId/method: bind to this existing student
--   ambiguous → candidateIds: needs a manual choice (never created)
--   new       → no existing identity and no name collision → safe to create
-- Matching priority: Student ID → Gov ID (normalized) → name + normalized
-- phone. Name alone is NEVER an auto-match. Idempotent.

-- Loose matching keys (separate from gov_id_key(), which backs the unique
-- index and must stay strict): strip every non-alphanumeric and uppercase so
-- "16-005772", " 16 005772", and "16005772" compare equal.
CREATE OR REPLACE FUNCTION public.gov_id_match_key(p_t TEXT)
RETURNS TEXT LANGUAGE sql IMMUTABLE SET search_path = public AS $$
  SELECT upper(regexp_replace(COALESCE(p_t,''), '[^a-zA-Z0-9]', '', 'g'));
$$;

CREATE OR REPLACE FUNCTION public.name_match_key(p_t TEXT)
RETURNS TEXT LANGUAGE sql IMMUTABLE SET search_path = public AS $$
  SELECT btrim(regexp_replace(lower(COALESCE(p_t,'')), '\s+', ' ', 'g'));
$$;

CREATE OR REPLACE FUNCTION public.resolve_class_import_rows(p_rows JSONB)
RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_role TEXT := public.current_profile_role();
  v_row JSONB;
  v_sid TEXT; v_gov TEXT; v_gov_key TEXT; v_name TEXT; v_phone TEXT;
  v_hits RECORD; v_n INT; v_id TEXT; v_method TEXT;
  v_candidates JSONB;
  v_out JSONB := '[]'::jsonb;
  v_idx INT := -1;
BEGIN
  IF v_role IS NULL OR v_role <> 'admin' THEN
    RAISE EXCEPTION 'Only admins may resolve student identities.'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF jsonb_typeof(COALESCE(p_rows,'[]'::jsonb)) <> 'array' THEN
    RAISE EXCEPTION 'Payload must be a JSON array.' USING ERRCODE = 'invalid_parameter_value';
  END IF;

  FOR v_row IN SELECT * FROM jsonb_array_elements(COALESCE(p_rows,'[]'::jsonb))
  LOOP
    v_idx := v_idx + 1;
    v_sid   := NULLIF(btrim(COALESCE(v_row->>'studentId','')), '');
    v_gov   := NULLIF(btrim(COALESCE(v_row->>'govId','')), '');
    v_name  := NULLIF(btrim(COALESCE(v_row->>'name','')), '');
    v_phone := NULLIF(public.normalize_phone(v_row->>'parentPhone'), '');
    v_gov_key := CASE WHEN v_gov IS NOT NULL THEN public.gov_id_match_key(v_gov) ELSE NULL END;
    v_id := NULL; v_method := NULL;

    -- 1. Exact internal Student ID.
    IF v_sid IS NOT NULL THEN
      SELECT s.id, s.name, s."className", s."govId" INTO v_hits
        FROM public.students s WHERE s.id = v_sid;
      IF FOUND THEN
        v_id := v_hits.id; v_method := 'student_id';
      END IF;
    END IF;

    -- 2. Gov ID (normalized), must be unique.
    IF v_id IS NULL AND v_gov_key IS NOT NULL AND v_gov_key <> '' THEN
      SELECT count(*) INTO v_n FROM public.students
       WHERE public.gov_id_match_key("govId") = v_gov_key;
      IF v_n = 1 THEN
        SELECT s.id, s.name, s."className", s."govId" INTO v_hits
          FROM public.students s WHERE public.gov_id_match_key(s."govId") = v_gov_key;
        v_id := v_hits.id; v_method := 'gov_id';
      ELSIF v_n > 1 THEN
        SELECT COALESCE(jsonb_agg(jsonb_build_object(
                 'id', s.id, 'name', s.name, 'className', s."className")), '[]'::jsonb)
          INTO v_candidates FROM (
            SELECT id, name, "className" FROM public.students
             WHERE public.gov_id_match_key("govId") = v_gov_key LIMIT 10) s;
        v_out := v_out || jsonb_build_object('index', v_idx, 'status', 'ambiguous',
          'reason', 'gov_id_not_unique', 'candidates', COALESCE(v_candidates,'[]'::jsonb));
        CONTINUE;
      END IF;
    END IF;

    -- 3. Exact name + normalized parent phone, must be unique.
    IF v_id IS NULL AND v_name IS NOT NULL AND v_phone IS NOT NULL THEN
      SELECT count(*) INTO v_n FROM public.students
       WHERE public.name_match_key(name) = public.name_match_key(v_name)
         AND public.normalize_phone("parentPhone") = v_phone;
      IF v_n = 1 THEN
        SELECT s.id, s.name, s."className", s."govId" INTO v_hits
          FROM public.students s
         WHERE public.name_match_key(s.name) = public.name_match_key(v_name)
           AND public.normalize_phone(s."parentPhone") = v_phone;
        v_id := v_hits.id; v_method := 'name_phone';
      END IF;
    END IF;

    -- Resolved to an existing student.
    IF v_id IS NOT NULL THEN
      v_out := v_out || jsonb_build_object('index', v_idx, 'status', 'matched',
        'matchMethod', v_method, 'matchedStudentId', v_hits.id,
        'matchedName', v_hits.name, 'matchedClassName', v_hits."className",
        'matchedGovId', v_hits."govId");
      CONTINUE;
    END IF;

    -- 4. Not resolved. If the name collides with an existing student at all,
    --    force manual review (name-only never auto-matches, and we never
    --    create a possible duplicate).
    IF v_name IS NOT NULL THEN
      SELECT count(*) INTO v_n FROM public.students
       WHERE public.name_match_key(name) = public.name_match_key(v_name);
      IF v_n > 0 THEN
        SELECT COALESCE(jsonb_agg(jsonb_build_object(
                 'id', s.id, 'name', s.name, 'className', s."className")), '[]'::jsonb)
          INTO v_candidates FROM (
            SELECT id, name, "className" FROM public.students
             WHERE public.name_match_key(name) = public.name_match_key(v_name) LIMIT 10) s;
        v_out := v_out || jsonb_build_object('index', v_idx, 'status', 'ambiguous',
          'reason', CASE WHEN v_n = 1 THEN 'name_only' ELSE 'name_not_unique' END,
          'candidates', COALESCE(v_candidates,'[]'::jsonb));
        CONTINUE;
      END IF;
    END IF;

    -- 5. No identity and no name collision → genuinely new.
    v_out := v_out || jsonb_build_object('index', v_idx, 'status', 'new');
  END LOOP;

  RETURN v_out;
END;
$$;

DO $$
BEGIN
  EXECUTE 'REVOKE ALL ON FUNCTION public.resolve_class_import_rows(JSONB) FROM PUBLIC';
  EXECUTE 'GRANT EXECUTE ON FUNCTION public.resolve_class_import_rows(JSONB) TO authenticated';
  EXECUTE 'REVOKE ALL ON FUNCTION public.gov_id_match_key(TEXT) FROM PUBLIC';
  EXECUTE 'REVOKE ALL ON FUNCTION public.name_match_key(TEXT) FROM PUBLIC';
END $$;

-- ─── Strengthen the commit guard with loose Gov-ID matching ─────────────────
-- Re-create apply_student_class_import with the transport-aware behavior of
-- 20260906e/f PLUS a loose gov-id collision check: before inserting a new
-- student, detect an existing record whose gov id matches after removing
-- non-alphanumeric characters (catches "16-005772" vs "16 005772" etc.). The
-- descriptive error names the existing record; atomic rollback is unchanged.
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
    IF NOT (v_class = ANY (v_known_classes)) THEN RAISE EXCEPTION 'Class "%" does not exist.', v_class USING ERRCODE = 'no_data_found'; END IF;
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
      -- STRICT exact key first (unique index), then a loose format-tolerant lookup.
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
    IF v_class = '' OR NOT (v_class = ANY (v_known_classes)) THEN
      RAISE EXCEPTION 'Class "%" does not exist.', v_class USING ERRCODE = 'no_data_found';
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
