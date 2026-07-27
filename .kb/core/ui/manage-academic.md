---
title: "ManageAcademic"
type: UI Page
tags: [core, ui, admin]
timestamp: 2026-07-27T00:00:00Z
description: "Admin interface for managing academic years and terms."
linked_concepts:
  - "core:data-model/academic-years"
  - "core:data-model/terms"
  - "exams:data-model/exam-periods"
  - "grades:data-model/session-config"
---

# ManageAcademic

- **Route:** `/admin/academic`
- **Data layer:** `lib/db/academic.ts`
- **Access:** Admin only

## Features

- Create, edit, delete academic years
- Set current academic year via `isCurrent` flag
- Create, edit, delete terms within an academic year
- Set current term via `isCurrent` flag
- Configure term months array

## Related

* [AcademicYears](../data-model/academic-years.md) — underlying table for this UI.
* [Terms](../data-model/terms.md) — underlying table for this UI.
