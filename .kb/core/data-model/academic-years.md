---
title: "academic_years"
type: Database Table
tags: [core, schema, academic]
timestamp: 2026-07-27T00:00:00Z
description: "Academic year definitions with current-year flag."
linked_concepts:
  - "core:data-model/terms"
  - "core:ui/manage-academic"
  - "exams:data-model/exam-periods"
  - "grades:data-model/session-config"
  - "attendance:data-model/session-config"
---

# academic_years

## Columns

| Column | Type | Description |
|--------|------|-------------|
| `id` | `text` PK | Primary key |
| `name` | `text` | Display name (e.g., "2025-2026") |
| `startDate` | `date` | Year start |
| `endDate` | `date` | Year end |
| `isCurrent` | `boolean` | Whether this is the active academic year |
| `createdAt` | `timestamptz` | Row creation timestamp |

## Related

* [Terms](terms.md) — terms belong to academic years via `academicYearId`.
* [ManageAcademic](../ui/manage-academic.md) — UI for managing academic years and terms.
* [Missing Tables](missing-tables.md) — migration note for this table's CREATE statement.
