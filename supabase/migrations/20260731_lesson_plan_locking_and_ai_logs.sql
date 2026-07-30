-- Migration: Lesson plan locking, revision workflow, and AI failure logging
--
-- 1. Adds the 'revision_requested' status so a submitted plan can be reopened.
-- 2. Enforces locking SERVER-SIDE: once a plan is submitted it cannot be edited
--    (neither the plan row nor its periods) unless it is in draft or
--    revision_requested. Hiding UI controls is not sufficient.
-- 3. Adds ai_review_logs so AI failures are inspectable without waiting for a
--    teacher to report them.

-- ============================================================================
-- 1. NEW STATUS: revision_requested
-- ============================================================================
ALTER TABLE lesson_plans DROP CONSTRAINT IF EXISTS lesson_plans_status_check;
ALTER TABLE lesson_plans ADD CONSTRAINT lesson_plans_status_check
  CHECK (status IN (
    'draft', 'submitted', 'in_review', 'approved',
    'rejected', 'ai_failed', 'revision_requested'
  ));

-- Track when the AI review started so a stuck plan can be timed out, and who
-- asked for a revision / why.
ALTER TABLE lesson_plans ADD COLUMN IF NOT EXISTS ai_started_at TIMESTAMPTZ;
ALTER TABLE lesson_plans ADD COLUMN IF NOT EXISTS ai_failure_reason TEXT;
ALTER TABLE lesson_plans ADD COLUMN IF NOT EXISTS revision_note TEXT;
ALTER TABLE lesson_plans ADD COLUMN IF NOT EXISTS revision_requested_at TIMESTAMPTZ;

-- ============================================================================
-- 2. SERVER-SIDE LOCKING
-- ============================================================================
-- A plan is editable only while it is a draft or has been explicitly marked for
-- revision. Everything else (submitted / in_review / approved / rejected /
-- ai_failed) is locked to the teacher.
CREATE OR REPLACE FUNCTION lesson_plan_is_editable(p_status TEXT)
RETURNS BOOLEAN
  LANGUAGE sql
  IMMUTABLE
AS $$
  SELECT p_status IN ('draft', 'revision_requested');
$$;

-- Guard the plan row itself. Status transitions are still allowed (that is how
-- submission and supervisor decisions work) but the *content* of a locked plan
-- may not change.
CREATE OR REPLACE FUNCTION enforce_lesson_plan_lock()
RETURNS TRIGGER
  LANGUAGE plpgsql
AS $$
BEGIN
  -- Only guard content edits; a pure status/metadata change is always allowed.
  IF NOT lesson_plan_is_editable(OLD.status) THEN
    IF (NEW.title IS DISTINCT FROM OLD.title)
       OR (NEW.class_name IS DISTINCT FROM OLD.class_name)
       OR (NEW.week_label IS DISTINCT FROM OLD.week_label)
       OR (NEW.period_count IS DISTINCT FROM OLD.period_count)
       OR (NEW.subject_id IS DISTINCT FROM OLD.subject_id)
    THEN
      RAISE EXCEPTION
        'Lesson plan % is locked (status: %). Ask a supervisor to request revisions before editing.',
        OLD.id, OLD.status
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_lesson_plans_lock ON lesson_plans;
CREATE TRIGGER trg_lesson_plans_lock
  BEFORE UPDATE ON lesson_plans
  FOR EACH ROW EXECUTE FUNCTION enforce_lesson_plan_lock();

-- Guard the periods. This is the important one: it blocks the actual grid edits
-- regardless of which client or RPC attempts the write.
CREATE OR REPLACE FUNCTION enforce_lesson_plan_period_lock()
RETURNS TRIGGER
  LANGUAGE plpgsql
AS $$
DECLARE
  v_plan_id TEXT;
  v_status  TEXT;
BEGIN
  v_plan_id := COALESCE(NEW.plan_id, OLD.plan_id);

  SELECT status INTO v_status FROM lesson_plans WHERE id = v_plan_id;

  IF v_status IS NOT NULL AND NOT lesson_plan_is_editable(v_status) THEN
    RAISE EXCEPTION
      'Lesson plan % is locked (status: %). Its periods cannot be modified.',
      v_plan_id, v_status
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN COALESCE(NEW, OLD);
END;
$$;

DROP TRIGGER IF EXISTS trg_lesson_plan_periods_lock ON lesson_plan_periods;
CREATE TRIGGER trg_lesson_plan_periods_lock
  BEFORE INSERT OR UPDATE OR DELETE ON lesson_plan_periods
  FOR EACH ROW EXECUTE FUNCTION enforce_lesson_plan_period_lock();

-- The save RPC is SECURITY DEFINER, so re-assert the lock inside it to return a
-- clean error rather than a raw trigger failure.
CREATE OR REPLACE FUNCTION save_lesson_plan_periods(
  p_plan_id TEXT,
  p_periods JSONB
) RETURNS SETOF lesson_plan_periods
  LANGUAGE plpgsql
  SECURITY DEFINER
AS $$
DECLARE
  v_status TEXT;
