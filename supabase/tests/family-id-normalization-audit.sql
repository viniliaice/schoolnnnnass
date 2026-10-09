-- ============================================================================
-- READ-ONLY AUDIT: students."familyId" vs public.normalize_family_id()
--
-- WHY THIS EXISTS. normalize_family_id() is:
--     regexp_replace(COALESCE(p_raw,''), '\D', '', 'g')      -- 20260802:55
-- It strips EVERY non-digit. A family ID that contains no digit at all — 'FAM',
-- 'ALPHA', 'HOUSE-RED' — therefore normalizes to '' and the safe duplicate
-- batch treats that record as having NO family ID.
--
-- Under the v2 field-consolidation policy (20261008) that matters twice over:
--   * a duplicate-only family ID that normalizes to '' is seen as blank, so no
--     transfer is offered and nothing is flagged — the value is invisible;
--   * two DISTINCT raw values that normalize to the SAME key ('FAM-12' and
--     'FAM12') can make a family transfer look "proven" against the wrong
--     family.
--
-- This script answers the four questions before any production merge. It
-- contains ONLY SELECT statements. It writes nothing, changes nothing, and
-- needs no special role — it reads public.students, which the admin screen
-- already reads.
--
-- RUN:
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 \
--        -f supabase/tests/family-id-normalization-audit.sql
--
-- If section 2 or section 5 returns ANY rows, correct the data (or the
-- normalizer) BEFORE running merge_safe_duplicate_batch().
-- ============================================================================

\echo ''
\echo '=== 1. Population ========================================='
SELECT
  count(*)                                                              AS total_students,
  count(*) FILTER (WHERE "familyId" IS NULL)                            AS family_id_null,
  count(*) FILTER (WHERE btrim(COALESCE("familyId", '')) = '')          AS family_id_blank,
  count(*) FILTER (WHERE btrim(COALESCE("familyId", '')) <> '')         AS family_id_non_blank,
  count(DISTINCT "familyId") FILTER (WHERE btrim(COALESCE("familyId",'')) <> '')
                                                                        AS distinct_family_ids
FROM public.students;

\echo ''
\echo '=== 2. CRITICAL: values that become BLANK under normalize_family_id() ==='
\echo '    Any row here is a real family ID the batch cannot see.'
SELECT
  count(*)                    AS records_that_go_blank,
  count(DISTINCT "familyId")  AS distinct_values_affected
FROM public.students
WHERE btrim(COALESCE("familyId", '')) <> ''
  AND public.normalize_family_id("familyId") = '';

\echo ''
\echo '=== 3. The affected values themselves (up to 50) =========='
SELECT "familyId" AS raw_value, count(*) AS students
FROM public.students
WHERE btrim(COALESCE("familyId", '')) <> ''
  AND public.normalize_family_id("familyId") = ''
GROUP BY "familyId"
ORDER BY students DESC, "familyId"
LIMIT 50;

\echo ''
\echo '=== 4. Character composition of every family ID in use ===='
\echo '    "alphabetic only" rows are the ones that vanish.'
SELECT
  CASE
    WHEN "familyId" ~ '^[0-9]+$'       THEN 'numeric only (safe)'
    WHEN "familyId" ~ '^[A-Za-z]+$'    THEN 'alphabetic only -> NORMALIZES TO BLANK'
    WHEN "familyId" ~ '^[A-Za-z0-9]+$' THEN 'alphanumeric mixed -> letters dropped'
    ELSE 'contains separators/symbols -> stripped'
  END                                                        AS shape,
  count(*)                                                   AS students,
  count(DISTINCT "familyId")                                 AS distinct_values,
  bool_or(public.normalize_family_id("familyId") = '')       AS any_become_blank,
  min(public.normalize_family_id("familyId"))                AS sample_normalized
FROM public.students
WHERE btrim(COALESCE("familyId", '')) <> ''
GROUP BY 1
ORDER BY students DESC;

\echo ''
\echo '=== 5. COLLISION RISK: distinct raw values, identical key =='
\echo '    Two unrelated families collapsing to one key could make a'
\echo '    family transfer look "proven" against the wrong family.'
WITH n AS (
  SELECT public.normalize_family_id("familyId") AS key, "familyId" AS raw
  FROM public.students
  WHERE btrim(COALESCE("familyId", '')) <> ''
)
SELECT
  key,
  count(DISTINCT raw)                                       AS distinct_raw_spellings,
  count(*)                                                  AS students,
  string_agg(DISTINCT raw, ' | ' ORDER BY raw)              AS spellings
FROM n
WHERE key <> ''
GROUP BY key
HAVING count(DISTINCT raw) > 1
ORDER BY count(DISTINCT raw) DESC, key
LIMIT 50;

\echo ''
\echo '=== 6. Family keys that would collide AFTER stripping ======='
\echo '    Distinct families today, same family key once normalized.'
WITH n AS (
  SELECT public.normalize_family_id("familyId") AS key, "familyId" AS raw
  FROM public.students
  WHERE btrim(COALESCE("familyId", '')) <> ''
), collapsed AS (
  SELECT key, count(DISTINCT raw) AS raws FROM n WHERE key <> '' GROUP BY key
)
SELECT
  count(*) FILTER (WHERE raws > 1)                          AS keys_with_colliding_spellings,
  COALESCE(sum(raws) FILTER (WHERE raws > 1), 0)            AS raw_values_involved
FROM collapsed;

\echo ''
\echo '=== 7. Verdict ============================================'
DO $$
DECLARE
  v_blank INT; v_collide INT;
BEGIN
  SELECT count(*) INTO v_blank
  FROM public.students
  WHERE btrim(COALESCE("familyId", '')) <> ''
    AND public.normalize_family_id("familyId") = '';

  SELECT count(*) INTO v_collide FROM (
    SELECT public.normalize_family_id("familyId") AS key
    FROM public.students
    WHERE btrim(COALESCE("familyId", '')) <> ''
    GROUP BY 1
    HAVING count(DISTINCT "familyId") > 1 AND public.normalize_family_id("familyId") <> ''
  ) z;

  IF v_blank = 0 AND v_collide = 0 THEN
    RAISE NOTICE 'familyId data is CLEAN: every value is digit-bearing and no two spellings collapse to one key. Safe to proceed.';
  ELSE
    RAISE WARNING 'familyId data needs attention BEFORE merging: % value(s) normalize to blank, % key(s) have colliding spellings.', v_blank, v_collide;
  END IF;
END $$;
