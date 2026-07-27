---
okf_version: "0.1"
title: "Report DB Functions"
type: Database Function
tags: [reports, api]
timestamp: 2026-07-27T00:00:00Z
description: "Server-side report computation functions — getMonthlyReport, getMidtermReport, getFinalReport, plus getReportComment and upsertReportComment."
source_file: "lib/db/reports.ts"
---

# Report DB Functions

All defined in `lib/db/reports.ts`.

## `getMonthlyReport(student_id, term_id)`

Computes monthly subject score averages and assessment breakdown for a given student and term.

## `getMidtermReport(student_id, term_id)`

Computes the midterm report with per-subject percentages, letter grades, remarks, class rank, class average, and highest score.

## `getFinalReport(student_id, term_id)`

Computes the final cumulative report with weighted CA / midterm / final scores, overall pass/fail status, and class rank.

## `getReportComment(student_id, term_id, subject_id)`

Retrieves a teacher's written comment for a specific subject on a student's report.

## `upsertReportComment(student_id, term_id, subject_id, comment)`

Creates or updates a teacher's written comment for a subject on a student's report.

## Cross-References

- `api/midterm-report-rpc.md` — Underlying `get_midterm_report` RPC
- `core:data-model/students` — Student parameter
- `core:data-model/terms` — Term parameter

## Related

- [midterm-report-rpc](midterm-report-rpc.md) — underlying midterm RPC
- [report-config](../data-model/report-config.md) — weight configuration
- [grade-scales](../data-model/grade-scales.md) — grade scale mapping
- [grading-logic](../grading-logic.md) — client-side grading helpers
- [MonthlyReport](../ui/monthly-report.md) — monthly report UI
- [MidtermReport](../ui/midterm-report.md) — midterm report UI
- [FinalReport](../ui/final-report.md) — final report UI
- [ExamReport](../ui/exam-report-admin.md) — exam report admin page
