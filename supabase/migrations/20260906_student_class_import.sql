-- Student Class Update & New Student Import (Excel/Google-Sheet workflow).
--
-- Background (see REPORT-student-class-import.md):
--   The school maintains the current student/class list in a Google Sheet.
--   Admins export it as .xlsx and upload it in the app. The client parses,
--   matches and previews everything WITHOUT touching the database; only after
--   explicit confirmation does it call apply_student_class_import(), which
--   commits all class changes + new students atomically.
--
-- Data-model notes that make this safe:
--   * students."className" is the student's CURRENT class assignment.
--   * Historical grades (exams) and attendance reference students."studentId"
--     — they follow the student and are NEVER rewritten by this function.
--   * Class-move history is recorded in student_promotions (same table the
--     Class Promotion feature uses), tagged source='class_import' so the
--     promotion re-run guard does not confuse the two workflows.
--
-- Security model mirrors set_student_import_fields() / mark_student_left():
--   students has no client INSERT/UPDATE policies under RLS, so the ONLY
--   write path is this admin-checked SECURITY DEFINER function. Hiding the
--   menu is not the control — SQL is.

-- ─── 1. Distinguish import moves from end-of-year promotions ──────────────
-- promote_students() refuses to re-promote a class that already has
-- promotion rows for the academic year. A mid-year import move (7A → 7B for
-- one student) must not block the later whole-class promotion of 7A, so the
-- history rows now record their origin.
ALTER TABLE public.student_promotions
  ADD COLUMN IF NOT EXISTS source TEXT NOT NULL DEFAULT 'promotion'
  CHECK (source IN ('promotion', 'class_import'));

CREATE OR REPLACE FUNCTION public.promote_students(
  from_class TEXT,
  to_class TEXT,
  academic_year_id TEXT DEFAULT NULL
)
RETURNS TABLE(promoted_id TEXT, student_name TEXT, old_class TEXT, new_class TEXT)
LANGUAGE plpgsql
AS $$
BEGIN
  -- Prevent re-promoting a class that has already been promoted this
  -- academic year. Rows created by the class-import flow (source =
  -- 'class_import') are individual mid-year moves and do NOT count.
  IF EXISTS (
    SELECT 1 FROM student_promotions
    WHERE "fromClass" = from_class
      AND "academicYearId" = academic_year_id
      AND source = 'promotion'
  ) THEN
    RAISE EXCEPTION 'Class "%" has already been promoted this academic year', from_class;
  END IF;

  RETURN QUERY
  WITH updated AS (
    UPDATE students
    SET "className" = to_class
    WHERE "className" = from_class
    RETURNING id, name, from_class AS old_class, to_class AS new_class
  )
  INSERT INTO student_promotions (id, "studentId", "fromClass", "toClass", "academicYearId", source)
  SELECT
    'promo-' || floor(extract(epoch from now()) * 1000)::text || '-' || substr(md5(random()::text), 1, 6),
    updated.id,
    updated.old_class,
    updated.new_class,
    academic_year_id,
    'promotion'
  FROM updated
  RETURNING
    student_promotions."studentId",
    (SELECT name FROM students WHERE id = student_promotions."studentId"),
    student_promotions."fromClass",
    student_promotions."toClass";
END;
$$;

