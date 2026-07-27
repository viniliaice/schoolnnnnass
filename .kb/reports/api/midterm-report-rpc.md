---
okf_version: "0.1"
title: "get_midterm_report (DB RPC)"
type: Database Function
tags: [reports, api, rpc]
timestamp: 2026-07-27T00:00:00Z
description: "Postgres RPC returning computed midterm report with per-subject scores, rank, class average, and highest score."
source_file: "db/migrations/20260707_midterm_report_rpc.sql"
params:
  - p_student_id
  - p_term_id
returns: JSONB
---

# `get_midterm_report`

Postgres RPC function created in migration `20260707_midterm_report_rpc.sql`.

## Parameters

| Param | Type | Description |
|---|---|---|
| `p_student_id` | `uuid` | Target student |
| `p_term_id` | `uuid` | Academic term |

## Returns

`JSONB` — Midterm report payload containing per-subject scores, rank, class average, and highest score for the student's class.

## Cross-References

- `api/report-rpc.md` — `getMidtermReport` TypeScript wrapper that calls this RPC
- `exams:data-model/exams` — Source exam score data
- `data-model/report-config.md` — Weight configuration used in computation
- `data-model/grade-scales.md` — Grade scale used to convert percentages

## Related

- [report-rpc](report-rpc.md) — TypeScript wrapper calling this RPC
- [report-config](../data-model/report-config.md) — weight configuration
- [grade-scales](../data-model/grade-scales.md) — grade scale mapping
- [exams](../../exams/data-model/exams.md) — source exam score data
- [MidtermReport](../ui/midterm-report.md) — midterm report UI
- [ExamReport](../ui/exam-report-admin.md) — exam report admin page
