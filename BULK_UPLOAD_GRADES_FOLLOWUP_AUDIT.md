# Bulk Upload Grades — Follow-up Verification Audit

**Auditor:** Independent senior QA / security / database engineer
**Scope:** Verification-only. No code, schema, migration, or data was changed.
**Commit audited:** `ff97d99` (branch `arena/01a0804f-schoolnnnnass`)
**Method:** Read the report + actual source, re-ran the test/type/build pipeline,
and executed **ephemeral** probe tests (created, run, deleted — repo left clean)
to exercise tamper/stale/authorization paths. The live PostgreSQL database was
**not reachable** in this environment (no `psql`, no `.env`, no running Supabase),
which materially limits what can be proven — see §12.

---

# Executive Verdict

## APPROVE WITH CONDITIONS

The implemented client + workbook layer is genuinely good and matches most of
the report. The **server RPC that actually enforces security already existed and
was reused correctly** — that is the right architecture. The report is largely
honest (it does *not* falsely claim per-record old→new display, for example).

However, three things prevent an unconditional APPROVE:

1. **The database security assertions were never executed against PostgreSQL**,
   and the SQL "tests" are *static text matchers*, not behavioral RLS tests. Every
   server-enforcement claim is therefore **verified by code-reading only**, not by
   execution. (Blocks production? **NO** — but must be run before go-live.)
2. **The Review step shows only aggregate counts, not the `14 → 17` per-record
   old→new comparison** the original spec (§12/§CONFIRMATION SCREEN) calls for.
   The server preview RPC does not return existing values, so this cannot be shown
   today. (Blocks production? **NO**, but it is a spec gap and a UX/safety miss.)
3. **Approved-grade overwrite is silent-by-policy**: an approved grade is
   overwritten and reset to `pending` with only a generic banner; there is no
   per-record "this is approved" flagging or extra gate. (Blocks production? **NO**,
   but should be an explicit product decision, not a default.)

None are hard security holes; the server still authorizes every write. They are
completeness/verification gaps against the stated requirements.

---

## 1. Claims Verified

| Claim | Evidence |
|---|---|
| **One class at a time; no multi-class selection** | `selectedClass` is a single `string`; class buttons are single-select; roster query is `.in('className', [selectedClass])`. No array/multi-select anywhere. ✅ |
| **Teacher sees only subjects for that class** | UI loads `getClassSubjectsForTeacher(session.userId, selectedClass)` (filtered by `teacherId` AND `className`). ✅ (teacher path) |
| **Roster-prefilled; Student IDs supplied by app** | `buildRosterWorkbook` writes `student.id`/`student.name` into rows from the roster; grade cells blank. ✅ |
| **Selected assessment blocks only** | `buildGradeColumns(subjects, blocks)` emits only chosen subject×block columns. ✅ |
| **Single workbook = 2 sheets (Instructions + Grades)** | Only two `book_append_sheet` calls. ✅ |
| **Multi-word subjects resolve correctly** | Probe: `parseGradeColumnHeader('Social Studies MT')` → `{subjectName:'Social Studies', block:MT}`. ✅ |
| **Akhlaaq isolation per subject** | `Arabic Akhlaaq`/`Tarbiya Akhlaaq` produce distinct `subjectId`-scoped records (unit test + probe). ✅ |
| **Single assessment-definition source** | `assessments.ts` derives everything from `ASSESSMENT_DEFINITIONS`; RPC hard-codes the *same* maxima (HW=5, CPW=15, Att=20, MT=20, Akhlaaq=10). ✅ (values match) |
| **blank ≠ zero; Absent/N-A distinct** | `interpretScoreCell`: `''→blank`, `'0'→scored 0`, `Absent→absent`, `N/A→not_applicable`. Shared by both parsers. ✅ |
| **Legacy fixed-block parser still works** | `excel-parser.test.ts` 8/8 pass; `parseScore` now delegates to `interpretScoreCell` with identical messages. ✅ |
| **Stale/wrong-class rejected client-side** | Probe: outsider ID not in roster → 0 records, error raised. ✅ (client mirror) |
| **Duplicate student rows detected** | Probe: `DUPLICATE_STUDENT_ROW` raised. ✅ |
| **Renamed column / added row detected** | Existing tests + probe confirm `UNKNOWN_COLUMN` / `MISSING_STUDENT_ID`. ✅ |
| **Class-change resets incompatible subjects** | `chooseClass` clears `selectedSubjectIds` + downstream state. ✅ |
| **Minimal DB fetching (no whole-school)** | 2 parallel calls on load, 2 parallel on class select; roster scoped to one class. ✅ |
| **658 tests / typecheck / build pass** | Re-ran: **65 files, 658 tests passed**, `tsc --noEmit` clean, `vite build` OK. ✅ |

