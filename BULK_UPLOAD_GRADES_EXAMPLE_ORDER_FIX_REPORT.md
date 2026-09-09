# Bulk Upload Grades — Example Download Column Order Fix

## Problem

When a teacher clicked **Download Example**, the generated workbook laid out its
subject columns in whatever order the database returned the teacher's authorized
subjects. Concretely:

- `BulkUploadGrades.tsx` computes `selectedSubjects` by filtering `classSubjects`
  (loaded from Supabase via `getClassSubjectsForTeacher`) against the checkboxes
  the teacher clicked.
- It passed that array straight into `buildRosterWorkbook({ subjects })`.
- `buildGradeColumns(subjectNames, blocks)` iterated `subjectNames` **in the order
  received** — i.e. database/selection order — when emitting `"<Subject> <Block>"`
  columns.

So the subject order was non-deterministic: it depended on the Supabase query
order and the order the teacher clicked checkboxes. A teacher copying from a
Google Sheet arranged as English → Math → … → Tarabiya had to hunt for and
rearrange columns.

The **assessment order within each subject was already correct** — it flows
through `orderBlocks()` in `assessments.ts`, which normalizes any input order to
the canonical `HW1..HW4 → CPW1..CPW4 → Att → MT → Akhlaaq`. That part was left
untouched; the fix is entirely about **subject** ordering.

## Required Order

**Student Name is always first** (preceded only by the existing `Student ID`
identity column, which the roster template prefills — see "Blank Student ID"
below).

**Subjects (fixed master order):**

```
English → Math → Science → Social → Somali → Arabic → Tarabiya
```

**Assessments inside every subject (fixed):**

```
HW1 → HW2 → HW3 → HW4 → CPW1 → CPW2 → CPW3 → CPW4 → Att → MT → Akhlaaq
```

Max marks (unchanged grading semantics): HW1–4 = 5, CPW1–4 = 15, Att = 20,
MT = 20, Akhlaaq = 10.

The master list controls **placement only**; the existing subject
selection/authorization model still controls **membership**. Unauthorized or
unselected subjects never appear just because they are in the master list.

## Implementation

### New canonical definition
- **`src/lib/bulk-grades/subjectOrder.ts`** (new) — the single source of truth for
  subject order:
  - `EXAMPLE_SUBJECT_ORDER` = `['English','Math','Science','Social','Somali','Arabic','Tarabiya']`.
  - `canonicalSubjectName(name)` — normalizes harmless DB naming differences to a
    canonical subject via an alias map on a lowercased, whitespace-collapsed,
    punctuation-stripped key (`Mathematics→Math`, `Social Studies→Social`,
    `Tarbiya/Tarabiyah→Tarabiya`, etc.). Unknown subjects → `null`.
  - `orderByCanonicalSubjects(items, getName)` — **stable** sort into master order;
    unrecognized subjects keep their relative order and are appended last.
  - `orderSubjectNames(names)` — convenience for plain name arrays. It **reorders
    but never renames** — the original subject name is preserved because the parser
    keys columns on that exact string.

### Wired into the one authoritative column builder
- **`src/lib/bulk-grades/workbook.ts`**:
  - `buildGradeColumns()` now applies `orderSubjectNames(subjectNames)` before the
    per-subject/per-block loop. Because this one function produces the workbook's
    grade columns, the change simultaneously fixes the merged headers, worksheet
    columns, and — since every header is `"<Subject> <Block>"` — the parser's
    understanding of each column.
  - `workbookFileName()` and the Instructions sheet's "Subjects" line now also list
    subjects in canonical order for consistency.

No changes were needed in `BulkUploadGrades.tsx`, the assessment definitions, the
scoring rules, the RPC, or any unrelated Bulk Upload logic.

## Parser Compatibility

The Example Download and the Bulk Upload parser share **one** canonical column
definition, so they cannot disagree:

- The generator emits self-describing headers `"<Subject> <Block>"` (e.g.
  `"Arabic HW1"`, `"Tarabiya Akhlaaq"`) from `buildGradeColumns`.
- The parser (`parseRosterWorkbook` → `parseGradeColumnHeader`) reads each column's
  meaning **from its header text**, not from its position. It resolves the block
  token against the same `ASSESSMENT_DEFINITIONS`/`ASSESSMENT_BLOCKS` the generator
  used, and takes the subject name as everything before the block token.

Because meaning is carried by the header, reordering subjects changes only the
visual/positional layout — the parser still maps every column correctly. This is
verified by the round-trip test (below): a workbook generated from scrambled DB
order is populated and re-parsed, and every score lands on the right
subject+assessment.

