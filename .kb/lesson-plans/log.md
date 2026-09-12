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
