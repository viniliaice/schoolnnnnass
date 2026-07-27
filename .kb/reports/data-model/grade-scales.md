---
okf_version: "0.1"
title: "grade_scales (Reports)"
type: Database Table
tags: [reports, schema, grading]
timestamp: 2026-07-27T00:00:00Z
description: "Grade scale definitions mapping percentage ranges to letter grades (A/B/C/D/F) with GPA values."
columns:
  - minScore
  - maxScore
  - grade
  - remark
  - gpa
source_file: "lib/db/reports.ts"
accessor_function: "getGradeScales()"
---

# `grade_scales`

Maps numeric score ranges to letter grades, remarks, and GPA values.

## Columns

| Column | Type | Description |
|---|---|---|
| `minScore` | `numeric` | Lower bound (inclusive) of the percentage range |
| `maxScore` | `numeric` | Upper bound (inclusive) of the percentage range |
| `grade` | `text` | Letter grade (A, B, C, D, F) |
| `remark` | `text` | Human-readable remark (e.g. "Excellent", "Pass", "Fail") |
| `gpa` | `numeric` | GPA value for the grade |

## Usage

Loaded by `lib/db/reports.ts` → `getGradeScales()` and used by report RPCs to assign letter grades and remarks to computed percentage scores.
