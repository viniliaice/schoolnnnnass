---
type: UI Page
title: LessonPlanReview
description: Supervisor-facing dashboard for reviewing AI-scored lesson plans and approving or rejecting them.
tags: [lesson-plans, ui, supervisor]
timestamp: 2026-07-27T00:00:00Z
---

# Overview

`LessonPlanReview` is the supervisor's dashboard for managing submitted lesson plans. It lives at `/supervisor/lesson-plans`.

## Features

- **Submitted plans list** — all plans with `submitted` or `in_review` status.
- **AI review display** — shows per-dimension scores, executive summary, strengths, and improvements.
- **Approve/Reject** — supervisor sets status and adds optional comment.
- **Filtering** — by class, subject, teacher, date range.

## Data flow

```
LessonPlanReview ──► lessonPlans.ts (DB lib) ──► Supabase
    │                                                      │
    │  getSubmittedPlans()                                 │ SELECT WHERE status = submitted
    │  getReview(planId)                                   │ SELECT ai_reviews
    │  approvePlan(planId, comment)                        │ UPDATE status = approved
    │  rejectPlan(planId, comment)                         │ UPDATE status = rejected
    └──────────────────────────────────────────────────────┘
```

Reviews [ai_reviews](../data-model/ai-reviews.md) for submitted [lesson_plans](../data-model/lesson-plans.md). Supervisor actions respect [RLS policies](../security/rls-policies.md). Routed via [sidebar](../ui/sidebar-routing.md).

# Citations

[1] [Source: LessonPlanReview.tsx](https://github.com/org/repo/blob/main/src/pages/supervisor/LessonPlanReview.tsx)