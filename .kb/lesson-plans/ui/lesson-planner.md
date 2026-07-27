---
type: UI Page
title: LessonPlanner
description: Teacher-facing page for creating, editing, submitting, and viewing lesson plan history.
tags: [lesson-plans, ui, teacher]
timestamp: 2026-07-27T00:00:00Z
---

# Overview

`LessonPlanner.tsx` is the teacher's primary interface for weekly lesson planning. It lives at `/teacher/lesson-plans`.

## Features

- **Plan list** — shows existing plans grouped by week, with status badges.
- **Plan editor** — grid layout: days (Sat-Wed) × periods (1-6), each cell has topic, objective, activities, slide number.
- **Draft save** — saves periods via `save_lesson_plan_periods` RPC without changing status.
- **Submit for review** — changes status to `submitted`, triggers AI review.
- **History** — view past plans and their AI review results.
- **Status indicators** — color-coded badges for draft/submitted/approved/rejected.

## Data flow

```
LessonPlanner ──► lessonPlans.ts (DB lib) ──► Supabase
    │                                                 │
    │  savePlanPeriods(planId, periods)               │ RPC
    │  submitPlan(planId)                             │ UPDATE status
    │  getPlans(teacherId)                            │ SELECT
    │  getPlanWithPeriods(planId)                     │ SELECT + JOIN
    └─────────────────────────────────────────────────┘
```

## Key state machine transitions

| Action | From → To | Notes |
|--------|-----------|-------|
| Save draft | any → draft | Persists periods, status stays draft. |
| Submit | draft → submitted | Triggers AI review. |
| Resubmit | rejected → submitted | Teacher iterates then resubmits. |
| View results | submitted → — | Read-only view of AI review scores. |

## Edge cases

- **AI failure**: status set to `ai_failed`, teacher sees retry prompt.
- **Concurrent edit**: RPC's atomic save prevents partial updates.
- **Empty periods**: validation prevents submitting a plan with missing required fields.

Uses [save_lesson_plan_periods](../api/db-functions.md) RPC to persist periods. Creates [lesson_plans](../data-model/lesson-plans.md) and [lesson_plan_periods](../data-model/lesson-plan-periods.md) records. Triggers the [generate-lesson-review](../api/edge-functions.md) edge function on submit. Teachers see AI results from [ai_reviews](../data-model/ai-reviews.md). Routed via [sidebar](../ui/sidebar-routing.md).

# Citations

[1] [Source: LessonPlanner.tsx](https://github.com/org/repo/blob/main/src/pages/teacher/LessonPlanner.tsx)