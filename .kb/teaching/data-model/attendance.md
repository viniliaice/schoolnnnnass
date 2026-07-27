---
title: "attendance"
type: Database Table
tags: [teaching, schema, attendance]
timestamp: 2026-07-27T00:00:00Z
description: "Daily student attendance records — one row per student per date with status and notes."
linked_concepts:
  - core:data-model/students
  - core:data-model/profiles
  - teaching:security/rls-policies
---

# `attendance`

**Source:** `supabase-schema.sql`, `feature-schema.sql`

Daily attendance records. Each row represents one student's attendance for a given date.

## Columns

| Column | Type | Constraints |
|--------|------|-------------|
| `id` | text | PK |
| `studentId` | text | FK → `students.id` ON DELETE CASCADE |
| `className` | text | |
| `date` | date | |
| `status` | text | CHECK (`present`, `absent`, `late`) |
| `note` | text | |
| `teacherId` | text | FK → `profiles.id` ON DELETE CASCADE |
| `createdAt` | timestamptz | |

## Constraints

- `UNIQUE(studentId, date)` — one record per student per day

## Indexes

| Name | Columns |
|------|---------|
| `idx_attendance_class_date` | `className`, `date` |
| `idx_attendance_student` | `studentId` |

## Related

* [Students](../../core/data-model/students.md) — `studentId` FK targets `students.id`.
* [Profiles](../../core/data-model/profiles.md) — `teacherId` FK targets `profiles.id`.
* [RLS Policies (Teaching)](../security/rls-policies.md) — row-level security for this table.
* [Attendance DB Functions](../api/attendance-functions.md) — CRUD functions for this table.
* [RecordAttendance](../ui/record-attendance.md) — UI for recording attendance.
