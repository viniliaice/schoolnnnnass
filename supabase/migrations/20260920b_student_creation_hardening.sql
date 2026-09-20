-- ============================================================================
-- Migration 20260920b — Harden student creation against duplicates
-- ============================================================================
-- Fixes root cause:
--   * create_student now resolves existing identity before creating new ID
--   * bulk_create_students same
--   * apply_student_class_import new-student branch now checks name+phone
--     and name collision, forcing manual review instead of auto-creating
--     duplicate unassigned records.
-- Preserves principle: name alone is NEVER definitive identity; govId and
-- name+phone are trusted signals; ambiguous cases require manual review.
-- ============================================================================

-- ─── Helper: ensure normalize_phone exists (from family_ids) ─────────────────
-- Already exists from 20260802_family_ids.sql, but keep idempotent definition
-- for local pglite tests that may not have it.

CREATE OR REPLACE FUNCTION public.normalize_phone(p TEXT)
RETURNS TEXT LANGUAGE sql IMMUTABLE SET search_path = public AS $$
  SELECT CASE
    WHEN btrim(COALESCE(p,'')) = '' THEN ''
    ELSE regexp_replace(
      CASE
        WHEN length(regexp_replace(btrim(p), '\D', '', 'g')) = 9 THEN regexp_replace(btrim(p), '\D', '', 'g')
        WHEN regexp_replace(btrim(p), '\D', '', 'g') LIKE '252%' THEN substr(regexp_replace(btrim(p), '\D', '', 'g'), 4)
        WHEN regexp_replace(btrim(p), '\D', '', 'g') LIKE '0%' THEN substr(regexp_replace(btrim(p), '\D', '', 'g'), 2)
        ELSE regexp_replace(btrim(p), '\D', '', 'g')
      END,
      '\D', '', 'g')
  END;
$$;

-- ─── Recreate create_student with identity resolution ───────────────────────

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
  v_gov_match TEXT := public.gov_id_match_key(p_gov_id);
  v_phone TEXT := NULLIF(public.normalize_phone(p_parent_phone), '');
  v_name TEXT := btrim(COALESCE(p_name,''));
  v_class TEXT := btrim(COALESCE(p_class,''));
  v_parent_id TEXT := NULLIF(btrim(COALESCE(p_parent_id,'')), '');
  v_year TEXT := COALESCE(p_academic_year_id, public.current_academic_year_id());
  v_existing RECORD;
  v_count INT;
  v_name_key TEXT := public.name_match_key(v_name);
  v_class_key TEXT := public.class_match_key(v_class);
