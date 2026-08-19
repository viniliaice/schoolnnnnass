-- PREFLIGHT — run BEFORE applying 20260819_family_id_stability_and_cards.sql
--
-- Read-only. Makes no changes. Answers the three questions that gate
-- production deployment of Phase 1:
--
--   GATE 1  Which generate_family_ids overload(s) are actually live, and
--           which body is bound to a no-argument call?
--   GATE 2  What is the current SECURITY DEFINER surface, and is it hardened
--           (search_path pinned, PUBLIC execute revoked, role-gated)?
--   GATE 3  Which real families have ALREADY been split into multiple
--           MBK numbers by the bug — i.e. what needs a human decision?
--
-- Usage:
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f supabase/tests/preflight-family-id-stability.sql
--
-- Capture the output and attach it to the deployment ticket. Nothing here
-- writes, so it is safe to run against production at any time.

\echo ''
\echo '════════════════════════════════════════════════════════════════════'
\echo ' GATE 1 — generate_family_ids overloads (expect exactly 1 AFTER the'
\echo '          migration; 2 BEFORE it is the bug we are fixing)'
\echo '════════════════════════════════════════════════════════════════════'

SELECT
  p.oid::regprocedure                                   AS signature,
  pg_get_function_identity_arguments(p.oid)             AS arguments,
  p.prosecdef                                           AS security_definer,
  CASE p.provolatile WHEN 'v' THEN 'VOLATILE' WHEN 's' THEN 'STABLE' WHEN 'i' THEN 'IMMUTABLE' END AS volatility,
  pg_get_functiondef(p.oid) LIKE '%p_transport_filter%' AS has_transport_filter,
  pg_get_functiondef(p.oid) LIKE '%v_existing%'         AS reuses_existing_id,
  pg_get_functiondef(p.oid) LIKE '%pg_advisory_xact_lock%' AS has_advisory_lock,
  pg_get_functiondef(p.oid) LIKE '%studentsJoined%'     AS reports_joined
FROM pg_proc p
JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname = 'public' AND p.proname = 'generate_family_ids'
ORDER BY p.pronargs;

\echo ''
\echo '-- Which body does a NO-ARGUMENT call bind to? (this is what the app'
\echo '-- sends for "All": rpc(''generate_family_ids'', {}) )'
\echo '-- 0 rows  = no zero-arg-callable candidate'
\echo '-- 1 row   = unambiguous (GOOD)'
\echo '-- 2 rows  = AMBIGUOUS — PostgREST will error or bind the stale body'

SELECT
  p.oid::regprocedure AS zero_arg_callable_candidate,
  p.pronargs          AS total_args,
  p.pronargdefaults   AS defaulted_args
FROM pg_proc p
JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname = 'public'
  AND p.proname = 'generate_family_ids'
  -- Callable with () when every argument has a default.
  AND p.pronargs - p.pronargdefaults <= 0;

\echo ''
\echo '════════════════════════════════════════════════════════════════════'
\echo ' GATE 2 — SECURITY DEFINER surface for the family-ID feature'
\echo '          search_path MUST be pinned; PUBLIC execute MUST be revoked'
\echo '════════════════════════════════════════════════════════════════════'

SELECT
  p.proname                                            AS function_name,
  pg_get_function_identity_arguments(p.oid)            AS arguments,
  p.prosecdef                                          AS security_definer,
  CASE p.provolatile WHEN 'v' THEN 'VOLATILE' WHEN 's' THEN 'STABLE' WHEN 'i' THEN 'IMMUTABLE' END AS volatility,
  COALESCE(array_to_string(p.proconfig, ', '), '(none)') AS config_search_path,
  has_function_privilege('public', p.oid, 'EXECUTE')   AS public_can_execute,
  pg_get_userbyid(p.proowner)                          AS owner,
  CASE
    WHEN pg_get_functiondef(p.oid) ILIKE '%current_profile_role()%' THEN 'yes'
    ELSE 'NO — check this'
  END                                                   AS role_gated
FROM pg_proc p
JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname = 'public'
  AND p.proname IN (
    'generate_family_ids', 'mark_student_left', 'lookup_family',
    'get_family_cards', 'assign_family_override', 'set_student_transport',
    'set_student_import_fields', 'record_release'
  )
ORDER BY p.proname;

