-- Family ID stability + complete card data (SPEC-family-id-printing-implementation.md)
--
-- Fixes three verified defects and adds one read-only RPC:
--
--   B1  generate_family_ids() split a family when a sibling enrolled later:
--       it grouped only students with familyId IS NULL and then ALWAYS
--       allocated a fresh number, never asking whether that family key
--       already owned an ID. Result: Xalimo/Ahmed -> 0001, new sibling
--       Yasmin -> 0002. At the gate, lookup_family('0001') then returned two
--       of three children and the third was invisible. Now the group key is
--       resolved against students that already hold an ID, and the existing
--       ID is reused.
--
--   B2  mark_student_left(true) nulled familyId, and restore never brought it
--       back, so the next Generate issued a DIFFERENT id. Now the familyId is
--       preserved; LEFT students are instead filtered out everywhere a family
--       is materialised (lookup_family, get_family_cards, and client-side
--       grouping/card building).
--
--   B3  Two generate_family_ids overloads existed. Migrations apply in
--       lexicographic order, so 20260802_mark_student_left.sql (0-arg, no
--       transport filter) was applied AFTER
--       20260802_generate_transport_filter.sql (1-arg, filtered). The client
--       calls rpc('generate_family_ids', {}) for "All", which is ambiguous or
--       binds the stale body. The 0-arg overload is dropped here so exactly
--       one definition remains.
--
--   B4/B5  get_family_cards(): printing read students via RLS-scoped REST, so
--       a supervisor (whose only students policy is "Teachers can read
--       assigned class students") printed cards MISSING SIBLINGS, and
--       office/supervisor cannot read profiles at all so cards printed with a
--       blank parent name. Phone resolution also differed from the gate. This
--       SECURITY DEFINER + STABLE function returns the complete roster with
--       the SAME phone COALESCE as lookup_family(). STABLE means Postgres
--       rejects writes inside it: printing can never generate an ID.
--
-- Verify before/after applying:
--   SELECT p.oid::regprocedure, pg_get_functiondef(p.oid) LIKE '%p_transport_filter%'
--   FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
--   WHERE n.nspname='public' AND p.proname='generate_family_ids';

-- ─── B3: remove the stale 0-arg overload ───────────────────────────────────
DROP FUNCTION IF EXISTS public.generate_family_ids();

-- ─── B1: generator reuses an existing family's ID ──────────────────────────
CREATE OR REPLACE FUNCTION public.generate_family_ids(p_transport_filter TEXT DEFAULT NULL)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_actor_id TEXT := public.current_profile_id();
  v_role TEXT := public.current_profile_role();
  v_next_id INTEGER;
  v_created INTEGER := 0;
  v_joined INTEGER := 0;
  v_assigned INTEGER := 0;
  v_unattached JSONB := '[]'::JSONB;
  v_group RECORD;
  v_student_id TEXT;
  v_family_id TEXT;
  v_existing TEXT;
  v_total_families INTEGER;
BEGIN
  IF v_actor_id IS NULL OR v_role <> 'admin' THEN
    RAISE EXCEPTION 'Only admins may generate family IDs.' USING ERRCODE = 'insufficient_privilege';
  END IF;

  -- Serialize concurrent runs: without this, two parallel calls can both read
  -- the same MAX and hand the same number to two different families.
  PERFORM pg_advisory_xact_lock(hashtext('family_ids_generate'));

  SELECT COALESCE(MAX(NULLIF(public.normalize_family_id("familyId"), '')::INTEGER), 0)
    INTO v_next_id
    FROM public.students
   WHERE "familyId" IS NOT NULL AND public.normalize_family_id("familyId") ~ '^\d+$';

  FOR v_group IN
    SELECT
      CASE
        WHEN s."parentId" IS NOT NULL THEN 'p:' || s."parentId"
        WHEN public.normalize_phone(s."parentPhone") <> '' THEN 't:' || public.normalize_phone(s."parentPhone")
        ELSE NULL
      END AS family_key,
      array_agg(s.id ORDER BY s.name) AS student_ids
    FROM public.students s
    WHERE s."familyId" IS NULL
      AND COALESCE(s."transport", '') <> 'LEFT'
      AND CASE
        WHEN p_transport_filter IS NULL OR p_transport_filter = 'all' THEN TRUE
        WHEN p_transport_filter = 'bus' THEN COALESCE(s."transport", '') ~ '^\d+$'
        WHEN p_transport_filter = 'walker' THEN COALESCE(s."transport", '') IN ('WALKER', 'CAR')
        WHEN p_transport_filter = 'empty' THEN s."transport" IS NULL OR s."transport" = ''
        ELSE TRUE
      END
    GROUP BY family_key
  LOOP
    IF v_group.family_key IS NULL THEN
      v_unattached := v_unattached || to_jsonb(v_group.student_ids);
      CONTINUE;
    END IF;

    -- INVARIANT: one family key -> one family ID, for the lifetime of the key.
    -- If any student sharing this key already holds an ID, the new sibling
    -- joins it instead of receiving a fresh number.
    SELECT s."familyId" INTO v_existing
    FROM public.students s
    WHERE s."familyId" IS NOT NULL
      AND CASE
            WHEN v_group.family_key LIKE 'p:%'
              THEN s."parentId" IS NOT NULL AND 'p:' || s."parentId" = v_group.family_key
            ELSE public.normalize_phone(s."parentPhone") <> ''
                 AND 't:' || public.normalize_phone(s."parentPhone") = v_group.family_key
          END
    ORDER BY s."familyId"
    LIMIT 1;

    IF v_existing IS NOT NULL THEN
      v_family_id := v_existing;
      v_joined := v_joined + 1;
    ELSE
      v_next_id := v_next_id + 1;
      v_family_id := lpad(v_next_id::TEXT, 4, '0');
      v_created := v_created + 1;
    END IF;

    FOREACH v_student_id IN ARRAY v_group.student_ids
    LOOP
      UPDATE public.students
         SET "familyId" = v_family_id
       WHERE id = v_student_id AND "familyId" IS NULL;
      IF FOUND THEN
        v_assigned := v_assigned + 1;
      END IF;
    END LOOP;
  END LOOP;

  SELECT COUNT(DISTINCT "familyId") INTO v_total_families FROM public.students WHERE "familyId" IS NOT NULL;

  INSERT INTO public.audit_logs (action, details, "createdAt")
  VALUES (
    'family_ids.generate',
    jsonb_build_object(
      'by', v_actor_id,
      'familiesCreated', v_created,
      'studentsJoined', v_joined,
      'studentsAssigned', v_assigned,
      'unattached', jsonb_array_length(v_unattached),
      'totalFamilies', v_total_families,
      'filter', p_transport_filter
    ),
    NOW()
  );

  RETURN jsonb_build_object(
    'familiesCreated', v_created,
    'studentsJoined', v_joined,
    'studentsAssigned', v_assigned,
    'unattached', v_unattached,
    'totalFamilies', v_total_families
  );
END;
$$;

-- ─── B2: marking a student as left must NOT destroy their family ID ────────
CREATE OR REPLACE FUNCTION public.mark_student_left(p_student_id TEXT, p_left BOOLEAN)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_role TEXT := public.current_profile_role();
BEGIN
  IF v_role IS NULL OR v_role <> 'admin' THEN
    RAISE EXCEPTION 'Only admins may mark students as left.'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  -- familyId is preserved in BOTH directions: a restored student rejoins the
  -- family they always belonged to. LEFT students are excluded from rosters
  -- by the readers (lookup_family / get_family_cards / client grouping), and
  -- from generate_family_ids candidacy, so they still get no gate card.
  IF p_left THEN
    UPDATE public.students SET "transport" = 'LEFT' WHERE id = p_student_id;
  ELSE
    UPDATE public.students SET "transport" = NULL WHERE id = p_student_id;
  END IF;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Student not found.' USING ERRCODE = 'no_data_found';
  END IF;

  INSERT INTO public.audit_logs (action, details, "createdAt")
  VALUES ('family_ids.left', jsonb_build_object('studentId', p_student_id, 'left', p_left), NOW());
END;
$$;

-- ─── B2 (coupled): the gate must not show students who left ────────────────
CREATE OR REPLACE FUNCTION public.lookup_family(p_family_id TEXT)
RETURNS JSONB
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT coalesce(jsonb_agg(
    jsonb_build_object(
      'id', s.id,
      'name', s.name,
      'className', s."className",
      'transport', s."transport",
      'familyId', s."familyId",
      'parentPhone', COALESCE(
        NULLIF(public.normalize_phone(pr."phone1"), ''),
        NULLIF(public.normalize_phone(pr."phone2"), ''),
        NULLIF(public.normalize_phone(s."parentPhone"), ''),
        s."parentPhone"
      )
    ) ORDER BY s.name
  ), '[]'::JSONB)
  FROM public.students s
  LEFT JOIN public.profiles pr ON pr.id = s."parentId"
  WHERE s."familyId" = public.normalize_family_id(p_family_id)
    AND COALESCE(s."transport", '') <> 'LEFT'
    AND public.current_profile_role() IN ('admin', 'supervisor', 'office')
    AND public.current_profile_id() IS NOT NULL;
$$;

-- ─── B4/B5: complete, role-independent card data ───────────────────────────
-- STABLE: Postgres rejects any write inside this function, so the printing
-- path is structurally incapable of creating or changing a family ID.
CREATE OR REPLACE FUNCTION public.get_family_cards(p_family_ids TEXT[])
RETURNS JSONB
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT coalesce(jsonb_agg(fam ORDER BY fam->>'familyId'), '[]'::JSONB)
  FROM (
    SELECT jsonb_build_object(
      'familyId', s."familyId",
      'parentName', COALESCE(max(pr.name) FILTER (WHERE pr.name IS NOT NULL), ''),
      'parentPhone', COALESCE(
        max(NULLIF(public.normalize_phone(pr."phone1"), '')),
        max(NULLIF(public.normalize_phone(pr."phone2"), '')),
        max(NULLIF(public.normalize_phone(s."parentPhone"), '')),
        max(s."parentPhone"),
        ''
      ),
      'students', jsonb_agg(
        jsonb_build_object(
          'id', s.id,
          'name', s.name,
          'className', s."className",
          'transport', s."transport",
          'parentId', s."parentId",
          'parentPhone', s."parentPhone",
          'familyId', s."familyId"
        ) ORDER BY s.name
      )
    ) AS fam
    FROM public.students s
    LEFT JOIN public.profiles pr ON pr.id = s."parentId"
    WHERE s."familyId" IS NOT NULL
      AND s."familyId" IN (
        SELECT public.normalize_family_id(x) FROM unnest(COALESCE(p_family_ids, ARRAY[]::TEXT[])) AS x
      )
      AND COALESCE(s."transport", '') <> 'LEFT'
      AND public.current_profile_role() IN ('admin', 'supervisor', 'office')
      AND public.current_profile_id() IS NOT NULL
    GROUP BY s."familyId"
  ) t;
$$;

-- ─── Grants ────────────────────────────────────────────────────────────────
REVOKE ALL ON FUNCTION public.generate_family_ids(TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.mark_student_left(TEXT, BOOLEAN) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.lookup_family(TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.get_family_cards(TEXT[]) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION public.generate_family_ids(TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.mark_student_left(TEXT, BOOLEAN) TO authenticated;
GRANT EXECUTE ON FUNCTION public.lookup_family(TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_family_cards(TEXT[]) TO authenticated;

-- ─── Data repair: families already split by B1/B2 (report only) ────────────
-- Run this after applying. Each row is one physical family holding more than
-- one ID; merge them with the admin UI's existing "Assign" override, which
-- already supports merging a student into an existing family.
--
--   SELECT COALESCE('p:'||s."parentId", 't:'||public.normalize_phone(s."parentPhone")) AS family_key,
--          array_agg(DISTINCT s."familyId") AS ids,
--          array_agg(DISTINCT s.name) AS students
--   FROM public.students s
--   WHERE s."familyId" IS NOT NULL
--     AND COALESCE(s."transport",'') <> 'LEFT'
--     AND (s."parentId" IS NOT NULL OR public.normalize_phone(s."parentPhone") <> '')
--   GROUP BY 1
--   HAVING count(DISTINCT s."familyId") > 1;