BEGIN
  IF v_name = '' THEN
    RAISE EXCEPTION 'Student name is required.' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF v_class = '' THEN
    RAISE EXCEPTION 'A valid class is required.' USING ERRCODE = 'invalid_parameter_value';
  END IF;

  -- 1. Stable ID check is not applicable here (ID is generated), but govId is authoritative.

  -- 2. Unique Government ID — exact or loose match — UPDATE existing, never create duplicate.
  IF v_gov IS NOT NULL THEN
    SELECT count(*) INTO v_count FROM public.students WHERE public.gov_id_key("govId") = v_gov;
    IF v_count = 1 THEN
      SELECT id INTO v_existing FROM public.students WHERE public.gov_id_key("govId") = v_gov;
      -- Reuse existing
      UPDATE public.students SET
        name = v_name,
        "className" = v_class,
        "parentId" = COALESCE(v_parent_id, "parentId"),
        "govId" = v_gov,
        "parentPhone" = COALESCE(v_phone, "parentPhone")
      WHERE id = v_existing.id;
      PERFORM public.record_class_assignment(v_existing.id, v_class, 'import', CURRENT_DATE, v_year, NULL, 'create_student:gov_reuse');
      INSERT INTO public.audit_logs (action, details, "createdAt")
      VALUES ('students.create_reuse_gov', jsonb_build_object('actor', v_actor, 'existingId', v_existing.id, 'name', v_name, 'className', v_class, 'govId', v_gov), NOW());
      RETURN jsonb_build_object('id', v_existing.id, 'name', v_name, 'className', v_class, 'reused', true, 'method', 'gov_id');
    ELSIF v_count > 1 THEN
      RAISE EXCEPTION 'Gov ID % matches % students — manual review required, not auto-created.', v_gov, v_count USING ERRCODE = 'unique_violation';
    END IF;

    -- Loose format-tolerant check
    IF v_gov_match <> '' THEN
      SELECT count(*) INTO v_count FROM public.students WHERE public.gov_id_match_key("govId") = v_gov_match;
      IF v_count = 1 THEN
        SELECT id INTO v_existing FROM public.students WHERE public.gov_id_match_key("govId") = v_gov_match;
        UPDATE public.students SET
          name = v_name,
          "className" = v_class,
          "parentId" = COALESCE(v_parent_id, "parentId"),
          "govId" = COALESCE("govId", v_gov),
          "parentPhone" = COALESCE(v_phone, "parentPhone")
        WHERE id = v_existing.id;
        PERFORM public.record_class_assignment(v_existing.id, v_class, 'import', CURRENT_DATE, v_year, NULL, 'create_student:gov_loose_reuse');
        INSERT INTO public.audit_logs (action, details, "createdAt")
        VALUES ('students.create_reuse_gov_loose', jsonb_build_object('actor', v_actor, 'existingId', v_existing.id, 'name', v_name, 'govId', v_gov), NOW());
        RETURN jsonb_build_object('id', v_existing.id, 'name', v_name, 'className', v_class, 'reused', true, 'method', 'gov_id_loose');
      ELSIF v_count > 1 THEN
        RAISE EXCEPTION 'Gov ID % (normalized % ) matches % students — manual review required.', v_gov, v_gov_match, v_count USING ERRCODE = 'unique_violation';
      END IF;
    END IF;
  END IF;

  -- 3. Name + parent phone — trusted secondary, must be unique
  IF v_phone IS NOT NULL AND v_phone <> '' AND v_name <> '' THEN
    SELECT count(*) INTO v_count FROM public.students
      WHERE public.name_match_key(name) = v_name_key
        AND public.normalize_phone("parentPhone") = v_phone;
    IF v_count = 1 THEN
      SELECT id INTO v_existing FROM public.students
        WHERE public.name_match_key(name) = v_name_key
          AND public.normalize_phone("parentPhone") = v_phone;
      UPDATE public.students SET
        "className" = v_class,
        "parentId" = COALESCE(v_parent_id, "parentId"),
        "parentPhone" = v_phone,
        "govId" = COALESCE("govId", v_gov)
      WHERE id = v_existing.id;
      PERFORM public.record_class_assignment(v_existing.id, v_class, 'import', CURRENT_DATE, v_year, NULL, 'create_student:name_phone_reuse');
      INSERT INTO public.audit_logs (action, details, "createdAt")
      VALUES ('students.create_reuse_name_phone', jsonb_build_object('actor', v_actor, 'existingId', v_existing.id, 'name', v_name), NOW());
      RETURN jsonb_build_object('id', v_existing.id, 'name', v_name, 'className', v_class, 'reused', true, 'method', 'name_phone');
    ELSIF v_count > 1 THEN
      RAISE EXCEPTION 'Name % with phone % matches % students — manual review required.', v_name, v_phone, v_count USING ERRCODE = 'unique_violation';
    END IF;
  END IF;

  -- 4. Name + parentId — trusted when parent assignment exists
  IF v_parent_id IS NOT NULL AND v_parent_id <> '' AND v_name <> '' THEN
    SELECT count(*) INTO v_count FROM public.students
      WHERE public.name_match_key(name) = v_name_key
        AND "parentId" = v_parent_id;
    IF v_count = 1 THEN
      SELECT id INTO v_existing FROM public.students
        WHERE public.name_match_key(name) = v_name_key
          AND "parentId" = v_parent_id;
      UPDATE public.students SET
        "className" = v_class,
        "parentPhone" = COALESCE(v_phone, "parentPhone"),
        "govId" = COALESCE("govId", v_gov)
      WHERE id = v_existing.id;
      PERFORM public.record_class_assignment(v_existing.id, v_class, 'manual', CURRENT_DATE, v_year, NULL, 'create_student:name_parent_reuse');
      INSERT INTO public.audit_logs (action, details, "createdAt")
      VALUES ('students.create_reuse_name_parent', jsonb_build_object('actor', v_actor, 'existingId', v_existing.id, 'name', v_name), NOW());
      RETURN jsonb_build_object('id', v_existing.id, 'name', v_name, 'className', v_class, 'reused', true, 'method', 'name_parent');
    ELSIF v_count > 1 THEN
      RAISE EXCEPTION 'Name % with parent % matches % students — manual review required.', v_name, v_parent_id, v_count USING ERRCODE = 'unique_violation';
    END IF;
  END IF;

  -- 5. Name + class unique — prevents the Axmed unassigned duplicate bug
  -- If exactly one existing student has same normalized name + class, reuse it
  -- rather than creating a second unassigned record. If multiple existing share
  -- same name+class, require govId or phone to disambiguate.
  IF v_name <> '' AND v_class <> '' THEN
    SELECT count(*) INTO v_count FROM public.students
      WHERE public.name_match_key(name) = v_name_key
        AND public.class_match_key("className") = v_class_key;
    IF v_count = 1 THEN
      SELECT id, "parentId" INTO v_existing FROM public.students
        WHERE public.name_match_key(name) = v_name_key
          AND public.class_match_key("className") = v_class_key;
      -- Reuse existing — this is the key fix for parent-assignment scenario:
      -- DB has Axmed Grade 1-B Parent Ayi, new request same name/class without parent
      -- must NOT create duplicate unassigned student.
      UPDATE public.students SET
        "parentId" = COALESCE(v_parent_id, "parentId"),
        "parentPhone" = COALESCE(v_phone, "parentPhone"),
        "govId" = COALESCE("govId", v_gov),
        name = v_name
      WHERE id = v_existing.id;
      -- If class is same, record_class_assignment is idempotent no-op; if different, it records move.
      PERFORM public.record_class_assignment(v_existing.id, v_class, 'import', CURRENT_DATE, v_year, NULL, 'create_student:name_class_reuse');
      INSERT INTO public.audit_logs (action, details, "createdAt")
      VALUES ('students.create_reuse_name_class', jsonb_build_object('actor', v_actor, 'existingId', v_existing.id, 'name', v_name, 'className', v_class), NOW());
      RETURN jsonb_build_object('id', v_existing.id, 'name', v_name, 'className', v_class, 'reused', true, 'method', 'name_class_unique');
    ELSIF v_count > 1 THEN
      -- Multiple existing with same name+class — ambiguous, require stronger evidence
      IF v_gov IS NULL AND (v_phone IS NULL OR v_phone = '') AND v_parent_id IS NULL THEN
        RAISE EXCEPTION 'Name % in class % matches % existing students — provide Gov ID or parent phone to disambiguate, or use manual review. A duplicate unassigned student is NOT created automatically.', v_name, v_class, v_count USING ERRCODE = 'unique_violation';
      END IF;
      -- If govId/phone provided but did not match uniquely above, allow creation as distinct real student with same name
      -- (two real students can share same name+class if govId/phone differ)
    END IF;
  END IF;

  -- 6. No existing identity — create fresh student ID
  v_id := 'student-' || floor(extract(epoch FROM clock_timestamp())*1000)::text
          || '-' || substr(md5(random()::text),1,6);

  INSERT INTO public.students (id, name, "className", "parentId", "govId", "parentPhone", "createdAt")
  VALUES (v_id, v_name, v_class, v_parent_id, v_gov, v_phone, NOW());

  PERFORM public.record_class_assignment(
    v_id, v_class, 'import', CURRENT_DATE, v_year, NULL, 'create_student');

  INSERT INTO public.audit_logs (action, details, "createdAt")
  VALUES ('students.create', jsonb_build_object(
      'actor', v_actor, 'studentId', v_id, 'name', v_name, 'className', v_class,
      'parentId', v_parent_id, 'govId', v_gov), NOW());

  RETURN jsonb_build_object('id', v_id, 'name', v_name, 'className', v_class, 'reused', false);
