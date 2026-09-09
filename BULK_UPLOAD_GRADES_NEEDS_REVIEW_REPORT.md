# Bulk Upload Grades — Needs Review Workflow

**Branch:** `arena/01a0804f-schoolnnnnass`
**Date:** 2026-09-08
**Scope:** Turn the existing legacy name-match cases that appeared under "Fix before submission" into a real, actionable **Needs Review** workflow, closely matching the existing **Student Class Update & Import** experience — without a second matching system, without redesigning the grade pipeline, and without weakening server authorization.

---

## Existing Behavior

- **Bulk Upload Grades resolver** (`src/lib/bulk-grades/resolve.ts`) matched student identity **only by Student ID**. It had exactly two non-valid buckets: `errors` and `excluded` (a `needsReview` category had previously been removed as always-empty).
- The **workbook parser** (`src/lib/bulk-grades/workbook.ts`) dropped any row that had a name but **no Student ID** as a blocking `MISSING_STUDENT_ID` error — so a legacy / name-only row never even reached the resolver, and its scores were discarded.
- The **Student Class Update & Import** flow (`src/lib/import/classImport.ts` + `src/pages/admin/ClassImport.tsx`) already implemented the desired pattern: per-row `status` (`ambiguous` = Needs Review) carrying `candidates[]`, candidate buttons ("… — use this student"), an "Exclude row" checkbox, and `resolveRowCandidate()` which **re-runs validation** when a candidate is chosen.

## What Was Changed

Single pipeline, reusing the Class Import pattern — no second matcher, no second upload path.

1. **Parser** (`workbook.ts`): a row with a name but no Student ID is no longer a hard error. It is surfaced to the resolver as a `WorkbookStudentRow` with `studentId: ''` plus a **warning** (`MISSING_STUDENT_ID`), carrying its scored cells. The roster-prefilled template always has IDs, so this only fires for legacy/edited workbooks.
2. **Resolver** (`resolve.ts`): added a real `reviews[]` / `reviewCount` category and a `decisions` input. Name-only rows are matched **by name against the current roster**:
   - ≥1 candidate → **Needs Review** (`ResolveReview` with `candidates`, `reason`, `message`), never auto-selected;
   - 0 candidates → **Error** ("No roster student matches legacy name …");
   - a `decisions[row]` of `{action:'use',studentId}` re-runs the **exact same** validation (roster membership, subject authorization, score, duplicate identity) and only then becomes Valid;
   - `{action:'exclude'}` moves the row to **Excluded** with no record.
3. **UI** (`src/pages/teacher/BulkUploadGrades.tsx`): the Resolve step now shows the 5 counts (Valid / Errors / Needs Review / Excluded / Students), an amber **Needs Review** panel with candidate "Use this student" buttons + "Exclude row", a "Reviewed rows" summary (with undo), a blocking message, and the **Validate** button is disabled while `reviewCount > 0`.

## Needs Review Classification Rules

| Situation | Category |
|---|---|
| Student ID → student in current class, authorized subject, valid score | **Valid** |
| Name-only row with ≥1 roster candidate | **Needs Review** |
| Name-only row with 0 roster candidates | **Error** |
| Student ID not in current class (stale/wrong class) | **Error** |
| Unauthorized subject / invalid assessment / invalid score | **Error** |
| Two workbook rows resolving to the same student/subject/assessment | **Error** |
| No score entered, or reviewer excluded the row | **Excluded** |

## Legacy Name Match Handling

`c/laahi cabdi xasan`, `Marwaan nuur maxamed`, and `Maxamed Cabdijabar Ibrahim` — when present only as a legacy/name-only row with a matching roster student — now land in **Needs Review** with a "could not be safely matched automatically (name-only match)" message and a candidate the reviewer explicitly confirms. They are **no longer** shown as errors.

## Candidate Selection

Candidates come from the **current roster** (the authoritative, class-scoped student list). One candidate → still requires an explicit "Use this student" click. Multiple same-name candidates → all shown under "Possible matches"; none pre-selected.

## Exclude Flow

"Exclude row" records `{action:'exclude'}`, the row moves to **Excluded**, produces no grade record, and stays visible in the "Reviewed rows" summary (with undo).

## Error Handling

Definitive, non-human-resolvable problems remain **Errors**: no roster candidate, unauthorized subject, stale/wrong class, invalid assessment/score, and duplicate identity. The "Fix before submission" (Errors) list is preserved for these.

## Duplicate Handling

Two rows resolving to the same student+subject+assessment+term remain an **Error** ("Keep one row or correct the Student ID; duplicate rows are not automatically chosen."). This includes the case where a manually chosen student collides with another row — caught by the same duplicate-identity check after selection.

## Server Security

