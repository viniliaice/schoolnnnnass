# Bulk Upload Grades — Final Independent Sign-Off

**Reviewer role:** Final independent senior verification audit (no code, migration, or data changes made).
**Branch:** `arena/01a0804f-schoolnnnnass` · HEAD `fea69fd`
**Date:** 2026-09-08
**Method:** Direct source/migration inspection + independent execution of the test suite (`typecheck`, `test:ci`, `build`, verbose DB-test run). Nothing was taken on faith from the implementation agent's report.

---

# Executive Verdict

## APPROVE WITH CONDITIONS

The implementation is **sound, correctly scoped, and its RPC security is genuinely proven by execution** against a real PostgreSQL engine. The prior blocking gap (server behavior only text-matched, never executed) is legitimately closed. However, the implementation agent's flat **"GO"** is **mildly overstated**: it proves *RPC* behavior, not the *Supabase RLS/PostgREST* security boundary, and there are real (mostly pre-existing) items that must be verified against the live project before a school relies on this for production grade entry. None of the open items are defects introduced by this feature; they are environment-verification gaps and one pre-existing platform-hardening concern.

**The correct wording is:** *"RPC behavior is proven by execution in PGlite; Supabase-specific RLS/PostgREST behavior remains to be verified against the live project."* The report's own §7 already says this — but its final one-word **GO** does not carry that qualifier forward, so I am downgrading to **APPROVE WITH CONDITIONS**.

**Blocks production: NO** — provided the pre-production conditions in §16 are executed. There is **no** functional defect that would cause wrong grades through the intended wizard path.

---

## 1. What Was Verified by Execution

Independently re-ran on this checkout:

| Check | Result |
|---|---|
| `npm run typecheck` | clean, exit 0 |
| `npm run test:ci` | **676 passed / 676, 67 files, 0 failed** |
| `npm run build` | success, built in 14.81s |
| DB suites via verbose reporter | **16 tests ran and passed — confirmed NOT skipped** (PGlite `@electric-sql/pglite@0.5.8` present) |

Test-count reconciliation (independently counted, not trusted):

```
baseline test count : 658
new tests           : 18  (13 behavioral DB + 3 E2E DB + 2 client parsing)
total test count    : 676   ✓ 658 + 18 = 676 — arithmetic consistent
database tests       : 13   (submit-bulk-grades.db.test.ts, grep it( = 13)
E2E tests            : 3    (e2e-teacher-scenario.db.test.ts, grep it( = 3)
client parsing tests : 2    (new describe block in bulk-grades.test.ts; file total 4)
```

No reporting inconsistency found. Every count in the remediation report matches the code.

**Proven by execution (all VERIFIED BY EXECUTION):** RPC authorization allow/deny (own class-subject allowed; wrong class, wrong subject, wrong teacher, unauthenticated all denied); tampered payload cannot inject `teacherId`/`parentId`/`status`/`uploadedBy` (server re-derives them); over-max score rejected; **atomic rollback — zero rows committed when any record in a batch is unauthorized**; **idempotency — same key + payload does not double-insert**; **preview old→new sourced from the DB row, not the workbook**; preview does not mutate the target row; approved-grade detection (`approvedChangeCount`, `requiresApprovedAcknowledgement`); approved overwrite on confirm resets `status='approved' → 'pending'`; admin may upload for another teacher's class subject with the stored `teacherId` remaining the assigned teacher; the `uniq_class_subjects_active` unique index exists and actually rejects a duplicate assignment.

I confirmed the harness loads the **actual shipped RPC migration text** (extracted from `20260908_bulk_grade_change_preview.sql`, not re-typed) and the **actual** `uniq_class_subjects_active` statement (from `20260906c`). This is real PL/pgSQL execution of the real function body.

---

## 2. What Was Verified by Code Inspection

