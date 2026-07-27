---
title: "teacher_exam_progress"
type: Database View
tags: [exams, api, progress]
timestamp: 2026-07-27T00:00:00Z
description: "CTE-based view computing per-teacher, per-class, per-subject, per-month exam entry completion with missing exam types."
linked_concepts:
  - core:data-model/exams
  - core:ui/monitor-teachers
---

## Logic

Required entries per student per subject per month:

1. **Coursework**: CA >= total OR (Homework AND Classwork >= total)
2. **Quiz**: >= total

## Columns Returned

- teacherId, teacherName
- className
- subjectId, subjectName
- month
- requiredEntries
- completedEntries
- completionStatus
- completionPercent
- missingExamTypes

## Migrations

- 20260707_fix_teacher_exam_progress_coursework_rule.sql
