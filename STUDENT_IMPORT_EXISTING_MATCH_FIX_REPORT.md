# Student Import — Existing-Student Match Fix Report

**Date:** 2026-09-07
**Branch:** `arena/01a0772c-schoolnnnnass`
**Regression case:** `Badriya Cabdisamad Sicid`, Student ID = Gov ID = `17-015311`
**Migration added:** `supabase/migrations/20260906f_class_import_preflight.sql`

---

## Root Cause

The class import preview classifies every uploaded row against the **roster the
browser downloaded** (`getStudents()`), not against the live database. When that
client roster is incomplete/stale (pagination, a student created by another
admin since load, or a legacy student whose internal `id` differs from the
school's sheet ID), a row that is actually an **existing** student fails every
local key lookup and falls through to `new_student`. The new-student payload then
carries the row's ID/Gov ID. On commit the **server** (authoritative and
complete) detects the duplicate and rejects the whole atomic transaction:

> `Gov ID 17-015311 is already assigned — duplicate student not created.`

Two concrete mechanisms produced it:

1. **Stale/incomplete client roster.** The matcher only knows the students it
   was given. A row not present locally has no way to bind, and the old code
   treated "not matched + has name + valid class" as `new_student` without any
   final identity-collision check.
2. **Over-conservative unknown-Student-ID handling.** In the school's data the
   Student ID and Gov ID are frequently the *same value in two columns*, and
   legacy/transport-imported students carry a generated `id` (`student-…`) with
   `govId = 17-015311`. The sheet's Student-ID column `17-015311` does not match
   the generated `id` (→ "Student ID not found"), and the old code treated that
   unknown ID as a **blocker** even when the Gov ID *uniquely* matched —
   demoting a confident Gov-ID match to manual review (and, combined with #1,
   toward a false new student).

## Exact Failing Flow

```
Excel row: 17-015311 | 17-015311 | Badriya Cabdisamad Sicid | 7B
 → parser            : studentId=17-015311, govId=17-015311 (text)
 → matcher (local)   : student-id lookup miss (legacy id / stale roster)
                       gov-id match either missed (not in roster) or demoted
 → classification    : new_student        ← BUG
 → preview           : counted under New Students
 → buildCommitPayload: newStudents += { id:17-015311, govId:17-015311, … }
 → apply RPC (server): students with govId 17-015311 exists
                       → RAISE unique_violation → whole tx rolls back
```

## Why Existing Students Became New

A row became `new_student` whenever it was (a) not bound locally and (b) carried
a name + a valid class. There was **no guard that a `new_student`'s claimed
Student ID / Gov ID already belongs to an existing student**, and no
**server-side preflight** — the first authoritative check was the commit-time
duplicate rejection, which failed the entire batch rather than correcting the
classification.

## Matching Logic Before

- Student ID exact → match (strongest).
- Gov ID unique → match.
- Name + phone unique → match.
- Name alone → review.
- **Unknown Student ID forced any weaker match (including a unique Gov-ID match)
  into manual review**, and an unbound row with name+class became `new_student`
  with no identity-collision check.

## Matching Logic After

1. **Student ID** exact → match.
2. **Gov ID** unique → match — **and this is now a confident match even when the
   sheet Student ID is not found** (unknown Student ID is a warning, not a
   blocker). This handles id == govId and legacy generated ids.
3. **Name + normalized parent phone** unique → match (confident).
4. **Name alone** → `ambiguous` / manual review. **Never** auto-match, never new.
5. Unknown Student ID + **no** confident key → manual review.
6. **Identity-collision guard (new):** before a row can become `new_student`, its
   claimed Student ID and Gov ID are checked against the existing-identity sets;
   any collision → `ambiguous` (manual review), **never** a new student.
7. A new-student row is only created when it claims no existing identity.

A unique Gov-ID match now also keeps the unknown-Student-ID **warning** so the
admin still sees it, but it no longer blocks or misclassifies.

## Commit Payload Before

`buildCommitPayload` emitted any `new_student` row verbatim; it did not
re-verify that the new identity was free, so a misclassified existing student
reached `newStudents` and only the database stopped it (failing everything).

## Commit Payload After

- `newStudents` only ever contains rows that are `new_student` **and**
  `matchedStudentId === null`.
- A defense-in-depth `if (row.matchedStudentId) continue` guarantees a bound row
  can never become a new student regardless of its status flag.
