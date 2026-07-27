---
type: Configuration
title: React Query Hooks (Exams)
description: TanStack Query hooks for exam and progress data.
tags: [exams, api, hooks]
timestamp: 2026-07-27T00:00:00Z
---

Custom hooks in src/lib/hooks/ that wrap DB functions with TanStack Query caching and auto-refetch.

- useExams(teacherId?) - getExams / getExamsByTeacher wrapper
- useAvailableMonths - getAvailableMonths wrapper
- useClassMonths(className) - getMonthsForClass wrapper
- useClassNames - getStudentClasses wrapper
- useClassStudentSubjectProgress(className, month) - progress per student per subject
- useTeacherExamProgress(filters) - auto-refreshing progress view
- useTeacherExamProgressVerification(filters) - detailed verification drill-down

## Related

- [exam-functions](./exam-functions.md) — underlying DB functions wrapped by hooks
- [exams](../data-model/exams.md) — source table
- [class-student-subject-progress](./class-student-subject-progress.md) — progress RPC used by useClassStudentSubjectProgress
- [exam-status-counts](./exam-status-counts.md) — status counts RPC
- [upload-results](../ui/upload-results.md) — UI using useExams
- [exam-verification](../ui/exam-verification.md) — UI using verification hooks
