# Former Students / Student Cleanup — Implementation Report

**Date:** 2026-10-08 · **Branch:** `arena/611716f2-schoolnnnnass` · **Base:** `1e781eb`

Admin-only feature that lets the school upload its list of students who left
(`Student Name | System ID`), have the **database** identify them by System ID,
review every match, and mark the confirmed leavers as **Former Students**.
Nothing is ever deleted; all history is preserved.

**Validation:** `npm run validate` ✅ end to end — `typecheck` 0 errors ·
`typecheck:api` 0 errors · `test:ci` **153 files / 1661 tests passing** · `build` ✅.
Baseline before this work: 145 files / 1539 tests → **+8 test files, +122 tests, no regressions**.

---

## 1. Files changed

### New — database (2)

| File | Purpose |
|------|---------|
| `supabase/migrations/20261008_former_students_cleanup.sql` | `students.status` + ledger + import tables + 8 admin RPCs + policy function; updates `get_system_stats`, `promote_students`, `mark_student_left`; backfills `transport='LEFT'` students |
| `supabase/migrations/20261008b_former_students_roster_filters.sql` | Recreates `teacher_exam_progress` (view) and `get_class_student_subject_progress()` with one added predicate each |

No existing migration file was edited (repo rule: migrations are append-only).

### New — application (4)

| File | Purpose |
|------|---------|
| `src/lib/import/formerStudents.ts` | Pure layer: CSV/XLSX parsing, delimiter sniffing, header aliases, file issues, the matching contract (`evaluateFormerStudentRows`), name normalization/similarity, `.xlsx` template, limits |
| `src/lib/db/formerStudents.ts` | RPC wrappers, result types, label helpers, `assertCanManageFormerStudents` |
| `src/pages/admin/FormerStudentCleanup.tsx` | Upload → preview → review → typed confirmation → completion |
| `src/pages/admin/FormerStudents.tsx` | Directory (search/filter/restore/history) + import history + rollback |

### New — tests (9)

| File | Tests | What it proves |
|------|-------|----------------|
| `src/lib/__tests__/pgFormerStudentsHarness.ts` | — | PGlite harness that boots the **actual shipped migrations** on a synthetic schema |
| `src/lib/__tests__/formerStudents.cleanup.db.test.ts` | 41 | Every safety rule executed on real PostgreSQL (see §6) |
| `src/lib/__tests__/formerStudentsParse.test.ts` | 20 | CSV (`,` `;` `|` tab), XLSX, header aliases, headerless, numeric-ID warning, duplicates, limits, template round-trip |
| `src/lib/__tests__/formerStudentsMatching.test.ts` | 19 | Matching + safety contract in the pure layer |
| `src/lib/__tests__/studentsStatusFilter.test.ts` | 8 | Active-only defaults in `lib/db/students.ts`; missing status = active |
| `src/lib/__tests__/studentsStatusFallback.test.ts` | 4 | Legacy-column retry when the database has not been migrated |
| `src/lib/__tests__/formerStudentCleanupPage.test.tsx` | 15 | Page behaviour in jsdom (columns, selection rails, review dialog, phrase gate) |
| `src/lib/__tests__/formerStudentsPage.test.tsx` | 9 | Directory, restore, history panel, import history, rollback phrase |
| `src/lib/__tests__/formerStudentsPreviewClient.test.ts` | 4 | The no-backend preview client honours the same contract end to end |

### Modified (18)

