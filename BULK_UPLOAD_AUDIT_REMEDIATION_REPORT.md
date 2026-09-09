# BULK UPLOAD AUDIT REMEDIATION REPORT

## Verdict

**GO**

Repository-shipped remediation for both original conditions is now implemented and independently verified in code, tests, workbook execution, and DB-backed report execution.

---

## Scope closed

- **A1 fixed:** missing expected grade columns are now explicitly detected from the same canonical column-definition path used to generate the downloadable workbook.
- **A2 fixed:** repo-shipped SQL now exists for `get_monthly_report` and `get_final_report`, and report decimal behavior is verified end-to-end. The midterm/report-path `MT` compatibility gap was also fixed so uploaded `MT` rows are treated as midterm, not CA.

---

## AUDIT FINDINGS

### AUDIT FINDING A1
Before remediation, `src/lib/bulk-grades/workbook.ts` parsed whatever recognizable grade headers existed, but it did **not** explicitly fail when expected template columns were physically missing.

### REMEDIATION APPLIED A1
Implemented canonical structural validation in `src/lib/bulk-grades/workbook.ts`:

- added `ParseRosterWorkbookOptions`
- parser now accepts `expectedSubjects` + `expectedBlocks`
- expected headers are derived via **`buildGradeColumns()`** (same canonical source as workbook generation)
- added explicit structural issue codes:
  - `MISSING_EXPECTED_COLUMN`
  - `UNEXPECTED_COLUMN`
  - `DUPLICATE_COLUMN`
- preserved header-based parsing
- kept blank-but-present columns structurally valid
- kept `Student Name` mandatory
- kept identity review separate from structural workbook errors

UI wiring was updated in `src/pages/teacher/BulkUploadGrades.tsx` so the real teacher upload flow passes the selected subjects/blocks into parser validation.

Decision: **missing expected columns are blocking errors**, not warnings. This matches the current workflow because parse errors block advancement to server validation.

### AUDIT FINDING A2
Before remediation, `src/lib/db/reports.ts` called `get_monthly_report` and `get_final_report`, but the repository had **no shipped SQL definitions** for those RPCs. Additionally, bulk-uploaded `MT` data is stored as `examType='Quiz'` + `assessmentLabel='MT'`, while shipped midterm SQL only looked for `examType='Midterm'`.

### REMEDIATION APPLIED A2
Added `supabase/migrations/20260912_report_rpc_remediation.sql`.

This migration:

- adds repo-shipped `get_monthly_report`
- adds repo-shipped `get_final_report`
- replaces `get_midterm_report`
- adds `assert_can_view_student_term_report`
- uses `class_for_term()` / `class_students_for_term()` for historical class-aware peer groups
- preserves decimal math with numeric calculations and explicit 2-decimal rounding
- excludes `assessmentLabel='MT'` from monthly CA and final-report CA aggregation
- includes bulk-uploaded `MT` rows in midterm/final midterm calculations

Client fallback logic in `src/lib/db/reports.ts` was also updated so the existing JS fallback treats `Quiz + MT` as midterm.

---

## Files changed

- `src/lib/bulk-grades/workbook.ts`
- `src/pages/teacher/BulkUploadGrades.tsx`
- `src/lib/db/reports.ts`
- `src/lib/__tests__/bulk-grades-workbook.test.ts`
- `src/lib/__tests__/reports.test.ts`
- `src/lib/bulk-grades/__tests__/pgHarness.ts`
- `src/lib/bulk-grades/__tests__/report-rpcs.db.test.ts`
- `supabase/migrations/20260912_report_rpc_remediation.sql`
- `docs/how-tos/generate-reports.md`
- `scripts/verify-bulk-upload-flat-header.ts`

---

## Independent evidence

### Workbook execution artifact
Generated and executed:

- `.tmp-audit/verify-bulk-upload-flat-header-output.json`

Confirmed from real XLSX generation + parse round-trip:

- one visible flat header row
- `Student Name` first
- no merged subject headers
- no duplicate headers
- canonical subject order
- real half-point values parsed unchanged:
  - `englishHw1 = 4.5`
  - `englishCpw1 = 12.5`
  - `mathHw2 = 3.5`
  - `arabicMt = 17.5`
  - `socialAttendance = 19.5`
  - `tarabiyaAkhlaaq = 9.5`

### DB-backed end-to-end proof
`src/lib/bulk-grades/__tests__/report-rpcs.db.test.ts` executes the real flow on PGlite:

1. build workbook
2. fill real XLSX cells
3. parse with canonical expected-contract validation
4. resolve student/subject/assessment
5. preview with real `submit_bulk_grades`
6. commit with real `submit_bulk_grades`
7. verify stored `exams` rows
8. execute real `get_monthly_report`
9. execute real `get_midterm_report`
10. execute real `get_final_report`

Verified values for student `S1 / English`:

- workbook/parser: `HW1 = 4.5`, `CPW1 = 12.5`, `MT = 17.5`
- resolved records: `studentId='S1'`, `subjectId='english'`, correct labels/types/totals
- server preview: correct new records returned
- DB rows:
  - `HW1` stored as `4.5`
  - `CPW1` stored as `12.5`
  - `MT` stored as `17.5` with `examType='Quiz'`
