-- Teacher push notifications + PWA push subscriptions (2026-10-05)
--
-- Adds the PWA push-notification system on top of the existing profile/auth
-- model (profiles.auth_id -> auth.users). No existing table is altered.
--
-- Security model (matches the repo's established pattern):
--   * Every table has RLS enabled; teachers can only read/write THEIR OWN
--     subscription / preferences / notification rows.
--   * The admin fan-out runs through the Vercel serverless function with the
--     service-role key (bypasses RLS), never through the browser.
--   * current_session_context() lets the serverless function verify the
--     caller's role using the same DB role system the app uses everywhere
--     else (the function passes the caller's access token to PostgREST).

-- ─── Tables ────────────────────────────────────────────────────────────────

-- Browser/device push subscriptions. A teacher may register many devices
-- (phone + laptop); each device gets its own row keyed by the push endpoint.
CREATE TABLE IF NOT EXISTS public.push_subscriptions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  endpoint TEXT NOT NULL,
  p256dh TEXT NOT NULL,
  auth TEXT NOT NULL,
  device_type TEXT,
  browser TEXT,
  user_agent TEXT,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- One row per endpoint: re-registering the same device updates the existing
-- row instead of creating a duplicate; two different devices never collide.
CREATE UNIQUE INDEX IF NOT EXISTS push_subscriptions_endpoint_uq
  ON public.push_subscriptions (endpoint);
CREATE INDEX IF NOT EXISTS push_subscriptions_user_active_idx
  ON public.push_subscriptions (user_id) WHERE is_active;

-- Per-teacher notification preferences (defaults all-on; missing row = on).
CREATE TABLE IF NOT EXISTS public.notification_preferences (
  user_id TEXT PRIMARY KEY REFERENCES public.profiles(id) ON DELETE CASCADE,
  push_enabled BOOLEAN NOT NULL DEFAULT TRUE,
  announcements BOOLEAN NOT NULL DEFAULT TRUE,
  messages BOOLEAN NOT NULL DEFAULT TRUE,
  lesson_plan_reminders BOOLEAN NOT NULL DEFAULT TRUE,
  admin_alerts BOOLEAN NOT NULL DEFAULT TRUE,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Notification history (what the admin sent).
CREATE TABLE IF NOT EXISTS public.notifications (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  url TEXT,
  category TEXT NOT NULL DEFAULT 'general',
  sender_id TEXT REFERENCES public.profiles(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS notifications_created_idx
  ON public.notifications (created_at DESC);

-- Per-recipient delivery record: lets teachers see their own history
-- (read/unread) and admins see per-recipient status.
CREATE TABLE IF NOT EXISTS public.notification_recipients (
  id TEXT PRIMARY KEY,
  notification_id TEXT NOT NULL REFERENCES public.notifications(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'sent', 'failed', 'no_devices', 'skipped')),
  delivered_devices INTEGER NOT NULL DEFAULT 0,
  failed_devices INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  read_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (notification_id, user_id)
);
CREATE INDEX IF NOT EXISTS notification_recipients_user_idx
  ON public.notification_recipients (user_id, created_at DESC);

-- ─── updated_at maintenance ────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.touch_push_subscription_updated_at()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  NEW.updated_at := NOW();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS push_subscriptions_touch_updated_at ON public.push_subscriptions;
CREATE TRIGGER push_subscriptions_touch_updated_at
  BEFORE UPDATE ON public.push_subscriptions
  FOR EACH ROW EXECUTE FUNCTION public.touch_push_subscription_updated_at();

-- ─── Session context RPC (used by the Vercel send function) ────────────────

-- Returns the caller's app profile id + role, resolved through the same
-- auth.users -> profiles bridge the whole app uses. The serverless function
-- calls this with the *caller's* access token so PostgREST sets auth.uid();
-- a teacher calling the send endpoint therefore resolves to role 'teacher'
-- and is rejected there.
CREATE OR REPLACE FUNCTION public.current_session_context()
RETURNS JSONB
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT jsonb_build_object(
    'profile_id', public.current_profile_id(),
    'role', public.current_profile_role()
  );
$$;

-- ─── Row Level Security ────────────────────────────────────────────────────

ALTER TABLE public.push_subscriptions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.notification_preferences ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.notifications ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.notification_recipients ENABLE ROW LEVEL SECURITY;

-- push_subscriptions: owners only. Endpoints/keys are per-device secrets.
DROP POLICY IF EXISTS "push_subscriptions_select_own" ON public.push_subscriptions;
CREATE POLICY "push_subscriptions_select_own" ON public.push_subscriptions
  FOR SELECT USING (user_id = public.current_profile_id());

DROP POLICY IF EXISTS "push_subscriptions_insert_own" ON public.push_subscriptions;
CREATE POLICY "push_subscriptions_insert_own" ON public.push_subscriptions
  FOR INSERT WITH CHECK (user_id = public.current_profile_id());

DROP POLICY IF EXISTS "push_subscriptions_update_own" ON public.push_subscriptions;
CREATE POLICY "push_subscriptions_update_own" ON public.push_subscriptions
  FOR UPDATE USING (user_id = public.current_profile_id())
  WITH CHECK (user_id = public.current_profile_id());

DROP POLICY IF EXISTS "push_subscriptions_delete_own" ON public.push_subscriptions;
CREATE POLICY "push_subscriptions_delete_own" ON public.push_subscriptions
  FOR DELETE USING (user_id = public.current_profile_id());

-- notification_preferences: owners only.
DROP POLICY IF EXISTS "notification_preferences_select_own" ON public.notification_preferences;
CREATE POLICY "notification_preferences_select_own" ON public.notification_preferences
  FOR SELECT USING (user_id = public.current_profile_id());

DROP POLICY IF EXISTS "notification_preferences_insert_own" ON public.notification_preferences;
CREATE POLICY "notification_preferences_insert_own" ON public.notification_preferences
  FOR INSERT WITH CHECK (user_id = public.current_profile_id());

DROP POLICY IF EXISTS "notification_preferences_update_own" ON public.notification_preferences;
CREATE POLICY "notification_preferences_update_own" ON public.notification_preferences
  FOR UPDATE USING (user_id = public.current_profile_id())
  WITH CHECK (user_id = public.current_profile_id());

-- notifications: admins/supervisors see the send log; recipients see what was
-- sent to them (joined through notification_recipients below).
DROP POLICY IF EXISTS "notifications_select_staff" ON public.notifications;
CREATE POLICY "notifications_select_staff" ON public.notifications
  FOR SELECT USING (
    public.current_profile_role() IN ('admin', 'supervisor')
    OR EXISTS (
      SELECT 1 FROM public.notification_recipients nr
      WHERE nr.notification_id = public.notifications.id
        AND nr.user_id = public.current_profile_id()
    )
  );

-- notification_recipients: own rows, or staff oversight.
DROP POLICY IF EXISTS "notification_recipients_select_own_or_staff" ON public.notification_recipients;
CREATE POLICY "notification_recipients_select_own_or_staff" ON public.notification_recipients
  FOR SELECT USING (
    user_id = public.current_profile_id()
    OR public.current_profile_role() IN ('admin', 'supervisor')
  );

-- Teachers may only mark their own rows read (read_at is the only column the
-- client updates; delivery bookkeeping happens with the service role).
DROP POLICY IF EXISTS "notification_recipients_update_own" ON public.notification_recipients;
CREATE POLICY "notification_recipients_update_own" ON public.notification_recipients
  FOR UPDATE USING (user_id = public.current_profile_id())
  WITH CHECK (user_id = public.current_profile_id());

-- ─── Grants ────────────────────────────────────────────────────────────────

GRANT SELECT, INSERT, UPDATE, DELETE ON public.push_subscriptions TO authenticated;
GRANT SELECT, INSERT, UPDATE ON public.notification_preferences TO authenticated;
GRANT SELECT ON public.notifications TO authenticated;
GRANT SELECT, UPDATE ON public.notification_recipients TO authenticated;

REVOKE ALL ON FUNCTION public.current_session_context() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.current_session_context() TO authenticated;
