# Bulk Upload Grades — Blank Student ID Fix

**Branch:** `arena/01a0804f-schoolnnnnass`
**Date:** 2026-09-08
**Scope:** Support the real school workflow where teachers upload Google Sheets (exported to Excel) with the **Student ID column left completely blank**, and make blank IDs resolve safely by name into **Needs Review** — without ever producing false duplicate errors.

---

## Root Cause

A blank Student ID cell was being carried through the pipeline as the **empty string** (`studentId: ''`) instead of as an explicit "identity not resolved" marker. An empty string is a *value* that compares equal to itself (`'' === ''`), so any code that keyed on it treated every blank-ID row as **the same identity**.

The observable symptom — repeated `Duplicate HW1 / HW2 / … / Akhlaaq for <name>` errors across different students — is the classic signature of an empty-string identity key: two (or more) name-only rows collapse into one identity, and their assessment records collide.

## Why Blank IDs Were Producing False Duplicates

Duplicate detection builds a uniqueness key of:

```
studentId + subjectId + examType + assessmentLabel + termId
```

If the `studentId` portion is `''` for several different students, then `Amiir sakariye`'s `Arabic HW1` and `Axmed Cabdale Maxamuud`'s `Arabic HW1` produce the **identical** key `'' | arabic | Homework | HW1 | term`, so the second one is flagged as a duplicate. With 11–22 assessments per student across a class, this explodes into hundreds of false "Duplicate …" errors, entirely caused by the blank IDs — not by any real duplication.

The bug lived in the **identity-resolution order**: an empty string was allowed to *be* an identity and reach the duplicate stage, instead of being recognized as "no identity yet, resolve me later."

## Correct Identity Resolution

The fix makes missing identity **explicit and unusable as a key**:

- **Parser (`src/lib/bulk-grades/workbook.ts`)** — `WorkbookStudentRow.studentId` is now typed `string | null`. A blank Student ID cell is stored as **`null`** (never `''`), with a code comment stating that `null` means "identity not yet resolved" and must never be used as an identity/duplicate key. The row's scores are collected and preserved; a non-blocking `MISSING_STUDENT_ID` **warning** is emitted so the row survives to Needs Review.
- **Resolver (`src/lib/bulk-grades/resolve.ts`)** — identity is decided per row in the correct order:

```
Workbook row
   ↓
studentId present (non-blank)?
   ├── YES → authoritative: look up in current roster
   │          (miss → Error: wrong/stale class)
   └── NO  → name → current-class roster candidates
              ├── 0 candidates → Error (removable in UI)
              ├── 1 candidate  → Needs Review (explicit pick required)
              └── ≥2 candidates → Needs Review (all shown)
                     ↓ reviewer picks
              resolved studentId → full re-validation → record
```

Only rows that reach a **concrete, resolved studentId** ever emit a `BulkGradeRecord`. Blank/`null`-ID rows emit **no records** — they wait in Needs Review — so they can never enter duplicate detection with an empty key.

## Needs Review Behavior

Blank-ID rows are matched by normalized name against the **current selected class roster only** (not the whole school), reusing the existing normalization and Needs-Review workflow:

- exactly one candidate → **Needs Review** (never auto-selected; explicit "Use this student");
- multiple candidates → **Needs Review**, all shown;
- zero candidates → **Error** (`No roster student matches legacy name "…"`), and — as added previously — that error row is **removable directly in the UI** (Exclude), so the teacher never has to edit the spreadsheet.

## Duplicate Detection Behavior

Duplicate detection now:

1. runs **after** identity resolution, over emitted records only;
2. **skips** any record without a concrete resolved id (defensive guard: `if (!resolvedId) continue`);
3. keys on `resolvedId + subjectId + examType + assessmentLabel + termId`.

Consequently:

- `blank ID + blank ID` → **not** a duplicate;
- `resolved student-123 (row 4) + resolved student-123 (row 5)` → **correctly** a duplicate.

The server-side uniqueness protection is **unchanged and not loosened**.

## Score Preservation

A blank-ID row's scores are collected at parse time and carried on the row while it waits for review. When the reviewer picks a student, the row's **full** score set is attached to the chosen student via the same `emitRecordsFor` path — no re-parsing, no dropped cells. Verified by Test E (8 scores) and Test H (2 subjects × 11 blocks = 22 records per resolved student).