Unchanged and authoritative. A manual selection just sets `studentId` on an otherwise-normal `BulkGradeRecord`; it flows through the **same** `submit_bulk_grades` RPC, which independently re-verifies authenticated actor → selected class → student's current class → subject → teacher/class/subject assignment → assessment → score, atomically, with idempotency. Manual review cannot upload a relationship the server rejects.

## Stale Roster

Proven both ways: (client) choosing a student not in the current roster becomes an Error; (server, executed) a manually-selected student who moved out of the class before confirm is still **rejected by the RPC** ("assigned class subjects"). Manual review does not weaken stale-roster protection.

## Old → New Preview

Unchanged. Once Needs Review = 0, the resolver → server preview → Review → Confirm path is identical; existing grades still show `14 → 17` with the old score sourced from the database.

## Approved Grade Protection

Unchanged. A manually resolved student whose existing grade is `approved 14` and uploaded `17` still surfaces `Approved → Pending`, `14 → 17`, and requires the acknowledgement checkbox before Confirm. Manual review does not bypass it (verified by the existing approved-overwrite DB tests, which run on the identical record shape).

## Tests

Resolver (`src/lib/__tests__/bulk-grades-resolve.test.ts`):
- **A/B** legacy name-only, one candidate → Needs Review (not Valid/Error)
- **C** multiple candidates → all shown, none auto-selected
- **D** "Use this student" → correct `studentId`, validation reruns → Valid
- **E** "Exclude row" → Excluded, no record
- **H** no candidate → remains Error
- **J (client)** choosing a student not in the roster → Error
- **I** duplicate identity after selection → Error
- **L** normal roster workbook (IDs) → zero reviews, all Valid
- **M** exact regression: `Maxamed Cabdijabar Ibrahim` / `Grade 11-A` / row 2 → actionable Needs Review, then resolves to Valid

Server (`src/lib/bulk-grades/__tests__/submit-bulk-grades.db.test.ts`, executed via PGlite):
- **J (server)** manually-selected student who moved out is still rejected by the RPC
- (existing) atomic rollback, idempotency, old→new preview, approved overwrite → pending, wrong class/subject/teacher denied

UI gating (**F/G**) is enforced by `canValidate` requiring `reviewCount === 0` and covered by the resolver `reviewCount` assertions.

## Test Results

- `npm run typecheck` → clean (exit 0)
- `npm run test:ci` → **700 passed / 700, 68 files, 0 failed** (was 690; +9 resolver Needs Review, +1 server J)
- `npm run build` → success (built in 11.36s)
- Targeted: bulk-grades-resolve (15), bulk-grades-workbook (15), submit-bulk-grades.db (16), classImport (47), bulkResolve (3) — all pass; **no regressions** in Student Class Import.

## Files Changed

- `src/lib/bulk-grades/workbook.ts` — name-only rows surfaced to the resolver (warning) instead of dropped.
- `src/lib/bulk-grades/resolve.ts` — `reviews[]`/`reviewCount`, `ResolveReview`/`ResolveCandidate`/`ReviewDecision`, name-candidate matching, decision re-validation.
- `src/pages/teacher/BulkUploadGrades.tsx` — Needs Review UI (candidate buttons, exclude, reviewed-rows summary, blocking), `reviewDecisions` state, Validate gated on `reviewCount === 0`.
- `src/lib/__tests__/bulk-grades-resolve.test.ts` — 9 new tests (A–M).
- `src/lib/bulk-grades/__tests__/submit-bulk-grades.db.test.ts` — server stale-roster-after-manual-selection test (J).

## Remaining Risks

- **Name matching is exact-normalized** (case/punctuation/whitespace-insensitive) against roster names; a legacy spelling variant with no exact roster name match yields **0 candidates → Error** (safe, but the reviewer must correct the ID). Fuzzy matching was intentionally not added to avoid a second matching system.
- **UI not exercised in a live browser** here (no Supabase env); UI is covered by typecheck + build + the resolver/DB unit tests. Behavior is enforced by pure functions the UI renders directly.

## Final Verdict

**Implemented and verified.** Legacy rows such as `c/laahi cabdi xasan`, `Marwaan nuur maxamed`, and `Maxamed Cabdijabar Ibrahim` are now placed into a genuine, actionable **Needs Review** state where the reviewer can **select the correct student** or **exclude the row**; definitive problems ("no roster match", duplicate records, unauthorized subject, stale/wrong class) remain **Errors**; and every resolved record continues through the **exact same authoritative `submit_bulk_grades` server validation and submission pipeline** — one pipeline, one matcher, one class at a time.

> **Answer to the acceptance question:** Yes. A legacy row like `c/laahi cabdi xasan`, `Marwaan nuur maxamed`, or `Maxamed Cabdijabar Ibrahim` can be placed into an actionable Needs Review state (choose the correct student or exclude the row), while "no roster match" and duplicate records remain Errors, and all resolved records still pass through the identical authoritative server validation and submission pipeline.
