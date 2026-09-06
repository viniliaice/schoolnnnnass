# Implementation Remediation Report — Bulk Upload Grades & Student Class Import

**Date:** 2026-09-06
**Branch:** `arena/01a0772c-schoolnnnnass`
**Based on:** `THIRD_AGENT_BULK_UPLOAD_CLASS_IMPORT_REVIEW.md` and `BULK_UPLOAD_CLASS_IMPORT_REMEDIATION_PLAN.md`
**Inputs in this branch:** PR #29 (Agent A class import) merged as baseline, then remediation applied.

---

## Executive Summary

The blocking security and data-correctness findings from the independent review have been remediated at the **database and client-write layer**, while preserving Agent A's conservative matcher, preview-first workflow, and atomic commit, and the existing server-derived Bulk Upload Grades authorization.

Three new migrations implement: a **historical enrollment ledger** (fixes mid-term-move report corruption), **admin SECURITY DEFINER RPCs for every student write** plus a **SELECT-only RLS lockdown** of `students` (removes the open `FOR ALL USING(true)` write path), **unique identity/assignment constraints** (govId, class_subjects), **teacher-scoped RLS** for attendance/homework/quizzes, and a **hardened class-import** (numeric-ID rejection, phone normalization, caps, idempotent history, enrollment writes).

**Status of the gate:** code + migrations + unit tests are complete and green. Because there is no live/staging database available in this environment, the SQL was verified by construction and an idempotent integration test script was added but **not executed against Postgres**. Per the acceptance criteria this is a **conditional GO for code review; the production migration must still be applied to a cloned/staging database and run through `supabase/tests/rls-remediation.sql` before production.**

---

## Baseline

- Branch with Agent A PR #29 merged: baseline **555 tests pass**, `tsc` clean, `vite build` clean (re-run independently).
- Direct student write paths confirmed in code (see write-path inventory below).
- Migrations on `main` end at `20260904_gate_walking_driver.sql`; Agent A added `20260906_student_class_import.sql`.

## Findings Verified (in code)

F1 contradictory students RLS state; F2 class_subjects no RLS / no unique; F3 reports derive peer group from current `className` (`get_midterm_report`); F4 numeric Excel Gov-id coercion (empirically reproduced); F5 direct browser writes to students; F6 no govId uniqueness / un-normalized phone; F7 repeated imports duplicate promotion history; F9 new students minimal; F10 no size/row caps / 500-row preview; F11 attendance/homework className snapshots; F12 one-class-per-upload grade workflow.

## Changes Implemented

### Database changes (new migrations, in order)

1. **`20260906b_student_enrollments_history.sql`**
   - `student_enrollments` ledger (`studentId, className, academicYearId, termId, effectiveFrom, effectiveTo, reason, sourceRef`) with:
     - unique index `uniq_student_enrollments_open` — **one open enrollment per student**;
     - indexes for student-date and class-period lookups;
     - RLS (staff/teacher/parent reads, no client writes).
   - `record_class_assignment(student, class, reason, effectiveFrom, year, term, ref)` — idempotent move ledger maintenance (closes prior open range, opens new).
   - `class_for_term(student, term)` and `class_students_for_term(class, term)` — **historical** class resolution with a safe current-class fallback for unreconstructable periods.
   - Idempotent **backfill**: open enrollment per current student (current academic-year start), closed ranges from `student_promotions`, earliest known class from the first promotion, and mid-year-transfer handling.
   - `get_midterm_report` repointed to `class_students_for_term` and made `SECURITY DEFINER` so peer averages resolve historically regardless of caller RLS. **Raw grades are never modified.**

