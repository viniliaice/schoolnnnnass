-- Queue lesson-plan review only after a confirmed status transition, and persist
-- aggregate + per-period AI results atomically for the matching attempt.

-- Expire pending attempts through one authoritative, actor-scoped sweep. A
-- teacher can expire only their own stale attempts; supervisors/admins can
-- sweep all visible plans. The conditional UPDATE remains race-safe against a
-- concurrent retry or successful persistence transaction.
CREATE OR REPLACE FUNCTION expire_stuck_ai_reviews(p_timeout_minutes INTEGER DEFAULT 3)
RETURNS SETOF lesson_plans
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = public
AS $$
DECLARE
  v_cutoff TIMESTAMPTZ := clock_timestamp() - make_interval(mins => GREATEST(1, p_timeout_minutes));
  v_plan lesson_plans%ROWTYPE;
  v_profile_id TEXT;
  v_role TEXT;
  v_now TIMESTAMPTZ := clock_timestamp();
BEGIN
  SELECT id, role INTO v_profile_id, v_role
  FROM profiles
  WHERE auth_id = auth.uid();

  IF v_profile_id IS NULL THEN
    RAISE EXCEPTION 'No profile is associated with the current user.'
      USING ERRCODE = '42501';
  END IF;

  FOR v_plan IN
    UPDATE lesson_plans lp
    SET status = 'ai_failed',
        ai_failure_reason = format(
          'AI review timed out after %s minutes with no response.',
          GREATEST(1, p_timeout_minutes)
        ),
        updated_at = v_now
    WHERE lp.status = 'submitted'
      AND lp.ai_started_at IS NOT NULL
      AND lp.ai_started_at < v_cutoff
      AND (
        lp.teacher_id = v_profile_id
        OR COALESCE(v_role, '') IN ('supervisor', 'admin')
      )
      AND NOT EXISTS (SELECT 1 FROM ai_reviews r WHERE r.plan_id = lp.id)
    RETURNING lp.*
  LOOP
    INSERT INTO ai_review_logs (
      id, plan_id, teacher_id, outcome, error_code, message, latency_ms
    ) VALUES (
      'ailog-timeout-' || v_plan.id || '-' || FLOOR(EXTRACT(EPOCH FROM v_now) * 1000000)::BIGINT::TEXT,
      v_plan.id,
      v_plan.teacher_id,
      'timeout',
      'TIMEOUT',
      format('Auto-expired: no AI review after %s minutes.', GREATEST(1, p_timeout_minutes)),
      LEAST(
        2147483647,
        GREATEST(0, FLOOR(EXTRACT(EPOCH FROM (v_now - v_plan.ai_started_at)) * 1000))
      )::INTEGER
    );

    RETURN NEXT v_plan;
  END LOOP;
END;
$$;

REVOKE ALL ON FUNCTION expire_stuck_ai_reviews(INTEGER) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION expire_stuck_ai_reviews(INTEGER) TO authenticated;

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

-- Retry/redo transition. Owners may recover their own ai_failed attempt;
-- supervisors/admins may also reset submitted or in_review attempts. Every
-- allowed retry creates a timestamp so a late older result is discarded.
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

  IF v_plan.status NOT IN ('submitted', 'ai_failed', 'in_review') THEN
    RAISE EXCEPTION 'Lesson plan % cannot retry AI review from status %.', p_plan_id, v_plan.status
      USING ERRCODE = 'check_violation';
  END IF;

  IF COALESCE(v_role, '') NOT IN ('supervisor', 'admin') THEN
    IF v_plan.teacher_id IS DISTINCT FROM v_profile_id THEN
      RAISE EXCEPTION 'You may not retry the AI review for lesson plan %.', p_plan_id
        USING ERRCODE = '42501';
    END IF;

    -- Owners may recover a failed attempt, but may not cancel a live attempt or
    -- erase a review that has already reached the supervisor. Supervisors/admins
    -- retain the broader retry control used by the review screen.
    IF v_plan.status <> 'ai_failed' THEN
      RAISE EXCEPTION 'Only a supervisor or administrator may retry an active lesson-plan review.'
        USING ERRCODE = '42501';
    END IF;
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

