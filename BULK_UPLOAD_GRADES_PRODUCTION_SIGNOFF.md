# Bulk Upload Grades — Production Sign-Off

**Role:** Final production-security engineer
**Branch:** `arena/01a0804f-schoolnnnnass`
**Date:** 2026-09-08
**Environment reality:** This sandbox has **no Docker, no local/hosted PostgreSQL, no Supabase CLI, and no Supabase credentials / `.env`.** Therefore the *hosted-Supabase-specific* conditions (live PostgREST/JWT, live migration application, live UI) **cannot be executed here and are reported as NOT VERIFIED — REQUIRES REAL DATABASE EXECUTION.** Everything that can be proven with a real PostgreSQL engine (PGlite runs actual Postgres: real RLS, real roles, real triggers, real PL/pgSQL) has been **executed**, including the direct-table RLS boundary and the status self-approval fix.

---

## 1. Executive Verdict

## APPROVED WITH CONDITIONS

A real security defect (Condition 2 — teacher status self-approval via direct table write) was **confirmed by execution and fixed**, with regression tests and a behavioral proof that the fix closes the hole while leaving the admin/supervisor approval path and the audited RPC untouched. All automated gates pass (typecheck, **690 tests**, build). The remaining conditions (live RLS on the hosted project, live UI smoke test, live migration state) are **environment-specific** and require the real Supabase/staging database, which is unavailable in this sandbox. They are listed as exact, executable pre-production steps in §15.

**Do not deploy** until the §15 live-database checks are run (they are scripted for one-command execution).

---

## 2. Real Supabase Tests Executed

**No hosted Supabase was reachable** (no CLI, no URL/key). Instead, security was executed against **real PostgreSQL via PGlite**, which enforces RLS, roles, `SET ROLE`, `WITH CHECK`, and triggers identically to production Postgres. What PGlite does **not** reproduce: the Supabase PostgREST layer, JWT→GUC plumbing, and the hosted project's exact GRANT/role bootstrap. Those are the residual live-only items.

New behavioral suites added and executed this session:

| Suite | Tests | What it executes |
|---|---|---|
| `exam-rls.db.test.ts` | 12 | Direct-table writes as a **real non-owner `authenticated` role** against the **actual shipped exam RLS policies** + the new status guard |
| `submit-bulk-grades.db.test.ts` (extended) | +2 | RPC ↔ status-guard-trigger coexistence (no regression) |

Total project tests: **690 passed / 690, 68 files, 0 failed** · typecheck clean · build 14.79s.

---

## 3. RLS Results

**VERIFIED BY EXECUTION (real Postgres, non-owner `authenticated` role); NOT VERIFIED on hosted Supabase.**

Using the **actual** `exam_select/insert/update/delete_authorized` policies extracted from `20260802_bulk_grade_integrity.sql` and `can_submit_exam_target`, running as Teacher A (owns 5-A Arabic) vs Teacher B (owns 5-B Arabic):

- Teacher A **cannot INSERT** a grade for Teacher B's class → denied by RLS. ✅
- Teacher A **cannot INSERT** for an unauthorized subject (Math) → denied. ✅
- Teacher A **cannot INSERT** a row claiming `teacherId='teacherB'` → denied. ✅
- Teacher A **cannot UPDATE** Teacher B's grade (USING hides the row → 0 rows affected; value untouched). ✅
- Teacher A **cannot re-assign** their own row's `teacherId` to Teacher B (WITH CHECK) → denied. ✅
- Teacher A **cannot move** their own row to an unauthorized `studentId` (WITH CHECK) → denied. ✅
- Teacher A **cannot even SELECT** Teacher B's rows (read isolation) → 0 rows. ✅

---

## 4. Direct Table Access Results

**VERIFIED BY EXECUTION.** Direct (non-RPC) writes to `exams` are constrained to exactly the teacher's own assigned class-subject rows; all cross-class / cross-subject / cross-teacher / identity-tamper attempts are denied by RLS (§3). This is the surface the earlier audit flagged as unproven; it is now behaviorally proven against real Postgres. **Hosted-project confirmation still required** (§15) because PostgREST/JWT wiring is not reproduced here.

---

## 5. Status Self-Approval Result

**Vulnerability CONFIRMED, then FIXED — both by execution.**

