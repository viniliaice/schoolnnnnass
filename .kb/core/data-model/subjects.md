---
title: "subjects"
type: Database Table
tags: [core, schema, subjects]
timestamp: 2026-07-27T00:00:00Z
description: "Subject catalog — 12 subjects with department, color coding, and weekly lesson counts."
linked_concepts:
  - "core:data-model/class-subjects"
  - "core:ui/manage-subjects"
  - "core:ui/manage-class-subjects"
  - "exams:data-model/exams"
  - "grades:data-model/grade-config"
  - "timetable:data-model/lesson-slots"
---

# subjects

## Columns

| Column | Type | Description |
|--------|------|-------------|
| `id` | `text` PK | Primary key |
| `name` | `text` | Subject name (one of 12: Mathematics, English, Science, Somali, Islamic Studies, Social Studies, Physics, Chemistry, Biology, History, Geography, Arabic) |
| `shortName` | `text` | Abbreviated name |
| `color` | `text` | Hex color for UI display |
| `weeklyLessons` | `int` | Default lessons per week (default 5) |
| `department` | `text` | One of 6 departments |
| `createdAt` | `timestamptz` | Row creation timestamp |

## Departments

| Department | Subjects |
|------------|----------|
| Mathematics | Mathematics |
| Languages | English, Somali, Arabic |
| Islamic Studies | Islamic Studies |
| Sciences | Science, Physics, Chemistry, Biology |
| Social Studies | Social Studies, History, Geography |

## Related

* [ManageSubjects](../ui/manage-subjects.md) — UI for CRUD on subjects.
* [ManageClassSubjects](../ui/manage-class-subjects.md) — UI linking classes to subjects.
* [ClassSubjects](class-subjects.md) — junction table linking classes to subjects.
