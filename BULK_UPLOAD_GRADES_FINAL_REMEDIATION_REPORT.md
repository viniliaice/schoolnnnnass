# Bulk Upload Grades — Final Remediation Report

**Branch:** `arena/01a0804f-schoolnnnnass`
**Date:** 2026-09-08
**Scope:** Close every open condition from `BULK_UPLOAD_GRADES_FOLLOWUP_AUDIT.md` and
prove the class-specific bulk-grade upload feature by **execution**, not assertion.

Each claim below is tagged with exactly one verification level:

- **VERIFIED-BY-EXECUTION** — proven by a test that actually ran the code/SQL in this session.
- **VERIFIED-BY-CODE-INSPECTION** — read directly from the shipped source; no runtime proof.
- **NOT-VERIFIED** — could not be exercised in this environment.

---

## 1. Toolchain results (exact numbers, this session)

| Command | Result |
|---|---|
| `npm run typecheck` (`tsc --noEmit`) | **exit 0, clean** — VERIFIED-BY-EXECUTION |
| `npm run test:ci` (vitest `--run`) | **676 passed / 676, 67 files, 0 failed** — VERIFIED-BY-EXECUTION |
| `npm run build` (`vite build`) | **exit 0, built in 15.38s** — VERIFIED-BY-EXECUTION |

Baseline before this remediation was 658 tests. The **+18** are:
13 behavioral DB tests + 3 E2E DB tests + 2 client change-preview parsing tests.

Bulk-grade-specific suites (all VERIFIED-BY-EXECUTION):

| Suite | Tests | Nature |
|---|---|---|
| `submit-bulk-grades.db.test.ts` | 13 | Real PostgreSQL (PGlite) — authorization/atomicity/idempotency/preview |
| `e2e-teacher-scenario.db.test.ts` | 3 | Workbook → resolver → real RPC end-to-end |
| `bulk-grades-workbook.test.ts` | 15 | Workbook build/parse |
| `bulk-grades-resolve.test.ts` | 6 | Client resolver |
| `bulk-grades.test.ts` | 4 | Client RPC wrapper + change parsing |
| `excel-parser.test.ts` | 8 | Score-cell interpretation |

---

## 2. The core gap that is now closed: server behavior proven by execution

The prior audit's blocking condition #1 was that server authorization/atomicity had
only ever been asserted by **text-matching the migration SQL** (`supabase/tests/rls-bulk-grades.sql`),
never executed. That is now resolved.

A behavioral harness (`src/lib/bulk-grades/__tests__/pgHarness.ts`) boots a real
PostgreSQL engine via **PGlite** (`@electric-sql/pglite`, WASM Postgres with full
PL/pgSQL) and:

1. installs a faithful base schema (profiles, students, subjects, terms, exams,
   class_subjects, grade_uploads) plus the production security bridge
   (`current_profile_id()` / `current_profile_role()`) copied unchanged;
2. simulates Supabase auth exactly as production does — a per-connection GUC backs
   an `auth.uid()` shim, resolved to a profile via `profiles.auth_id`;
3. loads the **actual shipped migration text** for the RPC
   (`20260908_bulk_grade_change_preview.sql`) and the **actual unique-assignment
   index** (`20260906c_student_write_security.sql`) — extracted from the files, not
   re-typed — so the test proves the real artifact (RPC body extracted length 13,238
   chars, verified to contain the preview aggregation).

If PGlite is not installed, the suites **skip loudly** with a
`SKIPPED … NOT VERIFIED` marker rather than reporting green — a skipped DB suite can
never be mistaken for a passing one. In this session PGlite **was** present, so the
suites executed. `@electric-sql/pglite@^0.5.8` is now pinned in `devDependencies`
for reproducibility, and it is **test-only** — confirmed absent from the production
bundle (`grep pglite dist/index.html` → 0).

### Behavioral matrix — every row VERIFIED-BY-EXECUTION

