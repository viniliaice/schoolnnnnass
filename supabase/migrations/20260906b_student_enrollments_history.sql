-- ============================================================================
-- Migration 20260906b — Student enrollment history (historical class model)
-- ============================================================================
-- Problem this solves: students."className" is the CURRENT class. Historical
-- report peer groups (midterm/final/class-progress) were derived from the
-- current className, so a mid-term transfer retroactively recomputed already
-- issued class ranks/averages. Grades/attendance rows themselves are correct
-- (they reference studentId) — only the *class context used for comparison*
-- was wrong.
--
-- Model (minimal, additive): a thin append-only enrollment ledger. students
-- ."className" stays the authoritative CURRENT class (zero churn for the many
-- current-state reads). student_enrollments records, per student, the class
-- over an effective date range. The class a student was in during a past term
-- is resolved at report time from this ledger.
--
-- This migration:
--   1. creates student_enrollments (+ constraints/indexes/RLS)
--   2. idempotently backfills history from students + student_promotions
--   3. provides SECURITY DEFINER helpers to record moves and resolve class
--   4. repoints get_midterm_report to the historical class (SECURITY DEFINER)
-- It does NOT rewrite any exam/attendance/homework row.

-- ─── 1. Enrollment ledger ──────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.student_enrollments (
  id TEXT PRIMARY KEY,
  "studentId" TEXT NOT NULL REFERENCES public.students(id) ON DELETE CASCADE,
  "className" TEXT NOT NULL,
  "academicYearId" TEXT REFERENCES public.academic_years(id) ON DELETE SET NULL,
  "termId" TEXT REFERENCES public.terms(id) ON DELETE SET NULL,
  "effectiveFrom" DATE NOT NULL,
  "effectiveTo" DATE,
  reason TEXT NOT NULL DEFAULT 'backfill'
    CHECK (reason IN ('backfill','promotion','import','transfer','correction','manual')),
  "sourceRef" TEXT,
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK ("effectiveTo" IS NULL OR "effectiveTo" >= "effectiveFrom")
);

-- At most ONE open enrollment per student.
CREATE UNIQUE INDEX IF NOT EXISTS uniq_student_enrollments_open
  ON public.student_enrollments ("studentId")
  WHERE "effectiveTo" IS NULL;
-- Lookup a student's ranges for a term/date.
CREATE INDEX IF NOT EXISTS idx_student_enrollments_student_dates
  ON public.student_enrollments ("studentId", "effectiveFrom", "effectiveTo");
-- Lookup all students in a class during a period.
CREATE INDEX IF NOT EXISTS idx_student_enrollments_class
  ON public.student_enrollments ("className", "effectiveFrom", "effectiveTo");

ALTER TABLE public.student_enrollments ENABLE ROW LEVEL SECURITY;
-- No client write policies: enrollments are written only through SECURITY
-- DEFINER RPCs. Read: staff (full), teachers (assigned), parents (children).
DROP POLICY IF EXISTS "enrollments_staff_read" ON public.student_enrollments;
CREATE POLICY "enrollments_staff_read" ON public.student_enrollments
  FOR SELECT TO authenticated
  USING (public.current_profile_role() IN ('admin','supervisor','office'));
DROP POLICY IF EXISTS "enrollments_teacher_read" ON public.student_enrollments;
CREATE POLICY "enrollments_teacher_read" ON public.student_enrollments
  FOR SELECT TO authenticated
  USING (
    public.current_profile_role() = 'teacher'
    AND public.student_enrollments."className" IN (
      SELECT cs."className" FROM public.class_subjects cs
       WHERE cs."teacherId" = public.current_profile_id()
    )
  );
DROP POLICY IF EXISTS "enrollments_parent_read" ON public.student_enrollments;
CREATE POLICY "enrollments_parent_read" ON public.student_enrollments
  FOR SELECT TO authenticated
  USING (
    public.current_profile_role() = 'parent'
    AND public.student_enrollments."studentId" IN (
      SELECT s.id FROM public.students s WHERE s."parentId" = public.current_profile_id()
    )
  );