-- Provider, validation, and persistence failures are owned by the service-role
-- background job. Status change and inspectable failure log commit together,
-- but only while this exact attempt remains pending.
CREATE OR REPLACE FUNCTION mark_lesson_plan_ai_review_attempt_failed(
  p_plan_id TEXT,
  p_ai_started_at TIMESTAMPTZ,
  p_outcome TEXT DEFAULT 'unknown',
  p_error_code TEXT DEFAULT 'UNKNOWN',
  p_reason TEXT DEFAULT 'AI review generation failed. Please retry.',
  p_latency_ms INTEGER DEFAULT NULL
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_plan lesson_plans%ROWTYPE;
  v_now TIMESTAMPTZ := clock_timestamp();
  v_outcome TEXT;
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

  v_outcome := CASE
    WHEN p_outcome IN (
      'success', 'timeout', 'api_error', 'unit_match_error',
      'malformed_json', 'rate_limit', 'save_error', 'unknown'
    ) THEN p_outcome
    ELSE 'unknown'
  END;

  UPDATE lesson_plans
  SET status = 'ai_failed',
      ai_failure_reason = LEFT(
        COALESCE(NULLIF(p_reason, ''), 'AI review generation failed. Please retry.'),
        1000
      ),
      updated_at = v_now
  WHERE id = p_plan_id;

  INSERT INTO ai_review_logs (
    id, plan_id, teacher_id, outcome, error_code, message, latency_ms
  ) VALUES (
    'ailog-failure-' || p_plan_id || '-' || FLOOR(EXTRACT(EPOCH FROM v_now) * 1000000)::BIGINT::TEXT,
    p_plan_id,
    v_plan.teacher_id,
    v_outcome,
    LEFT(COALESCE(NULLIF(p_error_code, ''), 'UNKNOWN'), 100),
    LEFT(COALESCE(NULLIF(p_reason, ''), 'AI review generation failed. Please retry.'), 1000),
    CASE WHEN p_latency_ms IS NULL THEN NULL ELSE GREATEST(0, p_latency_ms) END
  );

  RETURN TRUE;
END;
$$;

REVOKE ALL ON FUNCTION mark_lesson_plan_ai_review_attempt_failed(TEXT, TIMESTAMPTZ, TEXT, TEXT, TEXT, INTEGER) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION mark_lesson_plan_ai_review_attempt_failed(TEXT, TIMESTAMPTZ, TEXT, TEXT, TEXT, INTEGER) TO service_role;

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

-- Make the supervisor's final decision and review comment one row-locked
-- transaction. Since persistence locks the same lesson_plans row first, a slow
-- AI attempt can never delete or replace a decision that this RPC committed.
CREATE OR REPLACE FUNCTION decide_lesson_plan_review(
  p_plan_id TEXT,
  p_status TEXT,
  p_supervisor_comment TEXT DEFAULT NULL
)
RETURNS SETOF lesson_plans
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_plan lesson_plans%ROWTYPE;
  v_profile_id TEXT;
  v_role TEXT;
  v_now TIMESTAMPTZ := clock_timestamp();
  v_comment TEXT := COALESCE(p_supervisor_comment, '');
BEGIN
  SELECT id, role INTO v_profile_id, v_role
  FROM profiles
  WHERE auth_id = auth.uid();

  IF v_profile_id IS NULL OR COALESCE(v_role, '') NOT IN ('supervisor', 'admin') THEN
    RAISE EXCEPTION 'Only a supervisor or administrator may decide a lesson-plan review.'
      USING ERRCODE = '42501';
  END IF;

  IF p_status NOT IN ('approved', 'rejected') THEN
    RAISE EXCEPTION 'Invalid lesson-plan decision status: %', p_status
      USING ERRCODE = 'check_violation';
  END IF;

  SELECT * INTO v_plan
  FROM lesson_plans
  WHERE id = p_plan_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Lesson plan % was not found.', p_plan_id
      USING ERRCODE = 'P0002';
  END IF;

  IF v_plan.status NOT IN ('submitted', 'in_review', 'ai_failed', 'approved', 'rejected') THEN
    RAISE EXCEPTION 'Lesson plan % cannot be decided from status %.', p_plan_id, v_plan.status
      USING ERRCODE = 'check_violation';
  END IF;

  IF EXISTS (SELECT 1 FROM ai_reviews WHERE plan_id = p_plan_id) THEN
    UPDATE ai_reviews
    SET status = 'reviewed',
        supervisor_comment = v_comment,
        updated_at = v_now
    WHERE plan_id = p_plan_id;
  ELSIF BTRIM(v_comment) <> '' THEN
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
      status,
      supervisor_comment
    ) VALUES (
      'review-manual-' || p_plan_id || '-' || FLOOR(EXTRACT(EPOCH FROM v_now) * 1000000)::BIGINT::TEXT,
      p_plan_id,
      jsonb_build_object(
        'learning_objectives', jsonb_build_object('score', 0, 'explanation', 'Not scored — reviewed manually by the supervisor.'),
        'lesson_structure', jsonb_build_object('score', 0, 'explanation', 'Not scored — reviewed manually by the supervisor.'),
        'student_engagement', jsonb_build_object('score', 0, 'explanation', 'Not scored — reviewed manually by the supervisor.'),
        'teaching_strategies', jsonb_build_object('score', 0, 'explanation', 'Not scored — reviewed manually by the supervisor.'),
        'differentiation', jsonb_build_object('score', 0, 'explanation', 'Not scored — reviewed manually by the supervisor.'),
        'assessment_methods', jsonb_build_object('score', 0, 'explanation', 'Not scored — reviewed manually by the supervisor.'),
        'curriculum_alignment', jsonb_build_object('score', 0, 'explanation', 'Not scored — reviewed manually by the supervisor.'),
        'classroom_management', jsonb_build_object('score', 0, 'explanation', 'Not scored — reviewed manually by the supervisor.'),
        'resources_materials', jsonb_build_object('score', 0, 'explanation', 'Not scored — reviewed manually by the supervisor.'),
        'overall_quality', jsonb_build_object('score', 0, 'explanation', 'Not scored — reviewed manually by the supervisor.')
      ),
      'The AI review was unavailable for this plan. The supervisor reviewed it manually.',
      0,
      0,
      'Manual review',
      '[]'::JSONB,
      '[]'::JSONB,
      jsonb_build_object('status_recommendation', 'Manual review', 'reasoning', BTRIM(v_comment)),
      jsonb_build_object('manual', TRUE),
      'reviewed',
      BTRIM(v_comment)
    );
  END IF;

  UPDATE lesson_plans
  SET status = p_status,
      updated_at = v_now
  WHERE id = p_plan_id;

  RETURN QUERY SELECT * FROM lesson_plans WHERE id = p_plan_id;
