---
type: Database Function
title: "get_system_stats (Admin)"
description: "System-wide aggregate statistics: teacher/parent/student/exam counts with status breakdown and average score."
tags: [admin-tools, api, analytics]
timestamp: 2026-07-27T00:00:00Z
---

# Overview

Returns a single-row summary of key platform metrics for the admin dashboard. Aggregates counts across users, students, and exams with status breakdowns.

# Returns

| Field | Type | Description |
|-------|------|-------------|
| teacher_count | integer | Total number of teachers |
| parent_count | integer | Total number of parents |
| student_count | integer | Total number of students |
| student_status_breakdown | JSONB | Counts by student status |
| exam_count | integer | Total number of exams |
| average_score | numeric | Mean score across all exams |

# Migration

`20260707_get_system_stats_rpc.sql`
