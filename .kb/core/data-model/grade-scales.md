---
title: "grade_scales (Core)"
type: Database Table
tags: [core, schema, grading]
timestamp: 2026-07-27T00:00:00Z
description: "Grade scale definitions mapping score ranges to letter grades."
linked_concepts:
  - "exams:data-model/exam-results"
  - "grades:data-model/report-cards"
  - "grades:data-model/gpa-config"
---

# grade_scales

## Columns

| Column | Type | Description |
|--------|------|-------------|
| `id` | `text` PK | Primary key |
| `minScore` | `numeric` | Minimum score for this grade (inclusive) |
| `maxScore` | `numeric` | Maximum score for this grade (inclusive) |
| `grade` | `text` | Letter grade: `A`, `B`, `C`, `D`, or `F` |
| `remark` | `text` | Description (e.g., "Excellent", "Good", "Fair", "Poor", "Fail") |
| `gpa` | `numeric` | GPA points for this grade |

## Related

* [Missing Tables](missing-tables.md) — migration note for this table's CREATE statement.
* [Grade Scales (Reports)](../../reports/data-model/grade-scales.md) — duplicate definition in reports bundle.
* [ReportConfig](report-config-type.md) — companion configuration table for grading.