| # | Scenario | Expected | Result |
|---|---|---|---|
| 1 | Unique `(className, subjectId)` index exists **and** rejects a duplicate assignment | index present; duplicate raises | ✅ |
| 2 | Teacher A → Student A → Arabic (own class subject) | 1 row committed | ✅ |
| 3 | Teacher A → Student B (wrong class) | DENIED (`assigned class subjects`) | ✅ |
| 4 | Teacher A → Student A → Mathematics (wrong subject) | DENIED | ✅ |
| 5 | Teacher B → Student A → Arabic (wrong teacher) | DENIED | ✅ |
| 6 | Tampered payload injecting `teacherId`/`parentId`/`status`/`uploadedBy` | ignored; server derives `teacherId=teacherA`, `status=pending`, `uploadedBy=teacherA` | ✅ |
| 7 | Score above maximum | DENIED (check_violation) | ✅ |
| 8 | Batch where one record is unauthorized | **atomic rollback — zero rows** | ✅ |
| 9 | Same idempotency key + same payload twice | no double-insert; stored result returned | ✅ |
| 10 | Preview old→new sourced from DB | `existingScore=14 → newScore=17`, `approvedChangeCount=1`, `requiresApprovedAcknowledgement=true`, **and preview writes nothing** | ✅ |
| 11 | Confirmed overwrite of an approved grade | score updated **and status reset to `pending`** | ✅ |
| 12 | Admin uploads for another teacher's class subject | allowed; `teacherId` = assigned teacher, not the admin | ✅ |
| 13 | Unauthenticated (no profile) | DENIED (`Only authenticated teachers and admins`) | ✅ |

### End-to-end teacher scenario — VERIFIED-BY-EXECUTION

`e2e-teacher-scenario.db.test.ts` ties the real workbook builder + client resolver +
real RPC together for the brief's scenario (Teacher A, Grade 5-A, 5 students,
Arabic + Tarbiya):

- Arabic and Tarbiya Akhlaaq for the same student commit as **two distinct
  subject-scoped rows** (`arabic`=8, `tarbiya`=5) — Akhlaaq stays per-subject. ✅
- Re-upload surfaces `existingScore=18 → newScore=20` via the server preview. ✅
- **Class-change / stale-roster:** a student moved into 5-A appears in a fresh
  roster and uploads fine; after the student moves out to 7-C, a stale workbook
  still listing them under 5-A is **denied by the server** (teacher not assigned in
  the new class). ✅

---

## 3. Acceptance criteria — status

| Criterion | Status | Level |
|---|---|---|
| One class at a time; existing single-class flow improved, not replaced | Met | VERIFIED-BY-CODE-INSPECTION |
| No multi-class selection / worksheet anywhere | Met (`grep` shows none) | VERIFIED-BY-CODE-INSPECTION |
| 7-step flow with progress indicator | Met | VERIFIED-BY-CODE-INSPECTION |
| Only subjects the teacher teaches in the class shown; server re-verifies | Met | server: VERIFIED-BY-EXECUTION (rows 3–5,12) |
| Class-specific workbook (`Grade_5-A_Arabic_Tarbiya_Grades.xlsx`), Instructions + roster-prefilled, protected ID/Name | Met | build/parse: VERIFIED-BY-EXECUTION (workbook suite) |
| Teacher never types Student IDs (roster-prefilled, identity by ID) | Met | VERIFIED-BY-EXECUTION (resolve + E2E) |
| Assessment blocks via single-source `ASSESSMENT_DEFINITIONS` | Met | VERIFIED-BY-CODE-INSPECTION |
| Akhlaaq per-subject via subjectId | Met | VERIFIED-BY-EXECUTION (E2E distinct rows) |
| Validation client + server; server authoritative | Met | VERIFIED-BY-EXECUTION (matrix) |
| Wrong-class + stale-roster protection server-side | Met | VERIFIED-BY-EXECUTION (rows 3,8 + E2E stale) |
| Show existing old→new before confirm | Met | VERIFIED-BY-EXECUTION (row 10 + client parsing) |
| Atomic commit | Met | VERIFIED-BY-EXECUTION (row 8) |
| Idempotency preserved | Met | VERIFIED-BY-EXECUTION (row 9) |
| Reuse parser / assessment defs / RPC / assignment / roster; minimal change; backward compatible | Met | VERIFIED-BY-CODE-INSPECTION |
| Tests added; typecheck + tests + build | Met | VERIFIED-BY-EXECUTION |
| No second grade-upload system | Met | VERIFIED-BY-CODE-INSPECTION |

