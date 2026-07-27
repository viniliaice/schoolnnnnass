---
title: "get_class_student_subject_progress"
type: Database Function
tags: [exams, api, rpc]
timestamp: 2026-07-27T00:00:00Z
description: "RPC returning per-student, per-subject exam entry progress for a given class and month."
linked_concepts:
  - core:data-model/exams
  - core:ui/class-progress
---

## Details

- **Migration**: 20260707_class_student_subject_progress_rpc.sql
- **Type**: RPC (Supabase)

### Parameters

| Parameter | Type | Description |
|-----------|------|-------------|
| p_class_id | text | Target class |
| p_month | text | Target month |

### Returns

JSONB array with student info and `examEntries[]` by exam type.

## Related

- [exams](../data-model/exams.md) — source table for exam entries
- [exam-types](../data-model/exam-types.md) — exam type constants
- [hooks](./hooks.md) — React Query wrapper for this RPC
- [class-progress](../ui/class-progress.md) — UI that displays this data
- [exam-verification](../ui/exam-verification.md) — verification page consuming status counts
