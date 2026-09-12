---
type: UI Page
title: LessonPlanSubmissions
description: Supervisor-facing accountability page tracking which teachers submitted their lesson plan for a week — and which did not.
tags: [lesson-plans, ui, supervisor]
timestamp: 2026-09-15T00:00:00Z
---

# Overview

`LessonPlanSubmissions` is the supervisor's **submission tracker**. It lives at `/supervisor/lesson-plan-submissions` (supervisor, admin) and `/admin/lesson-plan-submissions` (admin) — same two-path setup as [LessonPlanReview](lesson-plan-review.md).

The two pages answer different questions and stay separate:

| Page | Question |
|------|----------|
| **Submission Tracking** (this page) | *Who has submitted and who hasn't?* |
| **Lesson Plan Review** | *What did they submit, and should it be approved / rejected / revised?* |

## Roster-first, not plans-first

The page starts from the **list of teachers expected to submit** — role `teacher` with at least one `assignedClasses` entry, the same contract the teacher's own planner uses — and then checks each teacher against the selected week's plans. A teacher with no plan appears as **Not Submitted** instead of disappearing. Teachers who submitted but left the roster are added from the plans (never flagged missing). A teacher with several plan records for the week still counts as **one** submitted teacher (`buildSubmissionRows` in `src/lib/lessonPlanSubmissionTracking.ts`).

## Features

- **Week selector** — generated from the academic-year calendar (week 1 … the current week), so weeks with zero submissions stay selectable; stored submission weeks (including future ones) merge in. Opens on the **current school week**, marked "Current week", with the real date range from the academic calendar — never grouped by the teacher-typed title. Legacy label spellings ("week 7") fold into their calendar week.
- **Summary cards** — Total Teachers / Submitted / Not Submitted / Submission Rate, computed from the roster, not from plan rows.
- **Progress bar** — "32 of 40 teachers submitted" + percentage, `role="progressbar"`.
- **Teacher list** — Teacher | Class | Status | Submitted At | Action. Status pills: green ✓ Submitted, red ✗ Not Submitted. Secondary notes: "Revisions requested", "N plans this week". Default sort is **Not Submitted first**; alternatives: Name (A–Z), Latest submission.
- **Filters** — Status (All / Submitted / Not Submitted), Class, teacher-name search. All narrow the selected week together.
- **View** — parks the plan id via `src/lib/lessonPlanDeepLink.ts` and navigates to the review page, which opens that plan and aligns its week selector with the plan's stored week. No review functionality is duplicated.
- **Send Reminder** — UI action only: the school's messaging rules (`can_send_message`) allow supervisor→parent messages, not supervisor→teacher, and this feature deliberately builds no new messaging infrastructure. Clicking explains this in a toast, ready to be wired to a future notification system.
- **Mobile** — below `sm` the table becomes compact per-teacher cards (320/360/390px friendly); the table keeps `min-w` + horizontal scroll on tablet+.

## Submission semantics

A teacher counts as Submitted when they hold ≥1 plan for the week with status in `submitted, in_review, approved, rejected, ai_failed, revision_requested` (`SUBMISSION_TRACKING_STATUSES`) — every state where the teacher handed the plan in. Only `draft` does not count. "Submitted At" is `ai_started_at ?? updated_at ?? created_at` (stamped by `submit_lesson_plan_for_review`); no schema change was needed.

## Data flow

```
LessonPlanSubmissions ──► useSupervisorPlanWeeks()        ──► list_lesson_plan_weeks            [week_label + count]
                     ──► useLessonPlanSubmitters()       ──► list_lesson_plan_submitters RPC    [teacher roster, fallback: profiles read]
                     ──► useSubmissionTrackingPlans(k)   ──► lesson_plans WHERE status IN (...) AND week_label IN (week)
                     ──► buildSubmissionWeeks / buildSubmissionRows / summarizeSubmissions (pure, tested)
```

Only the selected week's plans reach the browser. If `list_lesson_plan_submitters` is not applied yet, the client falls back to a direct `profiles` read (works for admin / permissive deployments), the same RPC-then-fallback shape as the week selector.

## Security

`/supervisor/lesson-plan-submissions: ['admin','supervisor']` and `/admin/lesson-plan-submissions: ['admin']` in `ROUTE_ACCESS`. The roster RPC is gated to supervisor+admin in SQL; the plan reads ride the existing `lesson_plans` SELECT policies. See [list-lesson-plan-submitters](../api/list-lesson-plan-submitters.md).

# Citations

[1] [Source: LessonPlanSubmissions.tsx](https://github.com/org/repo/blob/main/src/pages/supervisor/LessonPlanSubmissions.tsx)
[2] [Source: lessonPlanSubmissionTracking.ts](https://github.com/org/repo/blob/main/src/lib/lessonPlanSubmissionTracking.ts)
[3] [Migration: list_lesson_plan_submitters](https://github.com/org/repo/blob/main/supabase/migrations/20260915_lesson_plan_submission_tracking.sql)