-- ─── 2. The atomic import commit ──────────────────────────────────────────
-- p_changes:      [{ "studentId": text, "toClass": text }]   (matched students)
-- p_new_students: [{ "id": text, "name": text, "className": text,
--                    "govId": text?, "parentPhone": text? }] (new enrollments)
--
-- Everything runs in the single transaction of the RPC call: if any row
-- fails validation nothing is applied (no partial imports).
CREATE OR REPLACE FUNCTION public.apply_student_class_import(
  p_changes JSONB,
  p_new_students JSONB DEFAULT '[]'::JSONB,
  p_academic_year_id TEXT DEFAULT NULL,
  p_import_ref TEXT DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_role TEXT := public.current_profile_role();
  v_import_ref TEXT := COALESCE(NULLIF(trim(p_import_ref), ''),
                                'class-import-' || floor(extract(epoch from now()) * 1000)::text);
  v_changes JSONB := COALESCE(p_changes, '[]'::jsonb);
  v_new JSONB := COALESCE(p_new_students, '[]'::jsonb);
  v_known_classes TEXT[];
  v_change JSONB;
  v_new_student JSONB;
  v_student RECORD;
  v_id TEXT;
  v_name TEXT;
  v_class TEXT;
  v_seen_ids TEXT[] := ARRAY[]::TEXT[];
  v_updated INT := 0;
  v_skipped INT := 0;
  v_created INT := 0;
  v_applied_changes JSONB := '[]'::jsonb;
  v_created_students JSONB := '[]'::jsonb;
BEGIN
  -- Authorization: admin only. This is the enforcement point — the client
  -- check (menu/route) is convenience, never the control.
  IF v_role IS NULL OR v_role <> 'admin' THEN
    RAISE EXCEPTION 'Only admins may apply a student class import.'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  IF jsonb_typeof(v_changes) <> 'array' OR jsonb_typeof(v_new) <> 'array' THEN
    RAISE EXCEPTION 'Import payload must be JSON arrays.'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  -- Authoritative class/section data: classes that exist in the app are the
  -- ones with subject assignments or enrolled students (plus 'Graduated',
  -- which the promotion flow uses). Unknown classes are rejected, never
  -- invented or silently converted.
  SELECT COALESCE(array_agg(DISTINCT c), ARRAY[]::TEXT[]) INTO v_known_classes
  FROM (
    SELECT "className" AS c FROM public.class_subjects WHERE "className" IS NOT NULL
    UNION
    SELECT "className" AS c FROM public.students WHERE "className" IS NOT NULL
    UNION
    SELECT 'Graduated'::text AS c
  ) known;

  IF p_academic_year_id IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM public.academic_years WHERE id = p_academic_year_id) THEN
    RAISE EXCEPTION 'Academic year "%" does not exist.', p_academic_year_id
      USING ERRCODE = 'no_data_found';
  END IF;

  -- ── Class changes: update the CURRENT class only ────────────────────────
  FOR v_change IN SELECT * FROM jsonb_array_elements(v_changes)
  LOOP
    v_id := trim(COALESCE(v_change->>'studentId', ''));
    v_class := trim(COALESCE(v_change->>'toClass', ''));

    IF v_id = '' THEN
      RAISE EXCEPTION 'A class change is missing its student ID.'
        USING ERRCODE = 'invalid_parameter_value';
    END IF;
    IF v_id = ANY (v_seen_ids) THEN
      RAISE EXCEPTION 'Student "%" appears more than once in the import.', v_id
        USING ERRCODE = 'unique_violation';
    END IF;
    v_seen_ids := array_append(v_seen_ids, v_id);

    IF v_class = '' THEN
      RAISE EXCEPTION 'Class is required for student "%".', v_id
        USING ERRCODE = 'invalid_parameter_value';
    END IF;
    IF NOT (v_class = ANY (v_known_classes)) THEN
      RAISE EXCEPTION 'Class "%" does not exist.', v_class
        USING ERRCODE = 'no_data_found';
    END IF;

    SELECT id, name, "className" INTO v_student
    FROM public.students WHERE id = v_id FOR UPDATE;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'Student ID "%" does not exist.', v_id
        USING ERRCODE = 'no_data_found';
    END IF;

    IF v_student."className" = v_class THEN
      -- Already in the target class: idempotent no-op, not an error.
      v_skipped := v_skipped + 1;
      CONTINUE;
    END IF;

    -- The ONLY mutation to existing students: their current class.
    -- exams / attendance / reports / family links are untouched, so all
    -- historical records stay connected to the same student.
    UPDATE public.students SET "className" = v_class WHERE id = v_id;

    INSERT INTO public.student_promotions
      (id, "studentId", "fromClass", "toClass", "academicYearId", source)
    VALUES (
      'clsimp-' || floor(extract(epoch from now()) * 1000)::text || '-' || substr(md5(random()::text || v_id), 1, 8),
      v_id,
      v_student."className",
      v_class,
      p_academic_year_id,
      'class_import'
    );

    INSERT INTO public.audit_logs (action, details, "createdAt")
    VALUES (
      'students.class_change',
      jsonb_build_object(
        'importRef', v_import_ref,
        'studentId', v_id,
        'studentName', v_student.name,
        'fromClass', v_student."className",
        'toClass', v_class,
        'academicYearId', p_academic_year_id,
        'actor', public.current_profile_id()
      ),
      NOW()
    );

    v_updated := v_updated + 1;
    v_applied_changes := v_applied_changes || jsonb_build_array(jsonb_build_object(
      'studentId', v_id,
      'name', v_student.name,
      'fromClass', v_student."className",
      'toClass', v_class
    ));
  END LOOP;

  -- ── New students ─────────────────────────────────────────────────────────
  FOR v_new_student IN SELECT * FROM jsonb_array_elements(v_new)
  LOOP
    v_id := trim(COALESCE(v_new_student->>'id', ''));
    v_name := trim(COALESCE(v_new_student->>'name', ''));
    v_class := trim(COALESCE(v_new_student->>'className', ''));

    IF v_id = '' THEN
      RAISE EXCEPTION 'A new student row is missing its student ID.'
        USING ERRCODE = 'invalid_parameter_value';
    END IF;
    IF v_id = ANY (v_seen_ids) THEN
      RAISE EXCEPTION 'Student ID "%" appears more than once in the import.', v_id
        USING ERRCODE = 'unique_violation';
    END IF;
    IF EXISTS (SELECT 1 FROM public.students WHERE id = v_id) THEN
      RAISE EXCEPTION 'Student ID "%" already exists — a duplicate student was not created.', v_id
        USING ERRCODE = 'unique_violation';
    END IF;
    IF v_name = '' THEN
      RAISE EXCEPTION 'Student name is required for a new student.'
        USING ERRCODE = 'invalid_parameter_value';
    END IF;
    IF v_class = '' OR NOT (v_class = ANY (v_known_classes)) THEN
      RAISE EXCEPTION 'Class "%" does not exist.', v_class
        USING ERRCODE = 'no_data_found';
    END IF;

    v_seen_ids := array_append(v_seen_ids, v_id);

    INSERT INTO public.students (id, name, "className", "govId", "parentPhone", "createdAt")
    VALUES (
      v_id,
      v_name,
      v_class,
      NULLIF(trim(COALESCE(v_new_student->>'govId', '')), ''),
      NULLIF(trim(COALESCE(v_new_student->>'parentPhone', '')), ''),
      NOW()
    );

    v_created := v_created + 1;
    v_created_students := v_created_students || jsonb_build_array(jsonb_build_object(
      'studentId', v_id,
      'name', v_name,
      'className', v_class
    ));
  END LOOP;

  -- ── Summary audit row: who imported, when, and how much ─────────────────
  INSERT INTO public.audit_logs (action, details, "createdAt")
  VALUES (
    'students.class_import',
    jsonb_build_object(
      'importRef', v_import_ref,
      'actor', public.current_profile_id(),
      'academicYearId', p_academic_year_id,
      'classChanges', v_updated,
      'unchangedSkipped', v_skipped,
      'newStudents', v_created,
      'changes', v_applied_changes,
      'created', v_created_students
    ),
    NOW()
  );

  RETURN jsonb_build_object(
    'importRef', v_import_ref,
    'updatedCount', v_updated,
    'createdCount', v_created,
    'skippedCount', v_skipped,
    'changes', v_applied_changes,
    'created', v_created_students
  );
END;
$$;

-- ─── Grants ────────────────────────────────────────────────────────────────
REVOKE ALL ON FUNCTION public.apply_student_class_import(JSONB, JSONB, TEXT, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.apply_student_class_import(JSONB, JSONB, TEXT, TEXT) TO authenticated;
