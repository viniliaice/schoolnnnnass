---
type: Database Table
title: lesson_plan_periods
description: Individual teaching periods within a lesson plan — one row per day × period.
tags: [lesson-plans, schema]
timestamp: 2026-07-27T00:00:00Z
resource: postgres://supabase/lesson_plan_periods
---

# Schema

| Column | Type | Description |
|--------|------|-------------|
| `id` | TEXT PK | ID format: `period-{plan_id}-{day}-{period_number}`. |
| `plan_id` | TEXT FK→lesson_plans | Parent plan (CASCADE delete). |
| `day` | day_of_week | Saturday through Wednesday. |
| `period_number` | INTEGER | 1-6, period order within the day. |
| `topic` | TEXT | Lesson topic for this period. |
| `objective` | TEXT | Learning objective for this period. |
| `activities` | TEXT | Description of teaching activities. |
| `slide_number` | TEXT | Reference slide number in supporting materials. |
| `details` | JSONB | Structured JSON for extensible metadata. |
| `sort_order` | INTEGER | Display ordering (auto-generated). |
| `created_at` | TIMESTAMPTZ | Row creation timestamp. |
| `updated_at` | TIMESTAMPTZ | Auto-updated via trigger. |

## Constraints

- `UNIQUE(plan_id, day, period_number)` — prevents duplicate periods.
- `period_number BETWEEN 1 AND 6` — valid period range.
- CASCADE delete from parent `lesson_plans`.

## Indexes

Covered by the UNIQUE constraint on `(plan_id, day, period_number)`. No additional indexes.

Periods belong to a [lesson_plan](lesson-plans.md) and use the [day_of_week enum](day-of-week-enum.md). They are saved atomically via the [save_lesson_plan_periods](../api/db-functions.md) RPC.

# Citations

[1] [Migration SQL](https://github.com/org/repo/blob/main/supabase/migrations/20260727_lesson_plans.sql)