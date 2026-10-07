-- Unified academic reminders layered onto the existing Web Push system.
-- Notifications/subscriptions/history remain the one delivery architecture.

ALTER TABLE public.notification_preferences
  ADD COLUMN IF NOT EXISTS marks_entry_reminders BOOLEAN NOT NULL DEFAULT TRUE;

ALTER TABLE public.notification_recipients
  ADD COLUMN IF NOT EXISTS reminder_type TEXT,
  ADD COLUMN IF NOT EXISTS academic_period TEXT,
  ADD COLUMN IF NOT EXISTS relevant_entity TEXT,
  ADD COLUMN IF NOT EXISTS reminder_occurrence TEXT,
  ADD COLUMN IF NOT EXISTS reminder_stage TEXT,
  ADD COLUMN IF NOT EXISTS deduplication_key TEXT,
  ADD COLUMN IF NOT EXISTS expired_devices INTEGER NOT NULL DEFAULT 0;

COMMENT ON COLUMN public.notification_recipients.reminder_type IS
  'Academic reminder type; NULL for ordinary notifications.';
COMMENT ON COLUMN public.notification_recipients.academic_period IS
  'Canonical school-period key used to evaluate and deduplicate this reminder.';
COMMENT ON COLUMN public.notification_recipients.relevant_entity IS
  'Canonical lesson-plan/class-subject entity set represented by this reminder.';
COMMENT ON COLUMN public.notification_recipients.reminder_occurrence IS
  'Stable scheduled occurrence or manual idempotency event key.';
COMMENT ON COLUMN public.notification_recipients.reminder_stage IS
  'Academic reminder stage: reminder or penalty; NULL for ordinary notifications.';
COMMENT ON COLUMN public.notification_recipients.deduplication_key IS
  'SHA-256 key over teacher, type, academic period, entity, and occurrence.';

ALTER TABLE public.notification_recipients
  DROP CONSTRAINT IF EXISTS notification_recipients_reminder_stage_check;
ALTER TABLE public.notification_recipients
  ADD CONSTRAINT notification_recipients_reminder_stage_check
  CHECK (reminder_stage IS NULL OR reminder_stage IN ('reminder', 'penalty'));

-- Nullable unique values permit ordinary notifications while the partial
-- unique index makes a reminder event claim atomic without locking history.
CREATE UNIQUE INDEX IF NOT EXISTS notification_recipients_reminder_dedupe_uq
  ON public.notification_recipients (deduplication_key)
  WHERE deduplication_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS notification_recipients_reminder_lookup_idx
  ON public.notification_recipients (reminder_type, academic_period, user_id, created_at DESC)
  WHERE reminder_type IS NOT NULL;

ALTER TABLE public.notification_recipients
  DROP CONSTRAINT IF EXISTS notification_recipients_status_check;
ALTER TABLE public.notification_recipients
  ADD CONSTRAINT notification_recipients_status_check
  CHECK (status IN (
    'pending', 'sent', 'failed', 'no_devices', 'skipped',
    'no_subscription', 'expired', 'already_reminded', 'task_already_completed'
  ));

-- One independent schedule per reminder type. Cron checks these settings;
-- the database does not depend on a browser being open.
CREATE TABLE IF NOT EXISTS public.academic_reminder_schedules (
  reminder_type TEXT PRIMARY KEY
    CHECK (reminder_type IN ('lesson_plan_reminder', 'marks_entry_reminder')),
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  timezone TEXT NOT NULL DEFAULT 'Africa/Mogadishu',
  days_of_week SMALLINT[] NOT NULL DEFAULT ARRAY[2]::SMALLINT[],
  send_time TIME NOT NULL DEFAULT TIME '16:00',
  exam_scope TEXT NOT NULL DEFAULT 'monthly'
    CHECK (exam_scope IN (
      'monthly', 'midterm', 'final', 'ca', 'homework', 'classwork',
      'quiz', 'attendance', 'discipline'
    )),
  updated_by TEXT REFERENCES public.profiles(id) ON DELETE SET NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT academic_reminder_schedules_days_valid
    CHECK (cardinality(days_of_week) BETWEEN 1 AND 7
      AND days_of_week <@ ARRAY[0,1,2,3,4,5,6]::SMALLINT[])
);

