---
title: "ManageSubjects"
type: UI Page
tags: [core, ui, admin]
timestamp: 2026-07-27T00:00:00Z
description: "Admin interface for the subject catalog with department and metadata management."
linked_concepts:
  - "core:data-model/subjects"
  - "core:data-model/class-subjects"
  - "exams:data-model/exam-subjects"
---

# ManageSubjects

- **Data layer:** `lib/db/subjects.ts`
- **Access:** Admin only

## Features

- View subject catalog with color, department, and weekly lesson count
- Add new subjects
- Edit subject details
- Delete subjects
- Organize subjects by department

## Related

* [Subjects](../data-model/subjects.md) — underlying table for this UI.
* [ManageClassSubjects](manage-class-subjects.md) — assigns subjects to classes.
