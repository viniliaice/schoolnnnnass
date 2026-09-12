---
type: Database Function
title: list_lesson_plan_weeks
description: Aggregates lesson-plan submissions by stored week_label so the supervisor week selector loads counts instead of plan rows.
tags: [lesson-plans, api, rpc, supervisor]
timestamp: 2026-09-12T00:00:00Z
---

# Overview

`list_lesson_plan_weeks(p_statuses TEXT[] DEFAULT NULL) RETURNS TABLE (week_label TEXT, plan_count BIGINT)`

A `STABLE`, `SECURITY INVOKER` SQL function that returns one row per distinct `lesson_plans.week_label` with the number of plans stored under it. It backs the supervisor's week dropdown on [Lesson Plan Review](../ui/lesson-plan-review.md): the page needs to know *which* weeks have submissions before it fetches any plan.

## Parameters

| Param | Type | Description |
|-------|------|-------------|
| `p_statuses` | TEXT[] (optional) | Restrict the aggregate to these statuses. The supervisor page passes `['submitted','in_review','approved','rejected','ai_failed']` (drafts and plans sent back for revision are the teacher's again). `NULL` counts every row. |

## Return value

`(week_label TEXT, plan_count BIGINT)` — one row per stored label, unordered. The client sorts weeks most-recent-first and groups spelling variants of the same week (`src/lib/lessonPlanWeeks.ts`).

## Security

`SECURITY INVOKER` on purpose: row-level security still applies to the calling role, so a supervisor sees every reviewable week (`supervisor_select_all_plans`) while any other caller only ever sees the rows their existing `lesson_plans` policies already allow. Execution is granted to `authenticated` only.

## Index

`idx_lesson_plans_status_week_label (status, week_label)` serves both this aggregate and the per-week fetch (`status IN (...) AND week_label IN (...)`).

## Fallback

Until the migration is applied, `fetchSupervisorPlanWeeks()` falls back to `SELECT week_label FROM lesson_plans WHERE status IN (...)` and counts the labels client-side — still no plan rows leave the database.

This RPC reads [lesson_plans](../data-model/lesson-plans.md) and is called from [LessonPlanReview](../ui/lesson-plan-review.md) via `useSupervisorPlanWeeks()`.

# Citations

[1] [Migration SQL](https://github.com/org/repo/blob/main/supabase/migrations/20260914_supervisor_lesson_plan_week_selector.sql)
[2] [Source: lessonPlans.ts](https://github.com/org/repo/blob/main/src/lib/db/lessonPlans.ts)
