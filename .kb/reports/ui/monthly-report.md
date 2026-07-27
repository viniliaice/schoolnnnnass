---
okf_version: "0.1"
title: "MonthlyReport"
type: UI Page
tags: [reports, ui, parent]
timestamp: 2026-07-27T00:00:00Z
description: "Parent view of monthly subject scores with averages and assessment breakdown."
route: "/parent/monthly"
backend_fn: "getMonthlyReport"
---

# MonthlyReport

Parent-facing page displaying monthly subject scores.

## Data Source

Calls `getMonthlyReport(student_id, term_id)` from `lib/db/reports.ts`.

## Display

- Per-subject monthly average scores
- Assessment type breakdown (CA components grouped by exam type)
- Visual indicators for performance trends

## Cross-References

- `api/report-rpc.md` — `getMonthlyReport` function
- `core:data-model/students` — Student context