- **Confirmed (guard OFF):** with only the shipped `20260802` policies, a teacher directly inserting their own row with `status='approved'` **succeeds** — a genuine self-approval hole (the RLS `WITH CHECK` clauses never constrained `status`). Proven by an executing test.
- **Fixed:** new migration **`supabase/migrations/20260909_exam_status_teacher_guard.sql`** adds a `BEFORE INSERT OR UPDATE` trigger `enforce_exam_status_guard_trg` that forces `status='pending'` for any authenticated non-admin/non-supervisor actor.
- **Fix proven (guard ON):**
  - teacher INSERT with `status='approved'` → stored as `pending`. ✅
  - teacher UPDATE own grade to `approved` (with a legit score change) → `status` coerced to `pending`, **score change preserved**. ✅
  - teacher can still insert their own `pending` grade normally. ✅
  - **admin approval path still works** — admin UPDATE to `approved` is untouched. ✅
  - **RPC coexistence** — `submit_bulk_grades` still commits, rows land `pending`, and approved-overwrite still resets to `pending`, with the trigger installed. ✅

**Why this fix is correct and minimal:** the only UI that sets `status` (`ExamVerification.tsx`, via `updateExamStatus`/`approveAllPendingExams`/`approvePendingExamsForClasses`) is reachable **only** at `/admin/exams` and `/supervisor/verifications` — exactly the two roles the trigger exempts. Teachers never legitimately set `status`, and the audited RPC always writes `pending`, so the guard is a no-op there. The migration is idempotent (double-apply verified) and does not touch service-role/seed writes (fires only when `auth.uid()` is non-null and role ∉ {admin, supervisor}).

**Live confirmation still required** that the trigger is applied and behaves under real PostgREST (§15).

---

## 6. RPC Authorization Result

**VERIFIED BY EXECUTION** (unchanged from prior audit, re-run green): teacher/admin only; wrong class, wrong subject, wrong teacher, unauthenticated all denied; tampered `teacherId`/`parentId`/`status`/`uploadedBy` ignored and re-derived; admin uploads keep the assigned teacher's `teacherId`. The RPC re-validates on **both** preview and confirm.

---

## 7. Atomicity Result

**VERIFIED BY EXECUTION.** A batch containing one unauthorized (or invalid-score) record rolls back entirely — zero rows committed — via real PostgreSQL transaction semantics.

---

## 8. Idempotency Result

**VERIFIED BY EXECUTION** for same key + same payload (no double-insert; stored result returned). Different-key/same-records behavior (upsert via the identity unique index, no duplication) remains VERIFIED BY CODE INSPECTION only.

---

## 9. Preview / Old→New Result

**VERIFIED BY EXECUTION.** Preview returns `existingScore=14 → newScore=17` sourced from the actual DB row (not the workbook), does not mutate the row, and the UI consumes `serverPreview.changes`. Browser rendering itself is code-inspection-only (§13).

---

## 10. Approved-Grade Result

**VERIFIED BY EXECUTION** (server): approved change detected (`approvedChangeCount`, `requiresApprovedAcknowledgement=true`); on confirm the score updates and `status` resets `approved → pending` — including with the new trigger installed. UI acknowledgement gating is code-inspection-only.

---

## 11. Stale-Roster Result

**VERIFIED BY EXECUTION.** A student moved out of the class is rejected server-side at confirm because the RPC re-validates authorization against current DB state (the E2E "stale 5-A workbook with a moved student" case is denied).

---

## 12. Confirm-Time Staleness Result

**Analyzed; decision: ACCEPTED as last-writer-wins for the grade value — no code change required. This is a documented workflow decision, not an unhandled bug.**

- **Actual behavior (by code inspection of the confirm branch):** the RPC re-validates authorization/roster/term/score on confirm, then upserts the teacher's values (`ON CONFLICT DO UPDATE`). If another authorized user changed 14→16 between preview and this teacher's confirm of 17, the confirm writes 17 (last writer wins). Authorization is never bypassed.
- **Why optimistic concurrency is NOT warranted here:** (a) the brief explicitly says not to add it unless genuinely necessary; (b) grade entry is single-owner in practice — one teacher owns a given class-subject, so concurrent edits to the same cell are rare; (c) the one genuinely dangerous case — silently clobbering an **approved** grade — is already surfaced: any overwrite of an approved row is shown in the red "Approved → Pending" review section and gated behind the acknowledgement checkbox, and the overwrite always drops the row back to `pending` for re-approval, so no approved value is silently lost without re-review.
- **Residual (LOW):** two users editing the *same pending cell* in the same minute → last write wins with no "changed since preview" banner. Acceptable for this workflow. If the school later reports concurrent-edit collisions, a targeted guard (compare `existingScore` captured at preview against the row at confirm, per record) can be added without weakening authorization; a hook point exists in the RPC's normalization loop. Not implemented now by design.

