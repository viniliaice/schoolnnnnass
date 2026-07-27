---
type: Database Function
title: set_updated_at & Triggers
description: "Trigger function and triggers that auto-update the updated_at column on lesson plan tables."
tags: [lesson-plans, api, triggers]
timestamp: 2026-07-27T00:00:00Z
---

set_updated_at() trigger function — sets NEW.updated_at = NOW() on row update.
Applied as triggers: trg_lesson_plans_updated_at (on lesson_plans), trg_lesson_plan_periods_updated_at (on lesson_plan_periods), trg_ai_reviews_updated_at (on ai_reviews).
From migration 20260727_lesson_plans.sql.

## Related

- [lesson-plans](../data-model/lesson-plans.md) — lesson_plans table
- [lesson-plan-periods](../data-model/lesson-plan-periods.md) — lesson_plan_periods table
- [ai-reviews](../data-model/ai-reviews.md) — ai_reviews table