-- ─── 2. Helper: resolve the class a student was in for a given term ────────
-- Used by historical reports. SECURITY DEFINER because reports must resolve
-- peer classes regardless of the calling parent's student-level RLS.
CREATE OR REPLACE FUNCTION public.class_students_for_term(
  p_class_name TEXT,
  p_term_id TEXT
) RETURNS TABLE (student_id TEXT)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  WITH term AS (
    SELECT t."startDate" AS sd, t."endDate" AS ed
    FROM public.terms t WHERE t.id = p_term_id
  ),
  placed AS (
    SELECT DISTINCT e."studentId" AS sid
    FROM public.student_enrollments e, term t
    WHERE e."className" = p_class_name
      AND e."effectiveFrom" <= t.ed
      AND COALESCE(e."effectiveTo", DATE '9999-12-31') >= t.sd
  )
  SELECT sid FROM placed
  UNION
  -- Safety fallback for students whose history could not be reconstructed
  -- (no enrollment overlaps the term): behave like the legacy query and use
  -- their current class, so a report never renders empty after backfill gaps.
  SELECT s.id
  FROM public.students s, term t
  WHERE s."className" = p_class_name
    AND NOT EXISTS (
      SELECT 1 FROM public.student_enrollments e
       WHERE e."studentId" = s.id
         AND e."effectiveFrom" <= t.ed
         AND COALESCE(e."effectiveTo", DATE '9999-12-31') >= t.sd
    );
$$;

-- The class of ONE student during a term (fallback: current class).
CREATE OR REPLACE FUNCTION public.class_for_term(p_student_id TEXT, p_term_id TEXT)
RETURNS TEXT LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT COALESCE(
    (SELECT e."className"
       FROM public.student_enrollments e
       JOIN public.terms t ON t.id = p_term_id
      WHERE e."studentId" = p_student_id
        AND e."effectiveFrom" <= t."endDate"
        AND COALESCE(e."effectiveTo", DATE '9999-12-31') >= t."startDate"
      ORDER BY e."effectiveFrom" DESC
      LIMIT 1),
    (SELECT s."className" FROM public.students s WHERE s.id = p_student_id)
  );
$$;

-- ─── 3. Helper: record a class assignment / move in the enrollment ledger ──
-- Called by promote_students, the class import, and student admin RPCs.
-- Idempotent: if the student's open enrollment already has this class, no-op.
-- Moves are effective on p_effective_from (default today). The previously open
-- enrollment is closed at effective_from - 1. students."className" itself is
-- updated by the caller (this function only maintains the ledger).
CREATE OR REPLACE FUNCTION public.record_class_assignment(
  p_student_id TEXT,
  p_new_class TEXT,
  p_reason TEXT,
  p_effective_from DATE DEFAULT NULL,
  p_academic_year_id TEXT DEFAULT NULL,
  p_term_id TEXT DEFAULT NULL,
  p_source_ref TEXT DEFAULT NULL
) RETURNS VOID
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_from DATE := COALESCE(p_effective_from, CURRENT_DATE);
  v_open_class TEXT;
  v_open_from DATE;
BEGIN
  IF p_student_id IS NULL OR p_new_class IS NULL OR btrim(p_new_class) = '' THEN
    RAISE EXCEPTION 'record_class_assignment: student and class are required.'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.students WHERE id = p_student_id) THEN
    RAISE EXCEPTION 'Student % does not exist.', p_student_id USING ERRCODE = 'no_data_found';
  END IF;

  SELECT "className", "effectiveFrom" INTO v_open_class, v_open_from
  FROM public.student_enrollments
  WHERE "studentId" = p_student_id AND "effectiveTo" IS NULL
  LIMIT 1;

  IF v_open_class = p_new_class THEN
    RETURN; -- already in this class; idempotent
  END IF;

  IF v_open_class IS NOT NULL THEN
    -- Close the previous range up to the day before the move (never future-date).
    UPDATE public.student_enrollments
       SET "effectiveTo" = LEAST(v_from - 1, CURRENT_DATE)
     WHERE "studentId" = p_student_id AND "effectiveTo" IS NULL;
  END IF;

  INSERT INTO public.student_enrollments
    (id, "studentId", "className", "academicYearId", "termId", "effectiveFrom", "effectiveTo", reason, "sourceRef")
  VALUES (
    'enr-' || floor(extract(epoch FROM clock_timestamp())*1000)::text || '-' || substr(md5(random()::text || p_student_id),1,8),
    p_student_id, p_new_class,
    CASE WHEN p_academic_year_id IS NOT NULL AND EXISTS (SELECT 1 FROM public.academic_years WHERE id = p_academic_year_id)
         THEN p_academic_year_id ELSE NULL END,
    CASE WHEN p_term_id IS NOT NULL AND EXISTS (SELECT 1 FROM public.terms WHERE id = p_term_id)
         THEN p_term_id ELSE NULL END,
    GREATEST(v_from, COALESCE(v_open_from, DATE '2000-01-01')),
    NULL, COALESCE(p_reason,'manual'), p_source_ref
  );
