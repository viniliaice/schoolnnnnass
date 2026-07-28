---
type: Configuration
title: Sidebar & Routing
description: Navigation and route configuration for the lesson plan feature.
tags: [lesson-plans, ui, routing]
timestamp: 2026-07-29T00:00:00Z
---

# Routes

| Page | Path | Roles |
|------|------|-------|
| LessonPlanner | `/teacher/lesson-plans` | teacher |
| LessonPlanReview | `/supervisor/lesson-plans` | supervisor |
| LessonPlanReview | `/admin/lesson-plans` | admin |

Admin does **not** inherit the supervisor route by fallback — each role branch in
`App.tsx` is a self-contained `switch`, so admin has its own explicit
`/admin/lesson-plans` case rendering the same `LessonPlanReview` page.

## Sidebar entries

All three entries use the `NotepadText` icon from `lucide-react` and live in
`src/components/layout/navConfig.ts`.

```typescript
// Teacher sidebar — "Planning" group
{ label: 'Lesson Plans', icon: NotepadText, path: '/teacher/lesson-plans' }

// Supervisor sidebar — "Planning" group
{ label: 'Lesson Plans', icon: NotepadText, path: '/supervisor/lesson-plans' }

// Admin sidebar — "Academics" group
{ label: 'Lesson Plans', icon: NotepadText, path: '/admin/lesson-plans' }
```

## App.tsx routing

```typescript
// Admin routes
case '/admin/lesson-plans': return <LessonPlanReview />;

// Supervisor routes
case '/supervisor/lesson-plans': return <LessonPlanReview />;

// Teacher routes
case '/teacher/lesson-plans': return <LessonPlanner />;
```

Routes map to [LessonPlanner](lesson-planner.md) and [LessonPlanReview](lesson-plan-review.md).

Sidebar/route parity is enforced by
`src/components/layout/__tests__/sidebar-nav.test.ts`, which fails if a nav entry
points at a missing route or a route has no nav entry.

# Citations

[1] [Source: App.tsx](https://github.com/org/repo/blob/main/src/App.tsx)
[2] [Source: navConfig.ts](https://github.com/org/repo/blob/main/src/components/layout/navConfig.ts)
[3] [Source: Sidebar.tsx](https://github.com/org/repo/blob/main/src/components/layout/Sidebar.tsx)
