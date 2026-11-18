-- READ ONLY. Run this whole file BEFORE the migration and save all results;
-- then run again immediately AFTER COMMIT while assessment writes remain paused,
-- BEFORE any uploads, corrections or approvals. Compare fingerprints exactly.
-- No exam names/parent details are returned. IDs in group displays are hashed.
-- There is deliberately no INSERT, UPDATE, DELETE, merge RPC or migration here.
BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY;

-- 1. Inventory: old index before, two new indexes afterwards.
SELECT current_database(),current_setting('server_version') AS server_version;
SELECT indexname,indexdef FROM pg_indexes
WHERE schemaname='public' AND tablename='exams' ORDER BY indexname;
SELECT c.relname,i.indisunique,i.indisvalid,i.indisready,i.indnullsnotdistinct,
 pg_get_expr(i.indpred,i.indrelid) AS predicate
FROM pg_index i JOIN pg_class c ON c.oid=i.indexrelid
WHERE i.indrelid='public.exams'::regclass ORDER BY c.relname;
SELECT conname,convalidated,pg_get_constraintdef(oid) AS definition
FROM pg_constraint WHERE conrelid='public.exams'::regclass ORDER BY conname;
SELECT tgname,tgenabled,pg_get_triggerdef(oid) AS definition FROM pg_trigger
WHERE tgrelid IN ('public.exams'::regclass,'public.terms'::regclass)
AND NOT tgisinternal ORDER BY tgname;

-- 2. Exact integrity manifests. Expected no change across migration itself.
WITH rows AS (
 SELECT e.id,to_jsonb(e) row_image,e."assessmentLabel" label,e."examType" kind FROM public.exams e
), scopes AS (
 SELECT 'all_exams'::text scope,id,row_image FROM rows
 UNION ALL SELECT 'labelled',id,row_image FROM rows WHERE label IS NOT NULL
 UNION ALL SELECT 'unlabelled',id,row_image FROM rows WHERE label IS NULL
 UNION ALL SELECT 'Midterm_Final',id,row_image FROM rows WHERE kind IN ('Midterm','Final')
)
SELECT scope,count(*) records,md5(COALESCE(string_agg(md5(row_image::text),'' ORDER BY id),'')) row_fingerprint
FROM scopes GROUP BY scope ORDER BY scope;
-- Reference only: 35820 exams / 32321 labelled / 3499 unlabelled at investigation.
-- Do not hardcode these as today's truth if legitimate live activity intervened.
WITH groups AS (
 SELECT "studentId","subjectId","examType","assessmentLabel","termId",month,
 count(*) n,md5(string_agg(md5(to_jsonb(e)::text),'' ORDER BY id)) group_rows
 FROM public.exams e WHERE "assessmentLabel" IS NULL
 GROUP BY 1,2,3,4,5,6 HAVING count(*)>1
)
SELECT count(*) ambiguous_groups,COALESCE(sum(n),0) group_rows,
 md5(COALESCE(string_agg(md5(to_jsonb(g)::text),'' ORDER BY to_jsonb(g)::text),'')) group_fingerprint
FROM groups g;
-- Reference: 331 groups / 667 rows. These must not be deduplicated or relabelled.
SELECT status,count(*) records,
 md5(string_agg(md5(to_jsonb(e)::text),'' ORDER BY id)) status_row_fingerprint
FROM public.exams e GROUP BY status ORDER BY status;
SELECT "termId",month,status,count(*) records FROM public.exams GROUP BY 1,2,3 ORDER BY 1,2,3;
SELECT count(*) exams,
 count(*) FILTER(WHERE s.id IS NULL) missing_students,
 count(*) FILTER(WHERE sub.id IS NULL) missing_subjects,
 count(*) FILTER(WHERE t.id IS NULL) missing_terms,
 md5(string_agg(md5(jsonb_build_array(e.id,e."studentId",e."subjectId",e."termId")::text),'' ORDER BY e.id)) relationship_fingerprint
