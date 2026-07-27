---
okf_version: "0.1"
title: "MidtermReport"
type: UI Page
tags: [reports, ui, parent]
timestamp: 2026-07-27T00:00:00Z
description: "Parent view of midterm results with per-subject percentages, grades, remarks, and class ranking."
route: "/parent/midterm"
backend_fn: "getMidtermReport"
---

# MidtermReport

Parent-facing page displaying midterm results.

## Data Source

Calls `getMidtermReport(student_id, term_id)` which invokes the `get_midterm_report` Postgres RPC.

## Display

- Per-subject percentage scores
- Letter grade and remark (from `grade_scales`)
- Class rank per subject
- Class average and highest score comparison
- Conditional pass/fail indicators

## Cross-References

- `api/midterm-report-rpc.md` — Underlying RPC
- `data-model/grade-scales.md` — Grade/remark mapping
- `core:data-model/students` — Student context
