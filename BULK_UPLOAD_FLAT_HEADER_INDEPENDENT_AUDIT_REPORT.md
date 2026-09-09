# Bulk Upload Grades — Independent Audit Report

Auditor: independent review (skeptical, reproduce-don't-trust)
Date: 2026-09-09
Branch: `arena/01a08666-schoolnnnnass`
Base: `e2e983267e97044e3246d5a70e4acdaa3bbbc848`

---

# Executive Verdict

```
GO WITH CONDITIONS
```

The grade pipeline is **safe on the dimensions that matter most**: right student, right
subject, right assessment, right score, right authorization, right database result.
All of these were proven by **execution**, including against a real PostgreSQL engine.

However, this audit must open with a correction that invalidates a large part of the
audit brief itself.

## ⚠️ The audit brief describes a change that does not exist in this repository

The brief asks me to verify a "flat header rewrite" with `Student Name` first,
`ENGLISH HW1` uppercase headers, a `__RosterMetadata` hidden sheet, 78 columns, and a
`scripts/verify-bulk-upload-flat-header.ts`. It also quotes a prior report claiming
"73 test files, 781 tests".

**None of that is in this branch.** The actual diff vs. the base commit is 5 files:

```
BULK_UPLOAD_FLAT_HEADER_HALF_POINT_FIX_REPORT.md | 202 +
src/lib/__tests__/half-point-scores.test.ts      | 213 +
src/lib/scores.ts                                |  65 +
src/pages/admin/gradeCorrectionUtils.ts          |   9 +-
src/pages/teacher/UploadResults.tsx              |  35 +-
```

Verified absences (EXECUTED — `grep`/`ls` across `src/` and `scripts/`):

| Claimed artifact | Reality |
| --- | --- |
| `scripts/verify-bulk-upload-flat-header.ts` | **does not exist** |
| `__RosterMetadata` hidden sheet | **zero occurrences anywhere in the repo** |
| Uppercase `ENGLISH HW1` emission | **no `toUpperCase` in `src/lib/bulk-grades/`** |
| `Student Name` as column 1 | **false — column 1 is `Student ID`** |
| 78 visible columns | **false — 79 (`Student ID` + `Student Name` + 77)** |
| Changes to `subjectOrder.ts` / `workbook.ts` / `resolve.ts` / `BulkUploadGrades.tsx` | **unmodified in this branch** |
| "781 tests / 73 files" | **false — 799 tests / 74 files** |

The workbook format was deliberately left unchanged: the user explicitly instructed
*"leave the excel as is what i want is that hw and CPW to accept 3.5 or 4.5"*. The
implemented change was scoped to half-point acceptance in manual score entry.

**Sections 9, 10, 24 of the brief (hidden-metadata security) are therefore
non-applicable — there is no hidden metadata to attack.** This is the safest possible
outcome for those sections: an identity-authority attack surface that was hypothesised
simply does not exist. I verified this by exhaustive search rather than by assumption.

The single condition on this GO is documentation drift, not code risk (see Conditions).

---

# Scope

Independently audited by execution:

* the real generated XLSX (freshly built, written to disk, re-read from disk, and
  unzipped to raw OOXML)
* `workbook.ts` generator + parser contract, header normalization, round trip
* `resolve.ts` identity resolution, Needs Review, duplicate detection, authorization
* `excel-parser.ts` `interpretScoreCell` half-step validation
* `scores.ts` (new) and its use in `UploadResults.tsx`
* `submit_bulk_grades` and `admin_correct_grade` **executed as real PL/pgSQL** via PGlite
* the `exams` NUMERIC column and its half-step CHECK constraint
* the full regression suite, typecheck, and build
* downstream report calculations for integer-casting damage

---

# Evidence

## EXECUTED (reproduced first-hand)

1. Fresh workbook generation, all 7 subjects × 11 blocks → header sequence, column
   count, merges, sheet list.
2. Raw OOXML inspection of `xl/worksheets/sheet2.xml` (cell types, protection,
   validation, formulas, hidden flags, merges).
3. Column-shift and subject-cross-wiring probes with unique per-cell values.
4. Header case/whitespace/unknown-token probes (11 variants).
5. Duplicate-column and missing/extra-header probes.
6. Blank-Student-ID resolution, ambiguous names, no-candidate names, similar names.
7. Two blank-ID rows resolved to the *same* student → duplicate detection ordering.
8. Unauthorized-subject injection via edited header (client resolver **and** server RPC).
9. Stale/wrong-class Student ID.
10. Full E2E: XLSX → parser → resolver → **real `submit_bulk_grades`** → `SELECT` from
    `exams`, asserting `score::text`.
11. Quarter-point and over-maximum rejection at the real RPC and the DB CHECK.
12. Idempotency: same key + different payload.
13. `npm run typecheck`, `npm run test:ci`, `npm run build`.
14. Confirmed the `.db` suites actually run (PGlite present) rather than self-skipping.

## STATICALLY VERIFIED

* `submit_bulk_grades` `SECURITY DEFINER` body: role gate, `search_path`, server-derived
  `teacherId`/`status`/`uploadedBy`, assessment/type/total whitelist.
* `reports.ts` arithmetic reviewed for destructive casts.
* UI gating logic in `BulkUploadGrades.tsx` (`canValidate`, `pendingReviews`).

## NOT VERIFIED

* **Live browser UI walkthrough** (§41). No Supabase credentials in this sandbox
  (`Missing VITE_SUPABASE_URL`), so the click-path was verified by executing the
  underlying pure functions and reading the gating logic, not by driving the DOM.
* **Real Excel / real Google Sheets** file compatibility (§28). I tested
  SheetJS-generated and hand-built workbooks; no genuine Excel/Google binaries were
  available offline.
* **Production-scale performance** (§39). Reviewed algorithmically (linear passes,
  `Map`-based lookups, no N+1); not load-tested.
* `npm ci` needs `--ignore-scripts` here (Supabase CLI postinstall TLS failure) —
  environmental.

---

# Header Verification

Freshly generated, all 7 subjects passed in **deliberately scrambled** order
(Tarabiya, Arabic, Somali, Social, Science, Math, English):

```
COLCOUNT     79
FIRST3       ["Student ID","Student Name","English HW1"]
SUBJECT_SEQ  ["English","Math","Science","Social","Somali","Arabic","Tarabiya"]
ENGLISH_BLOCK ["English HW1","English HW2","English HW3","English HW4",
               "English CPW1","English CPW2","English CPW3","English CPW4",
               "English Attendance","English MT","English Akhlaaq"]
MERGES       none
SHEETS       ['Instructions','Grades']
```

* **One flat header row** — confirmed; `mergeCells: False` in raw XML. PASS
* **Canonical subject order** — enforced despite scrambled input. PASS
* **Canonical assessment order** — exact for every subject. PASS
* **No max marks in header names** — confirmed. PASS
* **Column 1 is `Student ID`, not `Student Name`** — differs from the brief, matches
  the user's "leave the excel as is" instruction. Column count is 79, not 78.
* No `sheetProtection`, no `dataValidation`, no formulas, no hidden rows/columns/sheets.
  Teachers can freely copy/paste. PASS

---

# Parser Verification

Generator emits `${subjectName} ${blockDisplayName(label)}`; the parser takes the **last
whitespace token** as the assessment and the remainder as the subject, so multi-word
subjects survive. Both sides derive from the single `ASSESSMENT_DEFINITIONS` table —
there is no divergent second definition.

Header tolerance (EXECUTED, with a Student ID column present):

| Header | Result |
| --- | --- |
| `ENGLISH HW1` | → `ENGLISH/HW1` ✅ |
| `English HW1` | → `English/HW1` ✅ |
| `  English HW1  ` | → `English/HW1` ✅ (trimmed) |
| `english hw1` | → `english/HW1` ✅ |
| `ENGLISH Attendance` / `ENGLISH ATTENDANCE` | both → `ATTENDANCE` ✅ |
| `ENGLISH MT`, `ENGLISH Akhlaaq` | → `MT`, `AKHLAAQ` ✅ |
| `ENGLISH TEST99` | `UNKNOWN_COLUMN` (rejected, not guessed) ✅ |
| `ENGLISH HW1 5` | `UNKNOWN_COLUMN` (max-in-header rejected) ✅ |
| `UNKNOWNSUBJ HW1` | parsed as subject `UNKNOWNSUBJ` → later **denied** as unauthorized ✅ |

Assessment tokens are matched **case-insensitively**; the subject string is preserved
verbatim and mapped later via alias normalization. Critically, uppercase headers still
resolve to the correct subject row:

```
"ENGLISH HW1","MATH HW1","SOCIAL Attendance","TARABIYA Akhlaaq","ARABIC MT"
→ sub-eng/HW1/Homework/4.5   sub-math/HW1/Homework/2
  sub-soc/ATTENDANCE/Attendance/19.5   sub-tar/AKHLAAQ/Discipline/9.5
  sub-ara/MT/Quiz/17.5      unauthorizedSubjects = []
```

Aliases resolved `Mathematics`, `Social Studies`, `Tarbiya` correctly. **So even if the
brief's uppercase format were pasted in by a teacher, it maps correctly.** PASS

**Column-shift / cross-wiring** — unique value per cell, two subjects, re-read from disk:

```
English HW1=1 HW2=2 HW3=3 HW4=4 CPW1=10 CPW2=11 CPW3=12 CPW4=13
        ATTENDANCE=14 MT=15 AKHLAAQ=9.5
Math    HW1=2 (distinct from English) ... AKHLAAQ=8.5
errors: []
```

Mapping is header-driven, not positional: reordering columns
(`HW2, HW1, HW3`) still yielded `HW2=2, HW1=1, HW3=3`. PASS

**Duplicate/missing/extra headers**: exact duplicates and case-variant duplicates
(`English HW1` + `ENGLISH HW1`) both raise `UNKNOWN_COLUMN` (duplicate branch) — no
silent collision, no last-write-wins. A removed column simply yields no record for that
assessment; values never shift. PASS

**Sheet renaming**: the parser falls back to the first non-Instructions sheet, so a
Google-Sheets-renamed `Sheet1` still parses (`errs=[] cols=1`). PASS

---

# Identity Resolution

| Scenario | Result |
| --- | --- |
| Blank ID, unique name match | → **Needs Review** with 1 candidate, `validCount=0`. Never auto-assigned. ✅ |
| Blank ID, 2 identical roster names | → Needs Review with 2 candidates, no auto-pick. ✅ |
| `Axmed Cabdi` vs `Axmed Cabdi Hassan` | Only exact normalized name matches; the longer name is **not** fuzzy-matched in. ✅ |
| Blank ID, no candidate | → hard error, row removable. ✅ |
| Wrong-class Student ID | → `"...is not currently in Grade 5-A"`, `validCount=0`. ✅ |

**Blank-ID duplicate ordering (historical bug area):** parse yields
`studentId = null` (explicitly *not* `""`), and three blank rows produced **zero** false
duplicates. Dedup runs *after* identity resolution and skips unresolved IDs. When both
rows were manually resolved to the same student, the duplicate was then correctly
detected: `"Duplicate HW1 for Amiir Sakariye"`. Order is
`identity → concrete ID → dedup`, exactly as required. PASS

**UI gate:** `canValidate` requires `pendingReviews === 0 && blockingCount === 0`, so no
unresolved identity can reach the server. PASS

**§12 caveat:** the parser *requires a `Student ID` column to exist* (blank **values**
are fine). A pure Google Sheet with only `Student Name` is rejected with
`MISSING_HEADER`. See Finding F-2.

---

# Hidden Metadata Security

**NOT APPLICABLE — no hidden metadata exists.** Exhaustive search for
`__RosterMetadata`/`RosterMetadata` returned zero hits; the workbook contains exactly
two visible sheets and the raw XML shows no `hidden="1"`. There is no hidden identity
authority, therefore §9/§10/§24 attacks are structurally impossible. Identity comes
only from the visible `Student ID` cell or human Needs-Review selection, and the server
re-validates it regardless. PASS (by absence)

---

# Half-Point Verification

`interpretScoreCell` uses a full-string regex `^\d+(?:\.[05])?$` — no `parseInt`, no
rounding.

| Input | Outcome |
| --- | --- |
| `0`, `0.5`, `4`, `4.5`, `5` (HW /5) | accepted exactly |
| `12.5`, `14.5`, `15` (CPW /15) | accepted exactly |
| `17.5`, `19.5`, `20` (MT/Att /20) | accepted exactly |
| `9.5`, `10` (Akhlaaq /10) | accepted exactly |
| `4.25`, `4.75`, `12.25` | rejected (`not_half_step`) |
| `5.5`, `15.5`, `20.5`, `10.5` | rejected (over max) |
| `-0.5`, `-1`, `abc`, `4abc`, `Infinity`, `1e999` | rejected |
| blank | `blank` — **no score row emitted, never 0** |

Excel cell types (raw XML): `4.5`, `12.5`, `3.5` are stored as **numeric** cells
(no `t="str"`), while untouched cells are empty strings — mathematically exact. PASS

**The genuine bug the implementation fixed** (independently confirmed by reading the
base commit): `UploadResults.tsx` used `parseInt(s.score)` on submit, so a manually
entered `4.5` was written to the database as `4`. That is real, silent grade corruption
on the manual-entry path, now fixed via `parseScoreInput`. The new `scores.ts` rule is
consistent with both the parser regex and the DB CHECK.

---

# Server/RPC Verification

Executed against real PostgreSQL (PGlite) running the **actual shipped migrations**.

Full chain — generate XLSX → write to disk → re-read → parse → resolve → real RPC →
`SELECT ... score::text FROM exams`:

```
RPC = {"message":"Bulk grade upload completed.","insertCount":6,"updateCount":0,
       "skippedCount":0,"requiresConfirmation":false}

STORED (score as text, so no float formatting can hide truncation):
 S1 ara MT         17.5 /20 Quiz       pending
 S1 eng CPW1       12.5 /15 Classwork  pending
 S1 eng HW1         4.5 /5  Homework   pending
 S1 math HW2        3.5 /5  Homework   pending
 S1 soc ATTENDANCE 19.5 /20 Attendance pending
 S1 tar AKHLAAQ     9.5 /10 Discipline pending
```

Every value landed on the correct student, subject, assessment, exam type, and total,
with status forced to `pending`. PASS

| Server control | Result |
| --- | --- |
| Unauthorized `Science` injected into payload | `"Teachers may upload only their assigned class subjects."` ✅ |
| Quarter point `4.25` | `"...only whole or half points are allowed..."` ✅ |
| Direct quarter-point INSERT | blocked by the `exams` CHECK ✅ |
| Same key + **different** payload | `"This upload key was already used with a different account or payload."`; stored value stayed `4` ✅ |
| Wrong class / wrong teacher / anon | denied (existing suite, re-run) ✅ |
| Tampered `teacherId`/`parentId`/`status`/`uploadedBy` | ignored, server-derived ✅ |
| Atomicity | one bad record ⇒ **zero** rows committed ✅ |

`SECURITY DEFINER` with a pinned `search_path`, role check via
`current_profile_role()`, ≥12-char idempotency key, and RLS + a status-guard trigger
that forces teacher-inserted `approved` back to `pending`. No caller-controlled
identity or approval state. The header format change (none) did not touch this boundary.

---

# Regression Verification

```
npm run typecheck   PASS  (tsc --noEmit, no errors)
npm run test:ci     PASS  74 files, 799/799 tests, 47.26s
npm run build       PASS  2536 modules, 13.86s, dist/index.html 5,787.42 kB
```

**Test-integrity check (§36):** the `.db` suites use
`const d = AVAILABLE ? describe : describe.skip` and would silently skip without PGlite.
I confirmed PGlite **is** installed and the suites genuinely executed — e.g.
`submit_bulk_grades ... ALLOWED: Teacher A -> Student A -> Arabic commits exactly one
row`, `IDEMPOTENCY`, `ATOMICITY`, plus 9 RLS tests and 7 half-point DB tests, all
running real PL/pgSQL against the shipped migration files rather than re-typed SQL.
No `describe.skip`/`it.skip` was added by this change; the only `.skip` entries are the
pre-existing PGlite fallbacks. The half-point tests genuinely open and parse a real
XLSX rather than asserting constants. Counts are 799/74, **not** the 781/73 claimed.

Report calculations: `Math.round` appears only on **derived percentages/averages**, never
on `score` itself. A stored `12.5/15` yields `83%` while `score` remains `12.5`. No
integer cast on the stored value in `reports.ts`, and the DB column is `NUMERIC`. PASS

---

# Security Findings

**No Critical or High security findings.**

* **S-1 (INFO)** — hypothesised hidden-metadata identity bypass is not exploitable: the
  feature does not exist.
* **S-2 (INFO)** — spreadsheet headers cannot grant authorization; an edited/injected
  subject is rejected independently by both the client resolver and the server RPC.
* **S-3 (LOW)** — `UNKNOWNSUBJ HW1` is accepted by the *parser* and only rejected later
  as unauthorized. Correct outcome, slightly late error message. No action required.

# Functional Findings

* **F-1 (MEDIUM) — documentation drift / false claims.**
  The prior report and the audit brief both describe artifacts that don't exist
  (`__RosterMetadata`, 78 columns, `Student Name` first, uppercase headers, a verify
  script, 781 tests). *Root cause:* reports written against an intended design rather
  than the shipped diff. *Risk:* a future engineer may "fix" the parser to match a
  format that was never built. *Fix before production:* not a code blocker — reconcile
  the docs. This audit report supersedes those claims.

* **F-2 (MEDIUM) — a `Student ID` column is structurally required.**
  Reproduce: build a sheet with headers `Student Name | ENGLISH HW1 | ...` and no
  `Student ID` column → `MISSING_HEADER: The workbook must contain a "Student ID"
  column.` Blank *values* work fine (→ Needs Review), but the *column* must be present.
  This contradicts the brief's §11/§12 "clean Google Sheet" workflow. It is a
  deliberate, safe design (fail-closed, not silent mis-assignment) and matches the
  user's "leave the excel as is". *Fix only if* the pure-Google-Sheet workflow is
  actually wanted — then accept a missing ID column and route all rows to Needs Review.

* **F-3 (LOW)** — `GradeQuizzes.tsx:60` still uses `parseInt` for quiz question points.
  Separate integer-by-design feature, out of scope; flagged for future half-point quizzes.

* **F-4 (INFO)** — the parser accepts a renamed worksheet, which is good for Google
  Sheets round trips.

# Performance Findings

* **P-1 (INFO)** — generation and parsing are linear in students × columns; roster and
  subject lookups use `Map`s (`rosterById`, `rosterByName`, `authorizedByAlias`). No
  N+1 queries introduced; the roster is fetched once per class. A 79-column × 40-student
  workbook generated and parsed in well under 100 ms. Not load-tested at full school
  scale (NOT VERIFIED).

---

# XLSX Verification

A fresh workbook was generated **during this audit** (not reusing any prior `/tmp`
file), written to `/tmp/audit_e2e.xlsx` and `/tmp/audit_shift.xlsx`, re-read **from
disk**, parsed, and additionally unzipped to inspect raw OOXML. Confirmed: one header
row, no merges, no protection, no data validation, no formulas, no hidden content,
correct sheet order, numeric half-point cells.

---

# Reproduction Steps

**F-2 (missing Student ID column):**
1. Create a sheet: `Student Name | ENGLISH HW1 | ENGLISH HW2`, rows with names + scores.
2. Save as `.xlsx`; call `parseRosterWorkbook(bytes)`.
3. Observe `issues = [{code:'MISSING_HEADER', ...}]` and `students = []`.

**F-1 (doc drift):** `grep -rn "__RosterMetadata" src scripts` → no matches;
`git diff --stat <base>..HEAD` → 5 files, none of them `workbook.ts`.

---

# Required Remediation

No Critical or High findings ⇒ **no mandatory pre-production code fix.**

Recommended (non-blocking):
1. **F-1** — correct/retire the inaccurate claims so future work isn't misled.
2. **F-2** — decide explicitly whether the ID-less Google Sheet workflow is required.

---

# Answers to the 12 Critical Questions

1. **Clean Google Sheet with no Student IDs?** — Partially. Blank ID *values* are fully
   supported and route to Needs Review. A sheet with **no `Student ID` column at all**
   is rejected with a clear message (F-2). It fails closed, never unsafely.
2. **Can hidden metadata mis-assign a grade?** — No. No hidden metadata exists.
3. **Can reordering/editing land a score on the wrong assessment?** — No. Mapping is
   header-based; reordering preserved correct mapping; unknown headers are rejected.
4. **Does `4.5` reach `exams.score` exactly?** — Yes. Verified `score::text = '4.5'`.
5. **Does `12.5` reach `exams.score` exactly?** — Yes. Verified `'12.5'`.
6. **Can `4.25` pass?** — No. Rejected at the parser, the RPC, and the DB CHECK.
7. **Can a flat header grant an unauthorized subject?** — No. Denied client-side and by
   the RPC (`"Teachers may upload only their assigned class subjects."`).
8. **Class bypass via metadata?** — No. No metadata; wrong-class IDs are rejected.
9. **False duplicates from blank IDs?** — No. Blank is `null`, excluded from dedup;
   dedup runs only on resolved IDs.
10. **Repeated uploads causing bad overwrites?** — No. Same key + different payload is
    rejected; approved overwrites require explicit acknowledgement and reset to pending.
11. **Does the XLSX match the claimed 78-column structure?** — **No.** It is 79 columns
    beginning with `Student ID`. The claim is wrong; the artifact is internally
    consistent and correct for the shipped design.
12. **Does the parser interpret every flat header as intended?** — Yes, including
    uppercase, mixed case, and padded variants; unknown tokens are rejected, not guessed.

---

# Final Acceptance Matrix

| Requirement | Result | Evidence |
| --- | --- | --- |
| Flat single header | **PASS** | `mergeCells: False`; one header row |
| Exact subject order | **PASS** | scrambled input → English…Tarabiya |
| Exact assessment order | **PASS** | HW1–4, CPW1–4, Attendance, MT, Akhlaaq |
| Optional Student ID | **PARTIAL** | blank values OK; column required (F-2) |
| Hidden metadata safe | **N/A (PASS)** | feature does not exist |
| Blank-ID workflow | **PASS** | `studentId=null`, no false duplicates |
| Needs Review | **PASS** | candidates listed, never auto-picked; UI gated |
| Half points | **PASS** | `4.5/12.5/17.5/19.5/9.5` stored exactly |
| Quarter points rejected | **PASS** | parser + RPC + DB CHECK |
| Parser round trip | **PASS** | disk round trip, zero errors |
| Subject mapping | **PASS** | 5 subjects → correct subjectIds |
| Assessment mapping | **PASS** | unique-value shift test, 2 subjects |
| Teacher authorization | **PASS** | Science injection denied by RPC |
| Class authorization | **PASS** | wrong-class ID rejected; stale roster test |
| Idempotency | **PASS** | same key + different payload rejected |
| Existing upload regression | **PASS** | 799/799 tests |
| Reports preserve decimals | **PASS** | `Math.round` only on percentages |
| Real XLSX verified | **PASS** | fresh file + raw OOXML inspection |
| Flat header = `Student Name` first | **FAIL vs brief** | col 1 is `Student ID` (intended) |
| Uppercase `ENGLISH HW1` emitted | **FAIL vs brief** | emits `English HW1` (intended); uppercase still parses |

---

# Conditions on the GO

1. Accept that the shipped format is `Student ID | Student Name | <Subject> <Block>`
   (79 columns), **not** the brief's 78-column `Student Name`-first uppercase layout.
   If the flat/uppercase format is genuinely wanted, that is a **new change request**,
   not a verification gap.
2. Reconcile the inaccurate prior claims (F-1).
3. Decide whether the no-ID-column Google Sheet workflow is required (F-2).
4. Browser-level UI walkthrough, real Excel/Google file compatibility, and scale
   performance remain **NOT VERIFIED** in this offline sandbox.

---

```
FINAL VERDICT:
GO WITH CONDITIONS
```

The core safety property — **right student + right subject + right assessment + right
score + right authorization + right database result** — was demonstrated by execution
end-to-end against a real PostgreSQL engine, including adversarial probes for column
shifting, cross-wiring, unauthorized subjects, stale rosters, ambiguous identities, and
truncation. No Critical or High findings. The conditions are documentation accuracy and
one deliberate design decision, not defects in the grading pipeline.
