---
type: Database Function
title: save_lesson_plan_periods
description: Atomic RPC that deletes all existing periods for a plan and inserts new ones in a single transaction.
tags: [lesson-plans, api, rpc]
timestamp: 2026-07-27T00:00:00Z
---

# Overview

`save_lesson_plan_periods(p_plan_id TEXT, p_periods JSONB) RETURNS SETOF lesson_plan_periods`

This SECURITY DEFINER function provides atomic save semantics for lesson plan periods. The frontend sends the full set of periods; the function does a delete-all + insert-all inside a savepoint.

## Parameters

| Param | Type | Description |
|-------|------|-------------|
| `p_plan_id` | TEXT | The `lesson_plans.id` to save periods for. |
| `p_periods` | JSONB | Array of period objects: `[{day, period_number, topic, objective, activities, slide_number, details}]`. |

## Return value

A set of `lesson_plan_periods` rows ordered by `day, period_number`.

## Transaction safety

Uses `SAVEPOINT`/`ROLLBACK TO SAVEPOINT` to guard against mid-operation failures:

1. `SAVEPOINT save_periods` — marks the restore point.
2. `DELETE FROM lesson_plan_periods WHERE plan_id = p_plan_id` — clears all existing periods.
3. `INSERT INTO lesson_plan_periods ...` — inserts new periods from JSONB.
4. `RELEASE SAVEPOINT save_periods` — commits the operation.
5. On exception: `ROLLBACK TO SAVEPOINT _sp; RAISE` — restores and re-raises.

## ID generation

Period IDs follow the convention: `period-{plan_id}-{day}-{period_number}`

This RPC saves [lesson_plan_periods](../data-model/lesson-plan-periods.md) for a [lesson_plan](../data-model/lesson-plans.md). Called from [LessonPlanner](../ui/lesson-planner.md).

# Citations

[1] [Migration SQL](https://github.com/org/repo/blob/main/supabase/migrations/20260727_lesson_plans.sql)
[2] [Details Migration](https://github.com/org/repo/blob/main/supabase/migrations/20260727_lesson_plans_details.sql)