# Student Import — Identity Matching Root-Cause Report

**Date:** 2026-09-07
**Branch:** `arena/01a0772c-schoolnnnnass`
**Migration added:** `supabase/migrations/20260906g_class_import_resolve.sql`
**Real regression students:** Xamda ibraahin Nur Jama (`16-005772`), Xamse Maxamed xasan (`23-920729`), Najax Xuseen Sh Cali (`21-359216`), Habon Ibrahim Nur Jama (`20-920750`).

---

## Exact Root Cause

Two assumptions in the identity pipeline were wrong for the school's real
Google Sheet:

1. **The school sheet has no internal Student ID column.** It carries the
   **Gov ID** (`Gov-id`, e.g. `16-005772`) as the authoritative external
   identifier, plus name, grade and bus. When the internal Student ID cell was
   blank, the row still had a perfectly good identity (its Gov ID) — but the
   code path that *generated a new internal id* ran for any row it failed to
   bind locally, instead of treating "no Student ID" as "keep matching by Gov
   ID". The message `no Student ID in the file — student-… will be assigned`
   therefore appeared for **existing** students.

2. **Matching trusted the browser-downloaded roster with fragile exact-string
   gov-id comparison.** The client classified every row against the
   `getStudents()` snapshot. A Gov ID that did not compare equal locally —
   formatting variance (spaces/quotes/dashes), or a record present in the live
   database but reconciled server-side — produced **no gov match**; the name was
   name-only (no phone in the sheet); so the row fell through to
   `new_student`. On commit the server's strict duplicate check caught it and
   failed the whole batch (`Gov ID already assigned`) — a broken "preview says
   new, commit fails" workflow.

So the failure point was: **identity resolution was decided entirely on the
client against an incomplete snapshot, using an over-strict key, and "no
internal Student ID" was conflated with "new person".**

## Why Student ID Missing Became New Student

`matchClassImportRows()` ran gov-id/name lookup; on any miss it reached the
not-matched branch. There, a row with a name + valid class was classified
`new_student`, and the blank Student ID immediately triggered
`generateNewStudentId()` — *before* identity resolution had been confirmed
against the authoritative database. A missing internal ID should only mean
"continue matching by Gov ID / name+phone", never "create".

## Current (before this fix) Matching Flow

```
Excel → header map → studentId? govId? name? phone?
  → exact internal Student ID → match
  → govId .trim().toUpperCase() EXACT against local snapshot → match
  → name + phone (local) → match
  → else: name-only → review (correct)
        BUT no gov/phone match locally → new_student + generated id (WRONG)
```

## Correct Matching Flow (after fix)

Identity priority, now enforced **client AND authoritatively on the server**:

```
1. Internal Student ID exact            → existing
2. Gov ID, NORMALIZED (alnum/uppercase), must be unique → existing   ← Gov ID is the key
3. Exact name + normalized phone, unique → existing
4. Name-only / ambiguous                 → MANUAL REVIEW (never new)
5. No identity AND no name collision      → NEW STUDENT (only now generate id)
```

- "No internal Student ID" simply moves matching to step 2 (Gov ID).
- A Gov ID identifies an existing student **even with the Student ID column
  absent**.
- The new internal ID is generated **only** after status is definitively
  `new_student` and the server confirms no identity/name collision.

## Gov ID Handling

- Added `normalizeGovId()` (client) and `gov_id_match_key()` (server): strip
  **all non-alphanumeric characters** and uppercase. `16-005772`,
  ` 16 005772 `, `"16-005772"` and `16005772` now compare equal. This is a loose
  **matching** key; the strict `gov_id_key()` still backs the unique index.
- Gov IDs remain text in the sheet; numeric Gov IDs are still a hard block
  (precision/leading-zero), unchanged.

## Student ID Handling

- A blank/internal Student ID is **never** itself a reason to create.
- The generated `student-…` id is only produced for a confirmed new student
  (defense in depth: a bound row can never be created; id generation is in the
  new-student branch only and echoed by the server).

