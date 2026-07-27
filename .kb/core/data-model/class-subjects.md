---
title: "class_subjects"
type: Database Table
tags: [core, schema, class-subjects]
timestamp: 2026-07-27T00:00:00Z
description: "Junction table linking classes to subjects with optional teacher assignment."
linked_concepts:
  - "core:data-model/profiles"
  - "core:data-model/subjects"
  - "core:ui/manage-class-subjects"
  - "timetable:data-model/teacher-availability"
  - "exams:data-model/exam-subjects"
---

# class_subjects

## Columns

| Column | Type | Description |
|--------|------|-------------|
| `id` | `text` PK | Primary key |
| `className` | `text` | Class name |
| `subjectId` | `text` | FK → subjects.id |
| `teacherId` | `text` | FK → profiles.id (assigned teacher, nullable) |
| `createdAt` | `timestamptz` | Row creation timestamp |

## Indexes

| Name | Column(s) |
|------|-----------|
| `idx_class_subjects_class` | `className` |
| `idx_class_subjects_teacher` | `teacherId` |
| `idx_class_subjects_subject` | `subjectId` |

## Related

* [Profiles](profiles.md) — `teacherId` FK targets `profiles.id`.
* [Subjects](subjects.md) — `subjectId` FK targets `subjects.id`.
* [ManageClassSubjects](../ui/manage-class-subjects.md) — UI for CRUD on class-subject links.
