# Update Log

## 2026-07-27
* **Creation**: Initial knowledge bundle for the Lesson Plan feature.
* **Creation**: Documented lesson_plans, lesson_plan_periods, ai_reviews tables.
* **Creation**: Documented RLS policies, RPC functions, edge function, and UI components.

## 2026-09-12
* **Update**: Lesson Plan Review is now week-first — a week selector (most recent submitted week selected by default) scopes the list, and the status filter only narrows that week.
* **Creation**: `src/lib/lessonPlanWeeks.ts` — groups stored `week_label` values into selectable weeks (newest first, date ranges, legacy spellings merged per week).
* **Creation**: `list_lesson_plan_weeks(TEXT[])` RPC + `(status, week_label)` index (migration `20260914_supervisor_lesson_plan_week_selector.sql`).
* **Creation**: `fetchSupervisorPlanWeeks()` and `fetchPlansBySupervisorForWeek(weekLabels)` in `src/lib/db/lessonPlans.ts`; matching `useSupervisorPlanWeeks()` / `useSupervisorPlansForWeek()` hooks.
* **Update**: Admin can now open the review page — `/admin/lesson-plans` (sidebar entry + route) and the supervisor path; both render `LessonPlanReview`. The database already granted admin the same rights, only the client routes were missing.

## 2026-09-15
* **Creation**: LessonPlanSubmissions — supervisor submission-tracking page at `/supervisor/lesson-plan-submissions` + `/admin/lesson-plan-submissions`. Roster-first (expected teachers from `profiles."assignedClasses"`), week selector generated from the academic-year calendar (zero-submission weeks selectable, current week default), summary cards + progress bar, missing-first sorting, status/class/search filters, mobile cards.
* **Creation**: `list_lesson_plan_submitters()` RPC (migration `20260915_lesson_plan_submission_tracking.sql`) — supervisor/admin-gated, SECURITY DEFINER read of the teacher roster; direct-read fallback until applied.
* **Creation**: `src/lib/lessonPlanSubmissionTracking.ts` (pure week/row/summary logic), `src/lib/db/lessonPlanSubmissions.ts`, `src/lib/hooks/useLessonPlanSubmissions.ts`, `src/lib/lessonPlanDeepLink.ts` (View hand-off into the review page).
* **Update**: LessonPlanReview accepts optional `navigate`/`submissionTrackingPath` props — a parked plan id opens directly and aligns the week selector; header gains a "Submission Tracking" cross-link. Fixed a latent crash when the selected plan row is missing (`planWithPeriods.plan` null).
* **Update**: Sidebar gains "Submission Tracking" (supervisor + admin); `ROUTE_ACCESS` lists both new paths; i18n adds the `lessonSubmission.*` dictionary (en/ar).
* **Fix**: Preview mode (no `VITE_SUPABASE_*`) crashed the review page on any plan selection — including the submission tracker's View deep-link — with `supabase.channel is not a function`: the in-browser demo client implemented no realtime. `createMockSupabase()` now provides inert no-op `channel()`/`removeChannel()` (plus an honest `functions.invoke` error), which also un-crashes Messages, Parent Dashboard/Quizzes, Announcements and Grade Quizzes in preview. Pinned by `lesson-plan-review.preview-client.test.tsx`, which mounts the real page against the real demo client.
