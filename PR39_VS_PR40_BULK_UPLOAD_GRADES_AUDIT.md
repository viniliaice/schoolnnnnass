# PR #39 vs PR #40 — Bulk Upload Grades Compatibility Audit

**Auditor:** independent third auditor (did not trust Agent 1 / Agent 2 reports; every claim below was re-derived from source, generated XLSX bytes, raw OOXML, and a real Postgres engine).
**Scope:** strictly the **Bulk Upload Grades** feature (class → authorized subjects → term → month → date → blocks → download example → enter → upload → parse → identity → Needs Review → validate → preview → confirm → `submit_bulk_grades` → `exams`). Manual Upload Results, GradeQuizzes, Admin Grade Correction, Parent Portal, reports and student management are OUT OF SCOPE and only mentioned where shared code touches bulk upload.
**Date:** 2026-09-09

| Ref | SHA | Notes |
|---|---|---|
| `main` (merge base of both PRs) | `e2e983267e97044e3246d5a70e4acdaa3bbbc848` | PR #35 merge |
| PR #39 head (“Accept half-point scores (4.5, 12.5) in manual grade entry”) | `297a806cc2d2d8c882424ce3bd3b7eaf6cdf44b5` | base = main |
| PR #40 head (“fix: remediate bulk upload audit findings”) | `072ead490de8f12e1cef8a0a0eae0bc753f84cdc` | base = main |
| Combined state audited (PR40 + PR39 merged locally) | `33eb628` (local worktree `/home/user/audit-wt/combined`) | source-file merge is clean; two markdown reports collide (see §4) |

---

## 1. Executive Verdict

### **VERDICT: GO WITH CONDITIONS**

Within the Bulk Upload Grades feature the two PRs are **functionally compatible**: the combined build compiles, type-checks, and the real XLSX → parser → resolver → `submit_bulk_grades` → `exams` pipeline stores half points exactly, enforces the score rules, and keeps every security guard. **But the combination is not clean as-is**, and it must not be declared GO merely because each PR passes alone:

