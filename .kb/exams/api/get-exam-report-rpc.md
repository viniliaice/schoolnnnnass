---
title: "get_exam_status_counts (Exam Report RPC)"
type: Database Function
tags: [exams, api, rpc]
timestamp: 2026-07-27T00:00:00Z
description: "Exam report RPC used by admin/supervisor/teacher exam report pages."
linked_concepts:
  - core:data-model/exams
  - core:data-model/report-comments
  - core:ui/exam-report
---

## Details

- **Type**: RPC (Supabase)

### Usage

Serves the admin/supervisor/teacher exam report pages with filtered result data.

## Related

- [exams](../data-model/exams.md) — source table for report data
- [report-comments](../data-model/report-comments.md) — comments attached to exam results
- [exam-report](../ui/exam-report.md) — UI that consumes this RPC
- [get-midterm-report](./get-midterm-report.md) — midterm variant of report RPC
- [hooks](./hooks.md) — React Query wrapper
