---
title: "ManageClassSubjects"
type: UI Page
tags: [core, ui, admin]
timestamp: 2026-07-27T00:00:00Z
description: "Admin interface for assigning subjects and teachers to classes."
linked_concepts:
  - "core:data-model/class-subjects"
  - "core:data-model/profiles"
  - "core:data-model/subjects"
  - "timetable:data-model/teacher-availability"
---

# ManageClassSubjects

- **Route:** `/admin/class-subjects`
- **Data layer:** `lib/db/classes.ts`
- **Access:** Admin only

## Features

- Assign subjects to classes
- Assign teachers to class-subject pairs
- View all class-subject-teacher mappings
- Remove assignments
- Filter by class, subject, or teacher

## Related

* [ClassSubjects](../data-model/class-subjects.md) — underlying junction table for this UI.
* [Subjects](../data-model/subjects.md) — `subjectId` FK targets `subjects.id`.
* [Profiles](../data-model/profiles.md) — `teacherId` FK targets `profiles.id`.
