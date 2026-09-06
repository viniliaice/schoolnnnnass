-- ============================================================================
-- Migration 20260906d — RLS lockdown.
-- ============================================================================
-- Depends on 20260906b (enrollments) and 20260906c (admin write RPCs) AND on
-- the matching client release that routes every student/class-subject write
-- through the new SECURITY DEFINER RPCs. This REMOVES the historic permissive
-- "Allow all operations" policy so no authenticated user can write students
-- directly; teacher daily-entry tables get teacher-scoped policies.
-- The protected row's columns are fully qualified as public.<table>.<column>
-- (the same convention the exams policies use) so subqueries never bind a
-- bare column to the wrong table. Idempotent.

-- ─── students: SELECT-only for clients; all writes via admin RPCs ──────────
ALTER TABLE public.students ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Allow all operations on students" ON public.students;

DROP POLICY IF EXISTS "students_admin_supervisor_office_read" ON public.students;
CREATE POLICY "students_admin_supervisor_office_read" ON public.students
  FOR SELECT TO authenticated
  USING (public.current_profile_role() IN ('admin','supervisor','office'));

DROP POLICY IF EXISTS "students_teacher_read" ON public.students;
CREATE POLICY "students_teacher_read" ON public.students
  FOR SELECT TO authenticated
  USING (
    public.current_profile_role() = 'teacher' AND (
      public.students."className" IN (
        SELECT cs."className" FROM public.class_subjects cs
         WHERE cs."teacherId" = public.current_profile_id()
      )
      OR public.students."className" IN (
        SELECT jsonb_array_elements_text(COALESCE(
          (SELECT p."assignedClasses" FROM public.profiles p WHERE p.id = public.current_profile_id()),
          '[]'::jsonb))
      )
    )
  );

DROP POLICY IF EXISTS "students_parent_read" ON public.students;
CREATE POLICY "students_parent_read" ON public.students
  FOR SELECT TO authenticated
  USING (
    public.current_profile_role() = 'parent' AND (
      public.students."parentId" = public.current_profile_id()
      OR public.normalize_phone(public.students."parentPhone") IN (
        SELECT x.phone FROM (
          SELECT COALESCE(NULLIF(public.normalize_phone(p.phone1),''),
                          NULLIF(public.normalize_phone(p.phone2),'')) AS phone
          FROM public.profiles p WHERE p.id = public.current_profile_id()
        ) x WHERE x.phone <> ''
      )
    )
  );
-- Intentionally NO INSERT / UPDATE / DELETE policy on students: mutations go
-- through admin SECURITY DEFINER RPCs (20260906c).

-- ─── student_promotions: staff read; writes only via SECURITY DEFINER RPCs ─
ALTER TABLE public.student_promotions ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "promotions_staff_read" ON public.student_promotions;
CREATE POLICY "promotions_staff_read" ON public.student_promotions
  FOR SELECT TO authenticated
  USING (public.current_profile_role() IN ('admin','supervisor','office','teacher'));

-- ─── attendance ────────────────────────────────────────────────────────────
ALTER TABLE public.attendance ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "attendance_staff_read" ON public.attendance;
CREATE POLICY "attendance_staff_read" ON public.attendance
  FOR SELECT TO authenticated
  USING (public.current_profile_role() IN ('admin','supervisor','office'));
DROP POLICY IF EXISTS "attendance_teacher_read" ON public.attendance;
CREATE POLICY "attendance_teacher_read" ON public.attendance
  FOR SELECT TO authenticated
  USING (public.current_profile_role() = 'teacher'
         AND public.attendance."className" IN (
           SELECT cs."className" FROM public.class_subjects cs
            WHERE cs."teacherId" = public.current_profile_id()));
DROP POLICY IF EXISTS "attendance_parent_read" ON public.attendance;
CREATE POLICY "attendance_parent_read" ON public.attendance
  FOR SELECT TO authenticated
  USING (public.current_profile_role() = 'parent'
         AND public.attendance."studentId" IN (
           SELECT s.id FROM public.students s WHERE s."parentId" = public.current_profile_id()));
DROP POLICY IF EXISTS "attendance_teacher_write" ON public.attendance;
CREATE POLICY "attendance_teacher_write" ON public.attendance
  FOR ALL TO authenticated
  USING (public.current_profile_role() IN ('admin','teacher')
         AND public.attendance."teacherId" = public.current_profile_id())
  WITH CHECK (public.current_profile_role() IN ('admin','teacher')
         AND public.attendance."teacherId" = public.current_profile_id()
         AND EXISTS (SELECT 1 FROM public.class_subjects cs
                      WHERE cs."className" = public.attendance."className"
                        AND cs."teacherId" = public.current_profile_id()));

