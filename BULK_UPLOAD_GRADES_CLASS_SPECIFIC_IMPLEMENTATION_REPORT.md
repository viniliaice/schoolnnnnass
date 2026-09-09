# Bulk Upload Grades — Class-Specific, Roster-Prefilled Redesign

**Status:** Implemented · typecheck ✅ · 658 unit tests ✅ · production build ✅
**Constraint honoured:** one class at a time — **no multi-class selection was added.**

---

## Current Workflow (before this change)

The original teacher screen (`src/pages/teacher/BulkUploadGrades.tsx`) was a 3-step flow:

> **Configure & Upload → Resolve & Preview → Review & Confirm**

It already had a strong, server-authoritative backbone:

- **`src/lib/excel-parser.ts`** — the single source of truth for the 11
  assessment definitions (HW1–4 / 5, CPW1–4 / 15, Attendance / 20, MT / 20,
  Akhlaaq / 10), plus a fixed "11-columns-per-subject" parser.
- **`src/lib/db/bulkGrades.ts`** + the **`submit_bulk_grades`** RPC
  (`supabase/migrations/20260802_bulk_grade_integrity.sql`) — a preview / atomic
  upsert endpoint that derives the actor server-side and re-validates student
  identity, current class, teacher/class/subject assignment, term, month, date,
  score ranges, per-subject assessment identity, duplicates, and idempotency.
- **`src/lib/db/classes.ts`** — authorized class list + per-class authorized
  subjects (`getClassAssignmentsForTeacher`, `getClassSubjectsForTeacher`).
- **`src/lib/db/students.ts`** — roster query (`getStudentsByClasses`).

## Problems Found

1. **The template was blank.** The teacher had to type or paste Student IDs and
   names, or upload a legacy name-only file that then needed manual
   name→student confirmation. This was the biggest usability and safety risk.
2. **No assessment-block selection.** The template always contained all 11
   blocks for every subject, even when the teacher only wanted HW1/HW2/MT.
3. **A multi-subject "template subjects" menu** existed but the flow wasn't the
   clean, guided, class-first wizard the spec asks for.
4. **Column identity was positional** in the download template (the fixed
   11-column block), which is fragile if a teacher reorders columns.

The **server side already covered the security requirements** — so the redesign
is a UX + workbook-generation improvement layered on the existing authorization
model, not a new grade-upload system.

---

## New Class-by-Class Workflow

A 7-step wizard with an always-visible progress indicator:

> **1. Class & Subjects → 2. Assessment → 3. Download Example → 4. Upload → 5. Resolve & Validate → 6. Review → 7. Confirm**

1. **Class & Subjects** — pick exactly ONE authorized class; then tick which of
   *your assigned subjects in that class* to include.