| File | Change |
|------|--------|
| `src/types/index.ts` | `StudentStatus`, `StudentStatusFilter`, `Student.status/statusUpdatedAt/statusUpdatedBy` |
| `src/lib/db/students.ts` | Status-aware readers (default `'active'`), `isActiveStudentRecord`, `filterStudentsByStatus`, legacy-column fallback |
| `src/lib/db/stats.ts` | `SystemStats.formerStudents`; fallback counts active = all − former (tolerates an unmigrated DB) |
| `src/lib/db/progress.ts` | Class-progress + teacher-progress **fallbacks** now use the shared active-only roster readers |
| `src/lib/db/parent-portal.ts` | Parent portal snapshot lists active children only |
| `src/lib/db/parentWeeklyLearning.ts` | Weekly-learning child picker lists active children only |
| `src/lib/db/duplicateStudents.ts` | Duplicate detection explicitly uses `'all'` (a leaver can still be a duplicate) |
| `src/lib/routing.ts` | `/admin/student-cleanup`, `/admin/former-students` → `['admin']` |
| `src/App.tsx` | Two admin route cases + imports |
| `src/components/layout/Sidebar.tsx` | "Student Cleanup" and "Former Students" admin entries |
| `src/lib/hooks/useClassNames.ts` | Explicit `getStudentClasses('active')` (React Query would otherwise pass its context as the new status arg) |
| `src/lib/supabase.ts` | Preview client: demo students carry `status`, 2 demo leavers, mock implementations of all 8 RPCs, HMR marker bumped 1 → 2 |
| `src/pages/admin/ManageStudents.tsx` | Note + links: leavers are not listed here |
| `src/pages/admin/AdminDashboard.tsx` | "Former Students" stat card (links to the directory) |
| `src/pages/admin/ClassImport.tsx`, `src/pages/admin/FamilyIds.tsx`, `src/pages/admin/ExamVerification.tsx`, `src/pages/reports/ExamReport.tsx`, `src/pages/parent/ExamResults.tsx` | Explicit `'all'` where the workflow is identity/historical rather than a current roster |
| `src/lib/__tests__/routing.test.ts`, `stats.test.ts`, `progress-utils.test.ts` | Updated for the new routes, the new stats key, and the shared roster reader in the fallback |

### New — knowledge base (5)

`.kb/core/data-model/students.md` (rewritten with the status columns),
`.kb/admin-tools/data-model/former-students.md`,
`.kb/admin-tools/api/former-students-rpcs.md`,
`.kb/admin-tools/ui/former-student-cleanup.md`,
`.kb/admin-tools/ui/former-students.md`, plus index/admin-role-map updates.

---

## 2. Database / schema changes

**Existing student table inspected first.** The authoritative System ID is
`students.id` (TEXT PK, generated by `create_student` as
`'student-' || epoch_ms || '-' || md5substr(6)` — exactly the `student-123456`
shape in the request). No second identifier was introduced.

### `students` (extended, not replaced)

```sql
status          TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','former'))
statusUpdatedAt TIMESTAMPTZ
statusUpdatedBy TEXT
+ idx_students_status, idx_students_status_class,
  idx_students_status_updated (statusUpdatedAt DESC) WHERE status = 'former'
```

A status field on the existing table was chosen over a separate table, as
requested. `'former'` is applied **together with** `transport = 'LEFT'` — the
school's existing left-school marker — so the already-tested exclusions
(family-ID generation, family cards, print batches, `gateEligibility`,
`record_release`, `attach_students_to_authorized_pickup`) immediately cover
leavers without re-typing safety-critical gate SQL. `familyId` is never touched.

### New tables (RLS: SELECT admin-only, **no client write policy**)

* `student_status_changes` — append-only ledger: previous/new status, **previous
  transport**, actor id + name, `importId`, `fileName`, reason
  (`former_import` / `former_manual` / `import_rollback` / `manual_restore` /
  `legacy_left_backfill`), note, timestamp.
* `former_student_imports` — one row per upload, with `seq BIGSERIAL UNIQUE`
  (the "Import #12" number), all preview counters, outcome counters, rollback
  state and the raw `summary` JSONB.
* `former_student_import_rows` — per-row audit: uploaded vs database values,
  `matchStatus`, `nameMatch`, `nameSimilarity`, `reasons[]`, requested action,
  `adminConfirmed`, `actionTaken`, `actionReason`, previous/new status, restore
  stamp.

### Functions

