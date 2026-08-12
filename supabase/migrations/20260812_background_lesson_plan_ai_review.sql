-- Queue lesson-plan review only after a confirmed status transition, and persist
-- aggregate + per-period AI results atomically for the matching attempt.

-- Teacher-owned status transition. Updating the status in this transaction also
-- activates the existing lesson-plan/period edit locks before the function
-- returns to the browser.
CREATE OR REPLACE FUNCTION submit_lesson_plan_for_review(p_plan_id TEXT)
RETURNS SETOF lesson_plans
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = public
AS $$
DECLARE
  v_plan lesson_plans%ROWTYPE;
  v_profile_id TEXT;
  v_started_at TIMESTAMPTZ := clock_timestamp();
BEGIN
  SELECT id INTO v_profile_id
  FROM profiles
  WHERE auth_id = auth.uid();

  IF v_profile_id IS NULL THEN
    RAISE EXCEPTION 'No profile is associated with the current user.'
      USING ERRCODE = '42501';
  END IF;

  SELECT * INTO v_plan
  FROM lesson_plans
  WHERE id = p_plan_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Lesson plan % was not found.', p_plan_id
      USING ERRCODE = 'P0002';
  END IF;

  IF v_plan.teacher_id IS DISTINCT FROM v_profile_id THEN
    RAISE EXCEPTION 'You do not own lesson plan %.', p_plan_id
      USING ERRCODE = '42501';
  END IF;

  IF v_plan.status NOT IN ('draft', 'revision_requested') THEN
    RAISE EXCEPTION 'Lesson plan % cannot be submitted from status %.', p_plan_id, v_plan.status
      USING ERRCODE = 'check_violation';
  END IF;

  -- A resubmission must not display a previous attempt as though it were the
  -- newly requested review.
  DELETE FROM lesson_period_ai_reviews WHERE plan_id = p_plan_id;
  DELETE FROM ai_reviews WHERE plan_id = p_plan_id;

  UPDATE lesson_plans
  SET status = 'submitted',
      ai_started_at = v_started_at,
      ai_failure_reason = NULL,
      updated_at = v_started_at
  WHERE id = p_plan_id;

  RETURN QUERY SELECT * FROM lesson_plans WHERE id = p_plan_id;
END;
$$;

