> **Note (integration of PR #39 + PR #40):** this report was written for PR #39 against the
> pre-flat-header workbook. Its "Why the spreadsheet needed no change" / "Real XLSX verification"
> sections describe the OLD `Student ID | Student Name | English HW1 …` layout, which PR #40
> replaced with the flat `Student Name | ENGLISH HW1 …` layout (see
> `BULK_UPLOAD_FLAT_HEADER_HALF_POINT_FIX_REPORT.md`). The manual-entry half-point changes
> (`src/lib/scores.ts`, `UploadResults.tsx`, `gradeCorrectionUtils.ts`) described below remain
> accurate. Integration details: `PR39_PR40_BULK_UPLOAD_INTEGRATION_FIX_REPORT.md`.

# Half-Point Scores for HW / CPW — Implementation Report

Date: 2026-09-09
Branch: `arena/01a08666-schoolnnnnass`

---

## Scope (as clarified by the user)

The original request also asked for a flat `SUBJECT ASSESSMENT` header rewrite of the
Bulk Upload Grades example workbook. During inspection the user clarified:

> "leave the excel as is what i want is that hw and CPW to accept 3.5 or 4.5 for example"

So the spreadsheet format was **left unchanged** and the work focused on making sure
half-point scores (3.5, 4.5, 12.5, …) are accepted and never truncated anywhere a
teacher can enter a grade.

### Why the spreadsheet needed no change

The example workbook already satisfies the flat-header requirements:

* **One flat header row** — no merged cells, no multi-row subject banner.
  Verified on a real generated file: `mergeCells present: False`.
* **Self-describing headers** of the form `<Subject> <Assessment>`, e.g.
  `English HW1`, `English CPW1`, `Arabic MT`, `Tarabiya Akhlaaq`.
* **No max marks embedded** in header names.
* **Deterministic subject order** (English → Math → Science → Social → Somali →
  Arabic → Tarabiya) enforced by `src/lib/bulk-grades/subjectOrder.ts`.
* **Deterministic assessment order** (HW1–HW4 → CPW1–CPW4 → Attendance → MT →
  Akhlaaq) enforced by `ASSESSMENT_DEFINITIONS` in `src/lib/excel-parser.ts`.
* **One student per row**, one worksheet, only authorized subjects.
* Download and parser already share the same canonical column definitions.

Actual header from a freshly generated workbook (Arabic/English/Math/Tarabiya selected,
deliberately passed in scrambled order):

```
Student ID | Student Name |
English HW1 | English HW2 | English CPW1 | English MT | English Akhlaaq |
Math HW1 | Math HW2 | Math CPW1 | Math MT | Math Akhlaaq |
Arabic HW1 | Arabic HW2 | Arabic CPW1 | Arabic MT | Arabic Akhlaaq |
Tarabiya HW1 | Tarabiya HW2 | Tarabiya CPW1 | Tarabiya MT | Tarabiya Akhlaaq
```

Subjects were reordered into the canonical order automatically. `Student ID` was kept
as column 1 (per the user's "leave the excel as is") — it remains **optional**: rows
without an ID still flow through the existing blank-ID / Needs-Review resolution.

---

## The real problem found: `parseInt` truncation on manual score entry

The Excel bulk pipeline already handled half points correctly
(`interpretScoreCell`, the `NUMERIC` `exams.score` column, and the
`score * 2 = floor(score * 2)` server check from
`supabase/migrations/20260911_half_point_scores.sql`).

But **Teacher → Upload Results** (the manual per-student score screen) still used
`parseInt()` everywhere. A teacher typing `4.5` had it silently saved as `4`:

```ts
score: parseInt(s.score),                  // 4.5 → 4   ← data loss
const score = parseInt(s.score);           // validation
const num = parseInt(score);               // colour + invalid check
Math.round((parseInt(s.score) / totalNum) * 100)   // percentages
```

The `<input type="number">` fields also had no `step`, so browsers rejected/stepped
half values in the spinner UI.

---

## Changes made

### New shared module: `src/lib/scores.ts`

One canonical half-point rule for every manual-entry screen, matching the parser and
the database constraint exactly:

| Helper | Behaviour |
| --- | --- |
| `parseScoreInput(raw)` | `"4.5" → 4.5`, `"12.5" → 12.5`. Blank → `null` (never `0`). Quarter points, junk, negatives → `null`. Never rounds or floors. |
| `parseScoreWithin(raw, total)` | As above, plus a `0 … total` range check. |
| `isScoreTextInvalid(raw, total)` | `true` only for entered-but-wrong values; blank is **not** an error. |
| `isHalfStep(n)` | `Number.isInteger(n * 2)` — accepts 4 and 4.5, rejects 4.25. |
| `formatScore(n)` | `4 → "4"`, `4.5 → "4.5"`, `null → "—"`. |

### `src/pages/teacher/UploadResults.tsx`

* Every `parseInt` on a **score** replaced with `parseScoreInput` — submission,
  validation, colour coding, percentages, review table, class average.
* `parseInt(total, 10)` kept for the **total marks** field (totals are integers).
* Score inputs and the quick-fill input gained `step={0.5}` and `inputMode="decimal"`.

### `src/pages/admin/gradeCorrectionUtils.ts`

* Its local `isHalfStep` duplicate now re-exports the shared one, so there is a single
  definition of the half-step rule. Behaviour and public API unchanged.

**Files changed**

```
src/lib/scores.ts                          (new)
src/lib/__tests__/half-point-scores.test.ts (new)
src/pages/teacher/UploadResults.tsx
src/pages/admin/gradeCorrectionUtils.ts
BULK_UPLOAD_FLAT_HEADER_HALF_POINT_FIX_REPORT.md (new)
```

No changes to the workbook format, the parser, the resolver, `submit_bulk_grades`,
or any migration.

---

## Score handling rules (unchanged and now uniformly enforced)

| Assessment | Max | Valid examples |
| --- | --- | --- |
| HW1–HW4 | 5 | `5`, `4.5`, `4`, `3.5`, `0` |
| CPW1–CPW4 | 15 | `15`, `14.5`, `13`, `12.5` |
| Attendance | 20 | `20`, `19.5` |
| MT | 20 | `20`, `17.5` |
| Akhlaaq | 10 | `10`, `9.5` |

* `4.5` and `12.5` remain **valid** and are never truncated or rounded.
* Quarter points (`4.25`, `12.25`) remain **rejected**.
* Over-maximum values (`5.5` for HW, `15.5` for CPW, `20.5` for MT) remain rejected.
* Blank stays blank — never coerced to `0`.
* Validation was **not** weakened to integer-only anywhere.

---

## Tests

New: `src/lib/__tests__/half-point-scores.test.ts` — 19 tests covering
no-truncation (`4.5 !== 4`, `12.5 !== 12`), blank ≠ 0, maximum acceptance/rejection,
quarter-point rejection, `interpretScoreCell` half points, and a real XLSX
build → fill → serialize → parse round trip.

```
$ npx vitest --run src/lib/__tests__/half-point-scores.test.ts
 ✓ src/lib/__tests__/half-point-scores.test.ts (19 tests) 50ms
 Test Files  1 passed (1)
      Tests  19 passed (19)
```

### Required validation commands

| Command | Result |
| --- | --- |
| `npm run typecheck` | **PASS** — `tsc --noEmit`, no errors |
| `npm run test:ci` | **PASS** — 74 files, **799/799 tests**, 49.05s |
| `npm run build` | **PASS** — 2536 modules, built in 13.80s, `dist/index.html` 5,787.42 kB |

No lint script exists in `package.json` (`dev`, `build`, `preview`, `test`,
`test:ci`, `typecheck`, `validate` only).

Note: `npm ci` needed `--ignore-scripts` in this sandbox — the `supabase` CLI
postinstall cannot reach GitHub through the proxy. This is environmental only and
does not affect the app.

---

## Real XLSX verification

A genuine workbook was generated, written to `/tmp/xlsxcheck/grades.xlsx` (22,971
bytes), re-read **from disk**, and inspected both through the parser and by unzipping
the raw OOXML:

* Sheets: `['Instructions', 'Grades']` — one data table, one student per row.
* `mergeCells present: False` — no merged subject header row.
* Header is a single flat row; no duplicate or missing headers; canonical subject and
  assessment order confirmed despite scrambled input order.
* Raw `xl/worksheets/sheet2.xml` row 2 cells: `MBK-1001`, `Amiir Sakariye`,
  `4.5`, ``, `12.5`, … — half points stored as **numeric** cells (`t="n"`, `v=4.5`),
  not text.
* Parser output: `English HW1=4.5`, `English CPW1=12.5`, `Math HW2=3.5`,
  `Arabic MT=17.5`, `Tarabiya HW1=5`, zero errors.
* The untouched second student produced **0** scores — blanks stayed blank.

---

## Regression check on existing functionality

Class selection, authorized subjects, Example Download, Upload, blank-Student-ID
resolution, Needs Review, duplicate detection, score validation, preview,
confirmation, `submit_bulk_grades`, admin grade corrections, and report calculations
are all covered by the existing suite — all 799 tests still pass. The workbook format
and parser were not modified.

---

## Remaining issues

1. **`GradeQuizzes.tsx` still uses `parseInt` for quiz question points**
   (`src/pages/teacher/GradeQuizzes.tsx:60`). Quiz rubric points are a separate,
   integer-by-design feature and were out of scope — flagged in case half-point quiz
   marking is wanted later.
2. **`npm ci` requires `--ignore-scripts`** in this sandbox because the `supabase`
   CLI postinstall download fails TLS verification through the proxy. Environmental,
   not a code defect.
