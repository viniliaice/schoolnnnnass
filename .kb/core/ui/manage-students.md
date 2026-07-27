---
title: "ManageStudents"
type: UI Page
tags: [core, ui, admin]
timestamp: 2026-07-27T00:00:00Z
description: "Admin CRUD interface for student records — enrollment, editing, class assignment."
linked_concepts:
  - "core:data-model/students"
  - "core:data-model/profiles"
  - "core:security/rls-policies"
  - "attendance:data-model/attendance"
  - "exams:data-model/exam-results"
---

# ManageStudents

- **Route:** `/admin/students`
- **Data layer:** `lib/db/profiles.ts` (via `getStudentsPaginated`)
- **Access:** Admin only

## Features

- Paginated student list with search
- Enroll new students (name, class, parent assignment)
- Edit student details
- Delete student records
- Filter by class name
- Parent assignment via `parentId` FK to profiles

## Related

* [Students](../data-model/students.md) — underlying table for this UI.
* [Profiles](../data-model/profiles.md) — `parentId` FK targets `profiles.id`.
* [RLS Policies (Core)](../security/rls-policies.md) — RLS enforcing admin-only access.