\echo ''
\echo '-- Red flags: any row below is a hardening gap that must be explained'
\echo '-- before deploy (empty result = clean).'

SELECT
  p.proname AS function_name,
  CASE
    WHEN NOT p.prosecdef THEN 'not SECURITY DEFINER'
    WHEN p.proconfig IS NULL OR NOT (array_to_string(p.proconfig, ',') LIKE '%search_path%')
      THEN 'search_path NOT pinned (privilege-escalation risk)'
    WHEN has_function_privilege('public', p.oid, 'EXECUTE')
      THEN 'PUBLIC can EXECUTE'
    WHEN pg_get_functiondef(p.oid) NOT ILIKE '%current_profile_role()%'
      THEN 'no role gate found in body'
  END AS finding
FROM pg_proc p
JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname = 'public'
  AND p.proname IN (
    'generate_family_ids', 'mark_student_left', 'lookup_family',
    'get_family_cards', 'assign_family_override', 'set_student_transport',
    'set_student_import_fields', 'record_release'
  )
  AND (
    NOT p.prosecdef
    OR p.proconfig IS NULL OR NOT (array_to_string(p.proconfig, ',') LIKE '%search_path%')
    OR has_function_privilege('public', p.oid, 'EXECUTE')
    OR pg_get_functiondef(p.oid) NOT ILIKE '%current_profile_role()%'
  )
ORDER BY p.proname;

\echo ''
\echo '-- students must still have NO direct write policy (RPC-only design)'

SELECT policyname, cmd
FROM pg_policies
WHERE schemaname = 'public' AND tablename = 'students'
ORDER BY cmd, policyname;

\echo ''
\echo '════════════════════════════════════════════════════════════════════'
\echo ' GATE 3 — historical split families (the human-decision list)'
\echo '════════════════════════════════════════════════════════════════════'
\echo ''
\echo '-- 3a. HEADLINE: how many physical families hold more than one MBK id?'

WITH keyed AS (
  SELECT
    s.id, s.name, s."className", s."familyId", s."transport",
    CASE
      WHEN s."parentId" IS NOT NULL THEN 'p:' || s."parentId"
      WHEN public.normalize_phone(s."parentPhone") <> '' THEN 't:' || public.normalize_phone(s."parentPhone")
    END AS family_key
  FROM public.students s
  WHERE s."familyId" IS NOT NULL
    AND COALESCE(s."transport", '') <> 'LEFT'
)
SELECT
  count(*) FILTER (WHERE id_count > 1)                       AS split_families,
  COALESCE(sum(student_count) FILTER (WHERE id_count > 1), 0) AS students_affected,
  count(*)                                                    AS total_keyed_families
FROM (
  SELECT family_key, count(DISTINCT "familyId") AS id_count, count(*) AS student_count
  FROM keyed
  WHERE family_key IS NOT NULL
  GROUP BY family_key
) t;

\echo ''
\echo '-- 3b. THE DECISION LIST — one row per split family.'
\echo '--     keep_id is the SUGGESTED survivor (lowest/oldest MBK number:'
\echo '--     it is the one most likely already printed and in parents'' hands).'
\echo '--     Review each row before merging; do NOT bulk-apply blindly.'

WITH keyed AS (
  SELECT
    s.id, s.name, s."className", s."familyId", s."transport", s."parentId",
    public.normalize_phone(s."parentPhone") AS phone,
    CASE
      WHEN s."parentId" IS NOT NULL THEN 'p:' || s."parentId"
      WHEN public.normalize_phone(s."parentPhone") <> '' THEN 't:' || public.normalize_phone(s."parentPhone")
    END AS family_key
  FROM public.students s
  WHERE s."familyId" IS NOT NULL
    AND COALESCE(s."transport", '') <> 'LEFT'
),
split AS (
  SELECT family_key
  FROM keyed
  WHERE family_key IS NOT NULL
  GROUP BY family_key
  HAVING count(DISTINCT "familyId") > 1
)
SELECT
  k.family_key,
  min(k."familyId")                                        AS keep_id_suggested,
  array_agg(DISTINCT k."familyId" ORDER BY k."familyId")   AS all_ids,
  array_agg(DISTINCT k."familyId" ORDER BY k."familyId")
    FILTER (WHERE k."familyId" <> (SELECT min(k2."familyId") FROM keyed k2 WHERE k2.family_key = k.family_key))
                                                            AS ids_to_merge_away,
  count(*)                                                  AS students,
  string_agg(k.name || ' (' || k."className" || ' → ' || k."familyId" || ')', '; ' ORDER BY k."familyId", k.name) AS roster
