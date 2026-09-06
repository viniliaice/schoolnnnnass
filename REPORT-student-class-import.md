# REPORT — Student Class Update & New Student Import

**Date:** 2026-09-06 · **Branch:** `arena/01a076e2-schoolnnnnass`
**Feature:** Admins upload the school's Google-Sheet student/class list (exported as
`.xlsx`) and the app safely applies class moves (7A → 7B) and new enrollments —
with a full preview, duplicate/ambiguity protection, and historical-data safety.

---

## 1. What was changed

| File | Change |
|---|---|
| `supabase/migrations/20260906_student_class_import.sql` | **NEW.** Adds `student_promotions.source`, re-creates `promote_students()` so import moves don't block end-of-year promotions, and adds the atomic, admin-gated `apply_student_class_import()` RPC. |
| `supabase/tests/rls-student-class-import.sql` | **NEW.** Schema assertions: students stays RPC-write-only, the RPC is SECURITY DEFINER + admin-gated and never touches `exams`/`attendance`, history is tagged. |
| `src/lib/import/classImport.ts` | **NEW.** Pure parse → match → classify → summarize → commit-payload logic + `.xlsx` template export + role guard. Zero DB writes. |
| `src/lib/db/classImport.ts` | **NEW.** The single commit call: `applyStudentClassImport()` → the RPC. |
| `src/pages/admin/ClassImport.tsx` | **NEW.** The admin workflow UI (upload → preview tabs → confirm → result). |
| `src/App.tsx`, `src/lib/routing.ts`, `src/components/layout/Sidebar.tsx` | Route `/admin/class-import` (admin-only), sidebar entry "Class Updates / Import". |
| `src/types/index.ts` | `StudentPromotion.source?: 'promotion' \| 'class_import'`. |
| `src/lib/__tests__/classImport.test.ts`, `classImportApply.test.ts`, `routing.test.ts` | 41 new/updated tests (all 17 required scenarios + the exact final acceptance scenario). |

Nothing in the existing Manage Students / Bulk Import / Class Promotion features was
rewritten — this extends them.

## 2. How the existing data model works (inspection results)

- **`students`** — `id` (stable text PK), `name`, `className`, `parentId`, `govId`
  (government/admission ID), `transport`, `parentPhone`, `familyId`, `createdAt`.
  **`className` is the student's *current* class property** — there is no enrollment
  table and no per-year class assignment.
- **Historical records follow the student, not the class:** `exams` (grades) reference
  `studentId` + term/month; `attendance` references `studentId` + date (with the class
  of that day as a snapshot). Updating `students.className` therefore never touches
  historical grades/attendance — this is exactly how the existing `promote_students()`
  RPC works, and this import reuses that pattern.
- **Class-move history** is recorded in `student_promotions` (student, fromClass,
  toClass, academicYearId). The import writes rows tagged `source='class_import'`.
- **`student_promotions.source`** was added so a mid-year import move (e.g. one child
  7A→7B) does **not** trip `promote_students()`'s "already promoted this year" guard
  for the whole class later.
- **RLS reality:** `students` has **no** client INSERT/UPDATE policies; every student
  write in this app goes through an admin-checked SECURITY DEFINER RPC
  (`promote_students`, `set_student_import_fields`, `mark_student_left`, …). The new
  commit path follows the same enforced pattern (a lesson documented in
  `supabase/tests/rls-family-import.sql`).
- **Bulk Upload Grades** rosters derive from `students.className` joins
  (`class_subjects.className`), so committed class changes flow into teacher grade
  upload immediately.

## 3. Excel format

Header-name based (column order and extra columns are ignored, first worksheet used):

| Column | Aliases | Notes |
|---|---|---|
| **Student ID** | `student id`, `admission number`, … | Primary key `students.id` — strongest match key |
| **Gov ID** | `gov-id`, `government id`, `national id`, `id` | `students.govId`, secondary key |
| **Student Name** | `student name`, `name`, `full name` | required |
| **Current Class** | `class`, `grade`, `section`, `form` | required |
| **Parent Phone** | `parent phone`, `phone`, `second number` | only used as a match confirmation |