1. **HIGH (interaction bug — combined-only test failure).** PR #39's new test `src/lib/__tests__/half-point-scores.test.ts` (“real XLSX round trip with half-point scores”, 4 tests) hard-codes the **old** workbook layout (`Student ID | Student Name | English HW1 …`). PR #40 changes the generated workbook to `Student Name | ENGLISH HW1 …`. Each PR passes alone (PR39 799/799, PR40 794/794); the merged tree fails **4 tests** with `missing column "English HW1": expected -1 to be greater than -1`. CI on `main` would go red the moment the second PR lands. This is a **test-only** conflict — the production code paths in the combined tree are correct — but a red `main` is a blocking condition.
2. **HIGH (Git conflict, non-source).** Both PRs add `BULK_UPLOAD_FLAT_HEADER_HALF_POINT_FIX_REPORT.md` and `BULK_UPLOAD_FLAT_HEADER_INDEPENDENT_AUDIT_REPORT.md` with different content → `git merge-tree` reports **add/add CONFLICT** in both orders. Whichever PR merges second will show “conflicts” on GitHub and cannot be merged with the button until resolved. No source files overlap.
3. **MEDIUM (PR #40 behaviour that PR #39's test also exposes).** PR #40's `expectedSubjects` check in the UI is case-insensitive but **alias-unaware**: a workbook whose headers use the DB subject name (e.g. `Mathematics HW1`, exactly what the base template emitted) is rejected with `MISSING_EXPECTED_COLUMN "MATH HW1"` + `UNEXPECTED_COLUMN "Mathematics HW1"`. Any teacher holding a template downloaded before PR #40 (for a subject with an alias: Mathematics/Maths, Social Studies, Tarbiya) will have it rejected. The rejection is *safe* (nothing is written, message tells them to re-download) but it is a workflow regression that should be a conscious release note.

**Conditions for GO (all must be met before both PRs are on `main`):**
- **C1.** Update PR #39's `half-point-scores.test.ts` round-trip helper to locate columns case-insensitively / by PR #40's uppercase headers (a 3-line change — verified in §13: with that change the file passes 19/19 in the combined tree). Alternatively rebase PR #39 onto PR #40 and fix there.
- **C2.** Resolve the two add/add markdown report conflicts (keep one or rename).
- **C3.** Release note / decision on old-template rejection (MEDIUM above). Not a code blocker if intentionally accepted.

No CRITICAL findings. No data-corruption, truncation, privilege-escalation, or atomicity break was found in the combined state.

---

## 2. PR #39 changes (bulk-upload-relevant only)

| File | Type | Bulk-upload relevance | Risk |
|---|---|---|---|
| `src/lib/scores.ts` (new, 65 lines) | new module: `parseScoreInput`, `parseScoreWithin`, `isScoreTextInvalid`, `isHalfStep`, `formatScore` | **Indirect.** Not imported by any bulk-upload module (`workbook.ts`, `resolve.ts`, `assessments.ts`, `excel-parser.ts`, `db/bulk.ts`, `BulkUploadGrades.tsx`). Regex `^\d+(?:\.[05])?$` is identical to `excel-parser.ts` `HALF_STEP_SCORE`. Verified equivalent on 28 probes (§6). | LOW (duplicate rule, consistent) |
| `src/pages/admin/gradeCorrectionUtils.ts` | replaces local `isHalfStep` with re-export from `scores.ts` | none (admin correction; out of scope) | — |
| `src/pages/teacher/UploadResults.tsx` | `parseInt` → `parseScoreInput`, `step=0.5` | none (manual entry; out of scope) | — |
| `src/lib/__tests__/half-point-scores.test.ts` (new, 213 lines) | 19 tests; the last `describe` builds a **real workbook via `buildRosterWorkbook`** and edits it by header name `English HW1`, `English CPW1`, `Math HW2`, `Arabic MT` | **Direct.** Locks in the *old* header casing/layout. | **HIGH in combination** (fails after PR #40) |
| `BULK_UPLOAD_FLAT_HEADER_*_REPORT.md` ×2 | docs | none | Git add/add conflict with PR #40 |

PR #39 adds **no migration** and does not touch `submit_bulk_grades`, `exams`, RLS, or the workbook/parser/resolver.

## 3. PR #40 changes (bulk-upload-relevant only)

| File | Type | Bulk-upload relevance | Risk |
|---|---|---|---|
| `src/lib/bulk-grades/workbook.ts` (+294/−) | **rewrite of generation and parsing**: flat header `Student Name` (col A) + `<SUBJECT UPPER> <Block>`; no `Student ID` column; hidden (`veryHidden`) `__RosterMetadata` sheet `[Visible Row, Student ID, Student Name]`; new `parseRosterWorkbook(buf, {expectedSubjects, expectedBlocks})` producing `MISSING_EXPECTED_COLUMN` / `UNEXPECTED_COLUMN`; ID recovery from metadata when `(row number, normalized name)` both match; otherwise `studentId: null` → Needs Review | **Direct — the core of the feature** | MEDIUM (alias-unaware expected check; identity by row position for same-name twins — see §8) |
| `src/lib/bulk-grades/subjectOrder.ts` | canonical subject aliases (Mathematics→Math, Social Studies→Social, Tarbiya→Tarabiya), `workbookSubjectHeader()` = UPPERCASE | Direct (header text) | LOW |
| `src/lib/bulk-grades/resolve.ts` (4 lines) | message wording only (“Correct the Student ID” → “Correct the student identity”) | Direct, cosmetic | none |
| `src/pages/teacher/BulkUploadGrades.tsx` (18 lines) | passes `expectedSubjects: selectedSubjects.map(s => s.name)`, `expectedBlocks: selectedBlocks` to the parser; copy text | Direct | see MEDIUM |
| `src/lib/__tests__/bulk-grades-workbook.test.ts`, `-resolve.test.ts`, `-subject-order.test.ts`, `e2e-teacher-scenario.db.test.ts`, `pgHarness.ts` (exports + `office` role) | tests updated to new format | Direct | — |
| `scripts/verify-bulk-upload-flat-header.ts` | standalone script; ran in combined tree: exit 0, parsedIssues `[]`, half points 4.5/12.5/3.5/17.5/19.5/9.5 preserved | Direct | — |
| `supabase/migrations/20260912_report_rpc_remediation.sql` | redefines `assert_can_view_student_term_report`, `get_monthly_report`, `get_midterm_report`, `get_final_report` only | **None** for bulk upload (no `exams` DDL, no `submit_bulk_grades`, no RLS/policy changes — verified by grep) | none |
| `src/lib/db/reports.ts`, `reports.test.ts`, `report-rpcs.db.test.ts`, docs | reports | out of scope | — |
| `BULK_UPLOAD_FLAT_HEADER_*_REPORT.md` ×2, `BULK_UPLOAD_AUDIT_REMEDIATION_REPORT.md` | docs | none | Git add/add conflict with PR #39 |

## 4. Direct PR comparison / overlapping-file analysis

```
$ comm -12 <(git diff --name-only e2e9832 pr39 | sort) <(git diff --name-only e2e9832 pr40 | sort)
BULK_UPLOAD_FLAT_HEADER_HALF_POINT_FIX_REPORT.md
BULK_UPLOAD_FLAT_HEADER_INDEPENDENT_AUDIT_REPORT.md

$ git merge-tree --write-tree pr40 pr39   → exit 1
CONFLICT (add/add): Merge conflict in BULK_UPLOAD_FLAT_HEADER_HALF_POINT_FIX_REPORT.md
CONFLICT (add/add): Merge conflict in BULK_UPLOAD_FLAT_HEADER_INDEPENDENT_AUDIT_REPORT.md
(same in the reverse order; zero src/ conflicts)
```

- **Git-level:** zero overlapping *source* files; two overlapping *markdown* files with different bodies → hard conflict, whichever order. (GitHub currently shows both as `MERGEABLE/CLEAN` only because each is compared against `main` alone.)
- **Semantic-level:** PR #39's test is coupled to PR #40's production file (`workbook.ts`) via `buildRosterWorkbook` output. That coupling is the interaction bug. There is **no** semantic coupling in the other direction: PR #40's code never imports `scores.ts`; the bulk pipeline continues to use `excel-parser.ts::interpretScoreCell`.
- **Score rule duplication (§34):** after the merge there are two client-side half-step validators (`scores.ts` regex and `excel-parser.ts` regex) plus the server regex in `20260911` (`^[0-9]+(\.[05])?$`). All three are textually the same rule; probe-equivalence proven in §6. No divergence today, but a future edit to one will not be caught by the other — recorded as LOW.

## 5. Interaction risks (combined-only)

| # | Risk | Evidence | Severity | Result |
|---|---|---|---|---|
| I-1 | PR39 round-trip test vs PR40 header format | 4 failing tests in combined `test:ci` (exact output §11) | **HIGH** | Confirmed |
| I-2 | Markdown add/add conflicts | `git merge-tree` both orders | HIGH (process) | Confirmed |
| I-3 | Two score validators diverge | probe equivalence, 28 inputs | LOW | Not occurring |
| I-4 | PR39 `scores.ts` alters bulk parsing | `grep` — no bulk module imports it | none | Not occurring |
| I-5 | PR40 migration `20260912` alters bulk RPC / `exams` | grep for `submit_bulk_grades`, `ALTER TABLE`, `INTEGER` in the file → none | none | Not occurring |
| I-6 | PR40 `pgHarness` change (`office` role, exported helpers) breaks PR39 DB tests | PR39 adds no DB test; all base DB tests pass in combined | none | Not occurring |
| I-7 | Old (pre-PR40) templates rejected by PR40 expected-column check | §7 test “OLD format with Mathematics” | MEDIUM (PR40 alone; surfaced by PR39's test) | Confirmed |

## 6. Half-Point Verification (combined state, `score::text`)

Real XLSX written to disk (`/tmp/audit-combined/half.xlsx`) from the combined `buildRosterWorkbook`, read back from disk, parsed **with the UI's `expectedSubjects/expectedBlocks` options**, resolved, previewed, then confirmed through the real `submit_bulk_grades` (PGlite with migrations 802 → 906b → 908 → 909 → 910 → 911 → 912 applied in order):

```
COMBINED DB ROWS (SELECT ... score::text):
s-ara CPW1 Classwork  '15'   /15   s-eng CPW1 Classwork  '12.5' /15
s-ara HW1  Homework   '0.5'  /5    s-eng CPW2 Classwork  '11.5' /15
s-ara MT   Quiz       '0'    /20   s-eng HW1  Homework   '4.5'  /5
s-eng AKHLAAQ Discipline '9.5' /10 s-eng HW2  Homework   '3.5'  /5
s-eng ATTENDANCE Attendance '19.5' /20   s-eng MT Quiz '17.5' /20
all: status=pending, teacherId=uploadedBy=caller, parentId server-derived
```

- Valid set 4 / 4.5 / 5 / 12 / 12.5 / 15 / 0 / 0.5 accepted; invalid 4.25, 12.25, 5.5/5, 15.5/15, 20.5/20, tampered total 6, `MT` as `Midterm` all rejected server-side (§9).
- `parseScoreInput` (PR39) vs `interpretScoreCell` (bulk path) agree on all 28 probes: `0 0.5 1 3.5 4 4.5 5 5.5 12 12.5 14.5 15 15.5 17.5 19.5 20.5 9.5 10.5 4.25 12.25 -0.5 abc 1e0 Infinity "4,5" 4.50 " 4.5 " ""` (scientific notation, comma decimals, negatives, `4.50` rejected by both).
- Truncation grep in bulk code (`parseInt|Math.floor|Math.trunc|Math.round|toFixed|::INTEGER|::int`) over `src/lib/bulk-grades/**`, `src/lib/excel-parser.ts`, `src/lib/db/bulk.ts`, `BulkUploadGrades.tsx`, `20260911`, `20260912`: **no truncating call on a score**. (`parseInt` remains only in `UploadResults.tsx`→ removed by PR39, and `GradeQuizzes.tsx` — OUT OF SCOPE, unchanged by both PRs.)
- DB: `exams.score` is `NUMERIC` (20260911); CHECK `(score*2)=floor(score*2)`; direct insert of 4.25 rejected by the constraint.

## 7. End-to-End Verification (combined workbook)

Fresh download (`/tmp/audit-combined/fresh.xlsx`, 2 subjects × 11 blocks, roster of 4 incl. two identical names):

| Item | Observed |
|---|---|
| Sheets | `Instructions`, `Grades`, `__RosterMetadata` (Hidden = 2 → `state="veryHidden"`) |
| Header row | `Student Name, ENGLISH HW1 … ENGLISH HW4, ENGLISH CPW1 … CPW4, ENGLISH Attendance, ENGLISH MT, ENGLISH Akhlaaq, ARABIC HW1 … ARABIC Akhlaaq` (23 cols). No `Student ID` column. |
| Subject ordering | canonical order regardless of selection order (passed `[Arabic, English]`, got English first) |
| Block ordering | canonical HW1-4, CPW1-4, Attendance, MT, Akhlaaq regardless of selection order |
| Row 2 | `Axmed Cabdi` + 22 blank strings (blank ≠ 0) |
| Metadata | `[Visible Row, Student ID, Student Name]`, `[2, MBK-7001, Axmed Cabdi]` … `[5, MBK-7004, Hodan Warsame]` |
| Merges / data validation / protection / formulas | none / none / none / 0 |

Parser/resolver behaviour in the combined tree (all with UI options unless stated):

| Scenario | Result |
|---|---|
| Header mapping | 22 columns → `English/Arabic` × {HW1-4→Homework/5, CPW1-4→Classwork/15, ATTENDANCE→Attendance/20, MT→**Quiz**/20, AKHLAAQ→Discipline/10}; resolver binds to `s-eng`/`s-ara` |
| Column reorder (swap HW1/HW2, move Akhlaaq to col B) | header-bound: every value stays with its block (11 distinct values verified) |
| Delete `ENGLISH CPW3` | `MISSING_EXPECTED_COLUMN "ENGLISH CPW3"` error; no shift. Without UI options: partial upload accepted, still header-bound (CPW4=13, Att=14, MT=15, Akhlaaq=9.5) |
| Duplicate header `ENGLISH HW1` ×2 / `English hw1` | `DUPLICATE_COLUMN` error; second column ignored (no last-write-wins) |
| `ENGLISH TEST99` | `UNKNOWN_COLUMN` error |
| `UnknownSubject HW1` | `UNEXPECTED_COLUMN` (UI); without options → resolver `unauthorizedSubjects=['UnknownSubject']` error |
| Injected `MATH HW1` (teacher not assigned Math) | parser `UNEXPECTED_COLUMN`; resolver `not authorized to upload "Math"`; server `Teachers may upload only their assigned class subjects.`; 0 rows written |
| Old format, canonical names (`Student ID, Student Name, English HW1`) | **accepted** (check is case-insensitive; ID column honoured) |
| Old format, DB alias names (`Mathematics HW1`) with UI options | **rejected**: `MISSING_EXPECTED_COLUMN "MATH HW1"` ×2 + `UNEXPECTED_COLUMN` ×2 (MEDIUM). Without options → resolves to `s-math` 4.5/12.5 correctly |

## 8. Identity (combined state)

| Case | Result |
|---|---|
| Unchanged template rows | IDs recovered from metadata for all 4 rows (incl. the two identical names); 0 reviews; records `[7001 4.5],[7002 3.5],[7003 2.5],[7004 1.5]` |
| Pasted roster (no metadata): unique exact name | Needs Review with 1 candidate — **never auto-committed** |
| Two identical names `Hodan Warsame` | Needs Review with 2 candidates each |
| Similar name `Axmed Cabdi Hassan` vs `Axmed Cabdi` | only the exact student offered; no fuzzy match |
| Case/space variant `Axmed  cabdi` | exact match after normalisation → 1 candidate (review) |
| No match `Nobody Real` | hard error row 6 |
| Blank Student ID rows (6 of them) | **no** `DUPLICATE_STUDENT_ROW` false positive; `studentId: null` for all |
| Duplicate detection after identity | resolving rows 3&4 → same student → `Duplicate HW1` error; rows 2&7 → same → error; fixing decisions → 0 errors, 4 records |
| Same student, different assessment / different subject | not duplicates (3 records) |
| Full sort by name (with twins) | all 4 → `null` → Needs Review; 0 records (safe) |
| Swap only the two same-name rows | IDs assigned by **visible row position** (7003 gets the row-4 score, 7004 the row-5 score). This is inherent: once IDs are hidden, row order is the only discriminator for identical names — equivalent to a teacher swapping two ID cells in the old format. Documented as LOW/INFO; not introduced by the combination. |
| Tampered metadata ID (`MBK-9999`) | resolver error naming `MBK-9999` (verified in earlier PR40-only run) |

## 9. Security (combined state, real RPC)

| Check | Result |
|---|---|
| Client-supplied `status: 'approved'`, `teacherId`, `uploadedBy`, `parentId` | ignored; stored `pending`, caller id, caller id, roster-derived `parentId` |
| Teacher uploading a subject not assigned to them | `Teachers may upload only their assigned class subjects.` |
| Teacher uploading a student of another class | rejected |
| Other-class teacher uploading this class | rejected |
| Parent / anonymous calling preview | rejected |
| Admin | allowed |
| Idempotency | same key + same payload → identical result, no extra rows; same key + different payload → `… already used …` |
| Atomicity | batch of 4, 4.5, 5.5 → error, 0 rows written |
| Overwrite 12 → 12.5 on an approved row | preview `requiresConfirmation=true`, `requiresApprovedAcknowledgement=true`, `existingScore 12 → newScore 12.5`; after confirm `score='12.5'`, status back to `pending` |
| RLS / grants | unchanged by both PRs; `20260912` only touches report functions (REVOKE PUBLIC / GRANT authenticated) |

## 10. Migration interaction

- Order applied in test: `20260802` → `20260906b` → `20260908` → `20260909` → `20260910` → `20260911` → `20260912`. All apply cleanly on PGlite.
- `20260911` (already on `main`) owns `exams.score NUMERIC`, the half-step CHECK, and the current `submit_bulk_grades`. PR #39 adds nothing; PR #40's `20260912` does not reference `exams` DDL or `submit_bulk_grades` → **no migration interaction** for bulk upload.

## 11. Test results (exact output, combined tree `33eb628`)

```
$ npx tsc --noEmit                      → exit 0
$ npm run test:ci  (vitest --run --reporter dot)
 FAIL  src/lib/__tests__/half-point-scores.test.ts > real XLSX round trip with half-point scores > parses half points back out with the exact same numeric values
AssertionError: missing column "English HW1": expected -1 to be greater than -1
 FAIL  … > stores half points as real numeric Excel values (not text)          (same assertion)
 FAIL  … > leaves untouched cells blank rather than 0                          (same assertion)
 FAIL  … > rejects a quarter point and an over-maximum score in the workbook   (same assertion)
 Test Files  1 failed | 76 passed (77)
      Tests  4 failed | 846 passed (850)
$ npm run build (vite build)            → exit 0  (dist/index.html 5,789.67 kB, ✓ built in 16.15s)
$ npx tsx scripts/verify-bulk-upload-flat-header.ts → exit 0, parsedIssues [] , half points intact
$ npx vitest --run audit-tmp/combined-bulk-upload.test.ts → 18 passed (18)   [this audit's probes]
$ npx vitest --run audit-tmp/half-point-scores.fixed.test.ts → 19 passed (19) [PR39 test with C1 fix]
```

Per-PR baselines (each alone): PR39 `tsc` 0, vitest 74 files / 799 passed; PR40 `tsc` 0, 794 passed; `main` 73 files / 780 passed. *(The earlier combined run counted 809 passed; the final run above is 846 because my scratch test files were present in the tree — the 4 failures are identical in both runs.)*

Skipped tests: none in the bulk-upload suites. My probe suite includes no `skip`.

## 12. Findings

| ID | Severity | Where | Finding | Recommendation |
|---|---|---|---|---|
| F-1 | **HIGH** | PR39 `src/lib/__tests__/half-point-scores.test.ts` × PR40 `workbook.ts` | Combined-only failure: 4 tests look up `English HW1` (Title-case, old layout); PR40 emits `ENGLISH HW1`. Passes in each PR alone, fails once both land. | Change `fillWorkbook` to match headers case-insensitively (`header.map(h => h.toUpperCase())`, `columnHeader.toUpperCase()`), and the `indexOf('English HW1')` at line ~193 likewise. Verified: 19/19 pass in combined with that change. |
| F-2 | **HIGH (process)** | both PRs | add/add conflict on two markdown reports | Delete/rename in one PR before merging the second. |
| F-3 | MEDIUM | PR40 `workbook.ts::detectExpectedColumnIssues` + `BulkUploadGrades.tsx` | Expected-header check normalises case/whitespace but not subject aliases. Old templates (or teacher-typed headers) using the DB name `Mathematics`, `Social Studies`, `Tarbiya` are rejected as missing/unexpected although the parser itself maps them correctly. Safe failure, but a workflow regression for any pre-PR40 template. | Either compare on `workbookSubjectName()` of both sides, or document “re-download templates after release”. Not a merge blocker. |
| F-4 | LOW | PR39 `scores.ts` vs `excel-parser.ts` | Two client-side copies of the half-step rule (identical today). | Have `interpretScoreCell` call `parseScoreInput` or vice-versa in a follow-up. |
| F-5 | LOW/INFO | PR40 identity | Same-name students are identified by visible row position via hidden metadata; swapping only those two rows silently swaps their grades. Inherent to hiding IDs; equivalent to swapping IDs in the old format; unique-name rows are safe (fall to Needs Review). | Optional: warn in Instructions sheet not to sort rows; or include a per-row hidden token column. Out of the interaction scope. |
| F-6 | INFO | `public/BulkUploadExample.xlsx` | Stale static example (old grouped-header layout, `Grades` sheet only) still shipped in `dist/`; the UI download button uses `buildRosterWorkbook`, and only `excel-parser.test.ts` references the static file. Not wired into the bulk flow. | Housekeeping. |
| F-7 | INFO (out of scope) | `GradeQuizzes.tsx` | still uses `parseInt` — untouched by both PRs, not part of bulk upload. | Report only. |

## 13. Combined-State Verification summary

| Step | Result |
|---|---|
| `git merge` PR40 + PR39 (source) | clean; docs conflict (F-2) |
| `tsc --noEmit` | ✅ exit 0 |
| `vitest --run` | ❌ 4 failed / 846 passed — all 4 = F-1 |
| `vite build` | ✅ exit 0 |
| Targeted: PR40 verify script | ✅ |
| Targeted: PR39 test with C1 fix applied (scratch copy) | ✅ 19/19 |
| Real XLSX → DB (combined workbook format, real RPC) | ✅ all half points exact (`score::text`) |
| This audit's 18 combined probes | ✅ 18/18 |

Scratch evidence kept (untracked, not for commit): `audit-tmp/combined-bulk-upload.test.ts`, `audit-tmp/half-point-scores.pr39-fixed-for-pr40.test.ts` in the repo root; XLSX fixtures in `/tmp/audit-combined/`.

## 14. Final Acceptance Matrix (combined state)

| # | Item | Status | Evidence |
|---|---|---|---|
| 1 | Half-point HW (4.5 / 3.5 / 0.5 of 5) | ✅ PASS | DB `'4.5' '3.5' '0.5'` |
| 2 | Half-point CPW (12.5 / 11.5 of 15) | ✅ PASS | DB `'12.5' '11.5'` |
| 3 | DB storage (NUMERIC, `score::text`, CHECK half-step) | ✅ PASS | §6 |
| 4 | XLSX parsing (real file from disk, numeric cells) | ✅ PASS | §6/§7 |
| 5 | Header mapping (22 headers → subject/block/type/total) | ✅ PASS | §7 |
| 6 | Assessment mapping (HW→Homework/5, CPW→Classwork/15, Attendance/20, MT→Quiz/20, Akhlaaq→Discipline/10) | ✅ PASS | §7, server label table |
| 7 | Subject mapping (ENGLISH→s-eng, ARABIC→s-ara, MATH alias→s-math) | ✅ PASS (⚠ F-3 for old alias headers under UI check) | §7 |
| 8 | Blank Student ID (no false duplicates, Needs Review) | ✅ PASS | §8 |
| 9 | Needs Review (never auto-commit; 1/2 candidates; decisions applied) | ✅ PASS | §8 |
| 10 | Duplicate detection (after identity; not across assessment/subject) | ✅ PASS | §8 |
| 11 | Unauthorized subject (parser + resolver + server) | ✅ PASS | §7/§9 |
| 12 | Wrong class (server) | ✅ PASS | §9 |
| 13 | Preview no-write | ✅ PASS | row count unchanged after preview |
| 14 | Confirm commit | ✅ PASS | 10 rows, pending |
| 15 | Idempotency (same key same payload / different payload rejected) | ✅ PASS | §9 |
| 16 | Atomicity | ✅ PASS | §9 |
| 17 | MT mapping (Quiz/20, `Midterm` rejected) | ✅ PASS | §6/§9 |
| 18 | Security (status/teacherId/parentId tamper, roles, RLS unchanged) | ✅ PASS | §9 |
| 19 | Combined tests (`test:ci`) | ❌ FAIL — 4 tests (F-1) | §11 |
| 20 | Build (`vite build`) | ✅ PASS | §11 |

**Result: 19/20 pass; item 19 fails only because of PR #39's format-coupled test. → GO WITH CONDITIONS (C1, C2 mandatory; C3 advisory).**
