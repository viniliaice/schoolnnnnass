---
title: "get_exam_status_counts (Exam Status Counts)"
type: Database Function
tags: [exams, api, rpc]
timestamp: 2026-07-27T00:00:00Z
description: "RPC returning pending/approved/rejected counts filtered by class, student, subject, and search text."
linked_concepts:
  - core:data-model/exams
  - core:ui/exam-verification
---

## Details

- **Migration**: 20260427_add_exam_status_counts_function.sql
- **Type**: RPC (Supabase)

### Parameters

| Parameter | Type | Description |
|-----------|------|-------------|
| class_names | text[] | Filter by class names |
| student_ids | text[] | Filter by student IDs |
| subject_filter | text | Filter by subject |
| search_filter | text | Text search across relevant fields |

### Returns

Row count per status: pending, approved, rejected.

## Related

- [exams](../data-model/exams.md) — source table for status aggregation
- [exam-functions](./exam-functions.md) — client wrapper (getExamStatusCounts)
- [hooks](./hooks.md) — React Query wrapper
- [exam-verification](../ui/exam-verification.md) — UI that displays these counts
- [all-results](../ui/all-results.md) — results page with status filters
