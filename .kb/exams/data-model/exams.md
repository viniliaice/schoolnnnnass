---
title: "exams"
type: Database Table
tags: [exams, schema, results]
timestamp: 2026-07-27T00:00:00Z
description: "Core exam result records — one row per student per subject per exam type per month."
linked_concepts:
  - core:data-model/report-comments
  - core:api/teacher-exam-progress
  - core:api/exam-status-counts
  - core:security/rls-policies
---

## Columns

| Column | Type | Constraints |
|--------|------|-------------|
| id | text | PK, format prefix-timestamp-random |
| studentId | text | FK → students.id, CASCADE |
| subject | text | NOT NULL |
| score | int | NOT NULL |
| total | int | NOT NULL |
| examType | text | NOT NULL, CHECK (CA\|Homework\|Classwork\|Quiz\|Midterm\|Final) |
| month | text | NOT NULL |
| status | text | CHECK (pending\|approved\|rejected) |
| parentId | text | FK → profiles.id, SET NULL |
| date | date | NOT NULL |
| createdAt | timestamptz | DEFAULT now() |
| teacherId | text | FK → profiles.id, CASCADE |

## Indexes

- idx_exams_studentId
- idx_exams_month
- idx_exams_parentId
- idx_exams_teacherId
- idx_exams_status
- idx_exams_teacher_month_examtype

## Constraints

- Text PKs use prefix-timestamp-random format
- examType limited to: CA, Homework, Classwork, Quiz, Midterm, Final
- status limited to: pending, approved, rejected

## Related

- [exam-types](./exam-types.md) — constants for examType column
- [report-comments](./report-comments.md) — comments FK → exams.id
- [rls-policies](../security/rls-policies.md) — row-level security on this table
- [exam-functions](../api/exam-functions.md) — CRUD functions for exams
- [exam-status-counts](../api/exam-status-counts.md) — status aggregation RPC
- [upload-results](../ui/upload-results.md) — teacher upload page
- [exam-verification](../ui/exam-verification.md) — approval workflow UI
- [exam-report](../ui/exam-report.md) — report generation UI
- [all-results](../ui/all-results.md) — results listing page