---

## 13. Live UI Smoke-Test Result

**NOT VERIFIED — REQUIRES REAL DATABASE EXECUTION.** The app throws on boot without `VITE_SUPABASE_URL`/`VITE_SUPABASE_ANON_KEY`, and no `.env` or Supabase project is available in this sandbox. The 14-step teacher flow and the tamper cases (wrong class, unauthorized subject, stale roster, duplicate student, edited Student ID/Name/subject header) are supported only by unit/integration tests + code inspection + a passing build — **not** by a real browser session. The exact live steps to run are in §15.

---

## 14. Remaining Risks

| # | Risk | Severity | Blocks production |
|---|---|---|---|
| 1 | Hosted-Supabase RLS/PostgREST boundary not executed on the live project (only on real Postgres via PGlite). | HIGH until §15 run | YES until §15 #1–#2 pass |
| 2 | `20260909` status-guard migration not yet applied to the target DB (exists in Git only). | HIGH until applied | YES until applied + §15 #3 |
| 3 | Live UI never exercised in a configured browser. | MEDIUM | Recommended before go-live |
| 4 | Confirm-time value staleness is last-writer-wins for pending cells (approved cells are protected). | LOW (accepted) | NO |
| 5 | Different-idempotency-key path proven by inspection, not execution. | LOW | NO |
| 6 | PGlite ≠ hosted Supabase for grants/JWT/extensions. | INFO | NO |

---

## 15. Exact Conditions Remaining (run against the live/staging DB before production)

1. **Apply migrations**, including the new `supabase/migrations/20260909_exam_status_teacher_guard.sql`.
2. **Catalog verification (scripted):**
   `psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f supabase/tests/verify-production-state.sql`
   Confirms: RPC exists once + SECURITY DEFINER + carries the 20260908 preview additions; `authenticated` has EXECUTE; `uniq_class_subjects_active` and `exams_bulk_assessment_identity_unique` exist; exams RLS enabled with all four policies; **status-guard trigger present**.
3. **Behavioral RLS probe with two real teacher identities** (Teacher A owns 5-A Arabic, Teacher B owns 5-B Arabic): as Teacher A via the real `authenticated` role, confirm every §3 denial AND that a direct `status='approved'` insert/update lands as `pending`. (Template at the bottom of `verify-production-state.sql`.)
4. **Live UI smoke test** (Condition 4): the full 14-step flow for Grade 5-A / Arabic + Tarbiya, an approved-grade overwrite with the acknowledgement checkbox, plus the tamper cases (wrong class, unauthorized subject, stale roster, duplicate student, edited Student ID/Name/subject header). Record results.
5. **Confirm grants**: `submit_bulk_grades` executable by `authenticated`, revoked from `PUBLIC`/`anon`.

---

## 16. Final Production Decision

## APPROVED WITH CONDITIONS

The feature's server-side security is strong and now includes a **fixed, regression-tested** defense against teacher status self-approval — the one real defect surfaced by the prior audit. All logic that can be executed against a real database has been executed and passes (690 tests, incl. 12 direct-table RLS proofs + RPC/trigger coexistence). The only outstanding items are **environment-specific verifications** that require the actual Supabase/staging database and a configured browser, which are impossible in this sandbox and must not be faked. They are scripted and enumerated in §15.

**Ship after §15 #1–#4 pass on the target database.** Do not record "production verified" until then.

---

### Answer to the standing requirement
The real target database was **not** available in this environment, so per the instructions I explicitly state: **NOT VERIFIED — REQUIRES REAL DATABASE EXECUTION** for the hosted-Supabase RLS boundary, live migration state, and live UI. PGlite was used only where it is genuinely equivalent (real PostgreSQL RLS/roles/triggers/PL-pgSQL) and is **not** claimed as a substitute for the hosted-project checks above.
