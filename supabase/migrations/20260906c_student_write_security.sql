-- ============================================================================
-- Migration 20260906c — Student write security: admin RPCs, RLS lockdown,
--                        identity integrity, assignment uniqueness.
-- ============================================================================
-- All legitimate student writes move behind admin-gated SECURITY DEFINER RPCs.
-- AFTER the client is repointed to these RPCs (same release), students RLS is
-- flipped to SELECT-only, so no direct table write survives. Every function:
--   * verifies role server-side (admin),
--   * SET search_path = public,
--   * REVOKE FROM PUBLIC; GRANT EXECUTE TO authenticated,
--   * writes an audit_logs row.
-- teacher/parent daily-write tables (attendance/homework/quizzes) are handled
-- in the next migration.

-- ─── Shared: require admin ─────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.assert_admin()
RETURNS TEXT LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_role TEXT := public.current_profile_role();
BEGIN
  IF v_role IS NULL OR v_role <> 'admin' THEN
    RAISE EXCEPTION 'Only administrators may perform this action.'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN public.current_profile_id();
END;
$$;

CREATE OR REPLACE FUNCTION public.current_academic_year_id()
RETURNS TEXT LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT id FROM public.academic_years WHERE "isCurrent" = true
  ORDER BY "startDate" DESC LIMIT 1;
$$;

-- Normalized identity used for Gov-id duplicate detection (null when blank).
CREATE OR REPLACE FUNCTION public.gov_id_key(p_gov TEXT)
RETURNS TEXT LANGUAGE sql IMMUTABLE SET search_path = public AS $$
  SELECT NULLIF(upper(btrim(COALESCE(p_gov,''))), '');
$$;

-- ─── Create student ─────────────────────────────────────────────────────────
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

-- ─── Update student (name/class/parent/gov id/phone/transport) ──────────────
CREATE OR REPLACE FUNCTION public.update_student(
  p_student_id TEXT,
  p_name TEXT DEFAULT NULL,
  p_class TEXT DEFAULT NULL,
  p_parent_id TEXT DEFAULT NULL,
  p_gov_id TEXT DEFAULT NULL,
  p_parent_phone TEXT DEFAULT NULL,
  p_transport TEXT DEFAULT NULL
) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_actor TEXT := public.assert_admin();
  v_old RECORD;
  v_class TEXT;
  v_gov TEXT;
  v_phone TEXT;
  v_year TEXT := public.current_academic_year_id();
  v_sets TEXT[] := ARRAY[]::TEXT[];
BEGIN
  SELECT * INTO v_old FROM public.students WHERE id = p_student_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Student % does not exist.', p_student_id USING ERRCODE = 'no_data_found';
  END IF;

  IF p_name IS NOT NULL AND btrim(p_name) <> '' THEN
    UPDATE public.students SET name = btrim(p_name) WHERE id = p_student_id;
  END IF;

  IF p_gov_id IS NOT NULL THEN
    v_gov := public.gov_id_key(p_gov_id);
    IF v_gov IS NOT NULL AND EXISTS (
       SELECT 1 FROM public.students
        WHERE public.gov_id_key("govId") = v_gov AND id <> p_student_id) THEN
      RAISE EXCEPTION 'Gov ID % is already assigned to another student.', v_gov
        USING ERRCODE = 'unique_violation';
    END IF;
    UPDATE public.students SET "govId" = v_gov WHERE id = p_student_id;
  END IF;

  IF p_parent_phone IS NOT NULL THEN
    v_phone := NULLIF(public.normalize_phone(p_parent_phone), '');
    UPDATE public.students SET "parentPhone" = v_phone WHERE id = p_student_id;
  END IF;

  IF p_parent_id IS NOT NULL THEN
    UPDATE public.students SET "parentId" = NULLIF(p_parent_id,'') WHERE id = p_student_id;
  END IF;

  IF p_transport IS NOT NULL THEN
    UPDATE public.students SET transport = NULLIF(btrim(p_transport),'') WHERE id = p_student_id;
  END IF;

  IF p_class IS NOT NULL AND btrim(p_class) <> '' THEN
    v_class := btrim(p_class);
    IF v_class <> v_old."className" THEN
      UPDATE public.students SET "className" = v_class WHERE id = p_student_id;
      PERFORM public.record_class_assignment(
        p_student_id, v_class, 'manual', CURRENT_DATE, v_year, NULL, 'update_student');
    END IF;
  END IF;

  SELECT name, "className" INTO v_old.name, v_old."className"
    FROM public.students WHERE id = p_student_id;

  INSERT INTO public.audit_logs (action, details, "createdAt")
  VALUES ('students.update', jsonb_build_object(
      'actor', v_actor, 'studentId', p_student_id,
      'name', v_old.name, 'className', v_old."className"), NOW());

  RETURN jsonb_build_object('id', p_student_id, 'name', v_old.name, 'className', v_old."className");
END;
$$;