The page offers **Export current students (.xlsx)** which writes the current roster in
exactly this shape — the admin edits it (or edits the Google Sheet export directly)
and re-uploads. Class cells accept canonical names (`Grade 7-A`), sheet codes (`G7A`)
or shorthand (`7A`, `7-A`, `Grade 7A`) — **but only when they resolve to a class that
actually exists** in the app (`class_subjects` ∪ enrolled-student classes ∪
`Graduated`). Unknown classes (`7Z`, `Grade 9-Z`) are rejected per row, never converted
or invented.

## 4. Matching strategy (never guess)

1. **Priority 1 — Student ID:** exact `students.id` match.
2. **Priority 2 — Gov ID:** unique `students.govId` match. If several students share
   the Gov ID → **AMBIGUOUS**.
3. **Priority 3 — controlled secondary:** exact normalized name **plus matching parent
   phone** auto-matches. **Name alone never auto-matches** — one candidate goes to
   manual review, several candidates → **AMBIGUOUS — MANUAL REVIEW REQUIRED**.
4. **Unknown Student ID + name collides with an existing student →** manual review
   with `Student ID MBK-9999 does not exist` — a duplicate is **never** silently
   created. **Unknown ID + unknown name → NEW STUDENT** keeping the sheet's ID as the
   stable student ID.
5. Two uploaded rows resolving to the same student → the later row is held back as a
   conflict for review.

Manual review actions in the preview: **Resolve** (click the candidate to bind the
row to that student), **Exclude** (any row can be toggled out of the commit).

### Duplicate detection (in-file)

Same Student ID twice → `Rows 52 and 87 contain the same Student ID MBK-1022`
(only the first occurrence is processed); same Gov ID twice → flagged; exact duplicate
rows → not processed twice.

## 5. How class changes work

For every matched row, uploaded class is compared with the student's current
`className`:

- different → **CLASS CHANGE** (`7A → 7B` previewed per student),
- same → **NO CHANGE** (never touched).

On confirm, the RPC updates **only** `students.className` for each changed student and
records: one `student_promotions` row (student, from, to, academic year,
`source='class_import'`) + one `students.class_change` audit row (admin actor, import
reference, timestamp) + one `students.class_import` summary audit row. The same
student record keeps its ID, grades, attendance, reports, family links and history —
**no second student is ever created for a class move.**

## 6. How new students work

A row is **NEW STUDENT** only when it cannot be matched by any approved rule and its
name matches no existing student. Required fields: **name + valid class**. The
student ID comes from the sheet (kept as the stable ID) or is generated in the app's
`student-…` format and shown in the preview. Missing optional data (gov ID, phone) is
left blank — **nothing is invented**. Rows missing required fields are rejected with
row-level errors (`Row 82: Student name is required for a new student.`) and never
committed.

## 7. Historical data protection

- The commit RPC updates only `students.className`, inserts new `students` rows, and
  writes history/audit rows. It contains **no reference to `exams` or `attendance`**
  — enforced by the SQL assertion test.
- A move `7A → 7B` changes where the student appears in *current* rosters (bulk grade
  upload, attendance entry going forward) while all previously recorded grades and
  attendance stay attached to the same `studentId` with their original
  term/month/date and class snapshots.