INSERT INTO public.academic_reminder_schedules
  (reminder_type, enabled, timezone, days_of_week, send_time, exam_scope)
VALUES
  ('lesson_plan_reminder', TRUE, 'Africa/Mogadishu', ARRAY[2]::SMALLINT[], TIME '16:00', 'monthly'),
  ('marks_entry_reminder', TRUE, 'Africa/Mogadishu', ARRAY[0,1,2,3,4,5,6]::SMALLINT[], TIME '16:00', 'monthly')
ON CONFLICT (reminder_type) DO NOTHING;

ALTER TABLE public.academic_reminder_schedules ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS academic_reminder_schedules_select_staff ON public.academic_reminder_schedules;
CREATE POLICY academic_reminder_schedules_select_staff
  ON public.academic_reminder_schedules
  FOR SELECT TO authenticated
  USING (public.current_profile_role() IN ('admin', 'supervisor'));
DROP POLICY IF EXISTS academic_reminder_schedules_update_staff ON public.academic_reminder_schedules;
CREATE POLICY academic_reminder_schedules_update_staff
  ON public.academic_reminder_schedules
  FOR UPDATE TO authenticated
  USING (public.current_profile_role() IN ('admin', 'supervisor'))
  WITH CHECK (public.current_profile_role() IN ('admin', 'supervisor'));
GRANT SELECT, UPDATE ON public.academic_reminder_schedules TO authenticated;

-- Atomic idempotency claim. Only the service role may call this RPC; it inserts
-- the recipient claim before any push is attempted. A second cron invocation
-- for the same event receives no row and therefore cannot resend the push.
CREATE OR REPLACE FUNCTION public.claim_academic_reminder_recipients(p_rows JSONB)
RETURNS SETOF public.notification_recipients
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF COALESCE(auth.role(), '') <> 'service_role' THEN
    RAISE EXCEPTION 'Only the service role may claim academic reminders.'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  IF jsonb_typeof(p_rows) IS DISTINCT FROM 'array' THEN
    RAISE EXCEPTION 'Reminder claim input must be a JSON array.'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  RETURN QUERY
  INSERT INTO public.notification_recipients (
    id, notification_id, user_id, status, reminder_type, academic_period,
    relevant_entity, reminder_occurrence, reminder_stage, deduplication_key
  )
  SELECT
    r.id, r.notification_id, r.user_id, r.status, r.reminder_type,
    r.academic_period, r.relevant_entity, r.reminder_occurrence,
    r.reminder_stage, r.deduplication_key
  FROM jsonb_to_recordset(p_rows) AS r(
    id TEXT,
    notification_id TEXT,
    user_id TEXT,
    status TEXT,
    reminder_type TEXT,
    academic_period TEXT,
    relevant_entity TEXT,
    reminder_occurrence TEXT,
    reminder_stage TEXT,
    deduplication_key TEXT
  )
  ON CONFLICT (deduplication_key)
    WHERE deduplication_key IS NOT NULL
    DO NOTHING
  RETURNING public.notification_recipients.*;
END;
$$;