## Authoritative Server Resolution (the main fix)

New admin, **read-only** RPC **`resolve_class_import_rows(p_rows)`**
(migration `20260906g`): for each uploaded row it returns a live-database
decision — `matched` (id + method + existing record), `ambiguous` (candidates,
never created), or `new` — using Student ID → normalized Gov ID → name+phone,
with name collisions forced to review. The page calls it after local matching
and applies the verdict (`applyServerResolutions()`):

- an existing student found by **Gov ID is bound** (`matchedStudentId` = their
  real internal id) and classified class_change / no_change;
- a name that exists server-side is moved to **Needs Review** (never created);
- only rows the server confirms absent remain new.

If the resolver RPC is unavailable (older DB), the flow falls back to the local
matcher plus the preflight and commit-time guards.

## New Student Decision Rules

A row becomes `new_student` only when: no internal-id match, **no normalized
gov-id match**, no name+phone match, **and the server finds no existing record
and no name collision**. The existing collision guard, `auditCommitPayload()`,
and the preflight all remain.

## Payload Before Fix

`newStudents` could contain `{ id: <sheet gov id or generated>, govId:
"16-005772", … }` for an existing child (client snapshot miss); the server then
rejected the batch.

## Payload After Fix

- `classChanges` → only rows bound to a real existing student
  (`studentId` = the database id, e.g. `student-xamda-1`), with Gov ID as match.
- `newStudents` → only rows the live server confirmed as genuinely new; never
  an id/gov-id that exists; never a name-collision row.
- New-student rows carry `govId` only for truly new children.

## UI Preview Before Fix

Existing child with a Gov ID but no internal Student ID appeared as
**New Student — "student-… will be assigned"**, and committing failed.

## UI Preview After Fix

- Each bound row shows **"Matched by Gov ID"** (or Student ID / name+phone /
  manual), the current vs uploaded class, and a Class Change / No Change
  result.
- A new row shows **"New student — no existing record found"**.
- After upload, an informational note reports how many rows the server
  confirmed as existing by Gov ID/phone and how many need review.
- Categories stay mutually exclusive; preview counts equal commit-payload
  categories.

## Exact Regression Cases (covered by tests)

- **Xamda** `16-005772`, no Student ID, 11-A→11-B → `class_change`,
  matchMethod `gov_id`, bound to existing internal id, **not** in `newStudents`.
- Xamda same class → `no_change`, no insert/update.
- Gov-id formatting variance (`" 23 920729 "` vs stored `23-920729`) → matched.
- All four real students (Xamse, Najax, Habon, Xamda) with gov ids → existing,
  4 class changes, 0 new.
- Gov id absent + name-only that exists → manual review, never new.
- Server finds by gov id what the empty local roster missed →
  `applyServerResolutions` converts new→class_change; payload has 0 new.
- Server finds only the name → row forced to review; 0 new.
- Truly new child (no id/gov/name collision) → created once.

## Tests

- New/extended `src/lib/__tests__/existingMatchFix.test.ts` — **21 tests**,
  including the four real students, no-Student-ID + Gov ID matching, formatting
  variance, name-only review, and server-resolution override.
- Full suite: **59 files, 590 tests pass**.

## Typecheck

`tsc --noEmit` — **clean**.

## Build

`vite build` — **clean** (single-file bundle produced).

## Final Verification

Apply order now: `20260906 → b → c → d → e → f → g`. After `g`, identity is
resolved against the live database before preview, so Xamda (`16-005772`) is
recognized as the existing student and updated — never inserted as new.

```text
Existing students with Gov ID matched correctly: 4 of 4 tested (gov-id present, no Student ID column)
Existing students incorrectly classified as new: 0
Existing students sent to newStudents[]: 0
Name-only automatic matches: 0
Unnecessary generated Student IDs: 0
Duplicate student inserts: 0
Class changes correctly classified: 4 (11-A→11-B etc.)
No-change students correctly classified: covered (same class → no_change, no update)
```
