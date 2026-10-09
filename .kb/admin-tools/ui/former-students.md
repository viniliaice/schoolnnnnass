---
type: UI Page
title: "FormerStudents"
description: "Admin directory of students marked as Former Students: search, class filter, preserved-history panel, restore to Active, import history and batch rollback."
tags: [admin-tools, ui, admin, former-students, audit]
timestamp: 2026-10-08T00:00:00Z
linked_concepts:
  - "admin-tools:api/former-students-rpcs"
  - "admin-tools:ui/former-student-cleanup"
  - "admin-tools:data-model/former-students"
---

# Overview

Admin-only page for everything the cleanup produced. Two tabs:

* **Former Students** — search by name, System ID or Gov ID; filter by previous
  class/section; each row shows when it was marked former, by whom, and the
  source (import file / manual / backfill). Actions: **History** (read-only
  panel with the preserved record + the full `student_status_changes` ledger) and
  **Restore** (back to Active, restoring the exact previous transport, with an
  optional reason).
* **Import History** — one card per import in the shape the school asked for
  ("Import #12 — Uploaded 486 · Exact matches 452 · ID/name conflicts 8 ·
  Not found 26 · Deactivated 452 · date · imported by"), expandable to the
  per-row audit trail, with **Rollback** behind the typed phrase
  `ROLLBACK IMPORT`.

# Route

`/admin/former-students` — `ROUTE_ACCESS: ['admin']`, admin `switch` in
`App.tsx`, sidebar entry "Former Students". Linked from Manage Students, the
cleanup page's completion step and the admin dashboard's Former Students card.

# Notes

* Reads go through admin-gated RPCs (`list_former_students`,
  `list_former_student_imports`, `get_former_student_import`) rather than direct
  table selects, so the RLS on the new audit tables is never the only defence.
* A rollback that skips students (because their status changed after the import)
  reports them as `partially_rolled_back` with the reason per student.
* Responsive: the table becomes cards below `lg`, dialogs stack, buttons are
  full-width on small screens.

# Dependencies

| Module | Purpose |
|--------|---------|
| `lib/db/formerStudents.ts` | RPC wrappers, reason/status labels |
| `components/ui/Dialog.tsx`, `context/ToastContext`, `context/RoleContext` | Shared UI |

# Related API

* [Former Students cleanup RPCs](../api/former-students-rpcs.md)
* [Former Students data model](../data-model/former-students.md)
* [FormerStudentCleanup](former-student-cleanup.md) — the upload workflow that fills this page.