-- ─── homework ──────────────────────────────────────────────────────────────
ALTER TABLE public.homework ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "homework_staff_read" ON public.homework;
CREATE POLICY "homework_staff_read" ON public.homework
  FOR SELECT TO authenticated
  USING (public.current_profile_role() IN ('admin','supervisor','office'));
DROP POLICY IF EXISTS "homework_teacher_read" ON public.homework;
CREATE POLICY "homework_teacher_read" ON public.homework
  FOR SELECT TO authenticated
  USING (public.current_profile_role() = 'teacher'
         AND (public.homework."teacherId" = public.current_profile_id()
              OR public.homework."className" IN (
                SELECT cs."className" FROM public.class_subjects cs
                 WHERE cs."teacherId" = public.current_profile_id())));
DROP POLICY IF EXISTS "homework_parent_read" ON public.homework;
CREATE POLICY "homework_parent_read" ON public.homework
  FOR SELECT TO authenticated
  USING (public.current_profile_role() = 'parent'
         AND public.homework."studentId" IN (
           SELECT s.id FROM public.students s WHERE s."parentId" = public.current_profile_id()));
DROP POLICY IF EXISTS "homework_teacher_write" ON public.homework;
CREATE POLICY "homework_teacher_write" ON public.homework
  FOR ALL TO authenticated
  USING (public.current_profile_role() IN ('admin','teacher')
         AND public.homework."teacherId" = public.current_profile_id())
  WITH CHECK (public.current_profile_role() IN ('admin','teacher')
         AND public.homework."teacherId" = public.current_profile_id());

-- ─── quizzes ───────────────────────────────────────────────────────────────
ALTER TABLE public.quizzes ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "quizzes_staff_read" ON public.quizzes;
CREATE POLICY "quizzes_staff_read" ON public.quizzes
  FOR SELECT TO authenticated
  USING (public.current_profile_role() IN ('admin','supervisor','office'));
DROP POLICY IF EXISTS "quizzes_teacher_read" ON public.quizzes;
CREATE POLICY "quizzes_teacher_read" ON public.quizzes
  FOR SELECT TO authenticated
  USING (public.current_profile_role() = 'teacher'
         AND (public.quizzes."teacherId" = public.current_profile_id()
              OR public.quizzes."className" IN (
                SELECT cs."className" FROM public.class_subjects cs
                 WHERE cs."teacherId" = public.current_profile_id())));
DROP POLICY IF EXISTS "quizzes_parent_read" ON public.quizzes;
CREATE POLICY "quizzes_parent_read" ON public.quizzes
  FOR SELECT TO authenticated
  USING (public.current_profile_role() = 'parent'
         AND public.quizzes."className" IN (
           SELECT s."className" FROM public.students s
            WHERE s."parentId" = public.current_profile_id()));
DROP POLICY IF EXISTS "quizzes_teacher_write" ON public.quizzes;
CREATE POLICY "quizzes_teacher_write" ON public.quizzes
  FOR ALL TO authenticated
  USING (public.current_profile_role() IN ('admin','teacher')
         AND public.quizzes."teacherId" = public.current_profile_id())
  WITH CHECK (public.current_profile_role() IN ('admin','teacher')
         AND public.quizzes."teacherId" = public.current_profile_id());

-- ─── quiz_attempts ─────────────────────────────────────────────────────────
ALTER TABLE public.quiz_attempts ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "quiz_attempts_staff" ON public.quiz_attempts;
CREATE POLICY "quiz_attempts_staff" ON public.quiz_attempts
  FOR SELECT TO authenticated
  USING (public.current_profile_role() IN ('admin','supervisor','office','teacher'));
DROP POLICY IF EXISTS "quiz_attempts_parent" ON public.quiz_attempts;
CREATE POLICY "quiz_attempts_parent" ON public.quiz_attempts
  FOR ALL TO authenticated
  USING (public.current_profile_role() = 'parent'
         AND public.quiz_attempts."studentId" IN (
           SELECT s.id FROM public.students s WHERE s."parentId" = public.current_profile_id()))
  WITH CHECK (public.current_profile_role() = 'parent'
         AND public.quiz_attempts."studentId" IN (
           SELECT s.id FROM public.students s WHERE s."parentId" = public.current_profile_id()));
