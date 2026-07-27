---
title: "RLS Policies (Teaching)"
type: Security Policy
tags: [teaching, security, rls]
timestamp: 2026-07-27T00:00:00Z
description: "RLS on attendance and homework — teachers manage their own records, admins full access, supervisors read assigned classes."
linked_concepts:
  - teaching:data-model/attendance
  - teaching:data-model/homework
  - core:security/rls-overview
  - core:data-model/profiles
---

# RLS Policies — Attendance & Homework

Row-level security for the `attendance` and `homework` tables.

## Attendance

| Role | Access |
|------|--------|
| Teacher | Full CRUD on own records (`teacherId = auth.uid`) |
| Admin | Full access (all records) |
| Supervisor | Read-only for assigned classes |

## Related

* [Attendance](../data-model/attendance.md) — secured by the `attendance` policies above.
* [Homework](../data-model/homework.md) — secured by the `homework` policies above.
* [Profiles](../../core/data-model/profiles.md) — `teacherId` FK used in policy conditions.

## Homework

| Role | Access |
|------|--------|
| Teacher | Full CRUD on own records (`teacherId = auth.uid`) |
| Admin | Full access (all records) |
| Supervisor | Read-only for assigned classes |

## Related

* [Attendance](../data-model/attendance.md) — secured by the `attendance` policies above.
* [Homework](../data-model/homework.md) — secured by the `homework` policies above.
* [Profiles](../../core/data-model/profiles.md) — `teacherId` FK used in policy conditions.
