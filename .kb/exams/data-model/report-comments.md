---
title: "report_comments"
type: Database Table
tags: [exams, schema, reports]
timestamp: 2026-07-27T00:00:00Z
description: "Teacher and principal comments attached to exam results for report cards."
linked_concepts:
  - core:data-model/exams
  - core:api/get-midterm-report
  - core:api/get-exam-report-rpc
---

## Columns

| Column | Type | Constraints |
|--------|------|-------------|
| id | text | PK |
| studentId | text | FK → students.id, CASCADE |
| termId | text | FK → terms.id, CASCADE |
| examId | text | FK → exams.id, SET NULL |
| teacherComment | text | |
| principalComment | text | |
| teacherId | text | FK → profiles.id, SET NULL |
| createdAt | timestamptz | DEFAULT now() |

## Indexes

- idx_report_comments_student_term (studentId, termId)

## Related

- [exams](./exams.md) — exam results this table references
- [get-midterm-report](../api/get-midterm-report.md) — midterm report RPC joining this table
- [get-exam-report-rpc](../api/get-exam-report-rpc.md) — exam report RPC joining this table
- [exam-report](../ui/exam-report.md) — UI displaying comments
