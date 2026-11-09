-- Split a merged family: move selected students out of an existing Family ID
-- onto a brand-new one.
--
-- WHY THIS EXISTS
-- ---------------
-- generate_family_ids() assigns ONE Family ID per household key (parentId
-- first, else the normalized parentPhone). Two households that shared a phone
-- number — or that were linked to the same parent account when the ID was
-- generated — therefore ended up on a single MBK number. Family IDs are
-- immutable by design (no re-run ever reassigns them), and assign_student_parent()
-- only changes parentId, so correcting the household afterwards could never
-- separate the two families again. The only tool was assign_family_override(),
-- which needs the admin to invent a free 4-digit number and repeat it per
-- student.
--
-- This RPC is the missing "separate" operation. It:
--   * is admin-only (same rule as generate / override / mark-left),
--   * allocates the next free MBK number itself, under the SAME advisory lock
--     as generate_family_ids(), so it can never collide with a concurrent run,
--   * refuses to touch a student who is not currently in the family being
--     split (no cross-family writes),
--   * refuses to move everyone (a family must keep at least one student, so a
--     "split" can never leave a phantom ID behind),
--   * changes ONLY "familyId" — parentId, transport, phone and status are
--     untouched,
--   * writes an audit_logs row (family_ids.split).
--
-- Verify after applying:
--   SELECT p.oid::regprocedure FROM pg_proc p JOIN pg_namespace n
--     ON n.oid = p.pronamespace
--    WHERE n.nspname = 'public' AND p.proname = 'split_family_members';

CREATE OR REPLACE FUNCTION public.split_family_members(
  p_family_id TEXT,
  p_student_ids TEXT[]
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_role TEXT := public.current_profile_role();
  v_actor_id TEXT := public.current_profile_id();
  v_family_id TEXT := public.normalize_family_id(p_family_id);
  v_ids TEXT[];
  v_next_id INTEGER;
  v_new_id TEXT;
  v_total INTEGER;
  v_moving INTEGER;
  v_moved INTEGER;
BEGIN
  IF v_actor_id IS NULL OR v_role <> 'admin' THEN
    RAISE EXCEPTION 'Only admins may split a family.'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  IF v_family_id = '' THEN
    RAISE EXCEPTION 'A family ID is required.' USING ERRCODE = 'invalid_parameter_value';
  END IF;

  -- De-duplicate: a repeated id must never be counted twice.
  SELECT array_agg(DISTINCT x)
    INTO v_ids
    FROM unnest(COALESCE(p_student_ids, ARRAY[]::TEXT[])) AS x
   WHERE NULLIF(btrim(x), '') IS NOT NULL;

  IF v_ids IS NULL OR cardinality(v_ids) = 0 THEN
    RAISE EXCEPTION 'Choose at least one student to move.'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  -- Same lock as generate_family_ids(): the MAX+1 number below must not race
  -- with a generator run handing out the same number.
  PERFORM pg_advisory_xact_lock(hashtext('family_ids_generate'));

  -- Every selected student must belong to THIS family right now. This blocks a
  -- stale screen from moving a student out of a family they no longer belong
  -- to, and from moving a student who has no Family ID at all.
  IF EXISTS (
    SELECT 1
      FROM public.students s
     WHERE s.id = ANY(v_ids)
       AND public.normalize_family_id(s."familyId") <> v_family_id
  ) THEN
    RAISE EXCEPTION 'Only students currently in family % can be split from it.', v_family_id
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  -- A split must leave a family behind: the remaining students keep v_family_id.
  SELECT count(*) FILTER (WHERE COALESCE(s."transport", '') <> 'LEFT')
    INTO v_total
    FROM public.students s
   WHERE public.normalize_family_id(s."familyId") = v_family_id;

  IF v_total <= cardinality(v_ids) THEN
    RAISE EXCEPTION 'Leave at least one student in family % — use Assign to move the whole family instead.', v_family_id
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  -- Next free number. Bounded to 1-4 digits so a historical malformed value
  -- (the old override bug allowed longer IDs) can never overflow the cast and
  -- brick splitting or generation.
  SELECT COALESCE(MAX(public.normalize_family_id("familyId")::INTEGER), 0)
    INTO v_next_id
    FROM public.students
   WHERE "familyId" IS NOT NULL
     AND public.normalize_family_id("familyId") ~ '^\d{1,4}$';

  v_next_id := v_next_id + 1;
  IF v_next_id > 9999 THEN
    RAISE EXCEPTION 'No Family IDs left (0001-9999).' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  v_new_id := lpad(v_next_id::TEXT, 4, '0');

  UPDATE public.students
     SET "familyId" = v_new_id
   WHERE id = ANY(v_ids);
  GET DIAGNOSTICS v_moved = ROW_COUNT;

  IF v_moved = 0 THEN
    RAISE EXCEPTION 'No student was moved.' USING ERRCODE = 'no_data_found';
  END IF;

  INSERT INTO public.audit_logs (action, details, "createdAt")
  VALUES (
    'family_ids.split',
    jsonb_build_object(
      'by', v_actor_id,
      'familyId', v_family_id,
      'newFamilyId', v_new_id,
      'studentsMoved', v_moved,
      'studentIds', to_jsonb(v_ids),
      'remaining', v_total - v_moved
    ),
    NOW()
  );

  RETURN jsonb_build_object(
    'familyId', v_family_id,
    'newFamilyId', v_new_id,
    'studentsMoved', v_moved,
    'remaining', v_total - v_moved
  );
END;
$$;

REVOKE ALL ON FUNCTION public.split_family_members(TEXT, TEXT[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.split_family_members(TEXT, TEXT[]) TO authenticated;

-- ─── Diagnosis: families that already carry more than one parent account ───
-- Run this to find other families in the same state as the reported one. Each
-- row is one Family ID holding two or more parent accounts; that is either a
-- merged household (use Split) or one household with two parent logins.
--
--   SELECT public.normalize_family_id(s."familyId") AS family_id,
--          count(DISTINCT s."parentId") AS parent_accounts,
--          count(*) AS students,
--          array_agg(DISTINCT s.name) AS students_names
--     FROM public.students s
--    WHERE s."familyId" IS NOT NULL
--      AND COALESCE(s."transport",'') <> 'LEFT'
--      AND s."parentId" IS NOT NULL
--    GROUP BY 1
--   HAVING count(DISTINCT s."parentId") > 1
--    ORDER BY 2 DESC, 1;
