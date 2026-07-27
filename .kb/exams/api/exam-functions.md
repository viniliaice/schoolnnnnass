---
type: Database Function
title: Exam Client DB Functions
description: "Client-side exam CRUD: getExamsPaginated, getExamCount, getExamsByStudent, getExamsByParent, getExamsByTeacher, getExamsByStatus, getExamSubjectsByClasses, approvePendingExamsForClasses, plus all CRUD helpers."
tags: [exams, api, rpc]
timestamp: 2026-07-27T00:00:00Z
---

From lib/db/exams.ts. Mention that get_exam_status_counts is the DB RPC version, while getExamStatusCounts is the client wrapper.

## Related

- [exams](../data-model/exams.md) — table these functions operate on
- [exam-types](../data-model/exam-types.md) — type constants used in filters
- [exam-status-counts](./exam-status-counts.md) — DB RPC version of status counts
- [hooks](./hooks.md) — TanStack Query wrappers around these functions
- [upload-results](../ui/upload-results.md) — UI that uses create/update functions
