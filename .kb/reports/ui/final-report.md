---
okf_version: "0.1"
title: "FinalReport"
type: UI Page
tags: [reports, ui, parent]
timestamp: 2026-07-27T00:00:00Z
description: "Parent view of final cumulative results with weighted CA/midterm/final scores, pass/fail, and overall rank."
route: "/parent/final"
backend_fn: "getFinalReport"
---

# FinalReport

Parent-facing page displaying end-of-term cumulative results.

## Data Source

Calls `getFinalReport(student_id, term_id)` from `lib/db/reports.ts`.

## Display

- Weighted composite score per subject (`caWeight * avgCA + midtermWeight * midtermScore + finalWeight * finalScore`)
- Pass/fail determination per subject
- Overall class rank
- Cumulative GPA across all subjects
- Teacher comments summary

## Cross-References

- `api/report-rpc.md` — `getFinalReport` function
- `data-model/report-config.md` — Weight configuration
- `data-model/grade-scales.md` — Grade conversion
- `core:data-model/students` — Student context
