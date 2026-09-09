# PR #39 + PR #40 — Bulk Upload Grades Integration Fix Report

**Role:** implementation + release engineering (follow-up to the independent audit in `PR39_VS_PR40_BULK_UPLOAD_GRADES_AUDIT.md`).
**Scope:** strictly Bulk Upload Grades. Shared code touched only where it feeds the bulk-upload path (`excel-parser.ts::interpretScoreCell`).
**Date:** 2026-09-09

| Ref | SHA |
|---|---|
| `main` (base of both PRs, unchanged) | `e2e9832` |
| PR #39 head | `297a806` |
| PR #40 head | `072ead4` |
| Integration branch `arena/01a0867d-schoolnnnnass` | `380c992` (merge of PR #40 + PR #39, doc conflicts resolved) → `72a0238` (fixes) → report commit |

The branch contains both PR heads as ancestors (`git merge-base --is-ancestor` = yes for both), so merging it merges PR #39 and PR #40 together with the reconciliation.

---

## Executive Summary

**What was wrong (combined state, each PR fine alone):**

1. PR #39's XLSX round-trip test hard-coded the pre-PR #40 header text (`English HW1`); PR #40 emits `ENGLISH HW1` with `Student Name` first → **4 failing tests** after both merge.
2. Both PRs added `BULK_UPLOAD_FLAT_HEADER_HALF_POINT_FIX_REPORT.md` and `BULK_UPLOAD_FLAT_HEADER_INDEPENDENT_AUDIT_REPORT.md` with different bodies → **add/add Git conflict** in either merge order.
3. PR #40's expected-column check compared raw header strings, so a workbook using DB subject names (`Mathematics HW1`) was rejected as *missing `MATH HW1` + unexpected `Mathematics HW1`* although the parser understands the alias.
4. Two copies of the half-step score rule (`scores.ts`, `excel-parser.ts`).
5. Hidden roster metadata identifies same-name students by row position; the Instructions sheet did not say so.
6. Stale `public/BulkUploadExample.xlsx` (legacy fixed-block layout) shipped in `dist/` although the page generates its template at runtime.

**What was fixed (commit `72a0238`):** all six, without changing the PR #40 workbook format, without weakening any assertion, and without touching GradeQuizzes / manual entry / parent portal / reports.

**Result on the committed branch:** `typecheck` ✅ · `test:ci` ✅ 842/842 (0 skipped) · `build` ✅ · real XLSX + OOXML ✅ · real DB-backed bulk upload ✅ · `git merge-tree` vs `main`, PR #39, PR #40: **0 conflicts**.

---

## PR #39 Interaction (F-1)

`src/lib/__tests__/half-point-scores.test.ts` → `describe('real XLSX round trip with half-point scores')` filled the generated workbook with `header.indexOf('English HW1')`.

**Fix (test only, production untouched):** the helper now resolves a column through the production header parser:

```ts
function findColumn(header: string[], wanted: string): number {
  const target = parseGradeColumnHeader(wanted);           // → { subjectName: 'English', block: HW1 }
  return header.findIndex(h => {
    const parsed = parseGradeColumnHeader(h);
    return !!parsed && parsed.subjectName === target.subjectName && parsed.block.label === target.block.label;
  });
}
```

So the test follows the workbook *contract* (canonical subject + assessment) instead of one casing, and reuses the existing normalisation instead of duplicating it. The "numeric cell" test additionally asserts the current contract explicitly: `header[0] === 'Student Name'` and `header[c] === 'ENGLISH HW1'`. All original assertions remain: 4.5 / 12.5 / 3.5 / 17.5 exact, `not.toBe(4)` / `not.toBe(12)`, cell type `n`, untouched cells blank (never 0), 4.25 and 15.5/15 → `INVALID_SCORE`. File result: **19/19**.

## PR #40 Interaction (F-3, alias-aware expected columns)

`src/lib/bulk-grades/workbook.ts::detectExpectedColumnIssues` now keys both the expected columns (from `buildGradeColumns`) and the actual headers (via `parseGradeColumnHeader`, which already applies `subjectOrder.ts`'s alias table) by `gradeColumnKey(canonicalSubject, assessmentLabel)` — the same key the parser already used for `DUPLICATE_COLUMN`. No second alias table was introduced.

| Header in workbook | Selected subject | Result |
|---|---|---|
| `Mathematics HW1` / `MATH HW1` / `Math HW1` / `Maths HW1` | Mathematics | ✅ accepted → `Math / HW1` |
| `Social Studies CPW1` / `SOCIAL CPW1` | Social Studies | ✅ → `Social / CPW1` |
| `Tarbiya MT` / `TARABIYA MT` | Tarbiya | ✅ → `Tarabiya / MT` |
| `RandomSubject HW1` | Mathematics | ❌ `UNEXPECTED_COLUMN` |
| `Mathematics HW1` + `Maths HW1` | English, Arabic (Math not selected) | ❌ `UNEXPECTED_COLUMN "Mathematics HW1"` + `DUPLICATE_COLUMN "Maths HW1"` |
| `Mathematics HW1` present, `MATH HW2` expected | Mathematics (HW1, HW2) | ❌ `MISSING_EXPECTED_COLUMN "MATH HW2"` only |

**Security preserved:** normalisation only identifies the intended column. `resolveWorkbook` still reports `unauthorizedSubjects: ['Math']` for every spelling when the teacher is not assigned Math, and `submit_bulk_grades` still rejects with `Teachers may upload only their assigned class subjects.` (proved in the DB test with the client bypassed).

## Duplicate half-point rule (F-4)

`excel-parser.ts::interpretScoreCell` now calls `parseScoreInput` from `src/lib/scores.ts` for the half-step check; the local `HALF_STEP_SCORE` regex was removed. Blank / `Absent` / `N/A` markers are still intercepted before that call, so the `blank` outcome is unchanged and `parseScoreInput`'s `null`-for-blank never leaks into `not_half_step`. `scores.ts` imports nothing → no cycle. Bulk Upload and manual entry now share one definition.

## Same-name row order (F-5)

The generated workbook **does** use row-position metadata (`__RosterMetadata`: `[Visible Row, Student ID, Student Name]`, matched on row number + normalised name). Added Instructions line 8:

> Do NOT sort or reorder the student rows. Rows are identified by their original position; if two students share the same name, keep them in the original row order or their grades may be attached to the wrong student.

No identity redesign; unique-name rows that are reordered still fall to Needs Review (tested).

## Stale static example (F-6)

`public/BulkUploadExample.xlsx` was referenced only by `excel-parser.test.ts` (legacy `parseExcel`, which no UI imports); `BulkUploadGrades.tsx` builds its template with `buildRosterWorkbook`. Moved to `src/lib/__tests__/fixtures/legacy-fixed-block-template.xlsx`; `dist/` no longer ships it (`dist/`: `index.html`, `logo.png`).

## Documentation Conflicts (F-2)

Resolved in merge commit `380c992`:

| File | Resolution |
|---|---|
| `BULK_UPLOAD_FLAT_HEADER_HALF_POINT_FIX_REPORT.md` | PR #40 version kept (describes the shipped flat-header contract) |
| `BULK_UPLOAD_FLAT_HEADER_INDEPENDENT_AUDIT_REPORT.md` | PR #40 version kept |
| PR #39's fix report | preserved verbatim as `MANUAL_ENTRY_HALF_POINT_SCORES_FIX_REPORT.md` with a header note that its XLSX sections describe the pre-PR #40 layout; its manual-entry content (`scores.ts`, `UploadResults.tsx`, `gradeCorrectionUtils.ts`) is still accurate |

`git grep '^<<<<<<< \|^>>>>>>> '` over `*.ts *.tsx *.md *.sql` → no matches.

---

## Bulk Upload Behavior (combined, committed branch)

`src/lib/bulk-grades/__tests__/pr39-pr40-integration.db.test.ts` (12 tests, real PGlite with the repo harness: `includeStatusGuard + includeGradeCorrection + includeHalfPoints` = migrations 20260908 → 20260909 → 20260910 → 20260911 NUMERIC RPC):

```
XLSX (buildRosterWorkbook, PR #40 format, real bytes)
 → parseRosterWorkbook(bytes, { expectedSubjects, expectedBlocks })   ← exactly what BulkUploadGrades.tsx passes
 → resolveWorkbook (identity, authorization, duplicates)
 → submit_bulk_grades(records, key, false)   preview: row count unchanged
 → submit_bulk_grades(records, key, true)    confirm: insertCount 9
 → exams                                     score::text checked
```

## Half-Point Verification

`SELECT "subjectId","assessmentLabel","examType",score::text,total FROM exams WHERE "studentId"='MBK-7001'` after confirm:

| subject | assessment | examType | `score::text` | total |
|---|---|---|---|---|
| eng | HW1 | Homework | **4.5** | 5 |
| eng | HW2 | Homework | **3.5** | 5 |
| eng | CPW1 | Classwork | **12.5** | 15 |
| eng | CPW2 | Classwork | **11.5** | 15 |
| eng | ATTENDANCE | Attendance | **19.5** | 20 |
| ara | HW1 | Homework | **4.5** | 5 |
| ara | CPW1 | Classwork | **14.5** | 15 |
| ara | MT | Quiz | **17.5** | 20 |
| tar | AKHLAAQ | Discipline | **9.5** | 10 |

All `status='pending'`, `teacherId=uploadedBy='teacherA'`, `parentId` derived from the roster. Update path: approved `12` → `12.5` requires `requiresConfirmation` + `requiresApprovedAcknowledgement`, preview leaves `12`, confirm stores `'12.5'` and resets status to `pending`.

**Invalid scores** — `4.25`, `12.25`, `5.5/5`, `15.5/15`, `20.5/20`, `10.5/10`: 6 × `INVALID_SCORE` at the parser; each denied by the RPC (plus tampered `total=6` and `MT` as `Midterm`); direct `INSERT … 4.25` fails `exams_score_entry_state_check`. **Atomicity:** `[4, 4.5, 5.5]` → error `whole or half`, 0 rows. **Idempotency:** same key + same payload → identical result, no extra rows; same key + different payload → `already used`.

## Security

| Attempt | Result |
|---|---|
| `status:'approved'`, `teacherId/uploadedBy:'teacherB'`, `parentId:'parent1'` in payload | stored `pending`, `teacherA`, `teacherA`, `null` |
| subject `math` (assigned to teacher B) | `Teachers may upload only their assigned class subjects.` |
| student from Grade 8-A | denied |
| teacher B (8-A English) → 7-A student | denied |
| parent / anonymous preview | denied |
| `Mathematics HW1` / `Maths HW1` / `MATH HW1` / `Math HW1` column for a teacher without Math | resolver `unauthorizedSubjects: ['Math']`, 0 records |
| tampered `total`, `examType` | `do not match the approved template` |

## Identity

- Unchanged template rows → IDs recovered from hidden metadata (`MBK-7001…7004`), 0 reviews.
- Name-only sheet (no IDs): 5 rows → `studentId: null` for all, **no** `DUPLICATE_STUDENT_ROW`, **0 records auto-assigned**; reviews: exact unique name → 1 candidate, `Hodan Warsame` ×2 → 2 candidates each, `Axmed Cabdi Hassan` → only `MBK-7002`, `Nobody Real` → hard error.
- Both Hodan rows decided to the same student → `Duplicate HW1` after identity; correct decisions → 6 records; same student across HW1/HW2 or English/Arabic is not a duplicate.
- Fully reordered template (unique names) → all `null` → Needs Review, 0 records.

## Real XLSX (fresh, from the final branch, 7 subjects × 11 blocks)

| Check | Observed |
|---|---|
| Sheets (`xl/workbook.xml`) | `Instructions`, `Grades`, `__RosterMetadata state="veryHidden"` |
| Columns | 78 = `Student Name` + 7 × 11 |
| Header order | `Student Name, ENGLISH HW1 … ENGLISH Akhlaaq, MATH …, SCIENCE …, SOCIAL …, SOMALI …, ARABIC …, TARABIYA MT, TARABIYA Akhlaaq` |
| `mergeCell` / `dataValidation` / `sheetProtection` / `<f>` in `sheet2.xml` | 0 / 0 / 0 / 0 |
| `B2` after entering 4.5 | `<c r="B2"><v>4.5</v></c>` (numeric, no `t` attr) |
| `F2` after entering 12.5 | `<c r="F2"><v>12.5</v></c>` |
| untouched `C2` | `t="str"` empty string (blank, not 0) |
| `scripts/verify-bulk-upload-flat-header.ts` | exit 0; `englishHw1 4.5, englishCpw1 12.5, mathHw2 3.5, arabicMt 17.5, socialAttendance 19.5, tarabiyaAkhlaaq 9.5` |

---

## Tests (exact results, run on the committed branch)

Run 1 — working tree at `72a0238`:
```
$ npm run typecheck        → tsc --noEmit, exit 0
$ npm run test:ci          → Test Files 76 passed (76) | Tests 842 passed (842) | exit 0
$ npm run build            → dist/index.html 5,789.99 kB, ✓ built, exit 0
```
Run 2 — **clean detached worktree of commit `72a0238`** (no scratch files, node_modules symlinked):
```
$ npx tsc --noEmit                      → exit 0
$ npx vitest --run --reporter dot       → Test Files 76 passed (76) | Tests 842 passed (842) | exit 0
$ npx vite build                        → ✓ built in 15.59s, exit 0; dist/ = index.html, logo.png
```
Targeted:
```
half-point-scores.test.ts                         19 passed
bulk-grades-workbook.test.ts (+13 alias tests)    passed
bulk-grades-resolve.test.ts (+5 alias/auth tests) passed
excel-parser.test.ts                              9 passed
pr39-pr40-integration.db.test.ts                  12 passed
```
Skips: the only `describe.skip` / `it.skip` in the bulk suites are the pre-existing `if (!pgliteAvailable)` guards; PGlite is importable in this environment, so every DB suite executed (0 skipped in the summary).

Baselines for comparison: PR #39 alone 799 pass; PR #40 alone 794 pass; PR #40 + PR #39 before this fix **4 failed** / 809 pass.

## Merge Verification

```
$ git merge-tree --write-tree HEAD origin/main            → exit 0, 0 CONFLICT
$ git merge-tree --write-tree HEAD refs/arena-audit/pr39  → exit 0, 0 CONFLICT
$ git merge-tree --write-tree HEAD refs/arena-audit/pr40  → exit 0, 0 CONFLICT
$ git merge-tree --write-tree refs/arena-audit/pr39 HEAD  → exit 0
$ git merge-tree --write-tree refs/arena-audit/pr40 HEAD  → exit 0
$ git grep -n '^<<<<<<< \|^>>>>>>> ' -- '*.ts' '*.tsx' '*.md' '*.sql'   → (no matches)
$ git status --short                                       → clean (scratch audit-tmp/ deleted, not tracked)
```

## Files in this PR (beyond the two PR heads)

| File | Change |
|---|---|
| `src/lib/bulk-grades/workbook.ts` | alias-aware expected-column comparison (`gradeColumnKey`); Instructions row-order warning |
| `src/lib/excel-parser.ts` | `interpretScoreCell` delegates half-step rule to `scores.ts` |
| `src/lib/__tests__/half-point-scores.test.ts` | column lookup via `parseGradeColumnHeader`; asserts flat-header contract |
| `src/lib/__tests__/bulk-grades-workbook.test.ts` | +13 alias / unknown / unauthorized-alias / duplicate cases |
| `src/lib/__tests__/bulk-grades-resolve.test.ts` | +5 alias-authorization cases |
| `src/lib/bulk-grades/__tests__/pr39-pr40-integration.db.test.ts` | new, 12 DB-backed combined-state tests |
| `src/lib/__tests__/excel-parser.test.ts` + `fixtures/legacy-fixed-block-template.xlsx` | fixture relocated from `public/` |
| `MANUAL_ENTRY_HALF_POINT_SCORES_FIX_REPORT.md` | PR #39 report preserved (conflict resolution) |
| `PR39_VS_PR40_BULK_UPLOAD_GRADES_AUDIT.md`, this file | audit + fix reports |

Not changed: workbook format, `submit_bulk_grades`, migrations, RLS, `BulkUploadGrades.tsx`, GradeQuizzes, UploadResults, parent portal, reports.

## Remaining non-blocking notes

- Same-name students are still distinguished by row position when the template is used as downloaded (inherent to hiding IDs; now documented in the Instructions sheet). A per-row hidden token would remove even that dependency — out of scope here.
- `GradeQuizzes.tsx` still uses `parseInt` (out of scope, untouched by all three PRs).

## PR URL

**https://github.com/viniliaice/schoolnnnnass/pull/41** — `fix: reconcile PR #39 and PR #40 bulk upload grades` (branch `arena/01a0867d-schoolnnnnass` → `main`; contains #39 + #40 + fixes).

## GitHub status checks on PR #41

| Check | Result | Note |
|---|---|---|
| Vercel Preview Comments | ✅ pass | |
| Vercel | ❌ failure | Message from Vercel: *"Git author arena-agent must have access to the project on Vercel to create deployments."* This is a Vercel team-permission condition on the commit author, not a build failure — `vite build` passes on this exact commit (`✓ built`, exit 0), and #39/#40 (authored by `viniliaice`) deployed fine. Resolution is outside the repository: grant the `arena-agent` GitHub user access to the Vercel project, or have a Vercel member re-author/merge. The commit author was deliberately not spoofed. |

## FINAL VERDICT

```
GO WITH CONDITIONS
```

**Code / tests / merge state: clean (no Critical/High/Medium open).** The single condition is external to the code: the Vercel preview-deployment status on PR #41 fails because the commit author (`arena-agent`) is not a member of the Vercel project. Once that permission is granted (or the PR is merged by a Vercel member), nothing else stands between this branch and `main`.
