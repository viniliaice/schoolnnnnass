# Half-Point Grade Scores — Implementation Report

## Request

Teachers were blocked from awarding partial credit. Cells like **F39 (English
HW4)**, **Q39 (Math HW4)**, **AA39 (Science HW3)**, **AJ39 (Social HW1)** and
**AU39 (Somali HW1)** were rejected with:

> ENGLISH HW4 must be a whole number from 0 to 5, Absent, N/A, or blank.

The teacher confirmed they want to enter **half points (e.g. 4.5)** for **all
assessment types** (Homework, CPW, Attendance, MT, Akhlaaq).

## Problem

Scores were integer-only at every layer:

- `exams.score` was `INTEGER` (column type, plus a CHECK requiring integers).
- The shared cell parser `interpretScoreCell` rejected anything matching a
  decimal via `^(?:0|[1-9]\d*)$` and used `Number.isSafeInteger`.
- `submit_bulk_grades` validated score strings against `^(0|[1-9][0-9]*)$` and
  cast to `::INTEGER`.
- `admin_correct_grade` took `INTEGER` parameters.
- The admin correction UI validator rejected non-integers.

So `4.5` failed at the parser before it ever reached the database.

## Decision

Allow **whole numbers and half points only** (steps of 0.5). Quarter points
(`4.25`) remain invalid. A half point is stored **faithfully as a decimal**
(the `score` column becomes `NUMERIC`) and never rounded, so `4.5/5` survives the
full round trip and all report percentage math (which already used
`score::numeric`) stays exact.

The rule "value × 2 is an integer" is enforced identically in the browser, in the
database CHECK constraint, and in both RPCs — one canonical definition of "whole
or half point".

## Implementation

### Client / shared parser
- **`src/lib/excel-parser.ts`** — `interpretScoreCell` now accepts
  `^\d+(?:\.[05])?$` and range-checks with `Number.isFinite`; the invalid reason
  is `not_half_step`; the error message became *"… must be a number from 0 to N in
  whole or half points (e.g. 4 or 4.5), Absent, N/A, or blank."* Both parsers
  share this function, so the fixed-block and roster workbooks agree.
- **`src/lib/bulk-grades/workbook.ts`** — the roster-workbook parser's
  `INVALID_SCORE` message and the Instructions sheet text updated to mention half
  points.

### Admin correction UI
- **`src/pages/admin/gradeCorrectionUtils.ts`** — added `isHalfStep()` and use it
  in `parseNewValue`; error is *"The score must be a whole or half point (e.g. 4
  or 4.5)."*
- **`src/pages/admin/GradeCorrections.tsx`** — the score `<input>` now uses
  `step={0.5}`.

### Database (new migration `supabase/migrations/20260911_half_point_scores.sql`)
- `ALTER TABLE public.exams ALTER COLUMN score TYPE NUMERIC`.
- New `exams_score_entry_state_check`: scored rows require
  `score >= 0 AND score <= total AND score * 2 = floor(score * 2)`; absent/N/A
  rows require `score IS NULL`.
- `grade_correction_audit.old_score` / `new_score` widened to `NUMERIC`.
- `submit_bulk_grades` redefined: `v_score NUMERIC`, score-string regex now
  `^[0-9]+(\.[05])?$`, score cast `::NUMERIC`, and the scored range check adds the
  half-step guard. Everything else (authorization, identity binding, term/month/
  date checks, duplicate detection, atomic upsert, status→pending, idempotency)
  is byte-for-byte preserved.
- `admin_correct_grade` dropped and recreated with `NUMERIC` score parameters and
  an added half-step validation; logic otherwise identical (admin-only, row lock,
  optimistic concurrency, no-op guard, append-only audit, status→pending).
- Grants/REVOKEs reissued for the new signatures.

### Reference schema
- **`supabase-schema.sql`** — base `exams.score` set to `NUMERIC` with the
  half-step CHECK, so fresh deployments match.

## Parser / RPC agreement

"Whole or half point" is defined once as *value × 2 is an integer* and enforced in
three places that must agree:

| Layer | Rule |
|-------|------|
| Browser parser (`interpretScoreCell`) | regex `^\d+(?:\.[05])?$` + range |
| DB CHECK (`exams_score_entry_state_check`) | `score * 2 = floor(score * 2)` + range |
| RPCs (`submit_bulk_grades`, `admin_correct_grade`) | string regex + `v_score * 2 <> floor(...)` guard |

## Tests

- **`src/lib/__tests__/excel-parser.test.ts`** — renamed the decimal-rejection
  test to use `3.25` (quarter point) and added a test that `4.5` and `0.5` parse
  and are stored faithfully.
- **`src/lib/__tests__/gradeCorrectionUtils.test.ts`** — `10.5` is now accepted;
  `10.25` is rejected with *"whole or half"*.
- **`src/lib/bulk-grades/__tests__/half-point-scores.db.test.ts`** (new,
  behavioral, executes the ACTUAL 20260911 migration via PGlite):
  1. `submit_bulk_grades` stores `4.5` faithfully (not rounded).
  2. accepts a whole number (`4`).
  3. rejects a quarter point (`4.25`).
  4. rejects a half point above the maximum (`5.5 > 5`).
  5. the DB CHECK itself rejects a direct quarter-point INSERT.
  6. `admin_correct_grade` corrects `4 → 4.5`, resets status to pending, and the
     audit records `4 → 4.5`.
  7. `admin_correct_grade` rejects a quarter-point correction (`4 → 4.25`).
- **`src/lib/bulk-grades/__tests__/pgHarness.ts`** — added an `includeHalfPoints`
  option that widens `exams.score` + audit columns to `NUMERIC`, installs the
  half-step CHECK, and loads the real redefined RPCs from the 20260911 migration.

## Verification

Dependencies installed in the sandbox (`NODE_EXTRA_CA_CERTS` = proxy CA;
`@electric-sql/pglite` installed for the behavioral DB tests).

```
npm run typecheck   → PASS (tsc --noEmit, 0 errors)
npm run test:ci     → PASS — 779 tests, 73 files (was 770/72)
npm run build       → PASS (vite build, ~14.4s)
```

## Behavior verified

A real PGlite run confirmed end to end: `submit_bulk_grades` with `score: 4.5`
stores `4.5`; `admin_correct_grade` correcting `4 → 4.5` writes `4.5` to the exam,
resets it to `pending`, and records `old_score=4, new_score=4.5` in the immutable
audit. Quarter points are rejected by the browser, the RPC string check, the
in-RPC guard, and the DB CHECK.

## Remaining Issues

- Not applied to / verified against a live Supabase instance (no DB credentials in
  this sandbox). The migration is idempotent and the RPC/CHECK logic is verified
  against a real PostgreSQL engine (PGlite executing the shipped migration), but
  production execution of `20260911_half_point_scores.sql` still needs to be run
  by an operator. **NOT VERIFIED — REQUIRES REAL DATABASE EXECUTION.**
- Existing `exams.score` values are unaffected (integers are valid NUMERIC
  values); no data backfill is required.
- The scope is whole/half points by design; quarter points remain invalid.
