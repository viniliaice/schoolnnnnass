---
type: UI Page
title: "FormerStudentCleanup"
description: "Admin upload → preview → review → typed confirmation → atomic apply workflow for marking students who left the school as Former Students."
tags: [admin-tools, ui, admin, former-students, import]
timestamp: 2026-10-08T00:00:00Z
linked_concepts:
  - "admin-tools:api/former-students-rpcs"
  - "admin-tools:ui/former-students"
  - "core:data-model/students"
---

# Overview

Admin-only workflow for the school's list of leavers. Mirrors the Student Class
Import pattern (`ClassImport.tsx`): parse locally → server preview → tabbed
review → explicit confirmation → ONE atomic RPC. No write happens before the
administrator types the confirmation phrase.

# Route

`/admin/student-cleanup` — `ROUTE_ACCESS: ['admin']`, admin `switch` in
`App.tsx`, sidebar entry "Student Cleanup".

# Steps

1. **Upload** — drag/drop or pick `.csv` / `.txt` / `.tsv` / `.xlsx` / `.xlsm` /
   `.xls` (≤ 5 MB, ≤ 5000 rows). CSV delimiters `,` `;` `|` and tab are detected
   from the header line (the school's lists arrive pipe-separated). Header
   aliases are matched exactly, then loosely on whole words ("Student Name
   (leavers)"), then positionally for a headerless export (with a warning). A
   file with no System ID column is refused: a name may never identify a student.
   A `.xlsx` template is downloadable.
2. **Review** — dashboard cards (Uploaded / Matched / Needs review / Not found /
   Ready to deactivate) plus the review table: Uploaded Name, Uploaded System
   ID, Database Name, Database System ID, Class/Section, Match Status, Name
   Match, Action. Filters (All / Safe / Needs review / Not found) + search.
   Mobile renders the same rows as cards with a sticky action bar.
3. **Confirm** — dialog with the exact wording ("You are about to mark N students
   as Former Students." / "No student records will be deleted." / "Historical
   records will be preserved." / "These students will no longer appear in active
   student lists.") and the typed phrase `MARK AS FORMER STUDENTS`.
4. **Done** — Deactivated / Skipped / Kept active / Blocked, "0 student records
   were deleted", the refused rows with reasons, and links to the directory.

# Safety rails in the UI

* Only `exact_match` rows are pre-selected ("Select All Safe Matches" selects
  nothing else). There is no plain "Deactivate All": the closest action ("Select
  every found row…") opens a red warning first and still cannot select blocked
  rows or bypass a per-row confirmation.
* A name-mismatch/duplicate row opens a review dialog; the admin must tick
  "I have checked this record…" before it can be selected.
* Not-found / missing-ID / already-former rows render "Cannot be applied" or "No
  action needed" with no control at all.
* If the preview RPC is missing (un-migrated database or the no-backend preview
  client), the page evaluates locally and says so in a banner — the server still
  re-checks every row at commit time.

# Dependencies

| Module | Purpose |
|--------|---------|
| `lib/import/formerStudents.ts` | Parsing, pure matching contract, template, limits |
| `lib/db/formerStudents.ts` | RPC wrappers + label helpers |
| `lib/db/students.ts` | `getStudents(…, 'all')` for the local-preview fallback |
| `components/ui/Dialog.tsx`, `context/ToastContext`, `context/RoleContext` | Shared UI |

# Related API

* [Former Students cleanup RPCs](../api/former-students-rpcs.md) — `preview_former_student_import`, `apply_former_student_import`.
* [FormerStudents directory](former-students.md) — where the result and its rollback live.
