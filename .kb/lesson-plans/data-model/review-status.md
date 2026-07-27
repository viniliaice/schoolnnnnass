---
type: Configuration
title: ReviewStatus & AdditionalData
description: ReviewStatus enum (pending|reviewed) and AdditionalData metadata type for AI review system.
tags: [lesson-plans, configuration]
timestamp: 2026-07-27T00:00:00Z
---

ReviewStatus: 'pending' | 'reviewed' — lifecycle status of supervisor review on an AI review record.

AdditionalData: latency_ms, model_used, input_tokens?, output_tokens?, retries?. Attached to each AIReview to track edge function performance and model metadata.

## Related

- [ai-reviews](ai-reviews.md) — ai_reviews table where ReviewStatus is applied
- [hooks](../api/hooks.md) — React Query hooks for plan review workflow
- [LessonPlanReview](../ui/lesson-plan-review.md) — review UI page
