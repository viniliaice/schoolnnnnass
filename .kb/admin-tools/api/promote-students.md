---
type: Database Function
title: "promote_students"
description: "Atomic class promotion RPC — updates className for all students in from_class and inserts promotion history in one transaction."
tags: [admin-tools, api, rpc]
timestamp: 2026-07-27T00:00:00Z
---

# Overview

Wraps promotion logic in a single database transaction. Updates the `className` field for every student in `from_class` to `to_class`, and inserts corresponding rows into `student_promotions` for the given `academic_year_id`.

# Parameters

| Parameter | Type | Description |
|-----------|------|-------------|
| from_class | text | Source class level to promote from |
| to_class | text | Target class level to promote to |
| academic_year_id | text | Academic year to associate with the promotion records |

# Migration

`20260721_student_promotions.sql`

# Related Functions

| Function | Description |
|----------|-------------|
| getPromotionHistory | Retrieves past promotions for a given student or class |
| undoPromotion | Reverses the most recent promotion for a specified set of students |
