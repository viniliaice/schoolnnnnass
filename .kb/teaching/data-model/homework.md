---
title: "homework"
type: Database Table
tags: [teaching, schema, homework]
timestamp: 2026-07-27T00:00:00Z
description: "Homework assignments per student with tracking status."
linked_concepts:
  - core:data-model/students
  - core:data-model/profiles
  - teaching:security/rls-policies
---

# `homework`

**Source:** `supabase-schema.sql`, `feature-schema.sql`

Homework assignments tracking per student from creation through grading.

## Columns

| Column | Type | Constraints |
|--------|------|-------------|
| `id` | text | PK |
| `studentId` | text | FK → `students.id` ON DELETE CASCADE |
| `className` | text | |
| `subject` | text | |
| `title` | text | |
| `description` | text | |
| `dueDate` | date | |
| `status` | text | DEFAULT `'assigned'`, CHECK (`assigned`, `submitted`, `graded`) |
| `teacherId` | text | FK → `profiles.id` ON DELETE CASCADE |
| `createdAt` | timestamptz | |

## Indexes

| Name | Columns |
|------|---------|
| `idx_homework_class` | `className` |
| `idx_homework_student` | `studentId` |
| `idx_homework_title_class` | `title`, `className` |

## Related

* [Students](../../core/data-model/students.md) — `studentId` FK targets `students.id`.
* [Profiles](../../core/data-model/profiles.md) — `teacherId` FK targets `profiles.id`.
* [RLS Policies (Teaching)](../security/rls-policies.md) — row-level security for this table.
* [Homework DB Functions](../api/homework-functions.md) — CRUD functions for this table.
* [AssignHomework](../ui/assign-homework.md) — UI for assigning homework.
