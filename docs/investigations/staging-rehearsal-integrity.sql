-- READ ONLY: capture on the VERIFIED, RESTORED STAGING target immediately before
-- and immediately after migration, BEFORE adding any synthetic test records.
-- No migration is invoked by this file. Do not confuse production inventory with
-- before/after staging evidence. Save both outputs securely and compare exactly.
BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY;
WITH records AS (
 SELECT e.id, to_jsonb(e) AS payload, e."assessmentLabel" AS label, e."examType" AS kind
 FROM public.exams e
), scoped AS (
 SELECT 'all_exams'::text AS scope, id, payload FROM records
 UNION ALL SELECT 'fully_labelled', id, payload FROM records WHERE label IS NOT NULL
 UNION ALL SELECT 'unlabelled', id, payload FROM records WHERE label IS NULL
 UNION ALL SELECT 'termwide', id, payload FROM records WHERE kind IN ('Midterm','Final')
)
SELECT scope,count(*) AS records,
 md5(COALESCE(string_agg(md5(payload::text),'' ORDER BY id),'')) AS ordered_row_fingerprint
FROM scoped GROUP BY scope ORDER BY scope;

WITH ambiguous AS (
 SELECT "studentId","subjectId","examType","assessmentLabel","termId",month,
        count(*) AS rows_in_group,
        md5(string_agg(md5(to_jsonb(e)::text),'' ORDER BY e.id)) AS row_fingerprint
 FROM public.exams e WHERE "assessmentLabel" IS NULL
 GROUP BY 1,2,3,4,5,6 HAVING count(*)>1
)
SELECT count(*) AS ambiguous_groups,COALESCE(sum(rows_in_group),0) AS ambiguous_rows,
 md5(COALESCE(string_agg(md5(to_jsonb(a)::text),'' ORDER BY to_jsonb(a)::text),'')) AS group_fingerprint
FROM ambiguous a;

SELECT status,count(*) FROM public.exams GROUP BY status ORDER BY status;
SELECT "termId",month,count(*) FROM public.exams GROUP BY 1,2 ORDER BY 1,2;
SELECT indexname,indexdef FROM pg_indexes WHERE schemaname='public' AND tablename='exams' AND indexdef ILIKE '%UNIQUE%' ORDER BY indexname;
SELECT pg_get_triggerdef(oid) FROM pg_trigger WHERE tgrelid='public.exams'::regclass AND NOT tgisinternal ORDER BY tgname;
COMMIT;
-- Fingerprints are reproducible integrity aids, not a substitute for a backup
-- or a row-by-row secure comparison. They contain no exported student details.