-- `monitor_marks_entries` intentionally permits only authenticated admins and
-- supervisors. Scheduled/teacher-self task reads run server-side as service
-- role, so this narrow wrapper supplies an existing admin identity internally
-- and calls the SAME authoritative monitor RPC. It does not reimplement marks
-- eligibility or return data to browser clients.
CREATE OR REPLACE FUNCTION public.monitor_marks_entries_for_reminders(
  p_academic_year_id TEXT,
  p_term_id TEXT,
  p_exam_scope TEXT DEFAULT 'monthly',
  p_month TEXT DEFAULT NULL,
  p_teacher_id TEXT DEFAULT NULL,
  p_class_name TEXT DEFAULT NULL,
  p_subject_id TEXT DEFAULT NULL
)
RETURNS TABLE (
  assignment_id TEXT,
  teacher_id TEXT,
  teacher_name TEXT,
  class_name TEXT,
  subject_id TEXT,
  subject_name TEXT,
  academic_year_id TEXT,
  term_id TEXT,
  exam_scope TEXT,
  month TEXT,
  expected_students INTEGER,
  entered_students INTEGER,
  missing_students JSONB,
  percentage NUMERIC,
  completion_status TEXT,
  last_updated TIMESTAMPTZ,
  ca_entered INTEGER,
  homework_entered INTEGER,
  homework_ca_entered INTEGER,
  classwork_entered INTEGER,
  quiz_entered INTEGER,
  attendance_entered INTEGER,
  coursework_complete BOOLEAN,
  quiz_complete BOOLEAN,
  monthly_complete_students INTEGER
)
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_admin_auth_id TEXT;
  v_original_claims TEXT;
  v_original_sub TEXT;
  v_original_role TEXT;
BEGIN
  IF COALESCE(auth.role(), '') <> 'service_role' THEN
    RAISE EXCEPTION 'Only the service role may invoke the reminder marks monitor.'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  SELECT p.auth_id::TEXT
    INTO v_admin_auth_id
  FROM public.profiles p
  WHERE lower(btrim(COALESCE(p.role, ''))) = 'admin'
    AND p.auth_id IS NOT NULL
  ORDER BY p.id
  LIMIT 1;

  IF v_admin_auth_id IS NULL THEN
    RAISE EXCEPTION 'No authenticated administrator is available for the marks monitor.'
      USING ERRCODE = 'no_data_found';
  END IF;

  v_original_claims := current_setting('request.jwt.claims', TRUE);
  v_original_sub := current_setting('request.jwt.claim.sub', TRUE);
  v_original_role := current_setting('request.jwt.claim.role', TRUE);
  PERFORM set_config('request.jwt.claim.sub', v_admin_auth_id, TRUE);
  PERFORM set_config('request.jwt.claim.role', 'authenticated', TRUE);
  PERFORM set_config(
    'request.jwt.claims',
    jsonb_build_object('sub', v_admin_auth_id, 'role', 'authenticated')::TEXT,
    TRUE
  );

  RETURN QUERY
  SELECT *
  FROM public.monitor_marks_entries(
    p_academic_year_id,
    p_term_id,
    p_exam_scope,
    p_month,
    p_teacher_id,
    p_class_name,
    p_subject_id
  );

  -- PostgREST runs each RPC in a transaction, but explicitly restore the
  -- claims for composability if this function is invoked by another routine.
  PERFORM set_config('request.jwt.claims', COALESCE(v_original_claims, ''), TRUE);
  PERFORM set_config('request.jwt.claim.sub', COALESCE(v_original_sub, ''), TRUE);
  PERFORM set_config('request.jwt.claim.role', COALESCE(v_original_role, ''), TRUE);
END;
$$;

REVOKE ALL ON FUNCTION public.claim_academic_reminder_recipients(JSONB) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.monitor_marks_entries_for_reminders(TEXT,TEXT,TEXT,TEXT,TEXT,TEXT,TEXT) FROM PUBLIC;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    EXECUTE 'GRANT EXECUTE ON FUNCTION public.claim_academic_reminder_recipients(JSONB) TO service_role';
    EXECUTE 'GRANT EXECUTE ON FUNCTION public.monitor_marks_entries_for_reminders(TEXT,TEXT,TEXT,TEXT,TEXT,TEXT,TEXT) TO service_role';
    EXECUTE 'GRANT SELECT, INSERT, UPDATE, DELETE ON public.academic_reminder_schedules TO service_role';
  END IF;
END $$;

-- Protect reminder metadata/deduplication keys from browser mutation. The only
-- recipient field the client changes is read_at; service role records outcomes.
REVOKE UPDATE ON public.notification_recipients FROM authenticated;
GRANT UPDATE (read_at) ON public.notification_recipients TO authenticated;
