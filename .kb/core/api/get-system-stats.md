---
title: "get_system_stats (Core)"
type: Database Function
tags: [core, api, analytics]
timestamp: 2026-07-27T00:00:00Z
description: "RPC returning aggregate counts: teachers, parents, students, exams, and exam status breakdowns."
linked_concepts:
  - "core:data-model/profiles"
  - "core:data-model/students"
  - "exams:data-model/exams"
  - "exams:data-model/exam-results"
---

# get_system_stats

## Migration

`20260707_get_system_stats_rpc.sql`

## Returns

JSONB object with the following keys:

| Key | Type | Description |
|-----|------|-------------|
| `totalTeachers` | `integer` | Count of profiles with role `teacher` |
| `totalParents` | `integer` | Count of profiles with role `parent` |
| `totalStudents` | `integer` | Count of all student records |
| `totalExams` | `integer` | Total exams created |
| `pendingExams` | `integer` | Exams with pending status |
| `approvedExams` | `integer` | Exams with approved status |
| `rejectedExams` | `integer` | Exams with rejected status |
| `averageScore` | `numeric` | Average score across all exam results |

## Related

* [Profiles](../data-model/profiles.md) — counts profiles grouped by `role`.
* [Students](../data-model/students.md) — counts all student records.
* [AdminDashboard](../../admin-tools/ui/admin-dashboard.md) — UI consuming this RPC.
* [get_system_stats (Admin)](../../admin-tools/api/get-system-stats.md) — duplicate definition in admin-tools bundle.