END;
$$;

-- ─── Bulk create with same identity resolution ──────────────────────────────

CREATE OR REPLACE FUNCTION public.bulk_create_students(p_students JSONB)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_actor TEXT := public.assert_admin();
  v_row JSONB;
  v_id TEXT; v_name TEXT; v_class TEXT; v_gov TEXT; v_gov_match TEXT; v_phone TEXT; v_parent TEXT;
  v_year TEXT := public.current_academic_year_id();
  v_created INT := 0;
  v_reused INT := 0;
  v_govs TEXT[] := ARRAY[]::TEXT[];
  v_name_key TEXT; v_class_key TEXT;
  v_count INT;
  v_existing_id TEXT;
BEGIN
  IF jsonb_typeof(p_students) <> 'array' THEN
    RAISE EXCEPTION 'Payload must be a JSON array.' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF jsonb_array_length(p_students) > 5000 THEN
    RAISE EXCEPTION 'Bulk create is limited to 5,000 students per batch.' USING ERRCODE = 'program_limit_exceeded';
  END IF;

  FOR v_row IN SELECT * FROM jsonb_array_elements(p_students)
  LOOP
    v_name := btrim(COALESCE(v_row->>'name',''));
    v_class := btrim(COALESCE(v_row->>'className',''));
    v_gov := public.gov_id_key(v_row->>'govId');
    v_gov_match := public.gov_id_match_key(v_row->>'govId');
    v_phone := NULLIF(public.normalize_phone(v_row->>'parentPhone'), '');
    v_parent := NULLIF(btrim(COALESCE(v_row->>'parentId','')),'');
    v_name_key := public.name_match_key(v_name);
    v_class_key := public.class_match_key(v_class);

    IF v_name = '' OR v_class = '' THEN
      RAISE EXCEPTION 'Every new student requires a name and a class.' USING ERRCODE = 'invalid_parameter_value';
    END IF;

    IF v_gov IS NOT NULL THEN
      IF v_gov = ANY (v_govs) THEN
        RAISE EXCEPTION 'Duplicate Gov ID % in bulk create payload.', v_gov USING ERRCODE = 'unique_violation';
      END IF;
      -- Check existing DB for govId (strict and loose) — reuse if found
      SELECT id INTO v_existing_id FROM public.students WHERE public.gov_id_key("govId") = v_gov LIMIT 1;
      IF FOUND THEN
        -- Reuse existing, update
        UPDATE public.students SET
          name = COALESCE(NULLIF(v_name,''), name),
          "className" = COALESCE(NULLIF(v_class,''), "className"),
          "parentId" = COALESCE(v_parent, "parentId"),
          "parentPhone" = COALESCE(v_phone, "parentPhone")
        WHERE id = v_existing_id;
        PERFORM public.record_class_assignment(v_existing_id, v_class, 'import', CURRENT_DATE, v_year, NULL, 'bulk_create_students:gov_reuse');
        v_reused := v_reused + 1;
        CONTINUE;
      END IF;
      IF v_gov_match <> '' THEN
        SELECT id INTO v_existing_id FROM public.students WHERE public.gov_id_match_key("govId") = v_gov_match LIMIT 1;
        IF FOUND THEN
          UPDATE public.students SET
            "className" = COALESCE(NULLIF(v_class,''), "className"),
            "parentId" = COALESCE(v_parent, "parentId"),
            "parentPhone" = COALESCE(v_phone, "parentPhone")
          WHERE id = v_existing_id;
          PERFORM public.record_class_assignment(v_existing_id, v_class, 'import', CURRENT_DATE, v_year, NULL, 'bulk_create_students:gov_loose_reuse');
          v_reused := v_reused + 1;
          CONTINUE;
        END IF;
      END IF;
      v_govs := array_append(v_govs, v_gov);
    END IF;

    -- Name + phone unique reuse
    IF v_phone IS NOT NULL AND v_phone <> '' THEN
      SELECT count(*) INTO v_count FROM public.students
        WHERE public.name_match_key(name) = v_name_key
          AND public.normalize_phone("parentPhone") = v_phone;
      IF v_count = 1 THEN
        SELECT id INTO v_existing_id FROM public.students
          WHERE public.name_match_key(name) = v_name_key
            AND public.normalize_phone("parentPhone") = v_phone;
        UPDATE public.students SET "className" = v_class, "parentId" = COALESCE(v_parent, "parentId") WHERE id = v_existing_id;
        PERFORM public.record_class_assignment(v_existing_id, v_class, 'import', CURRENT_DATE, v_year, NULL, 'bulk_create_students:name_phone_reuse');
        v_reused := v_reused + 1;
        CONTINUE;
      ELSIF v_count > 1 THEN
        RAISE EXCEPTION 'Name % with phone % matches % students — manual review required.', v_name, v_phone, v_count USING ERRCODE = 'unique_violation';
      END IF;
    END IF;

    -- Name + parentId unique reuse
    IF v_parent IS NOT NULL AND v_parent <> '' THEN
      SELECT count(*) INTO v_count FROM public.students
        WHERE public.name_match_key(name) = v_name_key AND "parentId" = v_parent;
      IF v_count = 1 THEN
        SELECT id INTO v_existing_id FROM public.students
          WHERE public.name_match_key(name) = v_name_key AND "parentId" = v_parent;
        UPDATE public.students SET "className" = v_class WHERE id = v_existing_id;
        PERFORM public.record_class_assignment(v_existing_id, v_class, 'import', CURRENT_DATE, v_year, NULL, 'bulk_create_students:name_parent_reuse');
        v_reused := v_reused + 1;
        CONTINUE;
      ELSIF v_count > 1 THEN
        RAISE EXCEPTION 'Name % with parent % matches % students — manual review required.', v_name, v_parent, v_count USING ERRCODE = 'unique_violation';
      END IF;
    END IF;

    -- Name + class unique reuse — prevents unassigned duplicate creation
    SELECT count(*) INTO v_count FROM public.students
      WHERE public.name_match_key(name) = v_name_key
        AND public.class_match_key("className") = v_class_key;
    IF v_count = 1 THEN
      SELECT id INTO v_existing_id FROM public.students
        WHERE public.name_match_key(name) = v_name_key
          AND public.class_match_key("className") = v_class_key;
      UPDATE public.students SET
        "parentId" = COALESCE(v_parent, "parentId"),
        "parentPhone" = COALESCE(v_phone, "parentPhone"),
        "govId" = COALESCE("govId", v_gov)
      WHERE id = v_existing_id;
      PERFORM public.record_class_assignment(v_existing_id, v_class, 'import', CURRENT_DATE, v_year, NULL, 'bulk_create_students:name_class_reuse');
      v_reused := v_reused + 1;
      CONTINUE;
    ELSIF v_count > 1 AND v_gov IS NULL AND (v_phone IS NULL OR v_phone = '') AND v_parent IS NULL THEN
      RAISE EXCEPTION 'Name % in class % matches % existing students — provide Gov ID or parent phone to disambiguate.', v_name, v_class, v_count USING ERRCODE = 'unique_violation';
    END IF;

    -- No reuse — create new
    v_id := 'student-' || floor(extract(epoch FROM clock_timestamp())*1000)::text
            || '-' || substr(md5(random()::text || v_name),1,6);
    INSERT INTO public.students (id, name, "className", "parentId", "govId", "parentPhone", "createdAt")
    VALUES (v_id, v_name, v_class, v_parent, v_gov, v_phone, NOW());
    PERFORM public.record_class_assignment(v_id, v_class, 'import', CURRENT_DATE, v_year, NULL, 'bulk_create_students');
    v_created := v_created + 1;
  END LOOP;

  INSERT INTO public.audit_logs (action, details, "createdAt")
  VALUES ('students.bulk_create', jsonb_build_object('actor', v_actor, 'created', v_created, 'reused', v_reused), NOW());
  RETURN jsonb_build_object('createdCount', v_created, 'reusedCount', v_reused);