- monthly report:
  - `average = 86.67`
  - `HW1 percentage = 90`
  - `CPW1 percentage = 83.33`
  - `MT` correctly excluded from monthly CA details
- midterm report:
  - `score = 17.5`
  - `percentage = 87.5`
  - `class_average = 75.83`
- final report (seeded `report_config = 30/30/40` for deterministic proof):
  - `ca_avg = 86.67`
  - `ca_weighted = 26.00`
  - `midterm_score = 87.5`
  - `midterm_weighted = 26.25`
  - `final_score = 85`
  - `final_weighted = 34.00`
  - `total = 86.25`

Historical class behavior was also exercised: after moving `S1` to current class `Grade 6-A`, the term report still used the original `Grade 5-A` peer group via enrollment history.

---

## 12 critical audit questions

| # | Question | Answer | Evidence |
|---|---|---|---|
| 1 | Is the workbook structure generated from one canonical contract? | **YES** | `buildGradeColumns()` is used for both generation and expected-column validation in `src/lib/bulk-grades/workbook.ts`. |
| 2 | Are physically missing expected grade columns explicitly detected? | **YES** | `MISSING_EXPECTED_COLUMN` added and covered by tests for first/middle/last/multiple missing columns. |
| 3 | Are missing expected columns blocking, not silently accepted? | **YES** | They are emitted as parse `error`s; `BulkUploadGrades.tsx` blocks progression when parse errors exist. |
| 4 | Are blank-but-present columns treated as structurally present? | **YES** | `bulk-grades-workbook.test.ts` covers blank-but-present columns with no missing-column error. |
| 5 | Is `Student Name` still mandatory? | **YES** | Missing/renamed header produces `MISSING_HEADER`; covered by test. |
| 6 | Are duplicate and unknown/unauthorized headers still explicit? | **YES** | `DUPLICATE_COLUMN`, `UNKNOWN_COLUMN`, and `UNEXPECTED_COLUMN` are emitted and tested. |
| 7 | Does parsing remain header-based rather than positional? | **YES** | Reordered-column test passes without errors; mapping still resolves by header text. |
| 8 | Is the correct student identity preserved and kept separate from Needs Review? | **YES** | Hidden metadata still resolves `studentId`; missing IDs remain `MISSING_STUDENT_ID` warnings, separate from structural errors. |
| 9 | Are the correct subject and assessment preserved end-to-end? | **YES** | End-to-end DB test proves `S1` -> `english` -> `HW1` / `CPW1` / `MT` with correct `examType`, `assessmentLabel`, and totals. |
| 10 | Does a half-point score survive workbook -> parser -> resolver -> server -> DB? | **YES** | DB-backed test proves `4.5`, `12.5`, and `17.5` are preserved unchanged through the full chain. |
| 11 | Do monthly and final reports preserve decimal behavior correctly? | **YES** | Monthly `86.67`, midterm `87.5`, final `86.25` verified via real RPC execution. |
| 12 | Are repo-shipped report RPCs now present and authorization-enforced? | **YES** | `20260912_report_rpc_remediation.sql` ships the RPCs; unrelated teacher access is denied in DB-backed tests. |

---

## Acceptance matrix

| Requirement | Status | Evidence |
|---|---|---|
| Fix A1 missing expected columns | **PASS** | parser contract + workbook tests + UI wiring |
| Use same canonical source as Example Download | **PASS** | `buildGradeColumns()` reused for validation |
| Preserve header-based parsing | **PASS** | reordered-column test |
| Keep structural errors separate from Needs Review | **PASS** | parse errors vs `MISSING_STUDENT_ID` warning flow |
| Fix A2 monthly/final RPC gap | **PASS** | new migration file added |
| Verify decimal behavior from real implementation | **PASS** | real PGlite RPC execution |
| Prevent MT from being folded into CA | **PASS** | monthly/final SQL explicitly exclude `assessmentLabel='MT'` from CA |
| Treat bulk-uploaded MT as midterm | **PASS** | migrated `get_midterm_report` + fallback update + DB test |
| Prove XLSX -> DB -> reports flow | **PASS** | `report-rpcs.db.test.ts` |
| Run typecheck | **PASS** | `npm run typecheck` |
| Run full tests | **PASS** | `npm run test:ci` |
| Run production build | **PASS** | `npm run build` |

---

## Commands executed

```bash
npm test -- --run src/lib/__tests__/bulk-grades-workbook.test.ts src/lib/__tests__/reports.test.ts src/lib/bulk-grades/__tests__/report-rpcs.db.test.ts
npx tsx scripts/verify-bulk-upload-flat-header.ts > .tmp-audit/verify-bulk-upload-flat-header-output.json
npm run typecheck
npm run test:ci
npm run build
```

All completed successfully.

---

## Final conclusion

Both original audit conditions are now closed in the repository with implementation + evidence:

- **A1** is closed by canonical expected-column enforcement and structural test coverage.
- **A2** is closed by repo-shipped monthly/final SQL, corrected MT handling, decimal-preserving calculations, and real end-to-end verification through DB-backed tests.
