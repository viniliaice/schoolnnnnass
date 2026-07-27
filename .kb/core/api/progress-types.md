---
type: Configuration
title: Progress & Verification Types
description: "TeacherExamProgressVerification — per-teacher per-class per-subject per-month exam entry verification type with row counts by exam type."
tags: [core, api, progress]
timestamp: 2026-07-27T00:00:00Z
---

TeacherExamProgressVerification from src/types/index.ts: teacherId, className, subjectId, subjectName, month, totalStudents, totalExamRows, rowCountsByExamType, studentCountsByExamType.
Used by getTeacherExamProgressVerification in lib/db/progress.ts.

## Related

* [MonitorTeachers](../../exams/ui/monitor-teachers.md) — exam UI consuming this type.
