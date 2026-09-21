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

Since the 2026-09-15 sidebar redesign the menu is grouped, so these rows live in
the `academic` section of `NAV` in [navigation.ts](https://github.com/org/repo/blob/main/src/lib/navigation.ts)
rather than in a flat list inside `Sidebar.tsx`. Paths, labels and icons are
unchanged — `NotepadText` for review, `ListChecks` for submission tracking.

```typescript
// NAV.teacher.sections → id: 'academic'
{ label: 'Lesson Plans', icon: NotepadText, path: '/teacher/lesson-plans' }

// NAV.supervisor.sections → id: 'academic'
// Submission Tracking answers "who submitted?", Lesson Plans is the review page.
{ label: 'Lesson Plans', icon: NotepadText, path: '/supervisor/lesson-plans' },
{ label: 'Submission Tracking', icon: ListChecks, path: '/supervisor/lesson-plan-submissions' }

// NAV.admin.sections → id: 'academic' (same pair, under /admin/*)
{ label: 'Lesson Plans', icon: NotepadText, path: '/admin/lesson-plans' },
{ label: 'Submission Tracking', icon: ListChecks, path: '/admin/lesson-plan-submissions' }
```

The `academic` group is collapsed by default unless it holds the current page,
so tests that drive the real `<App />` must expand it before clicking a row —
see `clickNav()` in `src/lib/__tests__/admin-lesson-plan-review.test.tsx`, which
resolves the owning group with `sectionIdForPath()` and clicks its
`button[aria-controls="nav-section-academic"]` header first.

Menu structure, remembered expand state and the mobile drawer are documented in
[core/ui/sidebar-navigation](../../core/ui/sidebar-navigation.md).

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
