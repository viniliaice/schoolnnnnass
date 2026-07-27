---
type: Database Table
title: lesson_plans
description: Weekly lesson plan header — one row per teacher, subject, and week.
tags: [lesson-plans, schema]
timestamp: 2026-07-27T00:00:00Z
resource: postgres://supabase/lesson_plans
---

# Schema

| Column | Type | Description |
|--------|------|-------------|
| `id` | TEXT PK | UUID-style primary key, generated client-side. |
| `teacher_id` | TEXT FK→profiles | Owner of the plan. |
| `subject_id` | TEXT FK→subjects | Subject this plan targets. |
| `class_name` | TEXT | Target class (e.g. "Grade 5-A"). |
| `week_label` | TEXT | Week identifier, e.g. "2026-W30". |
| `title` | TEXT | Human-readable plan title. |
| `status` | TEXT | One of: `draft`, `submitted`, `in_review`, `approved`, `rejected`, `ai_failed`. |
| `period_count` | INTEGER | Number of periods per day — constrained to 5-6. |
| `previous_score` | INTEGER | Prior AI review score (for improvement tracking). |
| `previous_reviewed_at` | TIMESTAMPTZ | When the last review happened. |
| `created_at` | TIMESTAMPTZ | Row creation timestamp. |
| `updated_at` | TIMESTAMPTZ | Auto-updated via trigger. |

## Indexes

- `idx_lesson_plans_teacher_week` on (`teacher_id`, `week_label`) — fast lookup by teacher+week.
- `idx_lesson_plans_status` on (`status`) — supervisor dashboard filtering.

## Constraints

- `status IN ('draft', 'submitted', 'in_review', 'approved', 'rejected', 'ai_failed')` — status state machine.
- `period_count BETWEEN 5 AND 6` — enforces valid period range.

## Status state machine

```
                    submit
  draft ──────────────────► submitted
                              │
                         AI review
                              │
                    ┌─────────┴─────────┐
                    ▼                   ▼
                approved             rejected
                    │                   │
                    │              resubmit
                    │                   │
                    └───────┬───────────┘
                            ▼
                         draft (iterate)
```

Each plan has [periods](lesson-plan-periods.md) and an optional [AI review](ai-reviews.md). The teaching week uses the [day_of_week enum](day-of-week-enum.md). Periods are saved atomically via the [save_lesson_plan_periods](../api/db-functions.md) RPC.

# Citations

[1] [Migration SQL](https://github.com/org/repo/blob/main/supabase/migrations/20260727_lesson_plans.sql)