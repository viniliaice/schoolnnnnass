-- READ ONLY. Re-run on the authorised target immediately before deployment.
-- No function/RPC calls that write metadata or marks.
SELECT current_setting('server_version') AS postgres_version;
SELECT column_name, data_type, is_nullable
FROM information_schema.columns WHERE table_schema='public' AND table_name='exams'
ORDER BY ordinal_position;
SELECT conname, pg_get_constraintdef(oid) AS definition
FROM pg_constraint WHERE conrelid='public.exams'::regclass;
SELECT indexname,indexdef FROM pg_indexes WHERE schemaname='public' AND tablename='exams';
SELECT pg_get_triggerdef(oid) AS definition FROM pg_trigger
WHERE tgrelid='public.exams'::regclass AND NOT tgisinternal;
-- Expected: no rows for fully classified monthly identities.
SELECT "studentId","subjectId","examType","assessmentLabel","termId",month,count(*)
FROM public.exams
WHERE "subjectId" IS NOT NULL AND "termId" IS NOT NULL AND "assessmentLabel" IS NOT NULL
GROUP BY 1,2,3,4,5,6 HAVING count(*)>1;
-- Expected: no rows for the new term-wide uniqueness rule (NULL labels included).
SELECT "studentId","subjectId","examType","assessmentLabel","termId",count(*)
FROM public.exams WHERE "examType" IN ('Midterm','Final')
GROUP BY 1,2,3,4,5 HAVING count(*)>1;
SELECT month,count(*) FROM public.exams
WHERE month IS NULL OR month NOT IN ('January','February','March','April','May','June','July','August','September','October','November','December')
GROUP BY month;
SELECT id,"academicYearId","startDate","endDate" FROM public.terms
WHERE "academicYearId" IS NULL OR "startDate" IS NULL OR "endDate" IS NULL
   OR "endDate"<"startDate" OR "endDate">="startDate" + interval '1 year';
-- Review only: legacy unlabeled assessments must NOT be inferred or deduplicated.
SELECT "examType",count(*) AS unlabeled_records FROM public.exams
WHERE "assessmentLabel" IS NULL GROUP BY 1;
SELECT "examType",count(*) AS ambiguous_groups,sum(n) AS records_in_groups
FROM (SELECT "studentId","subjectId","examType","assessmentLabel","termId",month,count(*) n
      FROM public.exams WHERE "assessmentLabel" IS NULL
      GROUP BY 1,2,3,4,5,6 HAVING count(*)>1) d GROUP BY 1;
-- Export these definitions and privileges with a schema backup before applying.
SELECT p.oid::regprocedure AS function_signature, pg_get_functiondef(p.oid) AS definition,
       p.proacl AS privileges
FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
WHERE n.nspname='public' AND p.prokind='f' AND p.proname IN
('submit_bulk_grades','enforce_exam_status_guard','admin_correct_grade',
 'merge_duplicate_student','merge_duplicate_students','merge_duplicate_students_resolved',
 'preview_student_merge','get_merge_conflicts','_safe_batch_evaluate_pair',
 'get_class_student_subject_progress','get_monthly_report','monitor_marks_entries');
SELECT pg_get_viewdef('public.teacher_exam_progress'::regclass,true) AS progress_view;