END;
$$;

-- ─── 4. Idempotent backfill ────────────────────────────────────────────────
-- Current-state open enrollment for every student (only if none exists).
INSERT INTO public.student_enrollments
  (id, "studentId", "className", "academicYearId", "effectiveFrom", "effectiveTo", reason)
SELECT
  'enr-open-' || s.id,
  s.id,
  s."className",
  (SELECT ay.id FROM public.academic_years ay WHERE ay."isCurrent" = true ORDER BY ay."startDate" DESC LIMIT 1),
  COALESCE((SELECT ay."startDate" FROM public.academic_years ay WHERE ay."isCurrent" = true ORDER BY ay."startDate" DESC LIMIT 1), DATE '2000-01-01'),
  NULL,
  'backfill'
FROM public.students s
WHERE NOT EXISTS (
  SELECT 1 FROM public.student_enrollments e
   WHERE e."studentId" = s.id AND e."effectiveTo" IS NULL
);

-- Closed intervals from promotions: a non-latest promotion's TO-class was the
-- student's class from that promotion until the next promotion.
WITH ranked AS (
  SELECT p."studentId", p."toClass", p."academicYearId", p."createdAt", p.source,
         LEAD(p."createdAt") OVER (PARTITION BY p."studentId" ORDER BY p."createdAt", p.id) AS next_at
  FROM public.student_promotions p
  WHERE p."toClass" IS NOT NULL
)
INSERT INTO public.student_enrollments
  (id, "studentId", "className", "academicYearId", "effectiveFrom", "effectiveTo", reason, "sourceRef")
SELECT
  'enr-promo-' || r."studentId" || '-' || to_char(r."createdAt",'YYYYMMDDHH24MISS'),
  r."studentId", r."toClass", r."academicYearId",
  date_trunc('day', r."createdAt")::date,
  (date_trunc('day', r.next_at)::date - 1),
  CASE WHEN r.source = 'class_import' THEN 'import' ELSE 'promotion' END,
  'backfill-promotion'
FROM ranked r
WHERE r.next_at IS NOT NULL
  AND date_trunc('day', r.next_at)::date > date_trunc('day', r."createdAt")::date
  AND NOT EXISTS (
    SELECT 1 FROM public.student_enrollments e
     WHERE e."studentId" = r."studentId" AND e."className" = r."toClass"
       AND e."effectiveFrom" = date_trunc('day', r."createdAt")::date
  );