2. **`20260906c_student_write_security.sql`**
   - Admin-only SECURITY DEFINER RPCs (`assert_admin` gate, `SET search_path=public`, explicit `REVOKE/GRANT`, audited): `create_student`, `update_student`, `delete_student`, `bulk_create_students`, `undo_promotions`, `unlink_parent_students`, `promote_students` (now SECURITY DEFINER + admin + enrollment-aware), and a hardened `apply_student_class_import`.
   - Hardened import: 5,000-change / 2,000-new row caps; normalized phone storage; **govId duplicate rejection** (in-batch and against existing); **idempotent promotion history** (no duplicate `class_import` rows for the same move); writes enrollment history via `record_class_assignment`.
   - govId integrity: duplicates quarantined (older rows' govId nulled, audited), then a **unique expression index** on normalized gov id (nulls allowed).
   - class_subjects: duplicates collapsed (keep row with teacher, then newest; audited), **unique `(className, subjectId)` index**, **RLS enabled** (authenticated reads, admin-only writes).

3. **`20260906d_rls_lockdown.sql`**
   - Drops `Allow all operations on students`; installs explicit SELECT policies (staff; teacher via `class_subjects` **and** legacy `assignedClasses`; parent via `parentId` **or** normalized phone). **No INSERT/UPDATE/DELETE policy** on students.
   - RLS enabled and policies added for `student_promotions` (staff read), `attendance`, `homework`, `quizzes` (owning-teacher writes, staff/teacher/parent reads), and `quiz_attempts`.
   - All policy columns fully `public.<table>.<column>`-qualified to prevent subquery column-binding bugs.

### Client changes (write paths moved to RPCs — signatures preserved)

| File | Before | After |
|---|---|---|
| `src/lib/db/students.ts` | direct `insert/update/delete` + `promoteStudentsByClass` direct update | `create_student` / `update_student` / `delete_student` / `promote_students` RPC wrappers |
| `src/lib/db/bulk.ts` | `bulkCreateStudents` direct insert | `bulk_create_students` RPC |
| `src/lib/db/promotions.ts` | `undoPromotion` direct update+delete | `undo_promotions` RPC |
| `src/lib/db/profiles.ts` | delete-user direct students update | `unlink_parent_students` RPC then profile delete |

### Excel import hardening (`src/lib/import/classImport.ts`, `ClassImport.tsx`)

- **Numeric identity detection:** a Student ID or Gov ID cell stored by Excel as a *number* is flagged `NUMERIC_ID`, held as `invalid`/excluded, and never auto-matched or auto-created (prevents the >15-digit precision and leading-zero duplicates). Text IDs with leading zeros match normally.
- **Official workflow:** the app-generated *Export current students* template remains the primary path (text IDs; round-trips to all-no-change).
- New-student **phone normalized** (`normalizePhone`, digits/+252 stripped) consistent with family-ID/transport import.
- File-size limit (5 MB) and row limit (7,000) enforced; **preview paginated** (100/page) instead of silently committing rows beyond the first 500.

## RLS Changes

See migrations above. Net effect: students can no longer be written by direct client calls; all legitimate mutations flow through admin SECURITY DEFINER RPCs; teacher daily-entry tables are scoped to the owning teacher; class_subjects (the grade-authorization anchor) is admin-write-only and unique.

## Historical Enrollment Changes

`students."className"` remains the authoritative **current** class. Historical/comparative reads (midterm peer group, rank, class average) now resolve through `student_enrollments` for the requested term. Current rosters, grade authorization, and attendance entry are unchanged. Backfill is additive and idempotent; un-reconstructable periods fall back to current class rather than rendering empty.

## Excel Import Changes

Numeric-ID rejection, normalized phone, caps, idempotent promotion rows, enrollment-history writes, and paginated full preview — as above.

## Bulk Grade Changes

The existing secure server-side authorization (`submit_bulk_grades`, per-subject Akhlaaq isolation, assessment allowlist, atomic preflight/commit) is unchanged and retained. The full multi-class/multi-sheet roster-prefilled **wizard UI (Phase 17)** is the remaining usability track — the server contract already authorizes by derived class and requires no security change; the design is documented in the remediation plan.

## Security Improvements

- Removes the open student write policy; no privilege escalation via direct table writes.
- class_subjects admin-only + unique (closes the self-assignment escalation and nondeterministic `LIMIT 1`).
- All write functions role-checked in SQL, pinned search path, explicit grants, audited.
- Teacher tables scoped to owning teacher.

## Tests

- Unit: added numeric-ID rejection, leading-zero text match, and phone-normalization tests in `classImport.test.ts`.
- **All 559 unit tests pass** (555 baseline + 4 new); `tsc --noEmit` clean; `vite build` clean.
- New **`supabase/tests/rls-remediation.sql`**: enforces/asserts enrollment ledger + one-open constraint, backfill correctness, idempotent moves, historical class resolution, students SELECT-only (no write policy; broad policy gone), class_subjects RLS+unique, govId uniqueness rejection, SECURITY DEFINER + grants on every write RPC, `get_midterm_report` using enrollment peers, RLS on teacher tables, and an end-to-end `create_student`/`delete_student` (phone normalization + open enrollment).

## Regression Results

Unit suite green. Client write call sites keep their previous signatures, so Manage Students, Class Promotion (promote/undo), Manage Users delete, legacy bulk student import, and the class-import page call the new RPCs with no UI contract change. **SQL execution against Postgres is required in staging** (not runnable in this checkout — no DB/Supabase CLI network access).

## Migration Order

Apply in this order on a cloned database first:
1. `20260906b_student_enrollments_history.sql`
2. `20260906c_student_write_security.sql`
3. `20260906d_rls_lockdown.sql`
(replacements: Agent A's `20260906_student_class_import.sql` functions are superseded/`CREATE OR REPLACE`d by 20260906c.)

## Deployment Requirements

1. Provision a staging/clone DB; apply the three migrations; run `supabase/tests/rls-remediation.sql` with `ON_ERROR_STOP=1`.
2. In staging, click through: Manage Students create/edit/delete, Class Promotion promote + undo, Manage Users delete (parent unlink), legacy bulk import, Class Import end-to-end, Bulk Upload Grades (single class), Record Attendance, Assign Homework, Create/Grade Quizzes, parent portal.
3. Confirm reports: a grade earned in class A still reports against A peers after a move; current rosters show the new class.
4. Backup production; run live introspection (`pg_policies`, `pg_proc.prosecdef`); migrate in a low-activity window; verify immediately.

## Remaining Risks / Follow-ups

- SQL not executed against a live Postgres in this environment (gating item).
- Full multi-class/multi-sheet Bulk Grades **wizard UI** (Phase 17/18) remains a usability follow-up; legacy single-class upload stays available.
- `profiles` broad write policy was left as-is to avoid disrupting auth/self-service flows; recommend a follow-up audit.
- `get_monthly_report` RPC is absent from migrations (possible production-drift) — verify and align with enrollment-based class logic.
- Teacher RLS on homework/quizzes should be smoke-tested with real assignment data in staging.

## Final Production Decision

**CONDITIONAL GO (code complete, tests green, typecheck/build green) — NO-GO for direct production until the three migrations are applied and `rls-remediation.sql` passes on a staging clone and the listed UI smoke tests succeed.** The blocker set that motivated the original NO-GO (open student writes, unprotected class_subjects, historical report corruption, Excel ID coercion, un-RPC'd write paths, duplicate govId, missing caps) is addressed in code and migrations; final sign-off is the staging DB verification described above.
