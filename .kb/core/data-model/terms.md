---
title: "terms"
type: Database Table
tags: [core, schema, academic]
timestamp: 2026-07-27T00:00:00Z
description: "Term definitions within an academic year, with month mapping and current-term flag."
linked_concepts:
  - "core:data-model/academic-years"
  - "core:ui/manage-academic"
  - "exams:data-model/exam-periods"
  - "grades:data-model/term-grades"
  - "attendance:data-model/term-attendance"
---

# terms

## Columns

| Column | Type | Description |
|--------|------|-------------|
| `id` | `text` PK | Primary key |
| `name` | `text` | Term name (e.g., "Term 1", "Term 2", "Term 3") |
| `academicYearId` | `text` | FK → academic_years.id |
| `startDate` | `date` | Term start |
| `endDate` | `date` | Term end |
| `isCurrent` | `boolean` | Whether this is the active term |
| `months` | `text[]` | Array of month names covered by this term |
| `createdAt` | `timestamptz` | Row creation timestamp |

## Related

* [AcademicYears](academic-years.md) — `academicYearId` FK targets `academic_years.id`.
* [ManageAcademic](../ui/manage-academic.md) — UI for managing academic years and terms.
* [Missing Tables](missing-tables.md) — migration note for this table's CREATE statement.
