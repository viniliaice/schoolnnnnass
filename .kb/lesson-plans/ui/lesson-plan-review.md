---
type: UI Page
title: LessonPlanReview
description: Supervisor-facing weekly dashboard for reviewing AI-scored lesson plans and approving or rejecting them.
tags: [lesson-plans, ui, supervisor]
timestamp: 2026-09-12T00:00:00Z
---

# Overview

`LessonPlanReview` is the supervisor's dashboard for managing submitted lesson plans. It lives at `/supervisor/lesson-plans`.

It is reachable at `/supervisor/lesson-plans` (supervisor and admin) and `/admin/lesson-plans` (admin) — both render the same component, because the database grants admin and supervisor identical lesson-plan rights.

The page is **week-first**: the supervisor picks a week, and only that week's submissions are loaded and listed. There is no "all weeks" list and no scrolling through history to reach the current week.

## Features

- **Week selector (primary filter)** — lists only the weeks that actually have submissions, most recent first, each showing its real date range (`Week 2026-W07 — 12 Sep – 16 Sep 2026`). The page opens on the most recent week with submissions.
- **Status filter (secondary)** — All Statuses / Submitted (pending AI) / In Review / Approved / Rejected / AI Failed. It only narrows the selected week.
- **Submitted plans list** — the selected week's plans, with teacher, class, week range, and status.
- **AI review display** — shows per-dimension scores, executive summary, strengths, and improvements.
- **Approve / Reject / Request revisions** — supervisor sets status and adds an optional comment; requesting revisions unlocks the plan for the teacher.
- **Per-plan extras** — period-level AI reviews, auto-generated quizzes (generate / redo / add to quiz bank), PDF export.

## Week grouping

Weeks are grouped by the **stored `lesson_plans.week_label`**, never by the teacher-entered `title` (real titles include `week 7`, `Week7`, `Week 05`, `week6`). `buildPlanWeeks()` in `src/lib/lessonPlanWeeks.ts` turns the distinct labels into selectable weeks:

- most recent week first (year, then week number);
- two spellings of the same year+week merge into one option, and the fetch sends every stored spelling for that week (`week_label IN (...)`);
- date ranges come from the academic-year start, and are hidden when a label's year does not match the current academic year;
- a week with no submissions shows `No lesson plans submitted for this week.` — other weeks are never substituted.

## Data flow

```
LessonPlanReview ──► useSupervisorPlanWeeks()      ──► list_lesson_plan_weeks(statuses)   [week_label + count only]
                 ──► useSupervisorPlansForWeek(k)  ──► SELECT * WHERE status IN (...) AND week_label IN (selected week)
                 ──► getReview(planId)             ──► SELECT ai_reviews
                 ──► approvePlan / rejectPlan      ──► decide_lesson_plan_review RPC
                 ──► requestPlanRevision(planId)   ──► request_lesson_plan_revision RPC
```

Only the selected week's plan rows reach the browser. The dropdown is built from aggregated counts, so a growing plan history does not grow the page payload. If `list_lesson_plan_weeks` has not been applied yet, the client falls back to selecting `week_label` alone and counting it locally — still never the full plan rows.

Reviews [ai_reviews](../data-model/ai-reviews.md) for submitted [lesson_plans](../data-model/lesson-plans.md). Supervisor actions respect [RLS policies](../security/rls-policies.md). Routed via [sidebar](../ui/sidebar-routing.md).

# Citations

[1] [Source: LessonPlanReview.tsx](https://github.com/org/repo/blob/main/src/pages/supervisor/LessonPlanReview.tsx)
[2] [Source: lessonPlanWeeks.ts](https://github.com/org/repo/blob/main/src/lib/lessonPlanWeeks.ts)
[3] [Migration: list_lesson_plan_weeks](https://github.com/org/repo/blob/main/supabase/migrations/20260914_supervisor_lesson_plan_week_selector.sql)
