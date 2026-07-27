---
type: Security Policy
title: "RLS Policies (Lesson Plans)"
description: Row-level security policies for all lesson plan tables, enforced per role.
tags: [lesson-plans, security, rls]
timestamp: 2026-07-27T00:00:00Z
---

# Overview

All three lesson plan tables (`lesson_plans`, `lesson_plan_periods`, `ai_reviews`) have RLS enabled. Policies enforce access based on the authenticated user's role and identity.

## lesson_plans

| Policy | Role | Access | Scope |
|--------|------|--------|-------|
| `admin_all_plans` | admin | ALL | All rows (wide-open). |
| `teacher_manage_own_plans` | teacher | ALL | `teacher_id = auth.uid()`. |
| `supervisor_select_all_plans` | supervisor | SELECT | Checks `profiles.role = 'supervisor'`. |

## lesson_plan_periods

| Policy | Role | Access | Scope |
|--------|------|--------|-------|
| `admin_all_periods` | admin | ALL | All rows. |
| `teacher_manage_own_periods` | teacher | ALL | Subquery: `EXISTS (SELECT 1 FROM lesson_plans WHERE id = plan_id AND teacher_id = auth.uid())`. |
| `supervisor_select_all_periods` | supervisor | SELECT | Checks `profiles.role = 'supervisor'`. |

## ai_reviews

| Policy | Role | Access | Scope |
|--------|------|--------|-------|
| `admin_all_reviews` | admin | ALL | All rows. |
| `teacher_select_own_reviews` | teacher | SELECT | Subquery: `EXISTS (SELECT 1 FROM lesson_plans WHERE id = plan_id AND teacher_id = auth.uid())`. |
| `supervisor_manage_reviews` | supervisor | ALL | Checks `profiles.role = 'supervisor'`. |

## Design notes

- **Teachers** own their plans fully (CRUD) but can only *read* their own AI reviews.
- **Supervisors** are read-only on plans/periods but can *write* reviews (approve/reject + comment).
- **Admins** have unrestricted access, consistent with the app's existing security pattern.
- Teacher ownership is enforced by `teacher_id = auth.uid()` (direct column match).
- Period ownership is enforced by subquery (periods table has no `teacher_id` column).

These policies protect [lesson_plans](../data-model/lesson-plans.md), [lesson_plan_periods](../data-model/lesson-plan-periods.md), and [ai_reviews](../data-model/ai-reviews.md).

# Citations

[1] [Migration SQL](https://github.com/org/repo/blob/main/supabase/migrations/20260727_lesson_plans.sql)