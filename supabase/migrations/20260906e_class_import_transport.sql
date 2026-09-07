-- ============================================================================
-- Migration 20260906e — student class import also updates Bus / transport.
-- ============================================================================
-- Supersedes apply_student_class_import() from 20260906c with a transport-aware
-- version. The client preview now reads an optional "Bus" column:
--   - a change row may carry `transport` (route number | WALKER | CAR | DRIVER);
--   - a row whose class is unchanged but whose bus differs is applied as a
--     transport-only update (no promotion / enrollment history written);
--   - new students carry `transport` (defaults to WALKER when the cell is blank).
-- A BLANK bus cell means "leave transport untouched" — it never silently turns a
-- rider into a walker. Transport is validated server-side against the same shape
-- as students_transport_check (digits | WALKER | CAR | DRIVER). Idempotent.

-- Canonical stored transport for comparison: NULL/'' is the school default (walker).
CREATE OR REPLACE FUNCTION public.norm_transport(p_t TEXT)
RETURNS TEXT LANGUAGE sql IMMUTABLE AS $f$
  SELECT CASE WHEN btrim(COALESCE(p_t,'')) = '' THEN 'WALKER'
              ELSE btrim(p_t) END;
$f$;

-- True when the value fits students_transport_check (LEFT is NOT settable here).
CREATE OR REPLACE FUNCTION public.valid_transport(p_t TEXT)
RETURNS BOOLEAN LANGUAGE sql IMMUTABLE AS $f$
  SELECT btrim(COALESCE(p_t,'')) IN ('WALKER','CAR','DRIVER')
      OR btrim(COALESCE(p_t,'')) ~ '^[0-9]+$';
$f$;

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
  v_transport TEXT; v_stored_transport TEXT;
  v_class_changed BOOLEAN; v_transport_changed BOOLEAN;
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
    -- transport key absent OR null → leave untouched; '' is treated as absent.
    v_transport := NULLIF(btrim(COALESCE(v_change->>'transport','')), '');
    IF v_id = '' THEN RAISE EXCEPTION 'A class change is missing its student ID.' USING ERRCODE = 'invalid_parameter_value'; END IF;
    IF v_id = ANY (v_seen) THEN RAISE EXCEPTION 'Student "%" appears more than once in the import.', v_id USING ERRCODE = 'unique_violation'; END IF;
    v_seen := array_append(v_seen, v_id);
    IF v_class = '' THEN RAISE EXCEPTION 'Class is required for student "%".', v_id USING ERRCODE = 'invalid_parameter_value'; END IF;
    IF NOT (v_class = ANY (v_known_classes)) THEN RAISE EXCEPTION 'Class "%" does not exist.', v_class USING ERRCODE = 'no_data_found'; END IF;
    IF v_transport IS NOT NULL AND NOT public.valid_transport(v_transport) THEN
      RAISE EXCEPTION 'Invalid bus/transport value "%" for student "%". Use a route number, WALKER, CAR, or DRIVER.', v_transport, v_id
        USING ERRCODE = 'check_violation';
    END IF;

    SELECT id, name, "className", transport INTO v_student FROM public.students WHERE id = v_id FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'Student ID "%" does not exist.', v_id USING ERRCODE = 'no_data_found'; END IF;

    v_class_changed := (v_student."className" <> v_class);
    v_stored_transport := public.norm_transport(v_student.transport);
    v_transport_changed := (v_transport IS NOT NULL AND v_transport <> v_stored_transport);

    IF NOT v_class_changed AND NOT v_transport_changed THEN
      v_skipped := v_skipped + 1; CONTINUE;
    END IF;

    IF v_transport_changed THEN
      UPDATE public.students SET transport = v_transport WHERE id = v_id;
    END IF;

    IF v_class_changed THEN
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
    END IF;

    INSERT INTO public.audit_logs (action, details, "createdAt")
    VALUES ('students.class_change', jsonb_build_object('importRef', v_import_ref,
        'actor', v_actor, 'studentId', v_id, 'studentName', v_student.name,
        'fromClass', v_student."className", 'toClass', v_class,
        'fromTransport', v_stored_transport,
        'toTransport', CASE WHEN v_transport_changed THEN v_transport ELSE v_stored_transport END,
        'classChanged', v_class_changed, 'transportChanged', v_transport_changed,
        'academicYearId', v_year), NOW());

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
      RAISE EXCEPTION 'Invalid bus/transport value "%" for new student "%".', v_transport, v_name
        USING ERRCODE = 'check_violation';
    END IF;
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

    INSERT INTO public.students (id, name, "className", "govId", "parentPhone", transport, "createdAt")
    VALUES (v_id, v_name, v_class, v_gov, v_phone, v_transport, NOW());
    PERFORM public.record_class_assignment(
      v_id, v_class, 'import', CURRENT_DATE, v_year, NULL, v_import_ref);

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

-- Function signature is unchanged (JSONB,JSONB,TEXT,TEXT) → existing EXECUTE
-- grants from 20260906c remain valid; re-assert them for safety.
DO $$
BEGIN
  EXECUTE 'REVOKE ALL ON FUNCTION public.apply_student_class_import(JSONB,JSONB,TEXT,TEXT) FROM PUBLIC';
  EXECUTE 'GRANT EXECUTE ON FUNCTION public.apply_student_class_import(JSONB,JSONB,TEXT,TEXT) TO authenticated';
END $$;