BEGIN
  SELECT status INTO v_status FROM lesson_plans WHERE id = p_plan_id;

  IF v_status IS NULL THEN
    RAISE EXCEPTION 'Lesson plan % not found', p_plan_id USING ERRCODE = 'no_data_found';
  END IF;

  IF NOT lesson_plan_is_editable(v_status) THEN
    RAISE EXCEPTION
      'Lesson plan % is locked (status: %). Ask a supervisor to request revisions before editing.',
      p_plan_id, v_status
      USING ERRCODE = 'check_violation';
  END IF;

  DELETE FROM lesson_plan_periods WHERE plan_id = p_plan_id;

  INSERT INTO lesson_plan_periods (id, plan_id, day, period_number, topic, objective, activities, slide_number, details, sort_order, subject, class_name, is_free)
  SELECT
    'period-' || p_plan_id || '-' || (elem->>'day') || '-' || (elem->>'period_number'),
    p_plan_id,
    (elem->>'day')::day_of_week,
    (elem->>'period_number')::INTEGER,
    elem->>'topic',
    elem->>'objective',
    elem->>'activities',
    elem->>'slide_number',
    COALESCE(elem->'details', '[]'::jsonb),
    row_number() OVER () - 1,
    elem->>'subject',
    elem->>'class_name',
    COALESCE((elem->>'is_free')::boolean, false)
  FROM jsonb_array_elements(p_periods) AS elem;

  RETURN QUERY
  SELECT * FROM lesson_plan_periods
  WHERE plan_id = p_plan_id
  ORDER BY day, period_number;
END;
$$;

-- Reopen a locked plan for editing. Only supervisors/admins should call this.
CREATE OR REPLACE FUNCTION request_lesson_plan_revision(
  p_plan_id TEXT,
  p_note    TEXT DEFAULT NULL
) RETURNS lesson_plans
  LANGUAGE plpgsql
  SECURITY DEFINER
AS $$
DECLARE
  v_plan lesson_plans;
BEGIN
  UPDATE lesson_plans
  SET status                = 'revision_requested',
      revision_note         = p_note,
      revision_requested_at = NOW(),
      updated_at            = NOW()
  WHERE id = p_plan_id
  RETURNING * INTO v_plan;

  IF v_plan.id IS NULL THEN
    RAISE EXCEPTION 'Lesson plan % not found', p_plan_id USING ERRCODE = 'no_data_found';
  END IF;

  RETURN v_plan;
END;
$$;

-- ============================================================================
-- 3. AI REVIEW FAILURE LOG
-- ============================================================================
CREATE TABLE IF NOT EXISTS ai_review_logs (
  id           TEXT PRIMARY KEY,
  plan_id      TEXT REFERENCES lesson_plans(id) ON DELETE CASCADE,
  teacher_id   TEXT REFERENCES profiles(id) ON DELETE SET NULL,
  outcome      TEXT NOT NULL CHECK (outcome IN ('success', 'timeout', 'api_error', 'unit_match_error', 'malformed_json', 'rate_limit', 'save_error', 'unknown')),
  error_code   TEXT,
  message      TEXT,
  latency_ms   INTEGER,
  attempt      INTEGER NOT NULL DEFAULT 1,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_ai_review_logs_plan ON ai_review_logs(plan_id);
CREATE INDEX IF NOT EXISTS idx_ai_review_logs_created ON ai_review_logs(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_ai_review_logs_outcome ON ai_review_logs(outcome);

ALTER TABLE ai_review_logs ENABLE ROW LEVEL SECURITY;

-- Admins/supervisors inspect the log; teachers see entries for their own plans.
CREATE POLICY "admin_all_ai_logs" ON ai_review_logs FOR ALL USING (true);

CREATE POLICY "teacher_select_own_ai_logs" ON ai_review_logs
  FOR SELECT
  USING (
    EXISTS (SELECT 1 FROM lesson_plans WHERE id = plan_id AND teacher_id = auth.uid())
  );

-- ============================================================================
-- 4. STUCK-PLAN TIMEOUT SWEEP
-- ============================================================================
-- Any plan left waiting on the AI past the threshold is flipped to ai_failed so
-- it can be retried, instead of hanging on "waiting" indefinitely.
CREATE OR REPLACE FUNCTION expire_stuck_ai_reviews(p_timeout_minutes INTEGER DEFAULT 3)
RETURNS SETOF lesson_plans
  LANGUAGE plpgsql
  SECURITY DEFINER
AS $$
DECLARE
  v_cutoff TIMESTAMPTZ := NOW() - make_interval(mins => GREATEST(1, p_timeout_minutes));
  v_plan   lesson_plans;
BEGIN
  FOR v_plan IN
    UPDATE lesson_plans lp
    SET status            = 'ai_failed',
        ai_failure_reason = format(
          'AI review timed out after %s minutes with no response.', p_timeout_minutes
        ),
        updated_at        = NOW()
    WHERE lp.status = 'submitted'
      AND COALESCE(lp.ai_started_at, lp.updated_at) < v_cutoff
      AND NOT EXISTS (SELECT 1 FROM ai_reviews r WHERE r.plan_id = lp.id)
    RETURNING *
  LOOP
    INSERT INTO ai_review_logs (id, plan_id, teacher_id, outcome, error_code, message)
    VALUES (
      'ailog-' || v_plan.id || '-' || extract(epoch FROM NOW())::BIGINT,
      v_plan.id,
      v_plan.teacher_id,
      'timeout',
      'TIMEOUT',
      format('Auto-expired: no AI review after %s minutes.', p_timeout_minutes)
    )
    ON CONFLICT (id) DO NOTHING;

    RETURN NEXT v_plan;
  END LOOP;
END;
$$;