FROM keyed k
JOIN split ON split.family_key = k.family_key
GROUP BY k.family_key
ORDER BY count(*) DESC, k.family_key;

\echo ''
\echo '-- 3c. Cross-key check: families that would MERGE differently because'
\echo '--     some siblings are linked by parentId and others only by phone.'
\echo '--     These need extra care — the generator keys on parentId first.'

SELECT
  public.normalize_phone(s."parentPhone")        AS phone,
  count(DISTINCT s."parentId")                   AS distinct_parent_ids,
  count(DISTINCT s."familyId")                   AS distinct_family_ids,
  array_agg(DISTINCT s."familyId")               AS ids,
  string_agg(DISTINCT s.name, '; ')              AS students
FROM public.students s
WHERE public.normalize_phone(s."parentPhone") <> ''
  AND COALESCE(s."transport", '') <> 'LEFT'
  AND s."familyId" IS NOT NULL
GROUP BY 1
HAVING count(DISTINCT s."familyId") > 1
ORDER BY 3 DESC, 1;

\echo ''
\echo '-- 3d. Students marked LEFT that already lost their familyId under the'
\echo '--     OLD mark_student_left(). Restoring them will mint a NEW id unless'
\echo '--     an admin reassigns the original one. Decide per student.'

SELECT s.id, s.name, s."className", s."parentId",
       public.normalize_phone(s."parentPhone") AS phone,
       (SELECT string_agg(DISTINCT sib."familyId", ', ')
          FROM public.students sib
         WHERE sib."familyId" IS NOT NULL
           AND ((s."parentId" IS NOT NULL AND sib."parentId" = s."parentId")
             OR (public.normalize_phone(s."parentPhone") <> ''
                 AND public.normalize_phone(sib."parentPhone") = public.normalize_phone(s."parentPhone")))
       ) AS sibling_family_id_to_restore
FROM public.students s
WHERE COALESCE(s."transport", '') = 'LEFT'
  AND s."familyId" IS NULL
ORDER BY s.name;

\echo ''
\echo '════════════════════════════════════════════════════════════════════'
\echo ' AUTOMATED VERDICT'
\echo '════════════════════════════════════════════════════════════════════'
\echo ''
\echo '-- Machine-checked gate status. A human reading a long report can miss a'
\echo '-- red flag; this block cannot. Run with -v ON_ERROR_STOP=1 and the'
\echo '-- script EXITS NON-ZERO when a gate is not satisfied.'
\echo '--'
\echo '-- Pass -v phase=pre  (default) to check the PRE-migration expectations'
\echo '-- Pass -v phase=post to require the POST-migration end state'
\echo ''

\if :{?phase}
\else
  \set phase pre
\endif

\echo 'Checking gates for phase:' :phase
SET preflight.phase = :'phase';

DO $$
DECLARE
  v_phase TEXT := current_setting('preflight.phase', true);
  v_overloads INT;
  v_zero_arg INT;
  v_redflags INT;
  v_has_cards INT;
  v_reuse BOOLEAN;
  v_splits INT;
  v_orphans INT;
  v_fail TEXT := '';
