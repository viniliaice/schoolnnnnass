---
type: System Overview
title: Lesson & Unit Plan System
description: AI-assisted lesson planning with teacher authoring, supervisor review, and automated quality scoring.
tags: [lesson-plans, teaching, ai-review]
timestamp: 2026-07-27T00:00:00Z
---

# Overview

The Lesson Plan system lets teachers create weekly lesson plans for their classes, then submit them for AI-powered review. Supervisors see a dashboard of submitted plans, review AI scores, and can approve or reject with comments.

## Key workflows

1. **Teacher creates a plan** — selects class/subject/week, fills periods (Sat-Wed, up to 6 periods/day), saves as draft.
2. **Teacher submits for review** — plan status changes to `submitted`.
3. **AI review edge function** — triggered on submit, scores the plan across multiple rubric dimensions, stores results in `ai_reviews`.
4. **Supervisor reviews** — sees all submitted plans, views AI scores, adds comment, approves/rejects.
5. **Teacher sees feedback** — reviews scored rubric, iterates if rejected.

## Architecture summary

- **Database**: 3 tables (`lesson_plans`, `lesson_plan_periods`, `ai_reviews`), 1 enum (`day_of_week`), 1 RPC (`save_lesson_plan_periods`).
- **Edge function**: `generate-lesson-review` — triggered via Supabase DB webhook on plan submission.
- **Frontend**: `LessonPlanner.tsx` (teacher), `LessonPlanReview.tsx` (supervisor), routed via `/teacher/lesson-plans` and `/supervisor/lesson-plans`.

See [lesson_plans](data-model/lesson-plans.md) for the schema, [RLS policies](security/rls-policies.md) for access control, and [LessonPlanner](ui/lesson-planner.md) for the teacher UI.

# Citations

[1] [DB Migration: Lesson Plans](https://github.com/org/repo/blob/main/supabase/migrations/20260727_lesson_plans.sql)
[2] [DB Migration: Details](https://github.com/org/repo/blob/main/supabase/migrations/20260727_lesson_plans_details.sql)
[3] [Edge Function](https://github.com/org/repo/blob/main/supabase/functions/generate-lesson-review/index.ts)