---
type: Configuration
title: Sidebar & Routing
description: Navigation and route configuration for the lesson plan feature.
tags: [lesson-plans, ui, routing]
timestamp: 2026-09-12T00:00:00Z
---

# Routes

| Page | Path | Roles |
|------|------|-------|
| LessonPlanner | `/teacher/lesson-plans` | teacher |
| LessonPlanSubmissions | `/supervisor/lesson-plan-submissions` | supervisor, admin |
| LessonPlanSubmissions | `/admin/lesson-plan-submissions` | admin |
| LessonPlanReview | `/supervisor/lesson-plans` | supervisor, admin |
| LessonPlanReview | `/admin/lesson-plans` | admin |

Both review paths render the same `LessonPlanReview` component. Admin is not a
wider role here — the database already grants admin and supervisor identical
lesson-plan rights (`admin_all_plans` RLS plus the `('supervisor','admin')`
checks inside `decide_lesson_plan_review`, `request_lesson_plan_revision`,
`retry_lesson_plan_ai_review` and the quiz-replacement RPC), so admin simply
gets the same week-first review page. Admin's own path exists so the admin
sidebar stays under `/admin/*`; the supervisor path is also open to admin so a
link shared by a supervisor still opens.

> Correction (2026-09-12): this file previously claimed "admin inherits the
> supervisor route via `switch` fallback". It did not — the admin `switch` in
> `App.tsx` had no lesson-plans case, so admin fell through to
> `<AdminDashboard />`, and the admin sidebar had no entry. Both now exist.

`ROUTE_ACCESS` in `src/lib/routing.ts` lists `/admin/lesson-plans: ['admin']`,
`/supervisor/lesson-plans: ['admin','supervisor']`,
`/admin/lesson-plan-submissions: ['admin']` and
`/supervisor/lesson-plan-submissions: ['admin','supervisor']`.

## Sidebar entries

The lesson-plan pages use the `NotepadText` (review) and `ListChecks` (submission tracking) icons from `lucide-react`.

```typescript
// Teacher sidebar
{ label: 'Lesson Plans', icon: NotepadText, path: '/teacher/lesson-plans' }

// Supervisor sidebar — Submission Tracking answers "who submitted?",
// Lesson Plans is the review page.
{ label: 'Submission Tracking', icon: ListChecks, path: '/supervisor/lesson-plan-submissions' }
{ label: 'Lesson Plans', icon: NotepadText, path: '/supervisor/lesson-plans' }

// Admin sidebar (same pair, under /admin/*)
{ label: 'Submission Tracking', icon: ListChecks, path: '/admin/lesson-plan-submissions' }
{ label: 'Lesson Plans', icon: NotepadText, path: '/admin/lesson-plans' }
```

## App.tsx routing

```typescript
// Teacher routes
case '/teacher/lesson-plans': return <LessonPlanner />;

// Admin routes
case '/admin/lesson-plans': return <LessonPlanReview />;
case '/supervisor/lesson-plans': return <LessonPlanReview />;

// Supervisor routes
case '/supervisor/lesson-plans': return <LessonPlanReview />;
```

Routes map to [LessonPlanner](lesson-planner.md) and [LessonPlanReview](lesson-plan-review.md).

# Citations

[1] [Source: App.tsx](https://github.com/org/repo/blob/main/src/App.tsx)
[2] [Source: Sidebar.tsx](https://github.com/org/repo/blob/main/src/components/layout/Sidebar.tsx)
[3] [Source: routing.ts](https://github.com/org/repo/blob/main/src/lib/routing.ts)
