-- Let OFFICE staff split a merged family, not just admins.
--
-- WHY
-- ---
-- 20261109_split_family_members.sql made splitting admin-only (the same rule as
-- generate / override / mark-left). In practice the front desk is who spots a
-- merged card — they are the ones printing it and taking the parent's call — so
-- requiring an admin turned a two-click repair into a queue. This migration
-- grants exactly that one repair operation to the office role.
--
-- Scope is deliberately unchanged:
--   * the operation still allocates the next free MBK number itself, under the
--     generator's advisory lock (no manual number typing, no collisions),
--   * it still refuses students who are not currently in that family,
--   * it still refuses to move everyone (a family must keep >= 1 student),
--   * it still changes ONLY "familyId" — parentId, phone, transport, status are
--     untouched,
--   * it still writes an audit row (family_ids.split) with the actor.
--
-- Nothing else office can touch changes here: generation, manual override,
-- mark-left and the transport-sheet import remain admin-only. Parent assignment
-- was already open to office (20261018_office_parent_assignment.sql).
--
-- Verify after applying:
--   SELECT pg_get_functiondef(p.oid) LIKE '%office%' AS office_can_split
--     FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
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
  -- Gate staff may repair a merged card; every other role stays out.
  IF v_actor_id IS NULL OR v_role NOT IN ('admin', 'office') THEN
    RAISE EXCEPTION 'Only administrators or office users may split a family.'
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
      'byRole', v_role,
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
