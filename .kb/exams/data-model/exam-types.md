---
type: Configuration
title: Exam Type Constants
description: "EXAM_TYPES and CA_TYPES constants defining assessment categories and continuous assessment membership."
tags: [exams, configuration]
timestamp: 2026-07-27T00:00:00Z
---

EXAM_TYPES: CA, Homework, Classwork, Quiz, Midterm, Final, Attendance, Discipline — all 8 types.
CA_TYPES: CA, Homework, Classwork, Quiz, Attendance — 5 types counted toward continuous assessment. Discipline/Akhlaaq is recorded per subject but intentionally remains a separate reported metric, not an academic CA component.
From src/types/index.ts.

## Related

- [exams](./exams.md) — table using these types in examType column
- [upload-results](../ui/upload-results.md) — UI where teachers select exam type
- [exam-functions](../api/exam-functions.md) — functions filtering by exam type
- [class-student-subject-progress](../api/class-student-subject-progress.md) — progress RPC returning entries by type