END;
$$;

REVOKE ALL ON FUNCTION decide_lesson_plan_review(TEXT, TEXT, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION decide_lesson_plan_review(TEXT, TEXT, TEXT) TO authenticated;

-- Replace the older unrestricted SECURITY DEFINER implementation with an
-- explicitly authorized, row-locked supervisor/admin transition. A pending AI
-- job sees revision_requested after this transaction and discards its result.
CREATE OR REPLACE FUNCTION request_lesson_plan_revision(
  p_plan_id TEXT,
  p_note TEXT DEFAULT NULL
)
RETURNS lesson_plans
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

  IF v_profile_id IS NULL OR COALESCE(v_role, '') NOT IN ('supervisor', 'admin') THEN
    RAISE EXCEPTION 'Only a supervisor or administrator may request lesson-plan revisions.'
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

  IF v_plan.status IN ('draft', 'revision_requested') THEN
    RAISE EXCEPTION 'Lesson plan % cannot request revisions from status %.', p_plan_id, v_plan.status
      USING ERRCODE = 'check_violation';
  END IF;

  UPDATE lesson_plans
  SET status = 'revision_requested',
      revision_note = p_note,
      revision_requested_at = v_now,
      updated_at = v_now
  WHERE id = p_plan_id
  RETURNING * INTO v_plan;

  RETURN v_plan;
END;
$$;

REVOKE ALL ON FUNCTION request_lesson_plan_revision(TEXT, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION request_lesson_plan_revision(TEXT, TEXT) TO authenticated;
