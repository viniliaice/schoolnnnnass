# Remediation Blueprint — Student Class Import & Bulk Upload Grades

**Author:** Senior remediation engineer (planning pass)
**Date:** 2026-09-06
**Inputs verified directly in this checkout:** `main` (commit `beb5d2f`), PR #28 (`BULK_UPLOAD_GRADES_AUDIT.md`), PR #29 (`arena/01a076e2-schoolnnnnass` — Agent A's feature).
**Constraint:** Planning only — no code, migration, data, merge, or deploy changes made.
**Purpose:** A document complete enough that a separate implementation agent can execute the fixes without re-discovering the architecture. Every step lists what existing functionality it could affect.

---

# Executive Decision

## **HELD — do not merge or deploy PR #29 as-is; do not approve the combined workflow for production yet.**

PR #29 is **not rejected**: its pure client matcher, preview UX, atomic commit shape, and admin-gated RPC are good engineering and are worth keeping. But it ships on top of two structural problems that must be fixed together, not separately:

1. **The effective `students`-write security state is unknown and contradictory in the source of truth (F1).** The root `supabase-schema.sql` contains an open `FOR ALL USING(true)` policy that is **never dropped by any migration**, yet the migration history (20260708 onward) only ever adds *narrower* policies and the 2026-08-02 fix comments state that direct student updates were **denied** in the live database. Both states are dangerous in opposite directions:
   - If the live DB matches `supabase-schema.sql`, **any authenticated user can INSERT/UPDATE/DELETE students directly** (privilege escalation) and the RPC is a redundant lock on an open door.
   - If the live DB matches the migration intent (SELECT-only), then **several legitimate, currently-shipped admin screens silently fail today** (Manage Students create/edit/delete, legacy bulk import, promotion undo, parent unlinking), because they still issue direct browser writes and `promote_students()` is not `SECURITY DEFINER`.
   Either way the system is not safe/reliable. The remediation must make the system correct **regardless of which state production is in**.
2. **There is no historical-class model (F3).** `students.className` is overloaded as *both* "current class" (for rosters/authorization — correct) and implicit *historical* class (for midterm/final/class-progress peer groups — wrong). Mid-term transfers retroactively recompute already-issued class ranks/averages.

The recommended posture is therefore **REWORKED in place**: keep PR #29's client/RPC, but land a dependency-ordered set of migrations + RPCs + report fixes (Phases below) **before** flipping RLS and before enabling mid-year class imports. Bulk Upload Grades is safe to continue using for the current, class-first workflow; its multi-class wizard is a follow-up usability track, not a security gate.

---

## 1. Third-Agent Findings — Verification

Method: each finding was traced through `supabase-schema.sql`, every file in `supabase/migrations/`, `supabase/feature-schema.sql`, the `src/lib/db/**` write paths, `src/pages/**` call sites, and (for the matcher) empirical probes with generated `.xlsx` files against PR #29's code.

