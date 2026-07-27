---
type: Configuration
title: Sidebar & Routing
description: Navigation and route configuration for the lesson plan feature.
tags: [lesson-plans, ui, routing]
timestamp: 2026-07-27T00:00:00Z
---

# Routes

| Page | Path | Roles |
|------|------|-------|
| LessonPlanner | `/teacher/lesson-plans` | teacher |
| LessonPlanReview | `/supervisor/lesson-plans` | supervisor, admin |

Admin inherits the supervior route via `switch` fallback pattern.

## Sidebar entries

Both entries use the `NotepadText` icon from `lucide-react`.

```typescript
// Teacher sidebar
{ label: 'Lesson Plans', icon: NotepadText, path: '/teacher/lesson-plans' }

// Supervisor sidebar
{ label: 'Lesson Plans', icon: NotepadText, path: '/supervisor/lesson-plans' }
```

## App.tsx routing

```typescript
// Teacher routes
case '/teacher/lesson-plans': return <LessonPlanner />;

// Supervisor routes
case '/supervisor/lesson-plans': return <LessonPlanReview />;
```

Routes map to [LessonPlanner](lesson-planner.md) and [LessonPlanReview](lesson-plan-review.md).

# Citations

[1] [Source: App.tsx](https://github.com/org/repo/blob/main/src/App.tsx)
[2] [Source: Sidebar.tsx](https://github.com/org/repo/blob/main/src/components/layout/Sidebar.tsx)