`former_students_policy()` (documented policy — single source of truth for rules
and UI text), `_former_name_key`, `_former_name_key_loose`,
`_former_name_similarity`, `_former_evaluate_rows` (the contract; EXECUTE revoked
from `anon`/`authenticated`), `preview_former_student_import`,
`apply_former_student_import`, `rollback_former_student_import`,
`list_former_student_imports`, `get_former_student_import`,
`list_former_students`, `set_student_former_status`. All admin-gated
`SECURITY DEFINER … SET search_path = public`, `REVOKE`d from `PUBLIC`,
`GRANT EXECUTE`d to `authenticated` — the two-tier convention already used by
`20260925_safe_duplicate_batch.sql`.

### Backfill

Students already carrying `transport = 'LEFT'` are set to `status = 'former'`,
each with a `legacy_left_backfill` ledger row plus one aggregate
`students.status_backfill` audit entry. The whole migration is idempotent (the
backfill is asserted to produce exactly one ledger row after three runs).

### Deploy order

Apply the migration **before** the client release. The client also survives the
reverse order: an explicit column list that includes `status` would fail against
an un-migrated database (PostgREST `42703`/`PGRST204`), so every student read
retries once with the legacy column list and logs a warning — rosters degrade to
"no former filtering" instead of going blank.

---

## 3. New routes, pages, components

| Route | Page | Access |
|-------|------|--------|
| `/admin/student-cleanup` | `FormerStudentCleanup` | admin (route map + App switch + SQL) |
| `/admin/former-students` | `FormerStudents` | admin (same three layers) |

Sidebar: **Student Cleanup** and **Former Students** in the admin nav. Also
linked from Manage Students, the cleanup completion step, and the dashboard's
new Former Students card.

Reusable pieces: `Dialog`, `useToast`, `useRole`, `cn`, lucide icons, Tailwind —
no new UI primitives were invented. Local components: `StatusBadge`,
`NameMatchBadge`, `SummaryCard`, `StepBadge`, `RowActions`, `ImportStatusBadge`.

Mobile UX: card layout below `md`/`lg`, sticky bottom action bar with the
selection count, full-width dialog buttons, `break-all` System IDs, tabular
numerals on counts, filter pills and a debounced search field.

---

## 4. Matching logic

**Primary key: System ID, exact.** `upper(btrim(students.id)) =
upper(btrim(uploaded System ID))`. Names are never used to look a student up.

**Name comparison (agreement only)** — three levels:

1. `exact` — byte-identical after trimming.
2. `normalized` — equal after lowercasing + whitespace collapse
   (`_former_name_key`), or equal after also removing punctuation
   (`_former_name_key_loose`, so `Cabdi-raxmaan` = `Cabdi raxmaan`).
3. `different` — anything else. `_former_name_similarity` (token Jaccard, 0–1)
   decides whether the warning says "Names differ" or "Names very different"
   (`< 0.5`). **Similarity never creates a match** — there is no fuzzy matching
   and no threshold that can deactivate anyone.

| Uploaded row | `matchStatus` | Action | Auto-safe |
|--------------|---------------|--------|-----------|
| ID matches one student + names agree | `exact_match` ✅ | Deactivate | **yes** |
| ID matches + names differ | `id_match_name_conflict` ⚠️ | Review → per-row confirmation | no |
| ID matches + ID or name repeats in the file | `possible_duplicate` ⚠️ | Review → per-row confirmation | no |
| Name missing (ID present) | `requires_review` ⚠️ | Review → per-row confirmation | no |
| System ID missing | `requires_review` + blocked ⚠️ | none | 🚫 never |
| System ID unknown | `not_found` ❌ + blocked | none | 🚫 never |
| >1 database row for the ID | `requires_review` + blocked ⚠️ | none | 🚫 never |
| Student already former | `already_former` ℹ️ | none (no-op) | no-op |

The same rules exist twice on purpose: `_former_evaluate_rows()` in SQL
(authoritative — it re-runs at commit time on the live rows) and
`evaluateFormerStudentRows()` in TypeScript (used by the no-backend preview
client and the unit tests). Both are covered by tests asserting identical
outcomes.

---

## 5. Safety protections

