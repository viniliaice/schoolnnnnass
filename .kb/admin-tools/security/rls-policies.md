---
type: Security Policy
title: "RLS Policies (Admin Tools)"
description: "Audit log RLS — authenticated users INSERT, admins SELECT all. Student promotion tracking visible to admins."
tags: [admin-tools, security, rls]
timestamp: 2026-07-27T00:00:00Z
---

# Overview

Row-level security policies governing access to admin-tools tables.

# Policies

## audit_logs

| Operation | Role | Behavior |
|-----------|------|----------|
| INSERT | Authenticated users | Any authenticated user may write audit entries |
| SELECT | Admins | Only users with admin role may read the full audit trail |

## student_promotions

Promotion records are visible to admin users for reporting and audit purposes.

# Affected Tables

* [audit_logs](../data-model/audit-logs.md) — RLS enforced on this table.
* [student_promotions](../data-model/student-promotions.md) — Admin-scoped visibility.