- A class-change id is only emitted once (`claimedChangeIds`).
- New exported helper **`auditCommitPayload(payload, existingIdentityKeys(students))`**
  returns human-readable problems if any new student reuses an existing id/gov id
  or two new students collide — the explicit invariant
  *"newStudents contains only genuinely new identities."*

## Server-Side Defense

New migration **`20260906f_class_import_preflight.sql`**:

- **`check_class_import_payload(p_changes, p_new)`** — admin-only, **read-only**
  preflight. Authoritatively checks every change target exists/valid and every
  new student's id **and** gov id do **not** already exist, returning a full list
  of per-row problems (`already_exists_id`, `already_exists_gov`,
  `change_student_missing`, `bad_class`, `bad_transport`, in-file duplicates)
  instead of failing on the first. Nothing is written.
- **`apply_student_class_import(...)`** replaced with the same transport-aware,
  atomic behavior but with **descriptive** duplicate errors, e.g.:
  > `Badriya Cabdisamad Sicid already exists as "Badriya Cabdisamad Sicid". The
  > spreadsheet row (ID 17-015311) was classified as a new student but matches an
  > existing record — nothing was changed. Match the row to the existing student
  > instead of creating a duplicate.`
  The atomic rollback and all duplicate constraints are unchanged.

The UI calls the preflight on Confirm: any row the server says already-exists is
**moved to "Needs Review"** (excluded from this commit, with a one-click
"use this student" candidate) rather than failing the import. If the preflight
RPC is absent (older DB), it falls back to the existing atomic commit-time guard.

## UI Changes

- Confirm now runs the server preflight; misclassified existing students are
  surfaced in **Needs Review** with a clear message instead of a hard failure.
- Preview tabs remain mutually exclusive categories: **Class Changes / New
  Students / No Change / Needs Review / Errors & Duplicates**. There is no
  "Matched by Name" label anywhere; name-only rows appear as **Possible Match —
  Manual Review Required**. (The reported "Present Students / Matched by Student
  ID" wording is not present in this page's source — the page uses the tabs
  above and the counts derive directly from final row status.)
- Preview counts are produced from the same row statuses that build the payload,
  so the categories the admin sees are exactly what is committed.

## Tests Added

`src/lib/__tests__/existingMatchFix.test.ts` (13 tests):

- Existing id=govId=17-015311 + class change → `class_change`, never new (AC1/3/9).
- Same class → `no_change`, absent from payload (AC4).
- Existing student found **only** by gov id (legacy generated id) → `class_change`
  bound to the existing record (AC2/3).
- Name alone → manual review, never auto-match/new (AC6).
- Unknown Student ID + existing name, no confident key → review, never new (AC7).
- Row claiming an existing gov id but not locally matched → never new.
- Payload audit flags a new student reusing an existing gov id even when the
  preview roster was stale (the production failure path).
- All nine other real names with id=govId → existing, never new.
- Invariant: `newStudents` never contains a row bound to an existing student.
- Genuinely new child (no collision) → created exactly once.

## Regression Results

- `tsc --noEmit`: **clean**.
- `vite build`: **clean**.
- Vitest: **58 files, 579 tests pass** (added 13; previous 566).
- Existing class-import suite (matching, numeric IDs, bus transport, payload)
  continues to pass — no safety behavior weakened.

## Security Impact

- **No** weakening of duplicate protection: unique Gov ID index, duplicate
  Student/Gov checks, atomic single-transaction commit, admin-only SECURITY
  DEFINER RPCs all remain.
- Identity resolution is more conservative about **creating** students, never
  less: the new guard makes duplicate creation impossible even with a stale
  roster, and the server preflight is authoritative.
- The preflight and apply RPCs are admin-gated with pinned `search_path` and
  explicit grants; the preflight only reads.

## Final Verification

Traced end-to-end for `17-015311`:

```
Excel → parser (text ids) → matcher:
  id=govId=17-015311 present in roster → class_change bound to existing id  ✔
  only govId present (legacy id)      → class_change via gov_id            ✔
  roster stale (student missing)      → identity guard → Needs Review      ✔
                                         → server preflight also catches it
payload → newStudents NEVER contains 17-015311                            ✔
RPC     → descriptive message + atomic rollback if anything slips         ✔
```

Apply order is unchanged with one addition: `20260906 → b → c → d → e → f`.

```text
Existing students incorrectly classified as new: 0
Existing students sent to new-student INSERT payload: 0
Name-only automatic matches: 0
Duplicate student creation: 0
Atomic rollback preserved: YES
```