- **One-class-only:** `selectedClass` is a singular `useState('')`; there is no class array, multi-class checkbox, multi-sheet workbook, or batch selector. `grep` for multi-class markers → none. **VERIFIED BY CODE INSPECTION.**
- **Subject source is teacher+class assignment:** `getClassSubjectsForTeacher(teacherId, className)` filters `class_subjects` by `teacherId` AND `className`; admin passes `''` to see all subjects for the class. **VERIFIED BY CODE INSPECTION.**
- **`needsReview` fully removed:** `grep -rn needsReview src/` → none; no always-zero category renders in the resolve step. **VERIFIED BY EXECUTION (grep) + CODE INSPECTION.**
- **Assessment-definition parity (no client/server drift):** client `ASSESSMENT_DEFINITIONS` (HW1–4/Homework/5, CPW1–4/Classwork/15, ATTENDANCE/Attendance/20, MT/Quiz/20, AKHLAAQ/Discipline/10) matches the RPC's hardcoded validation branch **exactly**. **VERIFIED BY CODE INSPECTION.**
- **Workbook anti-tampering (client mirror):** the resolver keys identity on trimmed **Student ID** against the current roster (never name/row/position); unknown ID → hard error; unauthorized subject header → hard error; duplicate assessment identity → hard error. The server re-enforces all of this. **VERIFIED BY CODE INSPECTION (client) + EXECUTION (server).**
- **Confirm re-validates:** the RPC's full validation loop runs **unconditionally** on both preview and confirm (line 89 iterates `p_records` before the `p_confirm_updates` branch), so authorization/roster/term/score are re-checked against **current** DB state at commit — the confirm path does not blindly trust the preview. **VERIFIED BY CODE INSPECTION.**

---

## 3. What PGlite Proves

PGlite is a genuine PostgreSQL engine with full PL/pgSQL, so it authoritatively proves everything **inside** `submit_bulk_grades`:

- the RPC's business logic and every PL/pgSQL branch;
- server-side authorization derived from `current_profile_id()`/`current_profile_role()` (bodies copied byte-for-byte from the real `20260708` migration);
- **atomic rollback** — genuine PostgreSQL transaction semantics, not a mock;
- idempotency via `grade_uploads` key/hash;
- the preview change-query behavior and old→new derivation from real rows;
- the `uniq_class_subjects_active` and `exams_bulk_assessment_identity_unique` constraints as they participate in the RPC's upsert.

This is a real, meaningful upgrade over the previous text-matching-only verification.

---

## 4. What PGlite Does NOT Prove

The harness enables **no row-level security at all** and defines only the tables/functions the RPC touches. Therefore the following are **NOT proven by execution** and must not be called "verified by execution":

- **Real Supabase RLS policies** on `exams`, `class_subjects`, `students`, `grade_uploads` (the harness never runs `ENABLE ROW LEVEL SECURITY` or any `CREATE POLICY`).
- **PostgREST direct-table access** behavior (the actual client can hit tables directly, not only the RPC — see §6).
- **Real Supabase roles/grants** (`authenticated`, `anon`, `service_role`) and the `REVOKE/GRANT` on the function.
- **Production extensions/config, migration application order, and real project data.**
- Hand-written harness pieces (base schema, `current_profile_*`, the `exams` identity index) were verified to **match** the real migrations by inspection, but they are copies — a future migration drift would not be caught by these tests.

---

## 5. RLS / Supabase Verification

`supabase/tests/rls-bulk-grades.sql` is **static / catalog-based**, not behavioral: it asserts via `pg_proc`, `pg_get_functiondef`, and `position(... in v_def)` text matching. It **never `SET ROLE`s to a teacher and attempts a direct write**, so it does not prove the RLS boundary either.

The real migrations **do** ship strong defense-in-depth RLS (inspected in `20260802_bulk_grade_integrity.sql`):
- `exams` RLS enabled with `exam_select/insert/update/delete_authorized` policies gated on `current_profile_role()` and `can_submit_exam_target(studentId, subjectId, teacherId)` — a direct insert/update is constrained to the teacher's own assigned class-subject.
- `class_subjects` RLS enabled (SELECT to authenticated); `students` locked down in `20260906d` (SELECT-only for clients, writes via admin RPCs); `grade_uploads` RLS enabled.

So the production security boundary appears well-designed, but **only the RPC security is proven by execution** — the RLS policies themselves are proven by neither the PGlite suite nor the static SQL. This matches the report's honest §7 disclosure.

---

## 6. Old → New Preview Verification

**VERIFIED BY EXECUTION.** The behavioral test seeds Arabic MT `score=14, status=approved` for Ahmed, uploads `17`, and asserts the preview returns `existingScore=14, newScore=17, existingStatus='approved', changeType='update', isApproved=true`, and that the stored row is **unchanged by preview**. The E2E test independently confirms `existingScore=18 → newScore=20`. The old value provably comes from the database, not the workbook. The UI (`BulkUploadGrades.tsx`) consumes `serverPreview.changes` and renders old→new via `ChangeTable`/`formatCellValue`; the "current" column uses server `existingScore`. UI consumption is VERIFIED BY CODE INSPECTION + typecheck/build (not clicked through — see §13).

---

## 7. Approved Grade Verification