-- ─── Delete student (cascades exams/attendance/homework via FKs) ────────────
CREATE OR REPLACE FUNCTION public.delete_student(p_student_id TEXT)
RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_actor TEXT := public.assert_admin();
        v_name TEXT;
BEGIN
  SELECT name INTO v_name FROM public.students WHERE id = p_student_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Student % does not exist.', p_student_id USING ERRCODE = 'no_data_found';
  END IF;
  DELETE FROM public.student_enrollments WHERE "studentId" = p_student_id;
  DELETE FROM public.students WHERE id = p_student_id; -- FK CASCADE handles exams/attendance
  INSERT INTO public.audit_logs (action, details, "createdAt")
  VALUES ('students.delete', jsonb_build_object(
      'actor', v_actor, 'studentId', p_student_id, 'name', v_name), NOW());
END;
$$;

-- ─── Bulk create students ──────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.bulk_create_students(p_students JSONB)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_actor TEXT := public.assert_admin();
  v_row JSONB;
  v_id TEXT; v_name TEXT; v_class TEXT; v_gov TEXT; v_phone TEXT; v_parent TEXT;
  v_year TEXT := public.current_academic_year_id();
  v_created INT := 0;
  v_govs TEXT[] := ARRAY[]::TEXT[];
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

-- ─── Promotion undo (replaces direct client writes) ────────────────────────
CREATE OR REPLACE FUNCTION public.undo_promotions(p_promotion_ids TEXT[])
RETURNS INT LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_actor TEXT := public.assert_admin();
  v_count INT := 0;
  r RECORD;
BEGIN
  FOR r IN
    SELECT p.id, p."studentId", p."fromClass"
    FROM public.student_promotions p
    WHERE p.id = ANY (p_promotion_ids)
    ORDER BY p."createdAt" ASC
  LOOP
    UPDATE public.students SET "className" = r."fromClass" WHERE id = r."studentId";
    PERFORM public.record_class_assignment(
      r."studentId", r."fromClass", 'correction', CURRENT_DATE,
      public.current_academic_year_id(), NULL, 'undo_promotion:'||r.id);
    DELETE FROM public.student_promotions WHERE id = r.id;
    DELETE FROM public.student_enrollments WHERE "sourceRef" = 'backfill-promotion'
      AND "studentId" = r."studentId";
    v_count := v_count + 1;
  END LOOP;
  INSERT INTO public.audit_logs (action, details, "createdAt")
  VALUES ('promotions.undo', jsonb_build_object('actor', v_actor, 'count', v_count,
      'promotionIds', to_jsonb(p_promotion_ids)), NOW());
  RETURN v_count;
END;
$$;

-- ─── Parent unlink (when a parent account is deleted) ──────────────────────
CREATE OR REPLACE FUNCTION public.unlink_parent_students(p_parent_id TEXT)
RETURNS INT LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_actor TEXT := public.assert_admin(); v_n INT;
BEGIN
  UPDATE public.students SET "parentId" = NULL WHERE "parentId" = p_parent_id;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  INSERT INTO public.audit_logs (action, details, "createdAt")
  VALUES ('students.unlink_parent', jsonb_build_object('actor', v_actor, 'parentId', p_parent_id, 'count', v_n), NOW());
  RETURN v_n;
END;
$$;

-- ─── promote_students: SECURITY DEFINER, admin-gated, enrollment-aware ─────
CREATE OR REPLACE FUNCTION public.promote_students(
  from_class TEXT, to_class TEXT, academic_year_id TEXT DEFAULT NULL
)
RETURNS TABLE(promoted_id TEXT, student_name TEXT, old_class TEXT, new_class TEXT)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_actor TEXT := public.assert_admin();
  v_effective DATE := COALESCE(
    (SELECT "startDate" FROM public.academic_years WHERE id = academic_year_id),
    CURRENT_DATE);
  rec RECORD;
BEGIN
  IF EXISTS (
    SELECT 1 FROM public.student_promotions
    WHERE "fromClass" = from_class AND "academicYearId" = academic_year_id
      AND source = 'promotion'
  ) THEN
    RAISE EXCEPTION 'Class "%" has already been promoted this academic year', from_class;
  END IF;

  FOR rec IN
    SELECT id, name, "className" FROM public.students
     WHERE "className" = from_class FOR UPDATE
  LOOP
    UPDATE public.students SET "className" = to_class WHERE id = rec.id;
    INSERT INTO public.student_promotions
      (id, "studentId", "fromClass", "toClass", "academicYearId", source)
    VALUES ('promo-' || floor(extract(epoch FROM clock_timestamp())*1000)::text
            || '-' || substr(md5(random()::text || rec.id),1,6),
            rec.id, from_class, to_class, academic_year_id, 'promotion');
    PERFORM public.record_class_assignment(
      rec.id, to_class, 'promotion', v_effective, academic_year_id, NULL, 'promote_students');
    promoted_id := rec.id; student_name := rec.name;
    old_class := from_class; new_class := to_class;
    RETURN NEXT;
  END LOOP;

  INSERT INTO public.audit_logs (action, details, "createdAt")
  VALUES ('students.promote', jsonb_build_object('actor', v_actor,
      'fromClass', from_class, 'toClass', to_class,
      'academicYearId', academic_year_id), NOW());