REVOKE ALL ON FUNCTION submit_lesson_plan_for_review(TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION submit_lesson_plan_for_review(TEXT) TO authenticated;

-- Retry/redo transition for the owner or a supervisor/admin. It creates a new
-- attempt timestamp so a late result from an older attempt can be discarded.
CREATE OR REPLACE FUNCTION retry_lesson_plan_ai_review(p_plan_id TEXT)
RETURNS SETOF lesson_plans
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = public
AS $$
DECLARE
  v_plan lesson_plans%ROWTYPE;
  v_profile_id TEXT;
  v_role TEXT;
  v_started_at TIMESTAMPTZ := clock_timestamp();
BEGIN
  SELECT id, role INTO v_profile_id, v_role
  FROM profiles
  WHERE auth_id = auth.uid();

  IF v_profile_id IS NULL THEN
    RAISE EXCEPTION 'No profile is associated with the current user.'
      USING ERRCODE = '42501';
  END IF;

  SELECT * INTO v_plan
  FROM lesson_plans
  WHERE id = p_plan_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Lesson plan % was not found.', p_plan_id
      USING ERRCODE = 'P0002';
  END IF;

  IF v_plan.teacher_id IS DISTINCT FROM v_profile_id
     AND COALESCE(v_role, '') NOT IN ('supervisor', 'admin') THEN
    RAISE EXCEPTION 'You may not retry the AI review for lesson plan %.', p_plan_id
      USING ERRCODE = '42501';
  END IF;

  IF v_plan.status NOT IN ('submitted', 'ai_failed', 'in_review') THEN
    RAISE EXCEPTION 'Lesson plan % cannot retry AI review from status %.', p_plan_id, v_plan.status
      USING ERRCODE = 'check_violation';
  END IF;

  DELETE FROM lesson_period_ai_reviews WHERE plan_id = p_plan_id;
  DELETE FROM ai_reviews WHERE plan_id = p_plan_id;

  UPDATE lesson_plans
  SET status = 'submitted',
      ai_started_at = v_started_at,
      ai_failure_reason = NULL,
      updated_at = v_started_at
  WHERE id = p_plan_id;

  RETURN QUERY SELECT * FROM lesson_plans WHERE id = p_plan_id;
END;
$$;

REVOKE ALL ON FUNCTION retry_lesson_plan_ai_review(TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION retry_lesson_plan_ai_review(TEXT) TO authenticated;

-- If the browser cannot hand the already-queued attempt to the Edge Function,
-- preserve the submitted lock but expose a retryable failure immediately. The
-- attempt timestamp prevents a late failure from clobbering a newer retry.
CREATE OR REPLACE FUNCTION mark_lesson_plan_review_dispatch_failed(
  p_plan_id TEXT,
  p_ai_started_at TIMESTAMPTZ,
  p_reason TEXT DEFAULT 'AI review could not be started. Please retry.'
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_plan lesson_plans%ROWTYPE;
  v_profile_id TEXT;
  v_role TEXT;
  v_now TIMESTAMPTZ := clock_timestamp();
BEGIN
  SELECT id, role INTO v_profile_id, v_role
  FROM profiles
  WHERE auth_id = auth.uid();

  SELECT * INTO v_plan
  FROM lesson_plans
  WHERE id = p_plan_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN FALSE;
  END IF;

  IF v_plan.teacher_id IS DISTINCT FROM v_profile_id
     AND COALESCE(v_role, '') NOT IN ('supervisor', 'admin') THEN
    RAISE EXCEPTION 'Not authorized to fail this lesson-plan review attempt'
      USING ERRCODE = '42501';
  END IF;

  IF v_plan.status <> 'submitted'
     OR v_plan.ai_started_at IS DISTINCT FROM p_ai_started_at THEN
    RETURN FALSE;
  END IF;

  UPDATE lesson_plans
  SET status = 'ai_failed',
      ai_failure_reason = LEFT(COALESCE(NULLIF(p_reason, ''), 'AI review could not be started. Please retry.'), 1000),
      updated_at = v_now
  WHERE id = p_plan_id;

  INSERT INTO ai_review_logs (
    id, plan_id, teacher_id, outcome, error_code, message, latency_ms
  ) VALUES (
    'ailog-dispatch-' || p_plan_id || '-' || FLOOR(EXTRACT(EPOCH FROM v_now) * 1000000)::BIGINT::TEXT,
    p_plan_id,
    v_plan.teacher_id,
    'unknown',
    'DISPATCH_FAILED',
    LEFT(COALESCE(NULLIF(p_reason, ''), 'AI review could not be started. Please retry.'), 1000),
    0
  );

  RETURN TRUE;
END;
$$;

REVOKE ALL ON FUNCTION mark_lesson_plan_review_dispatch_failed(TEXT, TIMESTAMPTZ, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION mark_lesson_plan_review_dispatch_failed(TEXT, TIMESTAMPTZ, TEXT) TO authenticated;

-- Called only by the service-role Edge Function. The row lock and attempt-time
-- check prevent a slow/stale job from replacing a supervisor decision or a
-- newer retry. All result rows and the in_review transition commit together.
CREATE OR REPLACE FUNCTION persist_lesson_plan_ai_review_attempt(
  p_plan_id TEXT,
  p_ai_started_at TIMESTAMPTZ,
  p_review JSONB,
  p_period_reviews JSONB DEFAULT '[]'::JSONB
) RETURNS BOOLEAN
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = public
AS $$
DECLARE
  v_plan lesson_plans%ROWTYPE;
  v_period JSONB;
BEGIN
  SELECT * INTO v_plan
  FROM lesson_plans
  WHERE id = p_plan_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN FALSE;
  END IF;

  IF v_plan.status <> 'submitted'
     OR v_plan.ai_started_at IS DISTINCT FROM p_ai_started_at THEN
    RETURN FALSE;
  END IF;

  DELETE FROM lesson_period_ai_reviews WHERE plan_id = p_plan_id;
  DELETE FROM ai_reviews WHERE plan_id = p_plan_id;

  INSERT INTO ai_reviews (
    id,
    plan_id,
    scores,
    executive_summary,
    total_score,
    percentage,
    performance_level,
    strengths,
    improvements,
    ai_summary_notes,
    additional_data,
    status
  ) VALUES (
    p_review->>'id',
    p_plan_id,
    p_review->'scores',
    p_review->>'executive_summary',
    (p_review->>'total_score')::INTEGER,
    (p_review->>'percentage')::INTEGER,
    p_review->>'performance_level',
    COALESCE(p_review->'strengths', '[]'::JSONB),
    COALESCE(p_review->'improvements', '[]'::JSONB),
    COALESCE(p_review->'ai_summary_notes', '{}'::JSONB),
    COALESCE(p_review->'additional_data', '{}'::JSONB),
    'pending'
  );

  FOR v_period IN
    SELECT value FROM jsonb_array_elements(COALESCE(p_period_reviews, '[]'::JSONB))
  LOOP
    INSERT INTO lesson_period_ai_reviews (
      id,
      plan_id,
      period_id,
      period_order,
      alignment_status,
      review_text,
      alignment_reason,
      alignment_gap,
      revision_status,
      revision_reason,
      suggested_activities,
      unit_plan_id
    ) VALUES (
      v_period->>'id',
      p_plan_id,
      NULLIF(v_period->>'period_id', ''),
      (v_period->>'period_order')::INTEGER,
      v_period->>'alignment_status',
      v_period->>'review_text',
      NULLIF(v_period->>'alignment_reason', ''),
      NULLIF(v_period->>'alignment_gap', ''),
      COALESCE(NULLIF(v_period->>'revision_status', ''), 'not_applicable'),
      NULLIF(v_period->>'revision_reason', ''),
      v_period->'suggested_activities',
      NULLIF(v_period->>'unit_plan_id', '')
    );
  END LOOP;

  UPDATE lesson_plans
  SET status = 'in_review',
      ai_failure_reason = NULL,
      updated_at = clock_timestamp()
  WHERE id = p_plan_id;

  RETURN TRUE;
END;
$$;

REVOKE ALL ON FUNCTION persist_lesson_plan_ai_review_attempt(TEXT, TIMESTAMPTZ, JSONB, JSONB) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION persist_lesson_plan_ai_review_attempt(TEXT, TIMESTAMPTZ, JSONB, JSONB) TO service_role;