| # | Third-agent claim | Classification | Evidence |
|---|---|---|---|
| **F1** | Open `students FOR ALL USING(true)`; contradicts RPC-only claim; feature RLS test would fail | **PARTIALLY VERIFIED** (the *risk* is VERIFIED; the *live* state is UNRESOLVABLE from the repo) | `supabase-schema.sql:372` creates `CREATE POLICY "Allow all operations on students" ON students FOR ALL USING (true);`. A full grep of `supabase/migrations/` finds **no** `DROP POLICY "Allow all operations on students"` (only `20260708_profiles_auth_session_rls.sql` adding narrower SELECT policies, and office-read policies in 20260802). **However** `20260802_family_import_rpc.sql:5-10` states "students is SELECT-only under RLS (20260708) — no UPDATE policy exists … every row was denied," proving the **live** DB did **not** have an open write policy at that time. `supabase-schema.sql` is a non-migrated baseline snapshot, not necessarily the live state. Conclusion: source of truth is contradictory; the only safe action is to make policy state explicit and idempotent in a new migration (§7) after every write path is RPC-backed. |
| **F2** | `class_subjects` has no RLS / no unique constraint; is the grade-authorization anchor | **VERIFIED (source); live state unverified** | No `ALTER TABLE class_subjects ENABLE ROW LEVEL SECURITY` and no policy exist in schema or migrations. Write sites are **direct client writes**: `src/lib/db/classes.ts` `createClassSubject/updateClassSubject/deleteClassSubject` (`insert/update/delete`), `src/lib/db/subjects.ts:30` `.delete()`, `src/lib/db/bulk.ts:109-180` bulk `insert` of class_subjects during teacher import. Authorization depends on it: `can_submit_exam_target()` and `submit_bulk_grades` join `class_subjects("className","subjectId","teacherId")` with `LIMIT 1`. No unique index on `("className","subjectId")`. |
| **F3** | Reports derive peer groups from current `students.className`; mid-term move rewrites history | **VERIFIED** | `20260802_bulk_grade_integrity.sql` `get_midterm_report`: `class_students AS (SELECT s.id FROM students s JOIN target_student ts ON ts."className" = s."className")`; class avg/rank/highest computed from that set. Client fallback `src/lib/db/reports.ts:~147-165` does `.from('students').select('id').eq('className', student.className)`. `20260707_class_student_subject_progress_rpc.sql`: `class_students AS (... WHERE s."className" = p_class_name)`. `teacher_exam_progress` view (`supabase-schema.sql` ~120, re-defined in `20260415`/`20260707_fix_*`) joins `class_subjects cs ON s."className" = cs."className"`. FinalReport renders `overall_rank/total_students` from the same RPC. Monthly report uses `getMonthlyReport` (RPC missing from migrations — see §4). No enrollment table exists (grep for `enrollment/enrolment` returns only comments). |
| **F4** | Numeric Excel Gov-id / leading-zero coercion; school sheet has no internal-ID column | **VERIFIED empirically** | Probe against PR #29: 17-digit numeric Gov cell → `String(number)` = `22100100000000000` (precision lost) → no match → falls to new-student when name differs; `01001` numeric → `1001` (leading zero lost) → no match. Parser reads identity cells with `raw:true` + `String(value)` (no text coercion/warning). The school's real sheet (`src/lib/import/transportImport.ts:7-11`, aliases `Gov-id, Bus, Grade, Name, SECOND NUMBER, Status`) has **no internal Student ID column**; `Gov-id` is the de-facto key. The app-generated template (`buildClassImportTemplate`) writes text IDs and round-trips to 100% no-change (VERIFIED). |
| **F5** | Existing workflows depend on direct student writes | **VERIFIED** | Direct client writes: `students.ts:114 createStudent(insert)`, `:123 updateStudent(update)`, `:132 deleteStudent(delete)`, `:152 promoteStudentsByClass(update className)`; `bulk.ts:35 bulkCreateStudents(insert)` used by `pages/admin/BulkUpload.tsx:281`; `promotions.ts:115 undoPromotion(update className)` + `student_promotions.delete`; `profiles.ts:176 deleteUser(update parentId=null)`. `promote_students()` RPC (`20260721`, re-defined in PR #29) is **not** `SECURITY DEFINER` and has no grant block — under SELECT-only RLS it fails for non-owner callers. |
| **F6** | No govId uniqueness; new-student phone stored un-normalised | **VERIFIED** | Only non-unique indexes `idx_students_gov_id`, `idx_students_parent_phone`. PR #29 RPC inserts `govId`/`parentPhone` via `trim` only; sibling RPC `set_student_import_fields` stores `normalize_phone(...)` — inconsistent. RPC does not check new-vs-new or new-vs-existing govId. |
| **F7** | Repeated/drifted imports duplicate `student_promotions` | **VERIFIED** | `student_promotions` PK is surrogate `id`; no unique `("studentId","fromClass","toClass","academicYearId",source)`. PR #29 inserts a row per moved student per commit; identical re-import is skipped (no-op), but any drift re-inserts. |
| **F8** | Approved grades reset to pending on bulk overwrite, no old/new audit | **VERIFIED** | `submit_bulk_grades` `ON CONFLICT DO UPDATE SET ... status='pending' ...`; preflight returns counts only. No change-history table. |
| **F9** | New students minimal: parentId null, transport null (→ WALKER) | **VERIFIED** | PR #29 inserts `(id,name,className,govId,parentPhone,createdAt)` only. `normalizeTransport` treats null transport as `WALKER` (`src/lib/transport.ts` documented business rule). |
| **F10** | No size/row cap on class import; preview 500 rows/tab | **VERIFIED** | `ClassImport.tsx` accepts file, `parseClassImportFile` no cap (grade flow has 5 MB cap); table `slice(0,500)`; RPC has no `jsonb_array_length` cap. |
| **F11** | attendance/homework carry denormalized `className`, not reconciled after moves | **VERIFIED** | `attendance("className")`, `homework("className")`, `quizzes("className")`, `announcements("className")` exist. Reads: `attendance.ts getAttendanceForDate(className,date)`, `homework.ts getHomeworkByClass`, `quizzes.ts getQuizzesByClass`, `parent-portal.ts` quizzes `in('className', currentClassNames)`. After a move, past rows stay under the old class; new rows under the new. |
| **F12** | Bulk Grades is 4-cycle for Arabic+Tarbiya/4 classes; template has no roster/IDs | **VERIFIED** | `BulkUploadGrades.tsx`: single `selectedClass`; `getStudentsByClasses([selectedClass])`; `downloadTemplate` one `Grades` sheet; `parseExcel` reads `SheetNames[0]`. |
| **F13** | `getStudentClasses()` no limit (PostgREST 1000 cap); stale roster; report count typo | **VERIFIED (minor)** | `students.ts getStudentClasses` `.select('className')` no `.limit`; `config.toml max_rows = 1000`. Report claims "41"/"38" new tests; measured delta = 40 (555 vs 515). |

---

## 2. Findings We Agree With (and keep as the basis for remediation)

All thirteen findings describe real conditions in the repository. The most load-bearing for the remediation plan:

- **F1/F2/F5 are one intertwined problem** ("who is allowed to write students/assignments, and how do legitimate features do it"). They must be fixed as a unit; dropping the open policy without first moving every write behind an admin RPC will silently break shipped admin features (and the comment history says that exact breakage already happened once, in the family-import bug of 2026-08-02).
- **F3 is a data-modelling gap, not a bug in any single function.** Fixing it requires introducing a minimal historical-enrollment record and repointing only the *historical* report reads; the many *current*-class reads must stay on `students.className`.
- **F4's root cause is a contract problem.** The app can eliminate the risk almost entirely by making its own **generated template** the required input for the official roster, while treating arbitrary spreadsheets as a guarded, warning-heavy "legacy" path.
- Agent A's matcher conservatism (never match on name alone; unknown-ID + existing-name → manual review; in-file duplicate/conflict handling; atomic commit) is correct and should be retained and hardened, not rewritten.
- Agent B's multi-class C+D wizard recommendation (one workbook, one roster-prefilled sheet per class, server re-derivation of class) is the correct end state for Bulk Upload Grades.

## 3. Findings That Need Correction / Nuance

- **F1 must be stated as "effective state unknown from repo", not "open policy confirmed in production".** The 2026-08-02 migration comments are strong evidence that production was SELECT-only. The plan therefore (a) never assumes which state is live, (b) makes policy state explicit + idempotent in a new migration that runs **after** all writes are RPC-backed, and (c) includes a live-DB introspection step (`pg_policies`, `pg_proc.prosecdef`) as the first deploy gate.
- **F3's blast radius must be scoped to *comparative* outputs (ranks/averages/peer progress), not raw score history.** Student-own scores (`exams`, attendance rows, homework status) are already correctly attached by `studentId` and are **never changed** by a class move. Only the *class context used for peer comparison and class-level monitoring* is wrong. The fix repoints those reads; it does not rewrite exam data.
- **F9 (transport null → WALKER)** is an existing, documented system-wide convention, not new behaviour from PR #29. Remediation should surface a warning for newly imported students, not change the global interpretation.
- **`getMonthlyReport` has no matching RPC in `supabase/migrations/`** (client calls `rpc('get_monthly_report')`). It either lives only in production or is silently failing; this is a deployment-drift item to verify and either add or confirm, and it must use the same historical-class logic as the midterm RPC (part of F3).

---

## 4. Current Data Model

Tables relevant to this work (from `supabase-schema.sql` + migrations):

- **`students`**: `id` (text PK), `name`, `"className"` (text NOT NULL, free-text, current class), `"parentId"` → profiles (SET NULL), `govId`, `transport`, `parentPhone`, `familyId`, `"createdAt"`. No unique constraint on `govId`/`parentPhone`/`familyId`. Indexes on `className`, `parentId`, `govId`, `parentPhone`.
- **`profiles`**: `id` (text PK), `role ∈ {admin,teacher,parent,supervisor}` + later `office` (not in the CHECK), `auth_id → auth.users(id)`, `"assignedClasses"` JSONB, `"assignedSubjects"` JSONB.
- **`subjects`**: `id`, `name`, … (name not unique).
- **`class_subjects`**: `id` PK, `"className"` text, `"subjectId"` → subjects, `"teacherId"` → profiles (SET NULL). No unique `(className,subjectId)`; no RLS in source.
- **`exams`**: `id`, `"studentId"` → students (CASCADE), `"subjectId"` → subjects (RESTRICT, nullable historically), `subject` text, `score`, `total`, `"examType"`, `"assessmentLabel"`, `"entryState"`, `"termId"` → terms, `month`, `status`, `"parentId"`, `date`, `"teacherId"`, `"uploadedBy"`. Partial unique index `("studentId","subjectId","examType","assessmentLabel","termId")`. **No `className` column** — exams attach to the student only.
- **`attendance`**: `id`, `"studentId"` (CASCADE), **`"className"` text (snapshot)**, `date`, `status ∈ present/absent/late`, `"teacherId"`, `UNIQUE("studentId",date)`.
- **`homework`**: `id`, `"studentId"`, **`"className"` snapshot**, `subject`, `title`, `dueDate`, `status`, `"teacherId"`.
- **`quizzes`**: `id`, **`"className"`**, `subject`, `title`, `"teacherId"`, dates/status. `quiz_attempts."studentId"` → students.
- **`student_promotions`**: `id`, `"studentId"`, `"fromClass"`, `"toClass"`, `"academicYearId"` → academic_years (SET NULL), `"createdAt"`, and (PR #29) `source ∈ {promotion, class_import}`. This is the **closest existing thing to enrollment history**, but it is promotion-oriented and not consulted by any report.
- **`academic_years` / `terms`**: years with `isCurrent`; terms with `startDate/endDate/months`, `"academicYearId"`.
- **`grade_uploads`**: idempotency/audit for bulk grades. `audit_logs`: action/details/createdAt (RLS locked to staff reads; SECURITY DEFINER inserts).

**Two class-name consumers, semantically different:**
- *Current-class* reads (rosters, grade authorization, attendance entry, class lists, dashboards) **should** keep reading `students.className`.
- *Historical-class* reads (midterm/final peer groups and ranks, class-progress for a past term, teacher progress for a past month) currently read `students.className` but **should** read "the class the student was in during that term/date."

---

## 5. Current-Class vs Historical-Class Architecture

**Smallest model that answers both questions without a redesign:**

Keep `students."className"` as the authoritative **current** class (zero churn for the dozens of current-state reads). Add a thin, append-only **enrollment history** table and treat `student_promotions` as a backfill source.

### New table: `student_enrollments`

```
student_enrollments
  id              text PK
  "studentId"     text NOT NULL REFERENCES students(id) ON DELETE CASCADE
  "className"     text NOT NULL
  "academicYearId" text REFERENCES academic_years(id) ON DELETE SET NULL
  "termId"        text NULL REFERENCES terms(id) ON DELETE SET NULL  -- optional finer grain
  "effectiveFrom" date NOT NULL            -- start date of this assignment
  "effectiveTo"   date NULL                -- NULL = current/active
  "reason"        text NOT NULL DEFAULT 'import'  -- import|promotion|transfer|correction|backfill
  "sourceRef"     text NULL                -- import ref / promotion id / actor
  "createdAt"     timestamptz NOT NULL DEFAULT now()
```
Rules:
- At most **one open enrollment** (`effectiveTo IS NULL`) per student (partial unique index `(studentId) WHERE effectiveTo IS NULL`).
- A class move = close current row (`effectiveTo = move date`) + insert new open row.
- Peer membership for a term = the enrollment row where `term.[startDate,endDate]` overlaps `[effectiveFrom, COALESCE(effectiveTo, far-future)]`.
- Reports that need *the* class for a past term resolve per-student from this table (or, for whole-class reports, join enrollments to the requested class for that term).

**Backfill (one-time, idempotent migration):**
1. Insert one backfilled open enrollment per current student using `students."className"` and the current academic year / term start date.
2. Reconstruct earlier ranges from `student_promotions` (ordered by `createdAt`): each `fromClass→toClass` row gives a transition; emit enrollment intervals per student per `academicYearId`. Where intervals can't be reconstructed, leave a single open row (current state still correct).
3. Because `attendance."className"` and `homework."className"` are reliable **date-stamped** snapshots, use them to refine enrollment boundaries (greatest confidence for daily history).

**What changes vs not:**
- Current-class reads: **unchanged** (still `students.className`).
- Historical report RPCs (`get_midterm_report`, final report, `get_class_student_subject_progress`, the missing `get_monthly_report`, `teacher_exam_progress` when scoped to a past month): repoint peer-group resolution from `students.className` to `student_enrollments` for the requested term/date.
- Exams remain keyed by `studentId`+`termId` only — **no exam data migration**. The class a grade "belonged to" is resolved at report time via enrollments.
- Bulk-grade authorization **stays** on current `className` (a teacher grades the class a student is in *now*, which is correct for in-term entry).

This is the minimal change that fixes F3: past-term reports reflect the class the student was in when the grade was earned; future/current reporting is unaffected.

---

## 6. Student Write-Path Inventory (and every consumer that could break under RLS lockdown)

Direct browser writes to `students` (these MUST be RPC-backed before flipping RLS):

| Call site | Operation | Current method | Legit role today | Action |
|---|---|---|---|---|
| `students.ts createStudent` → `ManageStudents.tsx:285` | INSERT one student | direct `.insert` | admin | New `upsert_student()` admin RPC (or reuse class-import new-student path) |
| `students.ts updateStudent` → `ManageStudents.tsx:312` (name/class/parent) | UPDATE | direct `.update` | admin | New `update_student_profile()` admin RPC |
| `students.ts deleteStudent` (+ manual `exams.delete`) → ManageStudents | DELETE student (+ grades) | direct `.delete` | admin | New `delete_student()` admin RPC that explicitly cascades/audits |
| `students.ts promoteStudentsByClass` → `BulkUpload.tsx:161` | bulk UPDATE className | direct `.update` | admin | Replace call with existing `promote_students()` RPC once it is SECURITY DEFINER (F5) |
| `bulk.ts bulkCreateStudents` → `BulkUpload.tsx:281` | bulk INSERT | direct `.insert` | admin | Route through class-import new-student RPC / a new `bulk_create_students()` admin RPC |
| `promotions.ts undoPromotion` → ClassPromotion | UPDATE className + DELETE student_promotions | direct | admin | New `undo_promotions(ids)` SECURITY DEFINER admin RPC |
| `profiles.ts deleteUser` → ManageUsers | UPDATE students SET parentId=NULL for children | direct | admin | New `unlink_parent_students(parentId)` admin RPC (call inside user deletion) |
| `promote_students()` RPC (`promotions.ts:25`) | bulk UPDATE className + INSERT promotions | RPC but **not** SECURITY DEFINER, no grant | admin | Re-create as SECURITY DEFINER, admin-gated, explicit grants |
| Agent A `apply_student_class_import` | UPDATE className + INSERT students/promotions/audit | SECURITY DEFINER admin RPC (good) | admin | Keep; add enrollment writes (F3), govId dedup, phone normalization, array cap |

Already-secure RPC writes to students (no change needed): `set_student_transport`, `set_student_import_fields`, `assign_family_override`, `mark_student_left`, `generate_family_ids` (familyId only), `generate_transport_filter`, family/card RPCs, gate/driver RPCs.

**Related non-student writes that also rely on absent RLS (must be addressed in the same lockdown pass):**
- `class_subjects` direct writes (`classes.ts create/update/deleteClassSubject`, `subjects.ts` delete, `bulk.ts` assignment inserts) → admin RPCs or admin-only RLS policy (§8).
- `attendance` / `homework` / `quizzes` direct client writes (teachers) → teacher-scoped RLS policies (these currently have no RLS in source).
- `student_promotions` direct delete (undoPromotion) → fold into undo RPC.

---

## 7. RLS Remediation Strategy

**Principle:** the schema must be correct **independent of** which live state production currently has. All new policy migrations are written idempotently (`DROP POLICY IF EXISTS …; CREATE POLICY …`) and are applied **only after** §6 paths are RPC-backed.

Target end state for `students`:
- **No** client `FOR ALL`/`INSERT`/`UPDATE`/`DELETE` policy.
- SELECT policies (permissive, OR-combined):
  - admin/supervisor/office: full read.
  - teacher/supervisor: students in assigned classes. **Two assignment sources are both live and must both be permitted**: the "My Students" screen (`TeacherStudents.tsx:26-30`) reads `profiles."assignedClasses"` JSONB, while grade rosters/authorization (`BulkUploadGrades`, `can_submit_exam_target`) use `class_subjects`. The SELECT policy therefore allows a student when `"className"` is in the teacher's `assignedClasses` JSONB **OR** exists in `class_subjects` with `"teacherId" = current_profile_id()` (the latter should eventually become the single source of truth; until `assignedClasses` is retired, keep both so the student directory does not break).
  - parent: `"parentId" = current_profile_id()`; plus office/family lookup continues through existing SECURITY DEFINER `lookup_family`.
- All writes via admin/office-gated SECURITY DEFINER RPCs (office keeps only the one narrow transport-edit it already has via `set_student_transport`).

Migration ordering (each step names affected functionality):
1. **`RLS_introspection` (manual/pre-deploy, read-only):** run `pg_policies` on `students`, `class_subjects`, `attendance`, `homework`, `quizzes`, `student_promotions`, `profiles`; `pg_proc.prosecdef` for the write functions. Record the true live state. *Affects: nothing.*
2. **Add new write RPCs** (`upsert_student`, `update_student_profile`, `delete_student`, `bulk_create_students`, `undo_promotions`, `unlink_parent_students`, hardened `apply_student_class_import`, SECURITY DEFINER `promote_students`). All admin-gated, `SET search_path=public`, `REVOKE ALL FROM PUBLIC; GRANT EXECUTE TO authenticated`, audit-logged. *Affects: none yet (additive).*
3. **Repoint client code** from direct writes to these RPCs (§6 table). *Affects: Manage Students, Manage Users delete, Class Promotion (promote+undo), legacy Bulk Import student step. Each is an admin-only screen; behaviour preserved.*
4. **Add RLS to `class_subjects`** (admin writes; authenticated reads) + unique active index, with the assignment-management screens already RPC/policy-compatible. *Affects: Manage Class Subjects / Academic Workspace assignment editor, bulk teacher import (must use admin RPC).*
5. **Add teacher-scoped RLS to `attendance`/`homework`/`quizzes`** (insert/update for the teacher whose `teacherId` matches; class/parent reads). *Affects: Record Attendance, Assign Homework, Create/Grade Quizzes.*
6. **Finally flip `students` policies**: `DROP POLICY IF EXISTS "Allow all operations on students";` (and the analogous profiles policy), create the SELECT-only set above, create NO write policies. *Affects: nothing that wasn't already migrated in steps 2–3; this is the gate. Run after verifying zero direct writes remain via `grep`/code review.*
7. Fix the failing/assertion-only tests: `rls-student-class-import.sql` assertion #1 ("zero INSERT/UPDATE policies") becomes **true** after step 6; until then it is expected to fail — make the test suite represent the post-remediation target and run it in CI against a migrated DB.

Every new function follows the established in-repo pattern (`set_student_import_fields`, `mark_student_left`): `current_profile_role()` check first, `RAISE … insufficient_privilege`, SECURITY DEFINER, pinned search path, audit row.

---

## 8. class_subjects Security Strategy

- Enable RLS; SELECT to all authenticated (needed by teachers/admin); **INSERT/UPDATE/DELETE to admins only** (the editor is admin-only; office/supervisor/teacher/parent get none). Co-teaching, if ever needed, is an explicit later policy, not implied.
- Add **unique active assignment**: partial unique index on `("className","subjectId")` where the assignment is active (add an `active BOOLEAN DEFAULT true` column if soft-delete is desired; otherwise a plain unique constraint on `("className","subjectId")`). Migrate existing duplicates by collapsing to the newest/non-null teacher before creating the index.
- Keep the bulk-grade `LIMIT 1` lookup but with the unique constraint it becomes deterministic.
- Move the three direct write sites (`createClassSubject/updateClassSubject/deleteClassSubject`, subject-delete cleanup, bulk teacher import) onto admin RPCs or admin-only policy calls, consistently.
- Affects: Manage Class Subjects/Academic Workspace, bulk teacher import, grade authorization (more reliable), Monitor Teachers dashboards.

---

## 9. Bulk Grade Upload Design

**Recommended single primary workflow (Agent B's "C + D"), phased:**

- **Selection:** teacher (or admin on behalf) opens Bulk Upload Grades; system shows only the authenticated teacher's exact assignment matrix from `class_subjects` (teacherId = me). Multi-select checkboxes for classes (e.g., 5A/5B/6A/6B); for each class, show exactly the assigned subjects (Arabic, Tarbiya) as a non-Cartesian matrix — no inferred pairs.
- **One generated workbook, one worksheet per selected class** (e.g. `Grade 5-A`, `Grade 5-B`, …) plus an `Instructions` sheet. Each class sheet is **pre-filled with the current roster** (stable text Student ID in a text-formatted column, Student Name read-only) and contains only that class's valid subject blocks and the assessment blocks the teacher selected (HW1–HW4/CPW1–CPW4/Att/MT/Akhlaaq). The teacher does **not** type IDs.
- **One upload, one validation, one atomic commit.** Parser is extended to iterate all class sheets (currently `SheetNames[0]` only); each record still carries its `studentId`/`subjectId`; the server continues to **derive class from `studentId`** and verify the exact `class_subjects(class,subject,teacher)` row — sheet names are advisory, never trusted.
- Authorization stays exactly as now (`submit_bulk_grades` join), which already prevents cross-class/cross-subject writes and keeps Arabic Akhlaaq distinct from Tarbiya Akhlaaq via `subjectId`.
- Overwrite: keep preflight/confirm, but return **old→new value list**, keep `status` handling explicit (approved grades require admin/extra confirmation), and write a replacement audit row.
- Why this over flat-sheet/multi-file: one file + per-class sheets removes both the repetition (4 cycles → 1) and the cross-class paste error (each sheet is roster-scoped), while the server stays the authority. It also naturally reflects rosters after class imports.

**Compatibility:** the existing single-class file keeps working (parser treats one class sheet as before). Multi-sheet generation reuses the same roster data the class-import template already exports.

---

## 10. Student Excel Import Design

**Primary supported input = app-generated template (eliminate Excel identity corruption by construction).**

- **"Download Current Student Template"** is the primary CTA (it already exists in PR #29). It exports all students as text: `Student ID` (forced text format, leading zeros preserved), `Gov ID` (text), `Student Name`, `Current Class`, `Parent Phone`. Round-trips to 100% no-change (verified). Admins edit class cells / append new rows in Google Sheets, then upload.
- **Legacy arbitrary-sheet path retained but guarded:** when the file lacks a recognizable `Student ID` column or matches the school sheet headers (`Gov-id, Bus, Grade, Name, SECOND NUMBER`), run in "legacy mode": Gov-id is treated as the key **only if read as text and unique**; numeric identity cells are **hard-flagged** (see §11).
- Cell handling contract:
  - Read with options that preserve identifier strings; detect identity columns whose raw value is `number` and produce a row-level error/warning (never silently `String(number)`).
  - Class cell: accept canonical (`Grade 7-A`), sheet code (`G7A` via the existing transport map), and `7A/7-A` shorthand **only if it resolves to an existing class** (already implemented and verified). Unknown → invalid row.
  - Academic year: default to the current year server-side; tag enrollment/promotion rows with it; allow admin override but not a nonexistent year.
  - New students: represented by a row with a non-existing-but-valid text ID and name + valid class (or blank ID → generated `student-…` ID shown in preview). Required = name + class; govId/phone optional but **validated** (govId unique, phone normalized).
  - Class changes: matched student whose resolved class differs → change; same → skip (idempotent).
- Cap: enforce a file/row limit (mirror the grade flow's cap; e.g. reject > ~3,000 student rows or > 5 MB) and render/export the full preview (not just first 500) or paginate.
- Commit payload: continue the single atomic RPC; add enrollment inserts, govId dedup, normalized phone, and array-length guard.

---

## 11. Identity Matching Rules (final, no silent guessing)

1. **Strongest identifier = `students.id` (Student ID)** — exact, case/whitespace-insensitive (`normId`). Student ID is authoritative even if name differs (verified behavior).
2. **Student ID present but not found** → never match on it; fall through to weaker keys but **always** raise `STUDENT_ID_NOT_FOUND`. If a weaker key finds a unique existing student → **manual review** (ambiguous), never auto-match, never auto-create.
3. **Student ID missing → Gov ID:** match only if the gov key resolves to **exactly one** student. 0 → fall through; >1 → ambiguous (manual).
4. **Gov/name cross-conflict:** if ID/Gov resolves to student X but the row's exact-normalized name is a *different* existing student → ambiguous with a conflict warning (force human).
5. **Parent phone shared (siblings):** phone alone never matches; requires exact-normalized **name + phone** yielding exactly one student. Shared phone + shared/ambiguous name → ambiguous. (Verified.)
6. **Duplicate names:** name alone **never** auto-matches (1 candidate → manual review; many → ambiguous). In-file identical name with no identifiers → later rows blocked.
7. **Numeric-looking IDs:** a numeric raw value in an identity cell → explicit error/warning ("ID read as number — may have lost digits/leading zeros; use the exported template"). If text column but value is all-digits, compare as zero-trimmed string **and** flag; never coerce to number.
8. **Leading zeros lost:** detected as the numeric case above; do not invent the zero. Route to manual review; the app template prevents it.
9. **New-student gate:** create only when no ID/Gov/name+phone match exists **and** name is unknown **and** name+class present; govId must be unique against existing and batch; phone normalized. Two new rows with the same govId → block.
10. All ambiguous/unmatched rows are excluded from commit until an admin explicitly resolves or excludes them (already the UX; keep and make numeric-ID rows blocking errors).

---

## 12. Historical Data Protection Rules

Every class event writes `students."className"` = current, and maintains `student_enrollments`:

- **Mid-year transfer 7B→7C (Class Import):** update current class; close 7B enrollment at transfer date, open 7C; write `student_promotions(source='class_import')`; **no** grade/attendance/homework mutation. Past-term reports for the student use the 7B enrollment; future grade entry/rosters use 7C.
- **End-of-year promotion 7B→8A (`promote_students`):** bulk update current class; one new open enrollment per student effective the new academic-year start; `source='promotion'`; re-run guard counts only promotions (PR #29 fix retained). Old term reports resolve via old-year enrollments.
- **Correction 7C→7B (data-entry fix):** allowed, but recorded as `reason='correction'`; current class corrected; **historical ranges are not forged** beyond the correction date — if the correction refers to the current period, the open enrollment is amended (not duplicated); past locked term reports are not retroactively changed by a correction unless the admin explicitly reopens the term. Audit both states.
- **Grades:** never rewritten by any move. Rankings/averages for a **past** term use that term's enrollment peer set; for the **current** term use current enrollments.
- **Attendance:** daily rows keep their `className` snapshot (correct history); current-day entry uses the roster. Enrollment backfill can use attendance snapshots to refine boundaries. Per-class historical attendance views should resolve membership via enrollment for the selected date (so a moved child is counted where they were that day).
- **Homework/quizzes:** class-keyed rows stay as snapshots; class-level *current* lists use current class; historical lists for a date/term resolve via enrollment (especially quizzes active at the move moment).
- **Reports/rankings:** midterm/final/monthly/class-progress/teacher-monitoring switch to enrollment-based peer resolution for any past term/month; current-term views keep using current class.
- **Promotion history:** keep `student_promotions` as the audit/transition ledger; add the unique guard to prevent duplicate import rows (F7) and a NULL-year policy (default current year server-side).

---

## 13. Migration Dependencies

1. Enrollment table + backfill (§5) — additive, no behaviour change.
2. Report RPC repointing (midterm/final/monthly/class-progress/teacher-progress) to enrollment-based history — after 1.
3. New admin write RPCs + hardened `promote_students` (SECURITY DEFINER) + hardened `apply_student_class_import` (enrollment writes, govId unique, phone normalize, cap) — additive.
4. Client repointing from direct writes to RPCs (§6).
5. `class_subjects` RLS + unique constraint (after duplicate cleanup).
6. Teacher-scoped RLS for attendance/homework/quizzes.
7. `students`/`profiles` policy flip (drop FOR ALL; SELECT-only) — **last data layer step**.
8. Client hardening for Excel identity (numeric detection, text template, caps, full preview).
9. Multi-class grade wizard (independent usability track; can follow).
10. CI + SQL integration tests (real role impersonation) — added alongside each layer.

Cross-cutting: every migration is idempotent (`IF EXISTS`/`OR REPLACE`), uses `SET search_path=public`, pins grants, and is safe to re-run. Never drop data; the policy flip is the only destructive-ish step and runs only when zero direct writes remain.

---

## 14. Implementation Order (dependency-safe)

1. **Live-DB introspection gate** (read-only) — capture true policy/function state. *No app impact.*
2. **Enrollment history** model + idempotent backfill (from students + student_promotions + attendance snapshots). *Additive.*
3. **Repoint historical report reads** to enrollment; add/repair `get_monthly_report`. Verify current-term reports unchanged. *Affects: parent/teacher reports (must show identical current values).*
4. **Build admin write RPCs** (student upsert/update/delete, bulk create, undo promotions, unlink parent) and **harden `promote_students` + `apply_student_class_import`** (enrollments, govId dedup, normalize phone, cap, source-tagged history, dedup guard). *Additive.*
5. **Switch client admin screens** to those RPCs (Manage Students, Manage Users delete, Class Promotion promote/undo, legacy bulk import students). *Affects: admin-only screens; feature parity must be verified each.*
6. **`class_subjects` lockdown** (RLS + unique) and move its writes to admin policy/RPC. *Affects: class-subject editor, bulk teacher import.*
7. **attendance/homework/quizzes teacher RLS.** *Affects: teacher daily-entry features.*
8. **Flip `students`/`profiles` RLS** to SELECT-only. *Gate; verifies §6 fully migrated.*
9. **Excel contract hardening** (numeric-ID block, text template primary, caps, full preview) + matcher rules §11. *Affects: Class Import UX (stricter but safer).*
10. **Multi-class Bulk Grade wizard** (C+D) + overwrite/audit improvements. *Affects: teacher grade upload (additive workflow; old one retained).*
11. **Tests & CI** (§15), then staged migration + production verification.

Ordering rationale: history model and RPCs are additive and safe first; the RLS flip is deliberately last so no shipped screen breaks mid-migration (the mistake that caused the 2026-08-02 family-import bug).

---

## 15. Testing Plan

SQL tests run in CI against a freshly migrated database (no mocks), using `SET ROLE`/`request.jwt.claims` impersonation:

- **Authorization:** teacher/parent/office direct `INSERT/UPDATE/DELETE` on `students` → denied; `class_subjects` write by teacher → denied, admin → allowed; attendance/homework insert only as the owning teacher.
- **Admin import:** `apply_student_class_import` as teacher → `insufficient_privilege`; as admin → class change + new student + enrollment rows + audit rows, all in one transaction.
- **Atomicity:** force a failure on the last row (invalid class / duplicate ID) → **zero** rows changed and zero enrollment/promotion/audit rows.
- **Class change 7A→7B:** exactly one `students.className` update, no exam/attendance/homework row mutated; enrollment intervals correct; grade roster shows the student in 7B and not 7A.
- **Historical reports:** seed grades while a student is in 7A; move to 7B; midterm report **for the 7A term** still computes class average/rank against the 7A peer set; 7B-term report uses 7B peers.
- **Promotion:** end-of-year promote creates new-year enrollments; class-import mid-year move does **not** trip the promotion re-run guard; repeated identical import is idempotent (no duplicate promotions/enrollments).
- **New students / no duplicates:** unknown-ID + existing-name → ambiguous, never created; two new rows same govId → blocked; numeric 17-digit ID cell → flagged, not silently created; shared sibling phone + ambiguous name → ambiguous.
- **Excel fidelity:** 17-digit text gov id and leading-zero text ids round-trip exactly; generated template round-trips to all-no-change.
- **Bulk grades authorization:** Arabic+Tarbiya teacher can grade exactly the 8 valid class/subject pairs; wrong class/subject → denied; Arabic Akhlaaq upsert cannot affect Tarbiya Akhlaaq (subjectId isolation); multi-sheet workbook: a record pasted into the wrong class sheet is still validated by server-derived class and rejected if unauthorized.
- **Concurrency:** two simultaneous imports serialize on row locks with no duplicate student/promotion/enrollment; idempotency key reuse on grade upload returns the prior result.
- **Performance:** 1,350-student import within a stated budget; report RPCs use enrollment indexes (index `student_enrollments(studentId, effectiveFrom/effectiveTo)` and `(className, academicYearId)`).
- **Regression:** current-term reports, parent portal, dashboards, rosters, attendance entry, family-ID/gate features return identical results after RLS flip.

---

## 16. Rollback Strategy

- Each migration is backward-compatible in order: enrollment table/RPCs are additive (safe to keep if a later step rolls back).
- The **RLS flip** is the single highest-risk step; it ships as its own migration and can be rolled back by re-instating the prior permissive policies in an emergency (`DROP POLICY … ; CREATE POLICY … FOR ALL USING(true)`) while root-causing — returning the DB to its pre-existing behaviour.
- Client repoints ship behind the new RPCs; if an RPC proves faulty, the screen can temporarily call it wrapped in try/alert, but **no** direct-table fallback is reintroduced (that would recreate the security hole).
- Data changes are append-only (enrollments/promotions/audit); no historical exam/attendance data is ever deleted or rewritten, so backfill errors are corrected by additional data, not restore.
- Stage on a cloned production database first (run the introspection + all SQL tests there); take a pre-deploy backup; migrate during a low-activity window; keep the legacy single-class grade upload available until the wizard is validated.

---

## 17. Risks

- **Unknown live RLS state (F1)** — mitigated by the introspection gate and idempotent policy migration; the system ends correct regardless.
- **Breaking admin screens when locking RLS** — mitigated by migrating all §6 write paths to RPCs *before* the flip and verifying parity on each admin screen.
- **Enrollment backfill inaccuracy** for pre-history students — mitigated by current-state correctness, promotion ledger, and attendance-date snapshots; report changes only affect comparative outputs, never raw scores.
- **Teacher RLS too tight** could block legitimate attendance/homework/quiz writes — mitigate by modelling policies on the exact `teacherId`/class_subjects semantics and testing each teacher feature.
- **Excel identity corruption on legacy sheets** — mitigated by making the generated template primary and hard-blocking numeric identity cells; legacy path is explicitly warning-gated.
- **Duplicate `class_subjects`** could block the unique index — a dedup/collapse data step precedes index creation.
- **Scope creep** (full SIS redesign) is explicitly avoided: one small enrollment table is the only schema-model addition; everything else is RPC/RLS/repoint work.
- **`get_monthly_report` drift** (RPC absent from migrations) — confirm in production or add it, applying the same historical-class logic.

---

## 18. Final Go/No-Go

**NO-GO today; GO after the gated remediation.**

- **Class import (PR #29):** hold until the live RLS state is resolved and writes are uniformly RPC-admin-gated (steps 1,4,5,8), the enrollment/history model protects past-term reports (steps 2,3), and Excel identity coercion is blocked (step 9). Its matcher/preview/atomic RPC are retained.
- **Bulk Upload Grades:** safe to keep operating (current class-first flow, server-enforced authorization). The Arabic+Tarbiya 4-class teacher's multi-sheet wizard (step 10) is a usability release, not a security prerequisite.
- **Hard gates before production use of class imports:** (a) explicit students SELECT-only RLS with zero remaining direct writes, verified by impersonation tests; (b) class_subjects RLS + unique assignment; (c) enrollment-based historical reports; (d) numeric-ID protection and app-generated template as the official roster format; (e) atomicity/concurrency/duplicate tests green on a production clone.

Once those gates pass, the combined system preserves grades, attendance, and historical reports; keeps promotions working; prevents duplicate students; and makes both class administration and multi-class grade entry practical and auditable.