BEGIN
  SELECT count(*) INTO v_overloads
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname='public' AND p.proname='generate_family_ids';

  SELECT count(*) INTO v_zero_arg
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname='public' AND p.proname='generate_family_ids'
    AND p.pronargs - p.pronargdefaults <= 0;

  SELECT count(*) INTO v_redflags
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname='public'
    AND p.proname IN ('generate_family_ids','mark_student_left','lookup_family',
                      'get_family_cards','assign_family_override','set_student_transport',
                      'set_student_import_fields','record_release')
    AND (
      NOT p.prosecdef
      OR p.proconfig IS NULL OR NOT (array_to_string(p.proconfig, ',') LIKE '%search_path%')
      OR has_function_privilege('public', p.oid, 'EXECUTE')
      OR pg_get_functiondef(p.oid) NOT ILIKE '%current_profile_role()%'
    );

  SELECT count(*) INTO v_has_cards
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname='public' AND p.proname='get_family_cards';

  WITH keyed AS (
    SELECT s."familyId",
      CASE WHEN s."parentId" IS NOT NULL THEN 'p:' || s."parentId"
           WHEN public.normalize_phone(s."parentPhone") <> '' THEN 't:' || public.normalize_phone(s."parentPhone")
      END AS k
    FROM public.students s
    WHERE s."familyId" IS NOT NULL AND COALESCE(s."transport",'') <> 'LEFT'
  )
  SELECT count(*) INTO v_splits
  FROM (SELECT k FROM keyed WHERE k IS NOT NULL GROUP BY k HAVING count(DISTINCT "familyId") > 1) t;

  SELECT count(*) INTO v_orphans
  FROM public.students
  WHERE COALESCE("transport",'') = 'LEFT' AND "familyId" IS NULL;

  RAISE NOTICE '';
  RAISE NOTICE 'GATE 1  generate_family_ids overloads = %, zero-arg-callable = %', v_overloads, v_zero_arg;
  RAISE NOTICE 'GATE 2  hardening red flags = %, get_family_cards present = %', v_redflags, v_has_cards;
  RAISE NOTICE 'GATE 3  split families = %, LEFT students missing an id = %', v_splits, v_orphans;
  RAISE NOTICE '';

  -- GATE 1: zero candidates means the app's "All" call already cannot bind.
  IF v_zero_arg = 0 THEN
    v_fail := v_fail || E'\n  GATE 1 FAIL: no zero-arg-callable generate_family_ids. The app sends '
                     || 'rpc(generate_family_ids, {}) — it cannot resolve. INVESTIGATE before deploying.';
  END IF;

  IF v_phase = 'post' THEN
    IF v_overloads <> 1 THEN
      v_fail := v_fail || E'\n  GATE 1 FAIL: expected exactly 1 overload after the migration, found '
                       || v_overloads || '. Extend the DROP.';
    END IF;
    IF v_zero_arg <> 1 THEN
      v_fail := v_fail || E'\n  GATE 1 FAIL: no-argument call is ambiguous (' || v_zero_arg || ' candidates).';
    END IF;
    SELECT pg_get_functiondef(p.oid) LIKE '%v_existing%' INTO v_reuse
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname='public' AND p.proname='generate_family_ids' LIMIT 1;
    IF NOT COALESCE(v_reuse, false) THEN
      v_fail := v_fail || E'\n  GATE 1 FAIL: live generate_family_ids does not reuse existing family IDs '
                       || '(the migration did not take effect).';
    END IF;
    IF v_has_cards <> 1 THEN
      v_fail := v_fail || E'\n  GATE 2 FAIL: get_family_cards is missing — cards would be built from '
                       || 'RLS-scoped reads and could omit siblings.';
    END IF;
    IF v_redflags > 0 THEN
      v_fail := v_fail || E'\n  GATE 2 FAIL: ' || v_redflags || ' SECURITY DEFINER hardening gap(s). '
                       || 'See the red-flags table above.';
    END IF;
  ELSE
    IF v_redflags > 0 THEN
      RAISE NOTICE 'GATE 2 note: % pre-existing hardening gap(s) — the migration is expected to clear these; re-check with -v phase=post.', v_redflags;
    END IF;
  END IF;

  -- GATE 3 never auto-fails: split families need a human decision, not a
  -- blocked script. It is loud, and the runbook requires a recorded decision.
  IF v_splits > 0 OR v_orphans > 0 THEN
    RAISE WARNING 'GATE 3 ACTION REQUIRED: % split famil(ies) and % LEFT student(s) without an id need a recorded decision (see 3b/3d above). Do NOT bulk-merge.', v_splits, v_orphans;
  ELSE
    RAISE NOTICE 'GATE 3 clear: no split families, no orphaned LEFT students.';
  END IF;

  IF v_fail <> '' THEN
    RAISE EXCEPTION 'PREFLIGHT FAILED (phase=%):%', v_phase, v_fail;
  END IF;

  RAISE NOTICE 'PREFLIGHT PASSED for phase=%.', v_phase;
END $$;

\echo ''
\echo '════════════════════════════════════════════════════════════════════'
\echo ' Preflight complete. Attach this output to the deployment ticket.'
\echo ' Deploy only when: GATE 1 unambiguous · GATE 2 no red flags ·'
\echo ' GATE 3 list reviewed and a merge decision recorded per family.'
\echo '════════════════════════════════════════════════════════════════════'
