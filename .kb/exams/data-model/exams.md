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
| subjectId | text | Subject identifier for authorized class-subject mapping |
| score | int | Nullable only for explicit absent/not-applicable entries |
| total | int | NOT NULL, must be positive |
| examType | text | NOT NULL, CHECK (CA\|Homework\|Classwork\|Quiz\|Midterm\|Final\|Attendance\|Discipline) |
| assessmentLabel | text | Optional for legacy rows; bulk grades use HW1–HW4, CPW1–CPW4, ATTENDANCE, MT, or AKHLAAQ |
| entryState | text | scored, absent, or not_applicable |
| termId | text | Required for new bulk records |
| uploadedBy | text | Actor who submitted the upload; may differ from assigned teacher |
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
- examType limited to: CA, Homework, Classwork, Quiz, Midterm, Final, Attendance, Discipline
- scored entries require a finite score from 0 through total; absent/N/A entries store a null score and are excluded from academic averages
- classified bulk records are unique by student, subject, exam type, assessment label, and term
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
