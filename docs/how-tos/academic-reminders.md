# Academic reminders

Academic reminders reuse the existing Web Push/VAPID sender, teacher
subscriptions, preferences, diagnostics, and `notifications` /
`notification_recipients` history. They do not create a second push or
subscription system.

## Deployment

1. Apply `supabase/migrations/20261007_teacher_academic_reminders.sql` after the
   existing push-notification and marks-monitor migrations. It adds the marks
   preference, reminder metadata/stages, two independent schedule rows, an
   atomic deduplication claim, and a service-role-only wrapper around the
   authoritative `monitor_marks_entries` RPC.
2. Keep the existing server-only Supabase and VAPID variables configured:
   `SUPABASE_URL` (or existing `VITE_SUPABASE_URL`), `SUPABASE_ANON_KEY` (or
   existing `VITE_SUPABASE_ANON_KEY`), `SUPABASE_SERVICE_ROLE_KEY`,
   `VAPID_PRIVATE_KEY`, and `VAPID_SUBJECT`.
3. Set `CRON_SECRET` in the Vercel project to a long random value (at least 16
   characters; 32 random bytes is recommended). Vercel sends it as a bearer
   token to `/api/academic-reminders/cron`. Do not put it in browser variables
   or client code.
4. `vercel.json` runs one daily Cron at 13:00 UTC, which is 16:00 in
   `Africa/Mogadishu`, so it works on Vercel Hobby. The school timezone and
   trigger time are fixed to `Africa/Mogadishu` and 16:00 for this daily plan.
   Admins/supervisors can independently enable or disable each reminder and
   choose lesson-plan reminder weekdays. The marks schedule follows the 5th/10th
   policy below; its scope selector applies only to authorized manual sends.
5. Confirm both schedule rows exist, the Cron request is authorized, and
   `/api/push/health` reports valid VAPID configuration before a production
   send.

## Eligibility and schedule policy

- **Lesson plans:** on enabled weekdays, the daily 16:00 Mogadishu Cron checks
  the current school week using actual `lesson_plans` rows,
  `lesson_plan_periods`, `period_count`, required topic completion via the
  shared `summarizeDay()` rule (free periods excluded), and the existing
  submission tracking/status. Assignment without a current-week plan does not
  by itself create a reminder task.
- **Marks:** scheduled checks run only on local calendar days 5 and 10 in
  `Africa/Mogadishu`, always against the previous calendar month's monthly
  coursework + Quiz entries. For example, October 5/10 checks September; January
  5/10 checks December of the prior year. The existing
  `monitor_marks_entries` RPC remains the source of truth for `class_subjects`,
  selected-term rosters, `LEFT` exclusions, exams, and completion rules.
  - On the 5th, incomplete entries produce a **Marks Entry Reminder**.
  - On the 10th, entries are checked again. If still incomplete, a **Marks Entry
    Penalty** notice is sent and the recipient history records
    `reminder_stage = 'penalty'`. Completing entries before the 10th stops the
    penalty notice.
  - The repository contains no penalty calculation or deduction data. The app
    records/reports the penalty-notice stage and does not invent a numeric
    amount or percentage.
- Teachers can inspect only their own tasks/history. Only admins/supervisors can
  inspect other teachers' delivery/subscription summaries, change schedules,
  or manually send reminders. Supervisors remain scoped to assigned classes.
- Each reminder type has independent configuration, preference, category,
  occurrence key, and delivery history. The reminder and penalty stages have
  separate event keys. Repeating the same teacher/type/period/entity/stage event
  does not send a second push.
- Synthetic preview endpoints are not treated as real devices. HTTP 404/410
  retirement, recoverable network/429/5xx preservation, and 401/403 VAPID
  diagnostics continue to use the existing sender rules.

## Production acceptance check

A passing unit test or fake push endpoint is **not** proof of production
notification delivery. Validate each type separately with a real teacher phone:

1. Complete push setup on the teacher's phone and confirm it appears as an
   active real subscription (not a `preview.push.local` endpoint).
2. Create one eligible current-week lesson-plan task and one eligible prior-month
   marks task. On the 5th, confirm the Marks Entry Reminder is received; on the
   10th, leave an entry incomplete and confirm the distinct penalty notice is
   received. Also verify completion before the 10th prevents the penalty notice.
3. Inspect existing notification history for each recipient, occurrence/stage,
   and actual device outcome (`sent`, `failed`, `expired`, or another recorded
   status). Confirm the marks task shows the recorded penalty-notice status.
4. Complete the underlying lesson-plan work; it should no longer qualify.
   Confirm repeating the same event does not send a duplicate. Inspect
   `last_error` for failed device outcomes.

Until those real-device steps have been performed against the production
Vercel/Supabase environment, production delivery remains unverified.
