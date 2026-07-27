---
type: UI Page
title: SupervisorDashboard
description: "Supervisor monitoring dashboard with teacher exam progress heat map, color-coded completion status, and drill-down to teacher details."
tags: [admin-tools, ui, dashboard]
timestamp: 2026-07-27T00:00:00Z
---

# Overview

Supervisor monitoring dashboard using `getTeacherExamProgress` and `getSupervisorDashboardData`. Shows per-teacher, per-month exam progress with heat map visualization. Color-coded cards: red (<30%), amber (30-70%), green (>70%). Drill-down to individual teacher-month progress.

# Route

`/dashboard` (supervisor role)

# Dependencies

| Module | Purpose |
|--------|---------|
| getTeacherExamProgress | Per-teacher exam progress data |
| getSupervisorDashboardData | Dashboard aggregation for supervisors |

# Related API

* [teacherExamProgress](../../exams/api/teacher-exam-progress.md) — Teacher exam progress RPC
