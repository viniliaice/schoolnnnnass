# Academic reminders

Academic reminders use the existing Web Push/VAPID sender, teacher subscriptions,
preferences, diagnostics, and `notifications` / `notification_recipients` history.
They do not create a second push or subscription system.

## Deployment

1. Apply `supabase/migrations/20261007_teacher_academic_reminders.sql` after the
   existing push-notification and marks-monitor migrations. It adds the marks
   preference, reminder metadata/statuses, two independent schedule rows, an
   atomic deduplication claim, and a service-role-only wrapper around the
   authoritative `monitor_marks_entries` RPC.
2. Keep the existing server-only Supabase and VAPID variables configured:
   `SUPABASE_URL` (or existing `VITE_SUPABASE_URL`), `SUPABASE_ANON_KEY` (or
   existing `VITE_SUPABASE_ANON_KEY`), `SUPABASE_SERVICE_ROLE_KEY`,
   `VAPID_PRIVATE_KEY`, and `VAPID_SUBJECT`.
3. Set `CRON_SECRET` in the Vercel project to a long random value (at least 16
   characters; 32 random bytes is recommended). Vercel's configured Cron sends
   this as a bearer token to `/api/academic-reminders/cron`. Do not put it in
   browser variables or client code.
4. Deploy the app. `vercel.json` checks the two schedule rows every five minutes.
   Admins and supervisors can independently enable/configure each reminder's
   days, local send time, timezone, and (for marks) exam scope from the
   Academic reminders dashboard panel. The default school timezone is
   `Africa/Mogadishu`.
5. Confirm both schedule rows exist, the Cron request is authorized, and
   `/api/push/health` reports valid VAPID configuration before a production
   send.

## Eligibility and access

- **Lesson plans:** current school week, actual `lesson_plans` rows,
  `lesson_plan_periods`, `period_count`, required topic completion via the shared
  `summarizeDay()` rule (free periods excluded), plus the existing submission
  tracking/status. Assignment without a current-week plan is visible in
  submission tracking but does not by itself create a reminder task.
- **Marks:** source of truth is the existing `monitor_marks_entries` RPC. It
  retains `class_subjects`, selected-term roster, `LEFT` exclusions, exams, and
  the existing monthly coursework + Quiz rules; reminder code does not recreate
  those formulas.
- Teachers can inspect only their own tasks/history. Only admins/supervisors can
  inspect other teachers' delivery/subscription summaries, change schedules, or
  manually send reminders. Supervisors remain scoped to assigned classes.
- Each reminder type has independent configuration, preference, category,
  occurrence key, and delivery history. Repeated requests for the same
  teacher/type/period/entity/occurrence do not send a second push.
- Synthetic preview endpoints are not treated as real devices. HTTP 404/410
  retirement, recoverable network/429/5xx preservation, and 401/403 VAPID
  diagnostics continue to use the existing sender rules.

## Production acceptance check

A passing unit test or fake push endpoint is **not** proof of production
notification delivery. Validate each type separately with a real teacher phone:

1. Complete push setup on the teacher's phone and confirm it appears as an
   active real subscription (not a `preview.push.local` endpoint).
2. Create one eligible lesson-plan task and one eligible marks-entry task in
   their respective academic periods; trigger each reminder type separately.
3. Confirm the phone receives each distinct reminder, then inspect the existing
   notification history for each category, recipient, occurrence, and actual
   device outcome (`sent`, `failed`, `expired`, or another recorded status).
4. Complete the underlying academic work and refresh the task view; it should no
   longer be eligible. Confirm repeating the same event does not send a
   duplicate. Inspect `last_error` for any failed device outcome.

Until those real-device steps have been performed against the production
Vercel/Supabase environment, production delivery remains unverified.