END;
$$;

-- ─── Harden apply_student_class_import new-student branch ───────────────────
-- Re-create with canonical-class acceptance + gov guards + name+phone checks
-- + name-collision guard that forces manual review instead of auto-creating
-- duplicate unassigned records.

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
  v_import_ref TEXT := COALESCE(NULLIF(btrim(p_import_ref),''), 'class-import-' || floor(extract(epoch FROM now())*1000)::text);
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
  v_name_key TEXT; v_class_key TEXT; v_count INT; v_phone_norm TEXT;
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
    v_phone_norm := v_phone;
    v_transport := COALESCE(NULLIF(btrim(COALESCE(v_ns->>'transport','')), ''), 'WALKER');
    v_name_key := public.name_match_key(v_name);
    v_class_key := public.class_match_key(v_class);

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

    -- ── NEW: name+phone reuse guard — if name+phone matches existing unique student, do NOT create new, require match ──
    IF v_phone_norm IS NOT NULL AND v_phone_norm <> '' AND v_name <> '' THEN
      SELECT count(*) INTO v_count FROM public.students
        WHERE public.name_match_key(name) = v_name_key
          AND public.normalize_phone("parentPhone") = v_phone_norm;
      IF v_count = 1 THEN
        SELECT id, name INTO v_existing FROM public.students
          WHERE public.name_match_key(name) = v_name_key
            AND public.normalize_phone("parentPhone") = v_phone_norm;
        RAISE EXCEPTION 'Student "%" with phone % already exists as "%" (ID %). Match the existing student instead of creating a duplicate.',
          v_name, v_phone_norm, v_existing.name, v_existing.id USING ERRCODE = 'unique_violation';
      ELSIF v_count > 1 THEN
        RAISE EXCEPTION 'Name % with phone % matches % students — manual review required, not auto-created.', v_name, v_phone_norm, v_count USING ERRCODE = 'unique_violation';
      END IF;
    END IF;

    -- ── NEW: name+class unique reuse guard — prevents Axmed unassigned duplicate ──
    -- If exactly one existing student has same normalized name+class, treat as duplicate creation attempt and block.
    -- Exception: if govId is provided and unique (already checked above not matching), allow creation as distinct real student with same name (two real students can share same name if govId differs).
    IF v_name <> '' AND v_class <> '' THEN
      SELECT count(*) INTO v_count FROM public.students
        WHERE public.name_match_key(name) = v_name_key
          AND public.class_match_key("className") = v_class_key;
      IF v_count = 1 AND v_gov IS NULL AND (v_phone_norm IS NULL OR v_phone_norm = '') THEN
        SELECT id, name, "className" INTO v_existing FROM public.students
          WHERE public.name_match_key(name) = v_name_key
            AND public.class_match_key("className") = v_class_key;
        RAISE EXCEPTION 'Student "%" in class "%" already exists as "%" (ID % in %). An unassigned duplicate is NOT created automatically. Match the existing student or provide Gov ID / parent phone to prove it is a distinct student.',
          v_name, v_class, v_existing.name, v_existing.id, v_existing."className" USING ERRCODE = 'unique_violation';
      ELSIF v_count >= 1 AND v_gov IS NULL AND (v_phone_norm IS NULL OR v_phone_norm = '') THEN
        -- Multiple existing with same name+class and no distinguishing govId/phone — ambiguous, block
        RAISE EXCEPTION 'Name % in class % matches % existing students — provide Gov ID or parent phone to disambiguate, or use manual review. Duplicate not created.',
          v_name, v_class, v_count USING ERRCODE = 'unique_violation';
      END IF;
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
DECLARE f TEXT;
BEGIN
  FOREACH f IN ARRAY ARRAY[
    'public.create_student(TEXT,TEXT,TEXT,TEXT,TEXT,TEXT)',
    'public.bulk_create_students(JSONB)',
    'public.apply_student_class_import(JSONB,JSONB,TEXT,TEXT)'
  ] LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', f);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO authenticated', f);
  END LOOP;
END $$;