- The move itself is preserved as history in `student_promotions` (auditable, and the
  Class Promotion screen's history/undo understands it via the `source` tag).

## 8. Safe transaction flow

```
Upload → Parse → Validate → Preview   (no DB writes anywhere)
            ↓ admin explicitly confirms
apply_student_class_import()  — ONE Postgres transaction:
   any validation/permission failure ⇒ RAISE ⇒ nothing applied
```

The preview summary mirrors the spec (rows in file / matched / class changes / new
students / unmatched / ambiguous / invalid), and the confirmation dialog states the
exact counts plus *"Historical grades and attendance will not be deleted."*

## 9. Errors handled (examples)

- `Row 43: Student ID MBK-9999 does not exist …` (never silently duplicated)
- `Row 51: Student name is required.` / `Class is required.`
- `Rows 52 and 87 contain the same Student ID MBK-1022.`
- `Row 64: Class 9Z does not exist.`
- `Row 71: Student … could not be safely matched — 2 possible students.`
- RPC failures (e.g. class deleted between preview and commit) abort the whole import
  with the DB error surfaced in a toast: *"Import failed — nothing was changed."*

## 10. Permissions

- Route `/admin/class-import` is listed in `ROUTE_ACCESS` as **admin-only** and only
  the admin switch in `App.tsx` renders it (teachers/supervisors/office/parents are
  redirected). Sidebar shows the entry only for admins.
- `assertCanImportClasses()` guards the UI actions client-side.
- **The enforcement point is SQL:** `apply_student_class_import()` raises
  `insufficient_privilege` for any non-admin caller, and `students` has no direct
  INSERT/UPDATE RLS policies to bypass it. Menu-hiding alone is not relied on.

## 11. Audit log

Per committed import: `students.class_import` (who, when, academic year, counts, full
change/create lists, import reference) + one `students.class_change` row per move
(student, old class, new class, academic year, actor, import reference). The import
reference is also returned to the UI.

## 12. Interaction with Bulk Upload Grades

Committed class changes are immediately visible to teachers: selecting *7B + Arabic*
after the import includes the student who moved 7A → 7B (rosters derive from
`students.className`). Covered by test #14. Recommended workflow: run this import
**before** teachers upload grades for the affected classes.

## 13. Tests performed

`npm run typecheck` ✅ · `npm run build` ✅ · `npx vitest run` ✅ **554/554 tests**
(38 new for this feature). All 17 required scenarios plus the exact final acceptance
scenario (Students A–E) are covered:

1. same class → no change · 2. A→B · 3. B→C · 4. new student · 5. unknown student ID
   (both outcomes) · 6. duplicate student ID · 7. duplicate Excel row · 8. ambiguous
   name · 9. invalid class · 10. missing required fields · 11. non-admin rejected
   (client guard + SQL assertion + RPC error propagation) · 12/13. commit payload
   carries no grade/attendance data + SQL assertion the RPC never touches
   `exams`/`attendance` · 14. bulk-grade roster after a move · 15. multiple class
   changes · 16. multiple new students · 17. 2,000-row file parses & classifies.

Also covered: class-alias resolution, header-order independence, blank-row skipping,
template round-trip, per-row exclusion, manual ambiguity resolution, conflicting rows.

SQL-level assertions live in `supabase/tests/rls-student-class-import.sql`
(run with `psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f supabase/tests/rls-student-class-import.sql`).

## 14. Remaining limitations / notes

- **Deployment:** the migration must be applied to the production database before use
  (`supabase db push` / migrations pipeline). The SQL tests require that migrated DB.
- **Name-only rows:** by design, rows with no ID/Gov-ID/phone can never auto-match
  (spec: "do not automatically match based on name alone"); on large ID-less sheets
  expect many manual-review rows. Exporting the template (which carries every stable
  ID) avoids this entirely.
- **Left/withdrawn students:** the import does not remove students absent from the
  sheet — absence is treated as "not mentioned", not "left" (use the existing
  mark-left tooling; no data is deleted by this feature).
- **Preview renders the first 500 rows per tab** for very large files (all rows still
  count in the summary and are included in the commit payload).
- New students are created with `parentId` unset; linking parents is done afterwards
  in Manage Students, matching the existing bulk-create behavior.
- The admin's Supabase session must be live at commit time (same as every other
  write in the app).
