---
title: "get_midterm_report"
type: Database Function
tags: [exams, api, reports]
timestamp: 2026-07-27T00:00:00Z
description: "RPC computing midterm report for a student — per-subject scores, rank, class average, highest."
linked_concepts:
  - core:data-model/exams
  - core:data-model/report-comments
  - core:ui/exam-report
---

## Details

- **Migration**: 20260707_midterm_report_rpc.sql
- **Type**: RPC (Supabase)

### Parameters

| Parameter | Type | Description |
|-----------|------|-------------|
| p_student_id | text | Target student |
| p_term_id | text | Target term |

### Returns

JSONB with:
- `scores[]` — per-subject score, total, average
- `overall_rank`
- `total_students`

## Related

- [exams](../data-model/exams.md) — source table for midterm scores
- [report-comments](../data-model/report-comments.md) — comments attached to reports
- [exam-report](../ui/exam-report.md) — UI that consumes this RPC
- [get-exam-report-rpc](./get-exam-report-rpc.md) — general exam report RPC
- [exam-types](../data-model/exam-types.md) — Midterm type constant
