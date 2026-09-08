# Admin Grade Correction — Implementation Report

**Branch:** `arena/01a0804f-schoolnnnnass`
**Date:** 2026-09-08

## Implementation Summary

Added a production-grade **Admin Grade Correction** workflow that lets an authorized administrator correct a single existing grade (exam row) without re-uploading a spreadsheet, while preserving the original value in an immutable, append-only audit trail. It is an **additional** admin workflow: the teacher Bulk Upload Grades pipeline (configure → upload → validate → resolve/Needs-Review → review → confirm → `submit_bulk_grades`) is unchanged — no multi-class support, no mandatory Student IDs, no weakened duplicate detection, no altered blank-ID resolution.

The correction **UPDATEs the existing `exams` row** (never delete+insert), so the row keeps its identity, provenance (`uploadedBy` stays the original teacher), subject/assessment/term binding, and historical class context. The grade is targeted by its exact database primary key (`exams.id`) — client-supplied student/class/subject context is never trusted for the mutation. All mutation goes through a SECURITY DEFINER RPC.

## Database Changes

**Migration:** `supabase/migrations/20260910_admin_grade_correction.sql` (idempotent)

- **Table `grade_correction_audit`** — append-only history: `exam_id` (FK, ON DELETE SET NULL), denormalized snapshot (`student_id`, `class_name`, `subject_id`, `subject`, `assessment_label`, `exam_type`, `term_id`, `assessment_date`), `old_score`/`new_score`, `old_entry_state`/`new_entry_state`, `old_status`/`new_status`, `reason`, `corrected_by` (FK), `corrected_at`, `source`.
- **Indexes** — `(exam_id, corrected_at DESC)`, `(student_id, corrected_at DESC)`, `(corrected_by, corrected_at DESC)`.
- **RLS** — SELECT for `admin`/`supervisor`; **no** INSERT/UPDATE/DELETE policy (only the SECURITY DEFINER RPC writes it). `INSERT/UPDATE/DELETE` explicitly revoked from `authenticated`; `SELECT` granted.
- **Immutability trigger** `grade_correction_audit_immutable()` — hard-blocks UPDATE/DELETE for any authenticated client (defense in depth; migrations/service-role unaffected, mirroring `enforce_exam_status_guard`).
- **RPC `admin_correct_grade(p_exam_id, p_expected_old_score, p_new_score, p_reason, p_expected_old_entry_state, p_new_entry_state)`** — SECURITY DEFINER, `search_path = public`, `EXECUTE` granted only to `authenticated`.
- **RPC `get_grade_correction_history(p_exam_id)`** — SECURITY DEFINER, staff-gated, returns chronological history with the corrector's display name.

**Client data layer:** `src/lib/db/gradeCorrections.ts` (`correctGrade`, `getGradeCorrectionHistory`) and `searchGradesForCorrection()` added to `src/lib/db/exams.ts` (server-side filtered/paginated grade search).

## Security

- **Who can correct:** administrators only. Enforced in SQL: `admin_correct_grade` raises `insufficient_privilege` unless `current_profile_role() = 'admin'`. Route + sidebar are admin-only, but the DB is the enforcement point.
- **Who cannot:** teachers, parents, students, supervisors, and anonymous callers are all denied by the RPC (verified behaviorally).
- **Authorization source:** derived from the authenticated session via the existing security bridge (`current_profile_id()`/`current_profile_role()` → `profiles.auth_id = auth.uid()`). The client cannot claim a role.
- **Client tampering prevented:** the client submits only `exam_id`, the reviewed value (for concurrency), the new value, and the reason. `corrected_by`, `corrected_at`, `old_score`, `old_status`, `new_status`, `uploadedBy`, `teacherId` are all derived server-side from the locked row/session. The audit table has no client write surface and an append-only trigger.
- **Direct-table status guard preserved:** the existing `enforce_exam_status_guard` trigger (teachers cannot self-approve via direct writes) is unaffected; the correction RPC always writes `status='pending'`.

## Audit Trail

Every successful correction appends one immutable row capturing **who** (`corrected_by`), **when** (`corrected_at`), **before** (`old_score`/`old_entry_state`/`old_status`), **after** (`new_score`/`new_entry_state`/`new_status`), and **why** (`reason`), plus the grade's identity snapshot. Corrections never overwrite prior audit rows: `12 → 10` then `10 → 11` yields two records. The trail is append-only (no edit/delete in UI or DB). `NULL` score with `absent`/`not_applicable` is preserved distinctly from a scored `0`.

## Status / Approval

A corrected grade is reset to **`pending`**, mirroring the existing bulk-overwrite behavior (`submit_bulk_grades` also resets an overwritten row to pending). An approved grade never silently keeps its approval on a new value — approval is re-earned through the existing approval path. The transition (`approved → pending`) is recorded in the audit and surfaced in the UI (amber warning on the review step). Reporting RPCs read `status='approved' AND entryState='scored'`, so a corrected grade drops out until re-approved, then reports show the corrected value — never the stale original.