2. **Assessment** — Term (read-only, real academic term), Month (restricted to
   the term's configured months), Assessment Date, and the assessment blocks
   grouped as Homework / CPW / Attendance / Midterm / Akhlaaq with maxima shown.
3. **Download Example** — generates `Grade_5-A_Arabic_Tarbiya_Grades.xlsx`,
   roster-prefilled, containing only the chosen subjects × chosen blocks.
4. **Upload** — drop the completed workbook → "File loaded successfully".
5. **Resolve & Validate** — client mirror categorizes rows into
   **Valid / Errors / Needs Review / Excluded**, then a server preview
   (no writes) confirms.
6. **Review** — server-validated **New grades / Grades changing** counts.
7. **Confirm** — full Upload Summary, then **Cancel / Back / Confirm & Upload**
   commits atomically.

The teacher repeats the same simple flow for Grade 5-B, Grade 6-A, Grade 6-B.
There is never more than one class in play.

---

## Teacher Subject Authorization

Authorization is `Teacher + Selected Class + Subject`, never "teaches Arabic ⇒
Arabic everywhere":

- **UI** loads authorized subjects for the selected class via
  `getClassSubjectsForTeacher(teacherId, className)` (the same RPC/query that
  already gates the class_subjects assignment). Only those subjects are shown.
- **Client resolve** (`resolveWorkbook`) binds each workbook subject to one of
  the teacher's *selected* authorized subjects; anything else becomes an error
  (`unauthorizedSubjects`).
- **Server** (`submit_bulk_grades`) independently re-derives the assigned
  teacher from `class_subjects` joined on the student's **current** `className`
  and rejects mismatches (`Teachers may upload only their assigned class
  subjects`). The client checks are advisory; the DB is authoritative.

---

## Workbook Design

New module **`src/lib/bulk-grades/workbook.ts`**:

- **Two sheets:** an `Instructions` sheet (class, subjects, blocks, maxima,
  how to enter grades, blank vs zero, absent handling, what not to change, how
  to upload) and a single **`Grades`** worksheet — exactly ONE class.
- **Roster-prefilled:** `Student ID` and `Student Name` columns are filled from
  the current class roster. The teacher never types an ID.
- **Self-describing columns:** every grade column header is
  `"<Subject> <Block>"` — e.g. `Arabic HW1`, `Arabic MT`, `Tarbiya Akhlaaq`.
  Identity comes from the header text, not the column position.
- **Only selected subjects × selected blocks** are generated
  (`buildGradeColumns`).
- **Akhlaaq isolation:** `Arabic Akhlaaq` and `Tarbiya Akhlaaq` are separate
  columns → separate `subjectId`-scoped records. Verified by test.
- **Advisory read-only** protection is set on the sheet; because the community
  `xlsx` build does not reliably persist cell protection, the **server** is the
  authoritative guard against edited IDs/rosters (not the spreadsheet lock).
- **File name:** `workbookFileName('Grade 5-A', ['Arabic','Tarbiya'])` →
  `Grade_5-A_Arabic_Tarbiya_Grades.xlsx` (spaces→`_`, existing hyphens kept).

## Parser

- New **`parseRosterWorkbook`** reads the self-describing format, resolving each
  header via `parseGradeColumnHeader` (last token = block; the rest = subject,
  so multi-word subjects like "Social Studies" survive). It detects the
  `Grades` sheet, requires a `Student ID` column, and flags unknown/renamed
  columns, duplicate columns, duplicate student rows, and rows with a missing
  Student ID (manually added students).
- **No second source of truth for score semantics.** The legacy parser was
  refactored to expose **`interpretScoreCell(raw, total)`**; both the legacy
  fixed-block parser and the new roster parser call it, so blank / Absent /
  N/A / integer-range behavior can never drift. All 8 pre-existing
  `excel-parser` tests still pass unchanged.
- `isRosterWorkbook()` lets the app distinguish the new format safely.

## Validation

**`src/lib/bulk-grades/resolve.ts`** (pure, unit-tested) mirrors the server:

- student identity **only** from `students.id` (never name/row/Excel position);
- student must be in the **current** roster of the selected class;
- subject must be one of the teacher's selected authorized subjects;
- assessment identity + maxima come from the shared definitions;
- blank cells are excluded (never coerced to zero); Absent/N/A are explicit;
- duplicate `student+subject+type+label+term` within the upload is an error.

Results are surfaced as **Valid / Errors / Needs Review / Excluded** counts.
The **server preview** (`p_confirm_updates=false`) then re-validates everything
without writing.

## Security

The workbook is never trusted. End to end, the server independently validates:

```
authenticated teacher → selected class → student's CURRENT class →
subject → teacher/class/subject assignment → assessment → grade
```

The teacher cannot alter teacherId, class/subject authorization, parentId,
approval status, or maximum score through Excel — none of those are read from
the file; the RPC derives them. SQL assertions in
**`supabase/tests/rls-bulk-grades.sql`** verify: single SECURITY DEFINER RPC,
actor derived server-side, wrong-class binding, maxima, preview-before-write,
atomic upsert + idempotency ledger, and RLS on `exams`.

## Existing Grade Overwrites

The server preview returns `insertCount` (new) and `updateCount` (changing).
Step 6 shows both and warns that existing scores will be replaced on the same
`student+subject+examType+assessmentLabel+term` key and that approval status
resets to `pending`. Nothing is written until step 7 is confirmed.

## Class Change Compatibility

Fully compatible with the Student Class Update & Import workflow:

- The roster is always re-queried live for the selected class, so a student
  moved `7-A → 7-B` appears in 7-B's next template and disappears from 7-A's.
- Historical grades are **not** rewritten by class moves (that workflow only
  touches `students.className` + enrollment history; grade rows are untouched).
- **Stale roster:** if a student moved after the template was downloaded, both
  the client resolve and the server reject the now-wrong-class record with a
  clear "re-download the template" message rather than silently moving anyone.

## UI Changes

- `src/pages/teacher/BulkUploadGrades.tsx` rewritten as the 7-step wizard
  (class → subjects → assessment config + blocks → download → upload →
  resolve/validate → review → confirm) with a clickable-back progress bar.
- Uses `Blob`-based download (works for generated bytes) and the new modules.
- Route unchanged: `/teacher/bulk-grades` and `/admin/bulk-grades`
  (admin path still works; admin sees all class subjects for the class).

## Tests

- **`src/lib/__tests__/bulk-grades-workbook.test.ts`** (15): definitions are
  derived from the single source; grouping; column construction; Akhlaaq
  separation; header parsing (multi-word subjects); file naming; build↔parse
  roundtrip with roster prefill; max-score rejection; Absent/N/A; renamed-column
  tampering; manually-added-row (missing ID) detection.
- **`src/lib/__tests__/bulk-grades-resolve.test.ts`** (6): subject-scoped
  records; Arabic vs Tarbiya Akhlaaq isolation; wrong-class/stale rejection;
  unauthorized-subject rejection; blank-row exclusion; moved-in student
  resolves.
- **`supabase/tests/rls-bulk-grades.sql`** (7 assertion blocks): server
  authorization invariants (see Security).
- Pre-existing `excel-parser.test.ts` (8) and `bulk-grades.test.ts` (2) still
  pass unchanged.

## Performance

- Template generation and validation operate on a **single class roster**
  (~40 students) — no whole-school fetch. Subjects/roster load in parallel.
- One RPC round-trip for preview, one for commit; the atomic upsert uses the
  existing partial unique index `exams_bulk_assessment_identity_unique`.

## Backwards Compatibility

- `ASSESSMENT_DEFINITIONS`, `submit_bulk_grades`, `BulkGradeRecord`, and the
  `classes`/`students`/`academic` queries are unchanged — no new grade-upload
  system was created.
- The legacy fixed-block parser (`parseExcel`) and its tests are untouched
  aside from a behavior-preserving extraction of `interpretScoreCell`.
- No database migration was required; the existing RPC already enforces the
  full authorization model.

## Remaining Risks

- **Spreadsheet cell-lock isn't enforced by the community `xlsx` writer**, so
  the read-only ID/name columns are advisory in Excel. This is mitigated
  entirely server-side (student identity/class/authorization are re-derived, not
  read from the file), which is the correct trust boundary.
- **Subject-name aliasing** (Math↔Mathematics, Tarbiya↔Tarabiya) is used to
  bind workbook headers to authorized subjects; unusual custom subject names
  outside the alias table fall back to exact (normalized) matching. Because the
  workbook headers are generated from the authorized subject names themselves,
  this only matters for hand-edited files, which the server rejects if
  unauthorized.

## Final Verification

| Check | Result |
|-------|--------|
| `npm run typecheck` | ✅ pass |
| `npm run test:ci` | ✅ 658 passed (65 files) |
| `npm run build` | ✅ built in ~13s |

---

## Final Question

> **Can a teacher teaching Arabic and Tarbiya in Grade 5-A select Grade 5-A, see
> only Arabic and Tarbiya, download a roster-prefilled Grade 5-A workbook, enter
> the grades without manually entering student IDs, upload it, review all
> changes, and safely confirm the grades — while the server prevents
> unauthorized students, classes, and subjects?**

**Yes.** The teacher selects one class (Grade 5-A), sees only their authorized
subjects for that class (Arabic, Tarbiya), picks assessment blocks, and
downloads `Grade_5-A_Arabic_Tarbiya_Grades.xlsx` with the roster (Student IDs +
names) already filled in. They enter only grades, upload once, review
server-validated new/changed counts, and confirm an atomic commit. Unauthorized
students (wrong/stale class), classes, and subjects are rejected client-side and,
authoritatively, by the `submit_bulk_grades` RPC. This is demonstrated by the
build, 21 new unit tests, and the server-authorization SQL assertions — with
**no multi-class support added**.
