---
okf_version: "0.1"
title: "RLS Policies (Parent Portal)"
type: Security Policy
tags: [parent-portal, security, rls]
timestamp: 2026-07-27T00:00:00Z
description: "Parent-scoped RLS — parents read only their own children's data via parentId FK joins."
cross_bundle_refs:
  - rbac:security/roles
  - core:data-model/students
  - core:schemas/parent
  - core:schemas/student
  - exams:data-model/exams
  - quizzes:data-model/quizzes
  - attendance:data-model/attendance
  - homework:data-model/homework
---
# RLS Policies

## Principle

Every query executed on behalf of a parent user MUST be scoped to rows accessible through the `ParentStudent` join table. The authenticated user's `parentId` determines visibility.

## Policy: `parent_student_select`

```sql
CREATE POLICY parent_student_select ON ParentStudent
  FOR SELECT
  USING (parentId = auth.parent_id());
```

## Policy: `exam_results_parent_select`

```sql
CREATE POLICY exam_results_parent_select ON ExamResult
  FOR SELECT
  USING (
    studentId IN (
      SELECT studentId FROM ParentStudent
      WHERE parentId = auth.parent_id()
    )
  );
```

## Policy: `quiz_attempts_parent_select`

```sql
CREATE POLICY quiz_attempts_parent_select ON QuizAttempt
  FOR SELECT
  USING (
    studentId IN (
      SELECT studentId FROM ParentStudent
      WHERE parentId = auth.parent_id()
    )
  );
```

## Policy: `attendance_parent_select`

```sql
CREATE POLICY attendance_parent_select ON AttendanceRecord
  FOR SELECT
  USING (
    studentId IN (
      SELECT studentId FROM ParentStudent
      WHERE parentId = auth.parent_id()
    )
  );
```

## Policy: `homework_parent_select`

```sql
CREATE POLICY homework_parent_select ON Homework
  FOR SELECT
  USING (
    studentId IN (
      SELECT studentId FROM ParentStudent
      WHERE parentId = auth.parent_id()
    )
  );
```

## Policy: `announcements_parent_select`

```sql
CREATE POLICY announcements_parent_select ON Announcement
  FOR SELECT
  USING (true);  -- announcements are public to all authenticated parents
```

## Summary

| Table | Policy | Scope |
|-------|--------|-------|
| `ParentStudent` | `parent_student_select` | Own parentId only |
| `ExamResult` | `exam_results_parent_select` | Children of parent |
| `QuizAttempt` | `quiz_attempts_parent_select` | Children of parent |
| `AttendanceRecord` | `attendance_parent_select` | Children of parent |
| `Homework` | `homework_parent_select` | Children of parent |
| `Announcement` | `announcements_parent_select` | All (public to parents) |

## Related

- [students](../../core/data-model/students.md) — student records joined via ParentStudent
- [exams](../../exams/data-model/exams.md) — ExamResult table scoped by parent RLS
- [quizzes](../../quizzes/data-model/quizzes.md) — QuizAttempt table scoped by parent RLS
- [ParentPortal API](../api/parent-portal-api.md) — getParentPortalSnapshot function
- [ParentDashboard](../ui/parent-dashboard.md) — parent dashboard UI