1. **No deletes, anywhere.** The migration contains no `DELETE FROM students`
   and no `DROP TABLE` (asserted by a test). The only student write is
   `status`/`transport`/`statusUpdatedAt`/`statusUpdatedBy`. A test proves that
   exams, attendance, homework, quiz attempts, release log and enrollments all
   survive, and that `id`, `name`, `className`, `parentId`, `govId`, `familyId`
   and `parentPhone` are byte-identical afterwards.
2. **Database decides, browser only narrows.** `apply_former_student_import`
   re-evaluates every row from the live table. A client that asks to deactivate a
   missing/unknown/ambiguous ID is refused (`blocked`, reason recorded) — proven
   by a test that sends exactly that hostile payload.
3. **Per-row confirmation for review rows.** A name mismatch or an ambiguous file
   row is applied only with `adminConfirmed = true` for that row; the UI collects
   it through a dialog with an explicit "I have checked this record" tick.
4. **No silent "Deactivate All".** Only exact matches are pre-selected. "Select
   All Safe Matches" cannot select anything else (tested). The nearest equivalent
   ("Select every found row…") opens a red warning first and still cannot select
   blocked rows or skip a per-row confirmation.
5. **Typed confirmation phrase** `MARK AS FORMER STUDENTS` (from
   `former_students_policy()`, not hardcoded in the browser) with the exact
   required wording in the dialog.
6. **Not-in-file students are untouched.** No reconciliation mode exists; a test
   proves a classmate of a leaver keeps `status='active'`, their transport value,
   a null `statusUpdatedBy`, and zero ledger rows.
7. **Audit trail per change** — student id, name, previous status, new status,
   timestamp, actor id + name, import batch id, uploaded file name — in
   `student_status_changes`, plus one aggregate `audit_logs` entry per operation
   (`students.former_import`, `students.former_import_rollback`,
   `students.status_change`, `students.status_backfill`) carrying the
   `deletedStudents: 0` invariant.
8. **Rollback is audit-checked.** It restores only the students *that import*
   deactivated, only when the newest ledger row for them is the one that import
   wrote, and only while they are still `former`. Anyone changed afterwards is
   skipped with reason `changed_after_import` and the batch becomes
   `partially_rolled_back`. Restore puts back the **exact** previous status and
   transport (e.g. bus `12`), never a default. Rolling back twice is refused.
9. **Authorization in three layers** — `ROUTE_ACCESS`, the admin `switch` in
   `App.tsx`, and a `current_profile_role() = 'admin'` check inside every RPC.
   The internal `_former_*` helpers additionally have `EXECUTE` revoked from
   `anon`/`authenticated`, and the new tables have no client INSERT policy (a
   test asserts a forged ledger insert is rejected by RLS).
10. **Row lock at commit time** (`FOR UPDATE`) so two administrators cannot race
    on the same student, and a re-check that the student is still active.
11. **Row/size caps** — 5 MB, 5000 rows (matching the policy's `maxRows`; the SQL
    rejects larger payloads independently of the browser).

---

## 6. Tests performed and results

All green via the repo's own gate, `npm run validate`: **153 files / 1661 tests**,
`tsc` and `tsc -p tsconfig.api.json` clean, `vite build` clean.

New tests for this feature: **120** across 8 files (41 PostgreSQL + 20 parsing +
19 matching + 15 cleanup page + 9 directory page + 8 status filtering + 4
deploy-order fallback + 4 preview client), plus 2 new cases in the existing
`routing.test.ts`.

