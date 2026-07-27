---
type: Database Enum
title: day_of_week
description: Teaching week day enumeration — Saturday through Wednesday (5-day week).
tags: [lesson-plans, schema]
timestamp: 2026-07-27T00:00:00Z
resource: postgres://supabase/day_of_week
---

# Overview

The `day_of_week` enum defines the school's confirmed teaching week: **Saturday through Wednesday**.

## Values

| Value | Notes |
|-------|-------|
| `Saturday` | First day of the teaching week. |
| `Sunday` | Regular teaching day. |
| `Monday` | Regular teaching day. |
| `Tuesday` | Regular teaching day. |
| `Wednesday` | Last teaching day of the week. |

## Extension path dependency

PostgreSQL does **not** allow `ALTER TYPE ... ADD VALUE` inside the same transaction as any other DDL on a referencing table. Adding a new teaching day (e.g., Thursday) requires two separate migrations:

1. **Standalone migration**: `ALTER TYPE day_of_week ADD VALUE 'Thursday'` (no DDL on `lesson_plan_periods`).
2. **Follow-up migration**: Any schema changes that depend on the new value.

This is documented in the migration file's DAY-OF-WEEK ENUM PATH-DEPENDENCY NOTE.

Used by [lesson_plan_periods](lesson-plan-periods.md) for the `day` column. Part of the [lesson_plans](lesson-plans.md) data model.

# Citations

[1] [Migration SQL](https://github.com/org/repo/blob/main/supabase/migrations/20260727_lesson_plans.sql)