## Server Security

Manual name-based selection is only a client-side identity aid. The chosen student flows through the **same** `submit_bulk_grades` RPC, which independently re-verifies authenticated actor → selected class → student's current class → subject → teacher/class/subject assignment → assessment → score, atomically and idempotently. A reviewer's pick cannot bypass authorization, and a picked student who is not in the current class is rejected both client-side (Error) and server-side (existing executed DB test).

## Tests Added

In `src/lib/__tests__/bulk-grades-resolve.test.ts`, describe block **"blank Student ID (real-world Google Sheet)"**:

- **A/G** — three different blank-ID names → 3 separate Needs-Review rows, **0** duplicate errors, and parser stores `null` (not `''`).
- **B** — blank ID + single candidate → Needs Review with that candidate.
- **C** — blank ID + multiple same-name candidates → Needs Review, all candidates shown.
- **D** — blank ID + no candidate → Error (flagged `removableRow`).
- **E** — manual resolution attaches **all** of the row's scores (8) to the chosen student; nothing lost.
- **F** — two blank-ID rows resolved to the **same** student → genuine Duplicate error.
- **H** — the exact real-world workbook: every ID blank, two subjects × 11 blocks, 3 students → resolves into 3 Needs-Review rows (not hundreds of duplicate errors); resolving all three yields exactly `3 × 2 × 11 = 66` records.

In `src/lib/__tests__/bulk-grades-workbook.test.ts`: the "manually added row with no Student ID" test now also asserts `studentId === null` and that its scores are preserved.

## Test Results

- `npm run typecheck` → clean (exit 0)
- `npm run test:ci` → **708 passed / 708, 68 files, 0 failed**
- `npm run build` → success (built in 11.29s)
- Targeted (`bulk-grades-workbook`, `bulk-grades-resolve`, `submit-bulk-grades`, `classImport`, `bulkResolve`) → **107 passed / 107**
- No regression to: Student Class Update & Import, Needs Review, approved-grade protection, stale-roster protection, duplicate protection, server authorization, old→new preview.

## Exact Real-World Workbook Tested

Structure exactly as described:

```
Student ID (blank for every row) | Student Name | MATH HW1 … MATH Akhlaaq | ENGLISH HW1 … ENGLISH Akhlaaq
(blank) | Amiir sakariye          | 3 … 3 | 3 … 3
(blank) | Axmed Cabdale Maxamuud  | 3 … 3 | 3 … 3
(blank) | C/raxmaan Cumar Farax   | 3 … 3 | 3 … 3
```

Result: **3 Needs-Review rows, 0 duplicate errors, 0 errors**. After choosing each student, **66 valid records** materialize (3 students × 2 subjects × 11 blocks), all scores intact. (Test H uses Arabic + English as the two authorized subjects; the subject names are arbitrary — the identity logic is subject-independent.)

## Final Verdict

**Fixed at the identity-resolution stage.** A missing Student ID now means "identity not yet resolved" (`null`), never `studentId = ''`. Blank IDs are matched by name against the current class roster into Needs Review, scores are preserved through manual selection, resolved records flow through the unchanged server-authoritative pipeline, and duplicate detection only fires on genuinely repeated **resolved** identities. Student IDs are **not** required, and duplicate detection was **not** disabled.

> **Answer to the acceptance question:** **Yes.** Teachers can upload their normal Google Sheets with the Student ID column left completely blank, have students resolved safely by name into Needs Review, choose the correct student (or exclude the row), retain all entered grades, and continue through the same server-authoritative `submit_bulk_grades` submission pipeline — with **no false duplicate errors**. A blank ID plus another blank ID never forms a duplicate; only the same *resolved* studentId + subject + assessment + term does.

## Note on Verification

Server behavior is verified against a real Postgres engine via **PGlite**, and the UI via typecheck + build + unit tests — **not** against the production database, and not click-tested in a live browser (no Supabase env in this workspace). Those specific claims are **NOT independently verified against the real production database**; final confirmation of the end-to-end click-through requires execution against the actual target environment.