| Requirement | Where it is tested | Result |
|-------------|--------------------|--------|
| Inspect schema, identify the System ID field | `students.md` KB + migration header (`students.id`) | ✅ |
| CSV import (comma / semicolon / pipe / tab) | `formerStudentsParse.test.ts` | ✅ |
| Excel import (.xlsx) | same | ✅ |
| Exact System ID match | `formerStudentsMatching` + DB test | ✅ |
| System ID match + different name | both (incl. "very different" warning) | ✅ |
| Missing System ID | both → blocked, never applied | ✅ |
| System ID not in database | both → `not_found`, never matched by name | ✅ |
| Duplicate System IDs in the file | both → `possible_duplicate`, not auto-safe | ✅ |
| Duplicate uploaded records (same name, different IDs) | both | ✅ |
| Students already marked Former | both → no-op, no second ledger row | ✅ |
| Ambiguous record (>1 DB row for one ID) | DB test + pure test | ✅ |
| Rollback restores previous status/transport | DB test | ✅ |
| Rollback skips students changed afterwards | DB test (`changed_after_import`) | ✅ |
| Rollback scoped to one batch; twice refused | DB test | ✅ |
| Student history remains intact | DB test (6 child tables + identity columns) | ✅ |
| Current students unaffected | DB test | ✅ |
| Active counts / promotion / progress views exclude leavers | DB test (`get_system_stats`, `promote_students`, `teacher_exam_progress`, `get_class_student_subject_progress`) | ✅ |
| Legacy `LEFT` backfill + idempotency | DB test (migration re-run 3×) | ✅ |
| Role gating (teacher / parent / supervisor / anonymous) | DB test — all 6 RPCs refused | ✅ |
| RLS on the new audit tables; no forged writes | DB test with `SET ROLE authenticated` | ✅ |
| Desktop UI (columns, badges, counts, selection rails) | `formerStudentCleanupPage.test.tsx` | ✅ |
| Mobile UI (cards + sticky action bar render the same rows) | page tests assert both trees; manual check in the live preview | ✅ |
| Un-migrated database degrades instead of breaking | `studentsStatusFallback.test.ts` | ✅ |
| Preview mode without a backend | mock RPCs in `lib/supabase.ts`, driven end to end by `formerStudentsPreviewClient.test.ts` + the page fallback test | ✅ |

The PostgreSQL tests run on **PGlite** (in-process WASM Postgres) against the
**actual shipped migration files**, seeded with synthetic students and destroyed
inside the run — no live or production database is contacted. The Supabase CLI is
not usable in this sandbox (its postinstall downloads a binary from GitHub
releases over a blocked TLS path), so `supabase db reset` was not run; PGlite is
the repo's established substitute (`pgDuplicateBatchHarness.ts`,
`bulk-grades/__tests__/pgHarness.ts`).

---

## 7. Existing app parts updated to exclude Former Students

**Default is now active-only** (`lib/db/students.ts`): `getStudents`,
`getStudentsByClass`, `getStudentsByClasses`, `getStudentIdsByClasses`,
`getStudentsByParent`, `getStudentClasses`, `getStudentsPaginated` (server-side
`status` filter so the reported total matches). That single change covers the
37 roster call sites: teacher class lists (`TeacherStudents`,
`RecordAttendance`, `UploadResults`, `BulkUploadGrades`, `AssignHomework`,
`AllResults`, `TeacherDashboard`), admin surfaces (`ManageStudents`,
`AdminDashboard`, `ClassPromotion`, `BulkUpload`), the office `StudentDirectory`,
and `useClassNames` (class dropdowns).

**Explicitly updated:**

* `get_system_stats()` → `totalStudents` counts active students; new
  `formerStudents` key (+ dashboard card). Client fallback does the same.
* `teacher_exam_progress` view + `get_class_student_subject_progress()` →
  leavers no longer inflate a teacher's "missing entries" denominator. Their
  client-side fallbacks in `lib/db/progress.ts` now use the same active-only
  readers, so the two paths agree.
* `promote_students()` → a leaver is never moved into a new class.
* `mark_student_left()` → keeps `status` in sync with the family-IDs LEFT toggle
  (still preserving `familyId` in both directions).
* Parent portal: `getParentPortalSnapshot` and `getParentLearningChildren` list
  active children; `ParentContext`/`ChildrenView`/quizzes inherit that.
  Historical results keep leavers reachable (`ExamResults` fallback and
  `ExamReport` ask for `'all'`) — the intentional "historical access" exception.
* Marking a student former also sets `transport='LEFT'`, so the existing gate,
  family-card, print-batch and driver-assignment exclusions apply automatically
  (`attach_students_to_authorized_pickup` already refuses `LEFT` students).

