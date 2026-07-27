---
type: UI Page
title: AdminDashboard
description: "Admin home page with system-wide statistics — total users, students, exams, approval rates, recent activity, and class summaries."
tags: [admin-tools, ui, dashboard]
timestamp: 2026-07-27T00:00:00Z
---

# Overview

Admin dashboard showing system-wide statistics from `getSystemStats`: teachers, parents, students, exams, pending/approved/rejected counts, average score. Includes recent exam entries, class roster summary with pagination, and quick links to all admin features.

# Route

`/dashboard` (admin role)

# Dependencies

| Module | Purpose |
|--------|---------|
| getSystemStats | System-wide statistics aggregation |

# Related API

* [getSystemStats](../api/get-system-stats.md) — Core stats RPC
* [getSystemStats (admin-tools)](../api/get-system-stats.md) — Admin-tools variant