## 2. Claims Partially Verified

| Claim | Why partial |
|---|---|
| **"Server side already covered the security requirements"** | The RPC code *does* re-derive actor, student's current class, teacher/class/subject binding, maxima, term/month/date, duplicates, atomic upsert, idempotency. But this is **verified by reading `20260802_bulk_grade_integrity.sql`, not by executing it** against a DB. Correct-by-inspection ≠ proven. |
| **"Stale roster … server reject"** | Client mirror proven by probe. Server rejection is present in RPC source (`students.className` join) but **not executed**. |
| **"Historical grades are not rewritten by class changes"** | True for the *class-import* RPC (separate feature). The bulk-grade RPC only upserts on the bulk identity key; it does not touch other rows — verified by reading the single `INSERT … ON CONFLICT`. Not executed. |
| **"Atomic commit"** | The RPC is one `plpgsql` function with a single loop inside one implicit transaction and an idempotency ledger; design is atomic. Not executed to prove rollback-on-error. |
| **Admin path subject authorization** | For `role='admin'`, the UI calls `getClassSubjectsForTeacher('', class)` which returns **all** subjects assigned to the class (no teacher filter). This is intended (admins upload for any teacher's subject), and the RPC still binds to the assigned teacher — but it means "teacher sees only their subjects" applies to the teacher role only. |

## 3. Incorrect / Misleading Claims

| Item | Finding |
|---|---|
| Report §"Existing Grade Overwrites" implies a satisfactory review | It is **accurate** that only counts are shown (report says `insertCount`/`updateCount`), so not a *false* claim — but it **does not meet** the original spec's `Existing / New` (`14 → 17`) requirement. Classified as **Missing Functionality (§4)**, not a lie. |
| Report §"Tests" lists "manually-added-row (missing ID) detection" etc. | All verified true. No incorrect test claims found. |
| No claim was found to be outright **INCORRECT**. | — |

## 4. Missing Functionality

1. **Per-record old→new overwrite preview (`14 → 17`).** *(Medium)*
   The spec's Review/Confirm screen requires showing each changing grade's
   existing vs new value. The RPC preview returns only `insertCount`/`updateCount`;
   no existing scores are returned, and the UI shows only count cards + a generic
   banner. A teacher cannot see *which* grades change or by how much.
2. **`Needs Review` category is dead.** *(Low)*
   `resolveResult.needsReview` is declared and surfaced in the UI counts but is
   **never populated** — it is always `0`/empty. Either wire it up or remove it.
3. **Approved-grade protection is generic.** *(Medium)*
   Approved grades are overwritten and silently reset to `pending`; there is no
   per-record "approved" flag in the review and no separate confirmation gate, so
   the "make the consequences clear / follow approval rules" requirement is only
   partially met (one shared banner line).
4. **No behavioral server test executed** (see §12).

Everything else in the requested workflow (class → subjects → term/month/date →
blocks → download → enter → upload → resolve/validate → review → confirm) is
**implemented**.

## 5. Security Findings

- **S1 — SEV: Medium — DB enforcement unproven.** `supabase/tests/rls-bulk-grades.sql`
  is a **static-text audit** (`pg_get_functiondef` + `position()`), not a
  privilege/behavior test, and there is no evidence it (or the RPC) ran against
  PostgreSQL. *Why it matters:* the prior review history in this repo explicitly
  warns that static assertions ≠ database behavior. *Fix:* run the migrations on a
  Supabase instance and execute a behavioral RLS test (two teachers, cross-class
  and cross-subject attempts) plus this file. **Blocks production? NO** (the code is
  correct-by-inspection) **but required before go-live sign-off.**
- **S2 — SEV: Low — Client authorization is a mirror only.** Correct by design;
  the server is authoritative. No action beyond keeping it that way.
- **No security regression found.** Teacher cannot inject teacherId/parentId/
  approval/max via Excel — none are read from the file; the RPC derives them.

## 6. Authorization Findings

- **Teacher → Class → Subject model is respected.** RPC re-derives the assigned
  teacher from `class_subjects` joined on the *student's current* `className` and
  rejects `v_teacher_id <> v_actor_id`. ✅ (by inspection)
- **A2 — SEV: Low — `LIMIT 1` on the teacher lookup.** The RPC does
  `SELECT "teacherId" … WHERE className=… AND subjectId=… AND teacherId IS NOT NULL
  LIMIT 1`. This is **only deterministic because** migration
  `20260906c_student_write_security.sql` adds `uniq_class_subjects_active`
  UNIQUE(`className`,`subjectId`) and de-dupes existing rows. *Risk:* if that
  migration is **not applied** in an environment, duplicate `(class, subject)` rows
  with different teachers make authorization non-deterministic (a co-teacher could
  be picked). *Fix:* confirm `20260906c` is applied in every target DB; consider
  matching on `teacherId = v_actor_id` directly rather than `LIMIT 1`.
  **Blocks production? NO** if `20260906c` is confirmed applied.

## 7. Workbook Findings

- Exactly two sheets (`Instructions`, `Grades`); one class only. ✅
- Grades sheet: `Student ID`, `Student Name`, then only selected `<Subject> <Block>`
  columns. ✅
- **W1 — SEV: Info — Cell "read-only" is advisory.** The report already discloses
  that the community `xlsx` writer does not persist cell protection, so ID/name
  columns are not truly locked in Excel. Mitigated server-side. Acceptable and
  disclosed.
- Header parsing is robust: block token = last word; subject = the rest, so
  multi-word subjects survive; unknown tokens → `UNKNOWN_COLUMN`. ✅

## 8. Validation Findings

- Client resolve enforces: identity via `students.id` only; current-roster
  membership; subject authorization; per-upload duplicate key; blank exclusion. ✅
- Score range/decimal/negative rejection lives in the shared `interpretScoreCell`
  and is exercised by both parsers + tests. ✅
- **V1 — SEV: Low — Term/month/date validated server-side but the client
  restricts month to the term's configured months only if present.** Adequate; the
  RPC independently checks `date ∈ [term.start, term.end]` and month∈term.months.
  ✅ (by inspection).

## 9. Grade Overwrite Findings

- Preview distinguishes insert vs update counts and blocks commit until confirm. ✅
- **Missing per-record old→new** (see §4.1). The `14 → 17` example in the original
  brief and echoed in the report's own narrative is **not** shown to the user.

## 10. Stale Roster Findings

- Client: proven — a student no longer in the roster yields an error and no record
  (probe). ✅
- Server: RPC reads `students.className` live and binds authorization to it, so a
  moved student fails server-side too — **by inspection, not executed.**

## 11. Class Change Integration

- Roster is always re-queried live per selected class, so `7-A → 7-B` moves flow
  into the next template and out of the old one. ✅ (logic verified; full
  import→roster→upload chain not run end-to-end against a DB).
- Bulk-grade RPC does not modify `students` or other grades — no historical
  rewrite. ✅ (by inspection)

## 12. Database Verification

**NOT EXECUTED.** No `psql`, no `.env`, no running Supabase (`config.toml` points
at `127.0.0.1:54322`, nothing listening). Therefore:

- `supabase/tests/rls-bulk-grades.sql` — **NOT RUN** (and is static-text anyway).
- `submit_bulk_grades` behavioral authorization — **NOT RUN**.
- RLS policies on `exams` / `class_subjects` — **NOT RUN**.
- Atomic rollback, idempotency ledger, upsert conflict — **NOT RUN**.

All server-side claims are **VERIFIED BY CODE READING ONLY**. This is the single
biggest verification gap and the primary condition of approval.

## 13. Test Verification

- `npm run test:ci` → **65 files, 658 tests, all passed** (matches report).
- `npm run typecheck` → clean.
- `npm run build` → success (~12–13s).
- New tests: `bulk-grades-workbook.test.ts` (15), `bulk-grades-resolve.test.ts`
  (6) = 21 new; legacy `excel-parser` (8) + `bulk-grades` (2) unchanged and green.
- Ephemeral auditor probes (7) all passed, then removed; `git status` clean.

## 14. Performance

- Workbook build & validation operate on a single ~40-student roster. ✅
- 2 parallel queries on mount, 2 on class-select; no whole-school fetch. ✅
- One RPC round-trip for preview, one for commit. ✅
- Roster limit is `10_000` but scoped to one class, so effectively small. ✅

## 15. UX Findings

- 7-step indicator with safe backward navigation (can't skip forward). ✅
- Changing class/subject/blocks/month/date calls `resetDownstream()`, clearing a
  stale server preview so users can't confirm outdated validation. ✅
- Empty states handled: no classes, no subjects, no current term. ✅
- **U1 — SEV: Low — `Needs review` count is always 0** (dead category); mildly
  misleading. **U2 — SEV: Low —** error list truncates at 50 with "…and N more",
  fine, but there is no per-cell location link in the resolve view (cells are in
  the parse errors though).

---

## 16. Required Fixes

| # | Severity | Issue | Evidence | Why it matters | Required fix | Blocks prod? |
|---|---|---|---|---|---|---|
| 1 | **High (process)** | DB security assertions never executed | No psql/DB; SQL file is static-text matcher | "Server enforces X" is unproven; prior repo reviews warn against this exact gap | Apply migrations to a Supabase DB; run a **behavioral** RLS/RPC test (cross-teacher, cross-class, cross-subject, tampered payload) + the SQL file | **NO**, but mandatory before go-live |
| 2 | Medium | No per-record `old → new` overwrite preview | Review step shows only counts; RPC preview returns no existing values | Spec explicitly requires `14 → 17` visibility; teachers can't see what changes | Extend RPC preview to return existing scores for updates; render a diff table | NO |
| 3 | Medium | Approved-grade overwrite is generic/silent | RPC sets `status='pending'` on conflict; UI shows one banner | Requirement: follow approval rules & make consequences clear per record | Flag approved records in review; require explicit acknowledgement | NO |
| 4 | Low | `Needs review` category never populated | `needsReview` always empty | Misleading count | Wire it up or remove the card | NO |
| 5 | Low | `LIMIT 1` teacher lookup relies on `20260906c` | RPC + `uniq_class_subjects_active` | Non-deterministic auth if dedupe migration absent | Confirm migration applied; prefer `teacherId = v_actor_id` match | NO (if migration confirmed) |

---

# FINAL GO / NO-GO

### 1. Does one selected class show only the subjects THIS teacher teaches in THAT class?
**YES** for the teacher role (server-filtered by teacherId+className). For admins, all class subjects show by design.

### 2. Does the generated workbook contain only that class's students?
**YES** — roster query is scoped `.in('className', [selectedClass])`; workbook has one Grades sheet.

### 3. Does the teacher never need to manually enter Student IDs?
**YES** — IDs/names are prefilled from `students.id`/`students.name`.

### 4. Can Arabic + Tarbiya be uploaded for the same class in one workbook?
**YES** — multi-subject columns build and resolve to distinct `subjectId`s.

### 5. Are HW1–HW4, CPW1–CPW4, Attendance, MT, and per-subject Akhlaaq correctly validated?
**YES** (client + shared definitions). Server maxima match. Server enforcement **verified by inspection, not executed.**

### 6. Can a tampered workbook bypass server-side authorization?
**NO — by inspection.** Identity/class/subject/teacher are all re-derived server-side; the file is never trusted. **Not proven by execution** (see §12).

### 7. Does a stale workbook fail safely after a student changes class?
**YES client-side (proven by probe); server-side by inspection.**

### 8. Can an existing grade be changed safely with a visible old → new review?
**PARTIAL — NO for `old → new`.** Change is safe and gated, but only aggregate counts are shown, not per-record `14 → 17`. (Gap #2.)

### 9. Does Arabic Akhlaaq remain separate from Tarbiya Akhlaaq?
**YES** — separate `subjectId`-scoped records (test + probe).

### 10. Does the feature still work for a simple one-class/one-subject upload?
**YES** — verified via unit tests/probes; legacy parser also intact.

### 11. Were the database security assertions actually executed against a PostgreSQL database?
**NO.** No DB available; the SQL file is static-text only. **NOT VERIFIED.**

### 12. Is every major claim in the implementation report actually verified?
**NO — most are; server-side claims are inspection-only, and the `old → new` review expectation is unmet.**

---

# FINAL DECISION

## GO — conditional (equivalent to APPROVE WITH CONDITIONS)

The client, workbook, parser, and resolution layers are correct, well-tested
(658 green), type-safe, and build cleanly, and they correctly reuse the existing
server-authoritative RPC without adding multi-class support. There is **no
demonstrated security hole.**

Before production, the following **must** be satisfied (none require redesign):

1. **Execute** the migrations + a **behavioral** server authorization test (and
   `rls-bulk-grades.sql`) against a real PostgreSQL/Supabase instance, covering
   cross-teacher, cross-class, cross-subject, stale-roster, tampered-payload,
   approved-overwrite, atomic-rollback, and idempotency cases. Until then, all
   server-enforcement claims remain **NOT VERIFIED (by execution)**.
2. Confirm migration `20260906c` (`uniq_class_subjects_active`) is applied in
   every target environment so the RPC's `LIMIT 1` teacher lookup is deterministic.

Recommended (not blocking): add per-record `old → new` overwrite preview and
explicit approved-grade acknowledgement; remove or populate the dead
`Needs review` category.

*No code was modified during this audit; `git status` is clean.*