**Deliberately left seeing leavers** (identity/historical workflows — each is an
explicit `'all'` with a comment): duplicate-student detection and merging, the
class import's identity pool (hiding a leaver there would offer to re-create them
as a duplicate), exam verification (a leaver's pending exam must not stay pending
forever), the Family IDs screen (it manages the LEFT marker), Manage Drivers
(lists existing assignments), and the report screens.

**Deliberately unchanged historical SQL:** `class_students_for_term`,
`get_midterm_report`, `get_final_report`, `get_monthly_report` — a report for a
term a leaver attended still includes them, which is correct history.

**Marks monitor (`monitor_marks_entries`) — changed in
`20261010_monitor_excludes_former_students.sql`.** The monitor is a live "who
still owes marks" view, so it now excludes former students from its current-term
roster. It still reads its roster through the historical `class_students_for_term()`
helper, which is left unchanged, so the historical reports keep leavers. The
migration is the shipped 20260919c function with one predicate added to
`eligible_roster`: `lower(COALESCE(to_jsonb(s) ->> 'status','active')) <> 'former'`.
The existing `transport <> 'LEFT'` check stays, so nothing that was excluded
before is now included. A demo-mode mirror is in `src/lib/supabase.ts`.

---

## 8. Issues needing manual review

1. **Run the migration.** `supabase db push` (or apply
   `20261008_former_students_cleanup.sql` then `…b_former_students_roster_filters.sql`)
   **before** deploying the client. The Supabase CLI could not run in this
   sandbox, so the SQL was validated on PGlite, not on the project's real
   instance. Please review the two files in a staging project first.
2. **`teacher_exam_progress` and `get_class_student_subject_progress` are
   recreated verbatim + one predicate.** They were copied from
   `20260707_fix_teacher_exam_progress_coursework_rule.sql` and
   `20260707_class_student_subject_progress_rpc.sql` (the latest definitions —
   no later migration redefines them). Worth a diff review, since
   `CREATE OR REPLACE VIEW` requires the column list to stay identical.
3. **Backfill decision.** Students already marked `transport='LEFT'` become
   `status='former'` automatically. If the school considers some `LEFT` students
   still enrolled (e.g. LEFT set by mistake), review them first — the backfill is
   ledger-recorded and reversible per student via `set_student_former_status`.
4. **Marks monitoring — resolved in `20261010_monitor_excludes_former_students.sql`.**
   The monitor no longer counts former students as expected or missing for the
   current term. It excludes them with an explicit `students.status` check, not
   only the older `transport = 'LEFT'` proxy. The historical
   `class_students_for_term()` helper is unchanged, so reports keep leavers. The
   new migration must be applied with the other two (see item 1). Verified by
   `monitorExcludesFormerStudents.db.test.ts`, which fails without the migration.
5. **Parent portal policy.** A parent whose only child left sees no current
   children (quizzes/weekly learning), but the child still appears in Exam
   Results / Exam Reports. Confirm that is the intended "historical access"
   behaviour; flipping `getStudentsByParent`'s default to `'all'` restores the
   old behaviour in one line.
6. **Office role cannot open the Former Students directory** (admin-only, as
   specified). If the front desk needs to look a leaver up, add `'office'` to
   `ROUTE_ACCESS['/admin/former-students']` **and** widen the RPC guards — the
   SQL is the real gate.
7. **One import = one file, max 5000 rows.** Larger lists must be split; each
   file becomes its own rollback-able batch. Chunked accumulation into one batch
   (the `p_batch_id` pattern from the safe duplicate merge) can be added later if
   the school routinely exceeds 5000 leavers per term.
8. **No "reconciliation mode"** (mark everyone absent from a full roster as
   former) was implemented, per the requirement that absence must never imply
   "former". If the school wants it later, it must be a separate, explicitly
   opted-into flow with its own confirmation.
9. **Preview mode (no Supabase env vars)** emulates all eight RPCs on demo data,
   including two demo leavers (`student-former-1/2`). The mock client's HMR
   marker was bumped to 2 so an already-open preview tab picks the new client up.