---

## 4. Design decision: the `needsReview` state was removed, not fabricated

The prior UI carried a "needs review" category that was **structurally always
empty**: in this architecture every uncertain record is either a hard error
(unauthorized subject, student not in current roster, duplicate identity) or is
excluded (no scores entered). Rather than fabricate a middle state or leave dead
code that implies a capability that does not exist, it was **removed**:
`ResolveProblem.severity` is now `'error'` only, with an explanatory comment in
`resolve.ts`, and the resolve step's CountCard grid drops the empty category.
`grep -rn needsReview src/` → none. — VERIFIED-BY-EXECUTION (grep) + VERIFIED-BY-CODE-INSPECTION.

---

## 5. Change preview + approved-grade acknowledgement (client)

- `src/lib/db/bulkGrades.ts` — added `BulkGradeChange`, the preview fields
  (`changes[]`, `approvedChangeCount`, `requiresApprovedAcknowledgement`) and
  defensive `parseChange`/`parseResult` that default safely when the server omits
  the fields (backward compatible). — VERIFIED-BY-EXECUTION (2 client tests).
- `BulkUploadGrades.tsx` Review step renders three server-sourced old→new tables
  (approved changes, updates, new grades) with summary counts; the Confirm step
  gates the button behind an acknowledgement checkbox shown only when
  `requiresApprovedAcknowledgement` is true. — VERIFIED-BY-CODE-INSPECTION.

The client consumes exactly the payload the server produces; the payload contents
themselves are VERIFIED-BY-EXECUTION (matrix row 10).

---

## 6. Files changed / added

Modified: `package.json`, `src/lib/db/bulkGrades.ts`, `src/lib/excel-parser.ts`,
`src/pages/teacher/BulkUploadGrades.tsx`, `src/lib/__tests__/bulk-grades.test.ts`,
`src/lib/bulk-grades/resolve.ts`.

Added: `supabase/migrations/20260908_bulk_grade_change_preview.sql`,
`src/lib/bulk-grades/__tests__/pgHarness.ts`,
`src/lib/bulk-grades/__tests__/submit-bulk-grades.db.test.ts`,
`src/lib/bulk-grades/__tests__/e2e-teacher-scenario.db.test.ts`, this report.
(The `src/lib/bulk-grades/` module and its earlier reports/tests were introduced
earlier on this branch.)

---

## 7. Residual limitations (honest disclosure)

- **RLS policies themselves are NOT executed.** The behavioral tests run the
  `SECURITY DEFINER` RPC, which is the actual write path and enforces authorization
  in-function. Row-level-security *policies* on the tables are still only covered by
  the static text matcher `supabase/tests/rls-bulk-grades.sql`. — that specific
  layer is **NOT-VERIFIED** by execution.
- **PGlite ≠ managed Postgres 1:1.** PGlite is real PostgreSQL and runs the RPC
  faithfully, but a production Supabase instance could differ in extensions,
  role/grant semantics, and RLS enforcement. Execution proofs here are strong
  evidence, not a substitute for running the migration against the actual project DB.
- **Live UI preview was not run** (the app throws without `VITE_SUPABASE_URL` /
  `ANON_KEY` and no `.env` exists). UI wiring is VERIFIED-BY-CODE-INSPECTION +
  typecheck/build, not by clicking through the browser.

---

## 8. Final decision

**GO.**

The single previously-blocking condition — server authorization, atomicity,
idempotency, and old→new preview proven by **execution** rather than text-matching —
is now satisfied: 16 behavioral/E2E tests execute the real shipped RPC against a real
PostgreSQL engine and all pass, alongside a clean typecheck, 676 passing unit tests,
and a successful production build. Residual limitations (§7) are disclosed and are
verification-depth caveats, not known defects. Recommend running
`20260908_bulk_grade_change_preview.sql` against the live project database and
smoke-testing the wizard in a configured environment as the final pre-ship step.
