---
okf_version: "0.1"
title: "Parent Portal DB Functions"
type: Database Function
tags: [parent-portal, api]
timestamp: 2026-07-27T00:00:00Z
description: "getParentPortalSnapshot — aggregate function returning parent's children, recent exams, attendance, homework, and announcements in a single call."
cross_bundle_refs:
  - core:data-model/students
  - exams:data-model/exams
  - exams:api/getExamsByParent
  - quizzes:data-model/quizzes
  - quizzes:api/getQuizzesByParent
  - attendance:data-model/attendance
  - attendance:api/getAttendanceByParent
  - homework:data-model/homework
  - homework:api/getHomeworkByParent
  - announcements:data-model/announcements
---
# Parent Portal DB Functions

## `getParentPortalSnapshot`

Aggregate function returning all parent-portal data in a single call.

### Signature

```sql
CREATE OR REPLACE FUNCTION getParentPortalSnapshot(p_parentId UUID)
RETURNS JSONB
LANGUAGE sql
STABLE
AS $$
  -- Returns: { children, recentExams, attendanceSummary, pendingHomework, activeAnnouncements }
$$;
```

### Returns

| Key | Type | Description |
|-----|------|-------------|
| `children` | JSONB[] | Array of child summaries (name, class, grade) |
| `recentExams` | JSONB[] | Last 30 days of exam results across all children |
| `attendanceSummary` | JSONB | Per-child attendance rates |
| `pendingHomework` | JSONB[] | Homework items not yet completed |
| `activeAnnouncements` | JSONB[] | Currently active school announcements |

### Dependencies

- `exams:api/getExamsByParent` — exam retrieval
- `quizzes:api/getQuizzesByParent` — quiz retrieval
- `attendance:api/getAttendanceByParent` — attendance retrieval
- `homework:api/getHomeworkByParent` — homework retrieval

## Related

- [students](../../core/data-model/students.md) — student records linked to parents
- [ParentDashboard](../ui/parent-dashboard.md) — parent dashboard UI
- [ChildrenView](../ui/children-view.md) — children list view
- [exam-results-parent](../ui/exam-results-parent.md) — parent exam results view
- [parent-quizzes](../ui/parent-quizzes.md) — parent quizzes view
- [RLS Policies](../security/rls-policies.md) — parent-scoped row-level security