-- Earliest known class (the FIRST promotion's FROM-class) for prior-year
-- reports. Start is the academic-year start; before that is unrecorded and
-- relies on the current-class fallback in class_students_for_term().
WITH first_promo AS (
  SELECT DISTINCT ON (p."studentId")
         p."studentId", p."fromClass", p."academicYearId", p."createdAt"
  FROM public.student_promotions p
  WHERE p."fromClass" IS NOT NULL
  ORDER BY p."studentId", p."createdAt", p.id
)
INSERT INTO public.student_enrollments
  (id, "studentId", "className", "academicYearId", "effectiveFrom", "effectiveTo", reason, "sourceRef")
SELECT
  'enr-first-' || fp."studentId",
  fp."studentId", fp."fromClass", fp."academicYearId",
  COALESCE((SELECT ay."startDate" FROM public.academic_years ay WHERE ay.id = fp."academicYearId"), DATE '2000-01-01'),
  date_trunc('day', fp."createdAt")::date - 1,
  'backfill',
  'backfill-first-promotion'
FROM first_promo fp
WHERE NOT EXISTS (
  SELECT 1 FROM public.student_enrollments e
   WHERE e."studentId" = fp."studentId" AND e."className" = fp."fromClass"
);

-- Mid-year transfer in the CURRENT year: if the latest promotion is within the
-- current academic year and its TO-class is the student's current class, scope
-- the open enrollment to the move date and add a closed FROM-class interval.
WITH latest AS (
  SELECT DISTINCT ON (p."studentId")
         p."studentId", p."fromClass", p."toClass", p."academicYearId", p."createdAt"
  FROM public.student_promotions p
  ORDER BY p."studentId", p."createdAt" DESC, p.id DESC
), cur_year AS (
  SELECT id, "startDate" FROM public.academic_years WHERE "isCurrent" = true ORDER BY "startDate" DESC LIMIT 1
)
UPDATE public.student_enrollments e
   SET "effectiveFrom" = GREATEST(date_trunc('day', l."createdAt")::date, cy."startDate")
  FROM latest l, cur_year cy
 WHERE e."studentId" = l."studentId"
   AND e."effectiveTo" IS NULL
   AND e."className" = l."toClass"
   AND l."fromClass" IS NOT NULL
   AND l."fromClass" <> l."toClass"
   AND date_trunc('day', l."createdAt")::date >= cy."startDate"
   AND NOT EXISTS (
     SELECT 1 FROM public.student_enrollments x
      WHERE x."studentId" = l."studentId" AND x."className" = l."fromClass"
   );
WITH latest AS (
  SELECT DISTINCT ON (p."studentId")
         p."studentId", p."fromClass", p."toClass", p."academicYearId", p."createdAt"
  FROM public.student_promotions p
  ORDER BY p."studentId", p."createdAt" DESC, p.id DESC
), cur_year AS (
  SELECT id, "startDate" FROM public.academic_years WHERE "isCurrent" = true ORDER BY "startDate" DESC LIMIT 1
)
INSERT INTO public.student_enrollments
  (id, "studentId", "className", "academicYearId", "effectiveFrom", "effectiveTo", reason, "sourceRef")
SELECT
  'enr-midyear-' || l."studentId",
  l."studentId", l."fromClass", l."academicYearId",
  cy."startDate",
  date_trunc('day', l."createdAt")::date - 1,
  'transfer', 'backfill-midyear'
FROM latest l, cur_year cy
WHERE l."fromClass" IS NOT NULL AND l."fromClass" <> l."toClass"
  AND date_trunc('day', l."createdAt")::date >= cy."startDate"
  AND NOT EXISTS (
    SELECT 1 FROM public.student_enrollments x
     WHERE x."studentId" = l."studentId" AND x."className" = l."fromClass"
  );

-- ─── 5. Repoint get_midterm_report to historical class (SECURITY DEFINER) ──
CREATE OR REPLACE FUNCTION public.get_midterm_report(
  p_student_id TEXT,
  p_term_id TEXT
) RETURNS JSONB
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_class TEXT;
BEGIN
  v_class := public.class_for_term(p_student_id, p_term_id);

  RETURN (
  WITH class_midterms AS (
    SELECT e.id, e."studentId" AS student_id, e.subject, e.score, e.total,
      CASE WHEN e.total > 0 THEN round((e.score::numeric / e.total::numeric) * 100)::INT ELSE 0 END AS percentage
    FROM public.exams e
    WHERE e."termId" = p_term_id AND e."examType" = 'Midterm'
      AND e.status = 'approved' AND e."entryState" = 'scored'
      AND e."studentId" IN (SELECT student_id FROM public.class_students_for_term(v_class, p_term_id))
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
  )
  SELECT jsonb_build_object(
    'scores', coalesce((SELECT jsonb_agg(jsonb_build_object(
      'subject', ss.subject, 'score', ss.score, 'total', ss.total, 'percentage', ss.percentage,
      'grade', ss.grade, 'remark', ss.remark, 'subject_rank', ss.subject_rank,
      'class_average', ss.class_average, 'highest_in_class', ss.highest_in_class, 'examId', ss.exam_id
    ) ORDER BY ss.subject) FROM subject_scores ss), '[]'::jsonb),
    'overall_rank', coalesce((SELECT count(*) + 1 FROM student_averages sa, student_averages ta WHERE ta.student_id = p_student_id AND sa.average_percentage > ta.average_percentage), 0),
    'total_students', (SELECT count(*) FROM student_averages)
  ));
END;
$$;

REVOKE ALL ON FUNCTION public.class_students_for_term(TEXT, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.class_students_for_term(TEXT, TEXT) TO authenticated;
REVOKE ALL ON FUNCTION public.class_for_term(TEXT, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.class_for_term(TEXT, TEXT) TO authenticated;
REVOKE ALL ON FUNCTION public.record_class_assignment(TEXT,TEXT,TEXT,DATE,TEXT,TEXT,TEXT) FROM PUBLIC;
-- record_class_assignment is invoked only by other SECURITY DEFINER RPCs; no
-- direct grant to authenticated (definer functions run as owner anyway).