END;
$$;

-- ─── apply_student_class_import: hardened (enrollments, govId, caps, dedup) ─
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
    -- Idempotent promotion history (no duplicate import rows for the same move).
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
      RAISE EXCEPTION 'Student ID "%" already exists — a duplicate student was not created.', v_id USING ERRCODE = 'unique_violation';
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

-- ─── Gov-id identity integrity: dedupe then unique index ───────────────────
-- Keep the newest record per normalized Gov ID; quarantine the rest by
-- nulling their govId (preserved in audit for manual reconciliation).
-- Quarantine duplicate Gov IDs: keep the newest student per normalized key,
-- null govId on the older duplicates (data preserved in audit for manual fix).
INSERT INTO public.audit_logs (action, details, "createdAt")
WITH ranked AS (
  SELECT id, public.gov_id_key("govId") AS gkey, "createdAt",
         ROW_NUMBER() OVER (PARTITION BY public.gov_id_key("govId")
                            ORDER BY "createdAt" DESC, id DESC) AS rn
  FROM public.students WHERE public.gov_id_key("govId") IS NOT NULL
)
SELECT 'students.govid_dedupe',
       jsonb_build_object('quarantinedStudentId', id, 'govId', gkey), NOW()
FROM ranked WHERE rn > 1;

UPDATE public.students s SET "govId" = NULL
WHERE s.id IN (
  SELECT id FROM (
    SELECT id, ROW_NUMBER() OVER (PARTITION BY public.gov_id_key("govId")
                                  ORDER BY "createdAt" DESC, id DESC) AS rn
    FROM public.students WHERE public.gov_id_key("govId") IS NOT NULL
  ) x WHERE x.rn > 1
);

CREATE UNIQUE INDEX IF NOT EXISTS uniq_students_gov_id
  ON public.students (public.gov_id_key("govId"))
  WHERE public.gov_id_key("govId") IS NOT NULL;

-- ─── class_subjects: dedupe, unique active assignment, RLS ─────────────────
-- Collapse duplicate (class, subject) rows: prefer a row WITH a teacher, then
-- the newest. Delete the losing duplicates so the unique index can be created.
INSERT INTO public.audit_logs (action, details, "createdAt")
SELECT 'class_subjects.dedupe',
       jsonb_build_object('removedId', id, 'className', "className",
                          'subjectId', "subjectId", 'teacherId', "teacherId"), NOW()
FROM (
  SELECT id, "className", "subjectId", "teacherId",
         ROW_NUMBER() OVER (
           PARTITION BY "className", "subjectId"
           ORDER BY ("teacherId" IS NOT NULL) DESC, "createdAt" DESC, id DESC
         ) AS rn
  FROM public.class_subjects
) ranked
WHERE rn > 1;

DELETE FROM public.class_subjects
WHERE id IN (
  SELECT id FROM (
    SELECT id,
           ROW_NUMBER() OVER (
             PARTITION BY "className", "subjectId"
             ORDER BY ("teacherId" IS NOT NULL) DESC, "createdAt" DESC, id DESC
           ) AS rn
    FROM public.class_subjects
  ) ranked WHERE rn > 1
);

CREATE UNIQUE INDEX IF NOT EXISTS uniq_class_subjects_active
  ON public.class_subjects ("className", "subjectId");

ALTER TABLE public.class_subjects ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "class_subjects_select" ON public.class_subjects;
CREATE POLICY "class_subjects_select" ON public.class_subjects
  FOR SELECT TO authenticated USING (true);
DROP POLICY IF EXISTS "class_subjects_admin_write" ON public.class_subjects;
CREATE POLICY "class_subjects_admin_write" ON public.class_subjects
  FOR ALL TO authenticated
  USING (public.current_profile_role() = 'admin')
  WITH CHECK (public.current_profile_role() = 'admin');

-- ─── Grants ────────────────────────────────────────────────────────────────
DO $$
DECLARE f TEXT;
BEGIN
  FOREACH f IN ARRAY ARRAY[
    'public.create_student(TEXT,TEXT,TEXT,TEXT,TEXT,TEXT)',
    'public.update_student(TEXT,TEXT,TEXT,TEXT,TEXT,TEXT,TEXT)',
    'public.delete_student(TEXT)',
    'public.bulk_create_students(JSONB)',
    'public.undo_promotions(TEXT[])',
    'public.unlink_parent_students(TEXT)',
    'public.promote_students(TEXT,TEXT,TEXT)',
    'public.apply_student_class_import(JSONB,JSONB,TEXT,TEXT)'
  ] LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', f);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO authenticated', f);
  END LOOP;
END $$;