**VERIFIED BY EXECUTION** for the server contract: approved change is detected (`approvedChangeCount=1`, `requiresApprovedAcknowledgement=true`); on confirm the score updates and `status` resets `approved → pending`.
**VERIFIED BY CODE INSPECTION** for the UI: the Review step renders approved changes in a distinct red "Approved → Pending" section; the Confirm step shows the acknowledgement checkbox only when `requiresApprovedAck`, and the Confirm button is gated by `canConfirm = !requiresApprovedAck || approvedAcknowledged` (also disabled with an explanatory `title`). The end-to-end click path was not executed in a browser.

---

## 8. Atomicity

**VERIFIED BY EXECUTION** (real PostgreSQL, not a mock). A 3-record batch with one unauthorized record raises and commits **zero** rows (total exam count unchanged; the valid HW3 row count is 0). Score/state validation likewise aborts the whole batch. This is genuine transaction rollback.

---

## 9. Idempotency

**VERIFIED BY EXECUTION** for same-key/same-payload: two identical confirm calls yield exactly one exam row and return the stored result. **NOT EXECUTED:** the "different idempotency key, same records" path is not covered by a test; by code inspection a new key would proceed and the assessment-identity unique index would cause the records to **upsert** (update the same rows), not duplicate — but this specific path is unproven. Minor.

---

## 10. Teacher / Class / Subject Authorization

**VERIFIED BY EXECUTION** at the server: wrong-class, wrong-subject, wrong-teacher, and unauthenticated are all denied; admin bypass works with correct derived `teacherId`. **VERIFIED BY CODE INSPECTION** at the client: subjects listed come from `getClassSubjectsForTeacher(teacherId, class)`, so a teacher assigned Arabic in 5A but not 6A will not see Arabic under 6A. The "Teacher A sees Arabic not Tarbiya unless assigned" case is enforced by the same query and re-checked server-side.

---

## 11. Workbook Security

**VERIFIED (client CODE INSPECTION + server EXECUTION).** Identity is by Student ID only; changed/foreign Student ID, unauthorized subject/assessment headers, extra columns, and students from another class are rejected — client-side as hard errors and server-side as RPC denials. Server remains authoritative (the E2E "stale 5-A workbook containing a moved student" case is denied by the server).

---

## 12. Class Change / Stale Roster

**VERIFIED BY EXECUTION.** The E2E test moves a student into 5-A (appears in fresh roster, uploads fine), then moves them out to 7-C; a stale workbook still listing them under 5-A is **denied by the server** because the teacher is not assigned in the new class. Because the RPC re-runs full validation on confirm (§2), stale-roster protection does not depend on the preview.

