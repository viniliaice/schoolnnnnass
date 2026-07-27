---
type: Database Table
title: "student_promotions"
description: "Promotion history tracking — records each student's class advancement with academic year link."
tags: [admin-tools, schema, promotions]
timestamp: 2026-07-27T00:00:00Z
---

# Overview

Tracks every class promotion a student undergoes. Each row records the advancement from one class level to the next, linked to the academic year in which the promotion occurred.

# Schema

| Column | Type | Description |
|--------|------|-------------|
| id | text PK | Unique promotion record identifier |
| studentId | text FK→students.id CASCADE | The promoted student |
| fromClass | text | Source class before promotion |
| toClass | text | Destination class after promotion |
| academicYearId | text FK→academic_years.id SET NULL | Academic year of the promotion |
| createdAt | timestamptz | When the promotion was recorded |

# Indexes

| Name | Columns |
|------|---------|
| idx_student_promotions_student | studentId |
| idx_student_promotions_year | academicYearId |

# Migration

`20260721_student_promotions.sql`

# Cross-Bundle References

* [core:data-model/students](../../core/data-model/students.md) — Referenced by `studentId` FK.
* [core:data-model/academic-years](../../core/data-model/academic-years.md) — Referenced by `academicYearId` FK.