## Tests

### `src/lib/__tests__/bulk-grades-subject-order.test.ts` (new, 12 tests)
- `EXAMPLE_SUBJECT_ORDER` is exactly the seven-subject master order.
- `canonicalSubjectName` normalizes `Mathematics/maths→Math`,
  `Social Studies→Social`, `Tarbiya/TARABIYAH→Tarabiya`, whitespace, and returns
  `null` for non-master subjects (`Physics`).
- `orderSubjectNames` reorders regardless of input order and preserves original
  names; stable-appends unknown subjects after known ones.
- `orderByCanonicalSubjects` reorders arbitrary item shapes.
- **Test 1** — all seven subjects (given scrambled, with name variants) produce the
  exact required 79-column header sequence.
- **Test 2** — partial `[Arabic, English, Tarbiya]` reorders to
  `English → Arabic → Tarbiya`.
- **Test 3** — single subject still gets all 11 assessment columns in order.
- **Test 4** — template is fixed even when no grade data exists.
- **Test 5** — random DB return order still yields the master order.
- **§15 realistic workflow** — authorized `[English, Math, Arabic, Tarabiya]`
  (clicked scrambled) downloads in master order, excludes unauthorized
  Science/Somali/Social, keeps the `Student ID` column (blank-ID workflow intact),
  and the filename lists subjects in master order.

### `src/lib/__tests__/bulk-grades-workbook.test.ts` (extended, +1 test → 16)
- **§14 Test 6 round trip** — generate all seven subjects from a scrambled input,
  confirm the real XLSX header is in master order, populate `English HW1`,
  `English CPW1`, `Math HW1`, `Arabic MT`, `Tarabiya Akhlaaq` by locating columns
  by header name, re-parse, and assert every score maps to the correct
  subject+assessment with no errors.

All pre-existing workbook/parser tests (subject-scoped Akhlaaq, tampering
detection, blank Student ID → null identity, score-range validation, Absent/N/A)
continue to pass unchanged.

## Verification

Dependencies were installed in the sandbox (`npm install --ignore-scripts`; the
only skipped script was the optional `supabase` CLI binary download, unrelated to
this feature). `NODE_EXTRA_CA_CERTS` was set to the sandbox proxy CA.

```
npm run typecheck   → PASS (tsc --noEmit, 0 errors)
npm run test:ci     → PASS — 770 tests, 72 files (was 757/71; +13 new)
npm run build       → PASS (vite build, 2535 modules, built in ~14.6s)
```

Targeted: `bulk-grades-workbook.test.ts` (16) + `bulk-grades-subject-order.test.ts`
(12) = 28 passed.

## Workbook Inspection

A real XLSX was generated (`buildRosterWorkbook`) from **deliberately scrambled**
DB subject order `[Arabic, Tarbiya, Somali, Social Studies, Science, Mathematics,
English]` with **scrambled** block order and inspected via `xlsx`. The generated
`Grades` sheet header (79 columns) was:

```
0  Student ID
1  Student Name
2  English HW1 … 12 English Akhlaaq
13 Mathematics HW1 … 23 Mathematics Akhlaaq
24 Science HW1 … 34 Science Akhlaaq
35 Social Studies HW1 … 45 Social Studies Akhlaaq
46 Somali HW1 … 56 Somali Akhlaaq
57 Arabic HW1 … 67 Arabic Akhlaaq
68 Tarbiya HW1 … 78 Tarbiya Akhlaaq
```

Confirmed by inspection:
- `Student Name` (and the `Student ID` identity column) come first.
- Subjects appear in `English → Math → Science → Social → Somali → Arabic →
  Tarabiya` regardless of the scrambled DB order and naming variants.
- Every subject exposes exactly the 11 assessment columns in order, with `Att`
  before `MT` and `MT` before `Akhlaaq`.
- Grade cells are blank; the roster (IDs + names) is prefilled.
- No duplicated or missing columns (79 = 2 identity + 7 × 11).

## Remaining Issues

None functional. Notes:
- The generated header uses each subject's **original** database name (e.g.
  `Mathematics`, `Social Studies`, `Tarbiya`) — only the **order** is canonicalized.
  This is intentional so the parser continues to match the school's actual subject
  records; the app's authorization layer already ties those names to teachers.
- Not verified against a live Supabase instance (no DB credentials in this
  sandbox). The change is pure client-side workbook generation with full unit +
  round-trip coverage; it does not touch server RPCs or RLS.
