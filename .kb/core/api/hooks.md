---
type: Configuration
title: React Query Hooks (Core)
description: TanStack Query hooks for core student and class data.
tags: [core, api, hooks]
timestamp: 2026-07-27T00:00:00Z
---

Custom hooks wrapping core DB functions with TanStack Query.

- useStudents(classNames?) - getStudentsByClasses wrapper
- useClassNames - getStudentClasses wrapper

## Related

* [Students](../data-model/students.md) — data type returned by `useStudents`.
* [ManageStudents](../ui/manage-students.md) — UI consuming `useStudents`.
