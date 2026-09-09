# Bulk Upload Flat Header + Half-Point Fix Report

## Problem

The Bulk Upload Grades example workbook was not optimized for simple teacher copy/paste workflows.

Problems in the prior implementation included:

- teacher-facing ambiguity around subject/assessment columns
- workbook expectations still tied to older multi-row / block-style thinking
- visible workbook identity depending on a `Student ID` column instead of allowing a clean `Student Name`-first sheet
- a risk of regressions if workbook generation and parsing drifted apart

The goal of this fix was to make the downloaded workbook immediately understandable while preserving the existing half-point grading pipeline.

## New Format

The Grades sheet now uses one flat header row.

Visible columns are:

- `Student Name`
- then repeated `SUBJECT ASSESSMENT` headers

Example:

```text
Student Name | ENGLISH HW1 | ENGLISH HW2 | ENGLISH HW3 | ENGLISH HW4 | ENGLISH CPW1 | ENGLISH CPW2 | ENGLISH CPW3 | ENGLISH CPW4 | ENGLISH Attendance | ENGLISH MT | ENGLISH Akhlaaq
```

Key changes:

- no merged subject headers
- no multi-row subject/header structure
- no maximum marks embedded in visible header names
- `Student Name` is the first visible column
- subject names are rendered in uppercase canonical form

A hidden metadata sheet is included in the downloaded example so unchanged roster rows still retain their internal student IDs even though the visible sheet no longer shows a `Student ID` column.

If that metadata is missing or the roster was manually replaced, the parser safely falls back to the existing name-based Needs Review workflow.

## Subject Order

The workbook now uses one explicit canonical subject order:

```text
English
Math
Science
Social
Somali
Arabic
Tarabiya
```

Visible headers therefore appear in this exact order:

```text
ENGLISH
MATH
SCIENCE
SOCIAL
SOMALI
ARABIC
TARABIYA
```

Only authorized/selected subjects are included.
The canonical order controls placement, not membership.

## Assessment Order

Every included subject now uses this exact assessment order:

```text
HW1
HW2
HW3
HW4
CPW1
CPW2
CPW3
CPW4
Attendance
MT
Akhlaaq
```

## Score Handling

Half-point support was preserved end-to-end.

The implementation continues to accept valid values such as:

```text
4
4.5
12
12.5
3.5
17.5
```

Important guarantees preserved:

- half-point scores are still valid where permitted
- scores are not truncated
- scores are not rounded
- blank cells remain blank
- quarter-point values such as `4.25` and `12.25` remain invalid
- maximums remain unchanged:
  - HW = 5
  - CPW = 15
  - Attendance = 20
  - MT = 20
  - Akhlaaq = 10

The workbook/parser path continues to reuse the same canonical assessment definitions and the same `interpretScoreCell()` validation logic, so generation and parsing stay aligned.

## Files Changed

- `src/lib/bulk-grades/subjectOrder.ts`
- `src/lib/bulk-grades/workbook.ts`
- `src/lib/bulk-grades/resolve.ts`
- `src/pages/teacher/BulkUploadGrades.tsx`
- `src/lib/__tests__/bulk-grades-workbook.test.ts`
- `src/lib/__tests__/bulk-grades-subject-order.test.ts`
- `src/lib/__tests__/bulk-grades-resolve.test.ts`
- `src/lib/bulk-grades/__tests__/e2e-teacher-scenario.db.test.ts`
- `scripts/verify-bulk-upload-flat-header.ts`

## Tests

### Targeted bulk-upload regression tests

Command:

```bash
npx vitest --run src/lib/__tests__/bulk-grades-workbook.test.ts src/lib/__tests__/bulk-grades-subject-order.test.ts src/lib/__tests__/bulk-grades-resolve.test.ts src/lib/bulk-grades/__tests__/e2e-teacher-scenario.db.test.ts
```

Result:

- 4 test files passed
- 56 tests passed
- 0 failures

Coverage included:

- exact English flat headers
- exact subject ordering from random input order
- exact assessment ordering
- half-point parsing
- no truncation of `4.5` / `12.5`
- maximum validation
- rejection of quarter-point values
- blank/no-ID name-based resolution workflow
- end-to-end workbook -> resolve -> real `submit_bulk_grades` RPC scenario

### Required validation commands

#### `npm run typecheck`

Result: passed

```text
> react-vite-tailwind@0.0.0 typecheck
> tsc --noEmit
```

#### `npm run test:ci`

Result: passed

```text
Test Files  73 passed (73)
Tests       781 passed (781)
Duration    57.37s
```

Notes:

- the suite emitted existing unrelated stderr noise from legacy print/family-id tests, but there were no failures

#### `npm run build`

Result: passed

```text
vite v7.2.4 building client environment for production...
✓ 2535 modules transformed.
dist/index.html  5,788.24 kB │ gzip: 2,518.61 kB
✓ built in 26.01s
```

## XLSX Verification

A real XLSX workbook was generated and inspected programmatically using:

- `scripts/verify-bulk-upload-flat-header.ts`

Verification run summary:

- output file generated: `/tmp/bulk-upload-flat-header-example.xlsx`
- sheets present:
  - `Instructions`
  - `Grades`
  - `__RosterMetadata`
- visible Grades header count: `78`
  - `1` visible identity column (`Student Name`)
  - `77` grade columns (`7 subjects × 11 assessments`)
- first visible header: `Student Name`
- no merged subject headers detected
- no duplicate headers detected
- first 12 visible headers were exactly:

```text
Student Name
ENGLISH HW1
ENGLISH HW2
ENGLISH HW3
ENGLISH HW4
ENGLISH CPW1
ENGLISH CPW2
ENGLISH CPW3
ENGLISH CPW4
ENGLISH Attendance
ENGLISH MT
ENGLISH Akhlaaq
```

Half-point numeric values were written into the real XLSX and survived disk round-trip as numeric Excel values:

- `ENGLISH HW1 = 4.5`
- `ENGLISH CPW1 = 12.5`
- `MATH HW2 = 3.5`
- `ARABIC MT = 17.5`
- `SOCIAL Attendance = 19.5`
- `TARABIYA Akhlaaq = 9.5`

`parseRosterWorkbook()` then re-read that same workbook with:

- `parsedIssues = []`
- exact numeric score preservation for all of the above values

## Remaining Issues

None identified for this change.

The required flat-header workbook generation, deterministic ordering, optional visible Student ID workflow, half-point preservation, and real XLSX verification are complete.
