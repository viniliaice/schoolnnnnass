---
type: Edge Function
title: generate-lesson-review
description: Supabase Edge Function that runs AI evaluation on submitted lesson plans.
tags: [lesson-plans, api, ai, edge-function]
timestamp: 2026-07-27T00:00:00Z
---

# Overview

The `generate-lesson-review` edge function is triggered when a lesson plan is submitted for review. It evaluates the plan against a rubric, generates scores, and writes results into `ai_reviews`.

## Trigger

Called from application code (not a DB trigger directly). The frontend calls this function after updating a plan's status to `submitted`.

## Scoring dimensions

The function evaluates plans across these rubric dimensions (stored in `scores` JSONB):

- Learning objectives alignment
- Activity variety and engagement
- Assessment integration
- Differentiation and inclusion
- Time allocation and pacing
- Resource utilization

## Output

The function writes an `ai_reviews` row with:

| Field | Description |
|-------|-------------|
| `scores` | Per-dimension rubric scores. |
| `executive_summary` | Natural language overview of strengths and gaps. |
| `total_score` | Sum of dimension scores. |
| `percentage` | Normalized to 0-100. |
| `performance_level` | Label: Excellent / Good / Needs Improvement. |
| `strengths` | Array of identified strengths. |
| `improvements` | Array of suggested improvements. |
| `ai_summary_notes` | Structured AI analysis notes. |

## Failure handling

If the AI review fails, the plan status is set to `ai_failed` so the teacher knows to retry.

This function writes [ai_reviews](../data-model/ai-reviews.md) for [lesson_plans](../data-model/lesson-plans.md). Triggered by submission from [LessonPlanner](../ui/lesson-planner.md). Results viewed by supervisors in [LessonPlanReview](../ui/lesson-plan-review.md).

# Citations

[1] [Edge Function Source](https://github.com/org/repo/blob/main/supabase/functions/generate-lesson-review/index.ts)