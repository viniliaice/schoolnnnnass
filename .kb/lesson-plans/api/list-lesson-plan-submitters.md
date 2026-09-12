---
type: Database Function
title: list_lesson_plan_submitters
description: Read-only roster of teachers expected to submit lesson plans (one row per teacher × assigned class), for the supervisor submission tracker.
tags: [lesson-plans, api, rpc, supervisor]
timestamp: 2026-09-15T00:00:00Z
---

# Overview

`list_lesson_plan_submitters() RETURNS TABLE (teacher_id TEXT, teacher_name TEXT, class_name TEXT)`

A `STABLE`, `SECURITY DEFINER` SQL function returning one row per (teacher, assigned class) for profiles with normalized role `teacher` and a non-empty `"assignedClasses"` JSONB array. It backs the roster side of [LessonPlanSubmissions](../ui/lesson-plan-submission-tracking.md): "who is expected to submit" must come from the teacher/class assignment, not from lesson-plan rows.

## Why SECURITY DEFINER

`profiles` is SELECT-restricted under RLS (own profile + admin only — `20260708_profiles_auth_session_rls`), so a supervisor cannot list teachers with a direct query. Supervisors already read every lesson plan school-wide (`supervisor_select_all_plans`, including each plan's teacher), so exposing the minimal roster projection (id, name, class names) is consistent with existing rights. The body re-checks `current_profile_role() IN ('supervisor','admin')` — every other role gets an empty result, verified in `lesson-plan-submission-roster.db.test.ts` against real Postgres.

## Expected-submitter contract

A teacher is expected exactly when their own planner would let them create a plan: role `teacher` + ≥1 assigned class. A teacher with no assigned class cannot submit anything and must **not** be flagged "Not Submitted". Role matching is case/whitespace-insensitive (`lower(btrim(role))`), mirroring `getUsersByRole`; non-array `"assignedClasses"` values are treated as empty.

## Fallback

Until the migration is applied, `fetchLessonPlanSubmitters()` (src/lib/db/lessonPlanSubmissions.ts) falls back to a direct `profiles` read filtered client-side — works for admin and permissive deployments, same RPC-then-fallback pattern as [list_lesson_plan_weeks](list-lesson-plan-weeks.md).

## Grants

`REVOKE ... FROM PUBLIC` + `GRANT EXECUTE TO authenticated` (conditional on the role existing, for local/PGlite environments).

# Citations

[1] [Migration SQL](https://github.com/org/repo/blob/main/supabase/migrations/20260915_lesson_plan_submission_tracking.sql)
[2] [Source: lessonPlanSubmissions.ts](https://github.com/org/repo/blob/main/src/lib/db/lessonPlanSubmissions.ts)