## UI

- **Route:** `/admin/grade-corrections` (admin-only in `ROUTE_ACCESS` + App switch). Sidebar entry "Grade Corrections" under the admin grades group.
- **Components:** `src/pages/admin/GradeCorrections.tsx` (filters: class, subject, assessment, term, month, status, student search by name/Student ID/Gov ID; server-side paginated results table; correction dialog with Edit → Review → Done stages showing `current → new`; mandatory reason; approved-grade warning; success state; correction-history panel with undo-free append-only list). Pure helpers in `src/pages/admin/gradeCorrectionUtils.ts`.
- Reuses existing `Dialog`, `Skeleton`, toast, and React Query conventions. Empty state, loading skeletons, and success toast included.

## Tests

- **`src/lib/bulk-grades/__tests__/admin-correct-grade.db.test.ts`** — 22 behavioral tests **executed against real PostgreSQL (PGlite)** loading the ACTUAL shipped migration: admin correct 12→10; audit created with old/new/reason/corrected_by; teacher/parent/supervisor/anonymous denied; score > max rejected; negative rejected; invalid (non-integer/Infinity) rejected by typed param; same-score no-op rejected (no audit); missing/whitespace reason rejected; multiple corrections → two immutable records; stale/concurrent correction rejected (not overwritten); nonexistent exam id rejected; approved → pending transition; provenance preserved (`uploadedBy` = teacher, `corrected_by` = admin); class assignment untouched; NULL/absent semantics; history reader staff-only + chronological; report-style consumer uses corrected value; audit UPDATE/DELETE blocked.
- **`src/lib/__tests__/gradeCorrectionUtils.test.ts`** — 21 unit tests for score/reason/no-op/range validation and display.
- **`src/lib/__tests__/gradeCorrectionsPage.test.tsx`** — 5 component tests (dialog opens with current value; empty reason blocks Review; review shows old→new + approved warning; confirm calls RPC + success; server/concurrency error surfaced; empty state).
- **`src/lib/__tests__/routing.test.ts`** — updated: `/admin/grade-corrections` is admin-only; ROUTE_ACCESS membership assertion updated.

## Test Results

```
npm run typecheck   PASS (exit 0)
npm run test:ci     PASS — 757/757 (71 files, 0 failed)   [+48 vs 709 baseline]
npm run build       PASS (built in ~11.7s)
```

Targeted: `admin-correct-grade.db` 22/22, `gradeCorrectionUtils` 21/21, `gradeCorrectionsPage` 5/5, `submit-bulk-grades.db` + `exam-rls.db` + `e2e-teacher-scenario.db` all pass (no regression), `bulk-grades-resolve`/`bulk-grades-workbook`/`classImport` unchanged.

## Database Verification

- **Verified against real PostgreSQL/PGlite:** the correction RPC, history RPC, audit table, RLS-less write path, immutability trigger, admin-only authorization, validation, concurrency conflict, no-op rejection, multi-correction history, and status transition are all **EXECUTED** against a real Postgres engine loading the actual migration file — not mocked.
- **NOT verified against production Supabase:** the hosted PostgREST layer, JWT→GUC plumbing, and the exact GRANT/role bootstrap of the live project are **NOT VERIFIED — REQUIRES REAL DATABASE EXECUTION**. The migration must be applied and the RLS/RPC re-checked against the actual Supabase instance before production sign-off.
- UI was validated via typecheck + build + jsdom component tests; it was **not** click-tested in a live browser (no Supabase env in this workspace).

## Risks / Follow-ups

- **Production migration not yet applied.** `20260910_admin_grade_correction.sql` must be run against the live database; the `authenticated` role and `create_audit_log`/security-bridge functions are assumed present (they are, from prior migrations).
- **Re-approval is manual.** A corrected grade returns to `pending`; an admin/supervisor must re-approve it through the existing Exam Verification flow. This is intentional (approval re-earned) but worth communicating to staff.
- **Score precision.** The existing `exams.score` column is INTEGER; the correction feature preserves that (integers only), matching current assessment definitions. If decimals are ever introduced, the RPC parameter type and client validation would need to change together.

## Final Verdict

**GO WITH CONDITIONS.**

All critical acceptance criteria are implemented and **verified against a real PostgreSQL engine (PGlite)**: an admin can correct a real grade; the database records an immutable audit; unauthorized users (teacher/parent/supervisor/anonymous) cannot perform it; the original value remains auditable across multiple corrections; reports use the corrected value once re-approved; provenance and historical class context are preserved; concurrency and no-op are handled; and the existing Bulk Upload Grades behavior is intact (757/757 tests, build, typecheck all green).

**Condition:** the migration has **not** been applied to, nor verified against, the **production Supabase** instance (PostgREST/JWT/role bootstrap). That step remains outstanding and is required before declaring full production readiness.