FROM public.exams e LEFT JOIN public.students s ON s.id=e."studentId"
LEFT JOIN public.subjects sub ON sub.id=e."subjectId" LEFT JOIN public.terms t ON t.id=e."termId";

-- 3. These queries must return ZERO rows. NULL labels deliberately excluded
-- from monthly duplicate checks and deliberately INCLUDED for termwide checks.
SELECT md5("studentId") student_token,"subjectId","examType","assessmentLabel","termId",month,count(*) records
FROM public.exams WHERE "subjectId" IS NOT NULL AND "termId" IS NOT NULL AND "assessmentLabel" IS NOT NULL
GROUP BY "studentId","subjectId","examType","assessmentLabel","termId",month HAVING count(*)>1;
SELECT md5("studentId") student_token,"subjectId","examType","assessmentLabel","termId",count(*) records
FROM public.exams WHERE "examType" IN ('Midterm','Final')
GROUP BY "studentId","subjectId","examType","assessmentLabel","termId" HAVING count(*)>1;
SELECT month,count(*) FROM public.exams WHERE month IS NULL OR month NOT IN
('January','February','March','April','May','June','July','August','September','October','November','December') GROUP BY month;

-- 4. October/November coexistence (no names, no writes).
-- An empty result is NOT a failure before an authorised November upload exists.
SELECT md5("studentId") student_token,"subjectId","examType","assessmentLabel","termId",
 jsonb_agg(jsonb_build_object('rowToken',md5(id),'month',month,'score',score,'total',total,'status',status)
 ORDER BY month,id) independent_assessments
FROM public.exams WHERE month IN ('October','November') AND "assessmentLabel" IS NOT NULL
GROUP BY "studentId","subjectId","examType","assessmentLabel","termId"
HAVING count(DISTINCT month)=2 ORDER BY student_token,"subjectId","assessmentLabel";

-- Optional targeted view: replace the THREE empty strings with exact IDs from
-- your own authorised test record. Empty strings intentionally return no rows.
WITH chosen AS (SELECT ''::text student_id,''::text subject_id,''::text term_id)
SELECT md5(e.id) row_token,e.month,e."assessmentLabel",e.score,e.total,e."entryState",e.status,
 md5(to_jsonb(e)::text) full_row_fingerprint
FROM public.exams e CROSS JOIN chosen c
WHERE e."studentId"=c.student_id AND e."subjectId"=c.subject_id AND e."termId"=c.term_id
AND e.month IN ('October','November','December') ORDER BY e."assessmentLabel",e.month;

-- 5. Existing security/permissions must be unchanged. New preview table is
-- private with RLS, and has no authenticated/anon access policy.
SELECT c.relname,c.relrowsecurity,c.relforcerowsecurity,c.relacl
FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
WHERE n.nspname='public' AND c.relname IN ('exams','terms','grade_upload_previews','teacher_exam_progress') ORDER BY c.relname;
SELECT tablename,policyname,roles,cmd,qual,with_check FROM pg_policies
WHERE schemaname='public' AND tablename IN ('exams','terms','grade_upload_previews') ORDER BY tablename,policyname;
SELECT p.oid::regprocedure::text AS signature,pg_get_function_result(p.oid) AS result_type,
 p.prosecdef,p.proconfig,p.proacl,pg_get_userbyid(p.proowner) AS owner,md5(p.prosrc) body_fingerprint,
 CASE WHEN p.proname='submit_bulk_grades' THEN position('identityVersion' IN p.prosrc)>0 END AS versioned_bulk_service
FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
WHERE n.nspname='public' AND p.proname IN
('submit_bulk_grades','enforce_exam_status_guard','admin_correct_grade','guard_exam_assessment_period','guard_assessed_term_year',
'merge_duplicate_student','merge_duplicate_students','merge_duplicate_students_resolved','get_merge_conflicts','preview_student_merge','_safe_batch_evaluate_pair',
'get_monthly_report','get_class_student_subject_progress','monitor_marks_entries') ORDER BY signature;
COMMIT;
-- This file measures existing data. It cannot prove future uploads, Auth/RLS,
-- concurrency or browser behaviour. Preserve BEFORE results for comparisons.