**Stale-preview / concurrent-edit (audit #10):** the confirm path is **last-writer-wins** — it re-validates authorization but does **not** compare against the exact values shown in the preview. If another process changes a grade between preview and confirm, the teacher's confirm overwrites it without a "value changed since you previewed" warning. This is not a security defect (authorization is re-checked) but is a **data-integrity UX gap** worth noting. Severity: **LOW–MEDIUM**.

---

## 13. UI Verification

The app cannot boot without `VITE_SUPABASE_URL`/`ANON_KEY` (no `.env`), so the wizard was **not** clicked through in a browser by either the implementer or this audit. UI claims are supported by **code inspection + typecheck + build + unit tests only**. A passing `vite build` proves compilation, **not** correct in-browser wizard behavior (step gating, toasts, checkbox interaction, download). This should not be overstated.

---

## 14. Legacy Compatibility

The legacy `excel-parser.ts`, `db/bulk.ts`, and other upload surfaces (`admin/BulkUpload.tsx`, `teacher/UploadResults.tsx`) remain present and referenced; the new roster module lives alongside them under `src/lib/bulk-grades/`. `ASSESSMENT_DEFINITIONS` remains the single source of truth reused by both. All 676 tests (including pre-existing parser/legacy suites) pass. Backward compatibility of the *parser* is preserved; whether *every* historical grade file still round-trips through the new roster wizard was not exhaustively tested (the new wizard expects the class-specific roster workbook). Legacy upload paths still exist for older flows.

---

## 15. Remaining Issues

| # | Issue | Severity | Blocks production |
|---|---|---|---|
| 1 | RLS policies on `exams`/`class_subjects`/`students`/`grade_uploads` are **not behaviorally executed** — only the RPC is. The direct-table security boundary is unproven against live PostgREST. | HIGH | NO (with §16 conditions) |
| 2 | `exams` INSERT/UPDATE RLS `WITH CHECK` does **not constrain the `status` column**. A teacher with direct PostgREST access could in principle insert/update their own row with `status='approved'`, self-approving outside the RPC. **Pre-existing, not introduced by this feature** (the feature RPC always forces `status='pending'`). Exploitability unproven without live Supabase. | HIGH | NO — but should be validated/closed |
| 3 | Stale-preview / concurrent-edit at confirm is last-writer-wins with no "values changed since preview" guard (authorization is still re-validated). | MEDIUM | NO |
| 4 | UI not exercised in a browser; wizard behavior is inference from code + build. | MEDIUM | NO |
| 5 | "Different idempotency key, same records" path is not covered by a test (relies on the identity unique index to upsert). | LOW | NO |
| 6 | Harness base schema / `current_profile_*` / exam identity index are hand-copied; verified matching today but not guarded against future migration drift. | LOW | NO |
| 7 | Preview-no-write test asserts the target row is unchanged but does not assert `grade_uploads` stayed empty during preview. | INFO | NO |
| 8 | Final report's one-word **GO** does not carry its own §7 RLS/PostgREST caveat — mild overstatement. | INFO | NO |

---

## 16. Required Pre-Production Tests

Run these against a **live Supabase project with all migrations applied** before real teacher use:

1. **Behavioral RLS test as a teacher role** (`SET ROLE authenticated` + `request.jwt.claims`): attempt a **direct** `INSERT`/`UPDATE` into `exams` for (a) own class-subject, (b) another teacher's class-subject, (c) with `status='approved'`. Confirm (b) is denied and decide whether (c) self-approval must be blocked by a policy or trigger (Issue #2).
2. **Direct-table bypass probe** on `class_subjects`, `students`, `grade_uploads` as a teacher — confirm no unauthorized write path exists.
3. **Apply `20260908_bulk_grade_change_preview.sql` to the live DB** and re-run the preview/confirm/approved/idempotency scenarios end-to-end through the real client.
4. **Click-through the wizard** in a configured browser: all 7 steps, progress indicator, approved-ack checkbox gating, download filename (`Grade_5-A_Arabic_Tarbiya_Grades.xlsx`), protected ID/Name columns.
5. **Concurrent-edit test** (Issue #3): change a grade between preview and confirm; decide whether last-writer-wins is acceptable or a re-preview guard is required.
6. Confirm grants: `submit_bulk_grades` is executable by `authenticated` and revoked from `PUBLIC`/`anon`.

---

## 17. Final Go/No-Go

**APPROVE WITH CONDITIONS.**

The code is well-architected, correctly scoped to one class, subject-aware, roster-driven, and its server-side RPC security, atomicity, idempotency, and old→new preview are **genuinely proven by execution** against real PostgreSQL — a real and verified improvement. The single previously-blocking condition is legitimately closed at the RPC layer. The remaining gaps are **environment-verification** items (live RLS/PostgREST, browser UI) plus one **pre-existing** platform-hardening concern (unconstrained `status` on direct exam writes) that this feature does not introduce and, through its RPC, does not exercise.

Do **not** ship as an unqualified "GO." Ship after the §16 conditions — especially #1 and #2 — are executed against the live project.

---

## MOST IMPORTANT QUESTION — answered explicitly

> **Is the current implementation actually ready for the school to use for real teacher grade uploads, or is there still anything that could cause unauthorized grades, incorrect class/subject grades, accidental overwrites, stale-roster submissions, or misleading Review/Confirm behavior?**

**Through the intended wizard path, the feature is safe and ready pending live-environment verification.** Specifically:

- **Unauthorized grades / wrong class / wrong subject / wrong teacher:** Prevented — proven by execution at the RPC, which re-validates on both preview and confirm. ✅
- **Accidental overwrite of approved grades:** Surfaced (old→new, red section) and gated behind an explicit acknowledgement checkbox; on commit the grade correctly returns to `pending`. ✅
- **Stale-roster submissions:** Rejected server-side because the confirm path re-validates against current DB state. ✅
- **Misleading Review/Confirm behavior:** Change lists and counts come from the server's actual DB rows, not the workbook. ✅ (Browser interaction itself unverified — §13.)

**The residual risks are NOT in the wizard path:**
1. The **direct-table (PostgREST) boundary is unproven** in this environment (Issue #1) — a teacher client could attempt writes outside the RPC; the shipped RLS *appears* to stop unauthorized rows, but this must be **executed** against live Supabase before trusting it.
2. **`status` is not constrained on direct exam writes** (Issue #2, pre-existing) — a determined authenticated teacher with direct API access could potentially self-approve their own grades outside this feature. This should be validated and, if exploitable, closed with a policy/trigger.
3. **Concurrent-edit at confirm is last-writer-wins** (Issue #3) — no data loss of *authorization*, but a silently overwritten concurrent change is possible.

None of these block the feature's own workflow, but items 1 and 2 concern the wider database security posture and must be verified on the live project before the school relies on it. **Verdict: APPROVE WITH CONDITIONS.**
