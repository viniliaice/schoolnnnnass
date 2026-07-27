---
title: "getAttendanceHomeworkStreams"
type: Database Function
tags: [teaching, api, streams]
timestamp: 2026-07-27T00:00:00Z
description: "Function that returns combined attendance and homework activity streams for dashboard feeds."
linked_concepts:
  - teaching:data-model/attendance
  - teaching:data-model/homework
  - core:api/streams
---

# `getAttendanceHomeworkStreams`

**Source:** `feature-schema.sql`

Returns a combined feed of recent attendance records and homework assignments for use in dashboard activity streams.

## Related

* [Attendance](../data-model/attendance.md) — data source for this function.
* [Homework](../data-model/homework.md) — data source for this function.
* [StreamsPage](../../communications/ui/streams-page.md) — UI consuming this function.
