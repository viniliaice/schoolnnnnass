---
title: "students"
type: Database Table
tags: [core, schema, students]
timestamp: 2026-07-27T00:00:00Z
description: "Student records — one row per enrolled student with class assignment and optional parent link."
linked_concepts:
  - "core:data-model/profiles"
  - "core:ui/manage-students"
  - "core:security/rls-policies"
  - "core:api/get-system-stats"
  - "exams:data-model/exam-results"
  - "attendance:data-model/attendance"
  - "grades:data-model/report-cards"
  - "timetable:data-model/class-schedule"
  - "finance:data-model/student-fees"
---

# students

## Columns

| Column | Type | Description |
|--------|------|-------------|
| `id` | `text` PK | Primary key |
| `name` | `text` | Student full name |
| `className` | `text` | FK-like reference to class name string |
| `parentId` | `text` | FK → profiles.id (the parent/guardian) |
| `createdAt` | `timestamptz` | Row creation timestamp |

## Indexes

| Name | Column(s) |
|------|-----------|
| `idx_students_parentId` | `parentId` |
| `idx_students_className` | `className` |

## Related

* [ManageStudents](../ui/manage-students.md) — UI for CRUD on students.
* [Profiles](profiles.md) — `parentId` FK targets `profiles.id`.
* [RLS Policies (Core)](../security/rls-policies.md) — row-level security for this table.
* [get_system_stats (Core)](../api/get-system-stats.md) — counts students.
