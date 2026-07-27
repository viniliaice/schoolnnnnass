---
type: Configuration
title: React Query Hooks (Lesson Plans)
description: TanStack Query hooks wrapping lesson plan DB operations.
tags: [lesson-plans, api, hooks]
timestamp: 2026-07-27T00:00:00Z
---

Custom hooks in src/lib/hooks/useLessonPlans.ts wrapping all lesson plan DB functions with TanStack Query caching, optimistic updates, and auto-refetch.

- useTeacherPlans(teacherId) - list teacher plans
- useSupervisorPlans() - list all plans for supervisor
- usePlanWithPeriods(id) - plan detail with periods
- useReview(planId) - AI review data
- useCreatePlan() / useDeletePlan() - CRUD mutations
- useSavePeriods() - period save mutation
- useSubmitForReview() - submit + trigger AI review
- useApprovePlan() / useRejectPlan() - supervisor actions

## Related

- [lesson-plans](../data-model/lesson-plans.md) — lesson_plans table
- [lesson-plan-periods](../data-model/lesson-plan-periods.md) — lesson_plan_periods table
- [ai-reviews](../data-model/ai-reviews.md) — ai_reviews table
- [review-status](../data-model/review-status.md) — ReviewStatus enum
- [LessonPlanner](../ui/lesson-planner.md) — LessonPlanner UI page
