# Safe Duplicate Batch Merge — how it works and why it is shaped this way

Admin → **Duplicate Students** → **Merge All Safe Duplicates**.

The individual guided merge (`preview_student_merge` → `get_merge_conflicts` →
`merge_duplicate_students_resolved`) stays exactly as it was. The batch adds one
thing only: an automated pass over the duplicate pairs that the **database can
prove are safe**, so administrators stop re-deciding the same obvious case
hundreds of times.

Everything below is enforced in
`supabase/migrations/20260925_safe_duplicate_batch.sql` (plus the prerequisite
fix in `20260926_fix_get_merge_conflicts_exam_identity.sql`). The UI renders the
server's verdict; it never computes one.

---

## 1. Why eligibility is server-side only

Three RPCs, all `SECURITY DEFINER`, all admin-only (role re-checked inside every
call), all with `EXECUTE` revoked from `PUBLIC`:

| RPC | Purpose | Writes |
|-----|---------|--------|
| `get_safe_duplicate_batch(p_limit, p_offset, p_include_excluded)` | paginated report: summary counts, per-reason exclusion counts, the exact safe pairs, the excluded pairs | none |
| `preview_safe_duplicate_batch(p_limit)` | dry run for the confirmation screen: the same report plus `dryRun`, `writesPerformed = 0`, `ready`, `chunkPlan`, `assertions`, `confirmPhrase`, `previewToken` | none |
| `merge_safe_duplicate_batch(p_pairs, p_chunk_size, p_confirm_phrase, p_reason, p_batch_id)` | executes **one** atomic chunk and returns per-pair results | yes |

The client list (`p_pairs`) is **advisory**. It can only *narrow* what the server
already decided:

* eligibility is recomputed from live rows at the start of every call;
* a pair that is not eligible server-side is reported `not_eligible_server_side`
  with its live exclusion codes — never merged;
* a pair the server never produced is reported `not_a_candidate`;
* an entry without both `keeperId` and `removedId` (for example
  `{ studentId, delete: true }`) is **rejected outright** with
  `Every reviewed pair must provide both keeperId and removedId…`. A malformed
  list can never fall back to "merge everything the server can find";
* the confirmation phrase and a ≤100-character batch id are validated, and an
  **existing** batch id is accepted only from the administrator who created it
  (`batch_id_not_owned` — see §3);
* `p_chunk_size` is clamped to the documented 1..50 window (default 25).

Nothing in `src/lib/db/duplicateStudents.ts` or
`src/pages/admin/SafeBatchMergePanel.tsx` filters, scores, or decides anything —
they call the RPCs and render the JSON.

### The three functions behind those RPCs are internal

`_safe_batch_candidate_pairs`, `_safe_batch_evaluate_pair` and
`_safe_batch_unhandled_child_rows` do the actual work. They are
`SECURITY DEFINER`, so they run as the function owner and see **every** student —
Gov IDs, parent phones, family ids, parent profiles and child-row counts that a
teacher's, parent's or supervisor's RLS policy would otherwise hide. Two layers
keep that power inside the admin flow:

* each one re-checks the project's standard guard
  (`current_profile_role()` must be `'admin'`, else `insufficient_privilege`);
* `EXECUTE` is revoked from `PUBLIC`, `anon` and `authenticated`, so no JWT role
  can call them directly at all.

The administrator's flow is unaffected: the RPCs call these helpers *inside*
their own `SECURITY DEFINER` chain, after their own admin check, and a
`SECURITY DEFINER` body runs with the owner's privileges.

---

## 2. The eligibility contract (ALL must hold)

Candidate grouping reuses the existing rule: same `name_match_key(name)` **and**
same current `className`, groups of two or more.

| Area | Rule | Result when it fails |
|------|------|----------------------|
| Group | exactly two records share name + class | `group_has_more_than_two_records` (review) |
| Name | normalized names identical, non-blank | `name_conflict` / `name_blank` (blocked) |
| Class | current class identical, non-blank | `class_conflict` / `class_blank` (blocked) |
| Parent | **exactly one** record has a parent assigned | `both_parents_assigned` (+`parent_conflict`) blocked; `both_parents_unassigned` review |
| Keeper | the parent-assigned record is kept — never "the older row", never the caller's "canonical" | — |
| Left | neither record is marked `LEFT` in transport | `student_marked_left` (review) |
| Gov ID | blank vs X → keep X (moved onto the keeper, never discarded); identical (`gov_id_match_key`) → safe; X vs Y → conflict | `gov_id_conflict` (blocked) |
| Gov ID | the value must not belong to a **third** student | `gov_id_belongs_to_third_student` (blocked) |
| Parent phone | keeper real + duplicate blank → safe; both blank → safe; identical after `normalize_phone` → safe; X vs Y → conflict; only the unassigned record has a phone → not authoritative | `parent_phone_conflict` (blocked) / `parent_phone_only_on_unassigned` (review) |
| Transport | same as phone: identical, keeper-only, or both blank | `transport_conflict` (blocked) / `transport_only_on_unassigned` (review) |
| Family ID | identical, keeper-only, or both blank | `family_id_conflict` (blocked) / `family_id_only_on_unassigned` (review) |
| Parent profile | the assigned parent actually exists | `parent_profile_missing` (blocked) |
| Enrollment | one open enrollment per side maximum; class + academic year must agree with each other and with the student's class; at least one open enrollment must exist | `multiple_open_enrollments`, `enrollment_class_conflict`, `enrollment_year_conflict` (blocked), `no_open_enrollment` (review) |
| Enrollment action | both open, same class + year → `consolidate`; only the duplicate has one → `transfer`; only the keeper has one → `preserve_history` | — |
| History | no conflicting identity in exams (`subjectId, examType, assessmentLabel, termId`), attendance (`date`), quiz attempts (`quizId`), release log (UTC day), report comments (`termId`) | `exam_conflict`, `attendance_conflict`, `quiz_conflict`, `release_conflict`, `report_comment_conflict` (blocked) |
| Children | the duplicate must have no rows in a student relationship the merge does not move (discovered from `pg_constraint`, not a hard-coded list) | `unhandled_child_dependency` (blocked) |

Severity: any code in the policy's `blockedCodes` → **blocked**; everything else
(ambiguous, not conflicting) → **needs individual review**. Both stay in the
individual queue. Nothing is ever silently discarded: a different parent, Gov ID,
phone, transport, class, exam/attendance/quiz/release/report result or an
ambiguous enrollment keeps the pair out of the batch.

The policy document itself is a function — `safe_duplicate_batch_policy()` — so
the UI, the tests and the database all read the same contract (policy id,
bilingual names and keeper rule, chunk configuration, required conditions,
field resolutions, exclusion explanations, blocked codes, invariants).

### Field resolution for every difference

Each pair carries the exact `mergeResolution` payload that
`merge_duplicate_students_resolved()` validates:

* `name`, `class_name`, `parent_id`, `parent_phone`, `transport` → `canonical`
  (the keeper's own values);
* `gov_id` → `canonical`, or `duplicate` when only the removed record has one, so
  the only recorded Gov ID is **preserved on the surviving Student ID**;
* history arrays → empty by construction (any conflict excludes the pair);
* `enrollment_resolution` → the action computed above.

After the shared merge returns, the batch **restores the keeper's raw `govId` and
`parentPhone`**: the individual RPC stores them normalized (`gov_id_key`,
`normalize_phone`), and the batch policy promises not to rewrite bytes it chose
to keep. The normalized key is identical, so the unique index is unaffected.

### The C/raxmaan Axmed Daahir case

```
C/raxmaan Axmed Daahir · Foundation A
  A: parent ahmed daahir aadan · phone 634572257 · transport 25   → KEEPER
  B: Unassigned               · phone 634453468 · transport 25   → removed?
```

Both records carry a **different** parent phone. The batch has no rule that says
"the parent-assigned phone always wins" (inventing one would silently discard
B's number), so the pair is excluded as `parent_phone_conflict` (blocked) and
stays in individual review, where an administrator can explicitly choose which
number survives. This is a permanent regression test:
`src/lib/__tests__/duplicateBatch.eligibility.db.test.ts` →
`REGRESSION (current screen): different parent phones → Needs individual review,
reason "Parent phone conflict"` (it seeds exactly the two records above and
asserts `safeCount = 0`, `blockedCount = 1`, `parent_phone_conflict`).

---

## 3. Preview → confirm → chunked execution

1. **Dry run.** `preview_safe_duplicate_batch()` writes nothing and says so
   (`dryRun: true`, `writesPerformed: 0`). It returns the exact pairs (keeper id,
   removed id, name, class, parent name, per-table history counts, enrollment
   action, reviewed fingerprint), the summary counts, the exclusion reasons, and
   `assertions` — a re-scan of the rows it is about to offer, so the claims on
   screen are verified rather than asserted.
2. **Confirmation gate.** Three checkboxes (keeper rule / nothing discarded /
   audit) **and** the typed phrase `MERGE SAFE DUPLICATES` are required before
   the button enables. There is no single-click destructive action, and the
   phrase is taken from the server policy, not hard-coded in the UI.
3. **Chunks.** One RPC call = one chunk = one atomic transaction, 25 merges by
   default (max 50). The panel loops chunks until the server reports
   `remaining: 0`, reusing the same `batchId`.
4. **Batch id ownership.** The id is client-supplied so one run accumulates into
   one aggregate row — so the server owns the identity check. Before any
   eligibility scan or merge it takes `pg_advisory_xact_lock(hashtext(batch id))`
   (which serialises two concurrent chunks that picked the same fresh id) and
   then requires `student_merge_batches.admin_id` to equal the acting
   administrator. Another administrator — or a legacy row with no owner — is
   refused with `batch_id_not_owned` (`insufficient_privilege`) having written
   **nothing**: no merges, no audits, no change to the aggregate row. The same
   administrator's later chunks accumulate normally, ownership and `created_at`
   are never rewritten, and the upsert itself only accumulates for the acting
   administrator.
5. **Per-pair results.** Every call returns `merged`, `skipped`, `blocked`,
   `failed` with ids, names and reasons, plus `totals` and `remaining`.

### Deterministic locking and staleness

* Both rows are locked `FOR UPDATE` in **Student ID order** — the same order the
  individual merge uses — so a batch and a single review cannot deadlock.
* Every pair carries a `fingerprint` (md5 over every field the contract depends
  on: both profiles, group size, enrollment rows, all history counts and
  conflicts, the computed action). The fingerprint the administrator reviewed is
  sent back and compared; the fingerprint is compared **again after locking**.
  A mismatch is reported `candidate_changed_since_preview` /
  `candidate_changed_during_batch` and skipped — never blind-merged.
* If a row vanished (another administrator merged it), the pair is skipped as
  `already_resolved`; pairs an earlier chunk of the same batch already merged are
  recognised through their audit rows and not reported twice.
* If any merge inside a chunk fails, the exception names the pair and **the whole
  chunk rolls back** — including the audits and history moves of the pairs that
  had already succeeded in that transaction. Chunk *n+1* is a fresh call.

---

## 4. Audit trail

* `student_merge_audits` — one row **per merged student**, with the full detail
  of an individual merge (`before_counts`, `after_counts`, `enrollment_action`,
  `exam_conflicts`, `reason`, `admin_id`) plus the new batch provenance columns
  `batch_id`, `batch_policy`, `batch_size` and `merge_kind`
  (`'safe_batch'`, default `'individual'` so the individual workflow is
  untouched). The reason string records which Student ID was kept, which record
  was removed, the policy id and the administrator's note.
* `audit_logs` — `students.merge` per merge (written by the shared RPC) and
  `students.merge_batch` per chunk, with the batch id, actor, policy, chunk
  size, counts, preserved and removed Student IDs and the audit ids.
* `student_merge_batches` — one row per batch id: administrator, policy, chunk
  size, chunks run, requested pairs, merged/skipped/blocked/failed counts,
  remaining eligible, and the full `chunk_results` JSON. The row belongs to the
  administrator who created it and `admin_id` is immutable — a second
  administrator can neither append to it nor adopt it. RLS: `SELECT` for
  admin/supervisor only, **no** write policies (RPC-only writes).

So "which students did this batch merge, under which policy, approved by whom,
and which Student ID survived?" is answerable from the audit tables alone.

---

## 5. Invariants asserted after every merge

* the keeper has **exactly one** open enrollment;
* the removed record has **0** open enrollments and **0** remaining rows in every
  student relationship before deletion;
* the removed record is deleted only after that zero-dependency verification;
* the kept Student ID is unchanged.

These come from the shared merge RPC (which raises if verification fails), are
published in `safe_duplicate_batch_policy()->'invariants'`, and are asserted
again by the tests.

---

## 6. Testing

| File | Runs against | Covers |
|------|--------------|--------|
| `src/lib/__tests__/duplicateBatch.eligibility.db.test.ts` | real PostgreSQL (PGlite) + the shipped migrations | every eligibility and exclusion rule, the C/raxmaan regression, order-independence of the pair evaluation, pagination, per-reason counts, performance on a few hundred candidate groups |
| `src/lib/__tests__/duplicateBatch.execution.db.test.ts` | real PostgreSQL (PGlite) | happy path + invariants, newer-record keeper, keeper byte preservation, Gov ID move, third-party rows untouched, per-merge audits + batch metadata, 25/25/10 chunking, chunk-size clamping, **whole-chunk rollback**, stale candidates, already-resolved pairs, server authority against forged/incomplete lists, phrase enforcement, anon/teacher/parent/supervisor denial, zero-write dry run, timings |
| `src/lib/__tests__/duplicateBatch.security.db.test.ts` | real PostgreSQL (PGlite) + `SET ROLE authenticated` | **Finding 1:** teacher/parent/supervisor/anon refused by all three internal helpers (`insufficient_privilege`, no PII in the error), helpers not executable by `anon`/`authenticated` while the four client RPCs still are, PostgreSQL-level denial under a real JWT role, admin flow (`get` → `preview` → `merge`) still working. **Finding 2:** batch creation, same-admin accumulation, cross-admin refusal with `batch_id_not_owned`, byte-identical aggregate row and zero writes after a refusal, second admin's own batch, same-admin retry idempotency, aggregate totals vs chunk results vs per-merge audits, uncorrupted per-merge detail, unadoptable `NULL` owner, server-generated ids, batch id as a bound value |
| `src/lib/__tests__/duplicateBatch.sqlAssertions.db.test.ts` | real PostgreSQL (PGlite) | executes `supabase/tests/safe-duplicate-batch.sql` |
| `supabase/tests/safe-duplicate-batch.sql` | any migrated database (`psql -v ON_ERROR_STOP=1`) | RPC existence/`SECURITY DEFINER`/no PUBLIC execute, policy contract, **internal-helper hardening** (admin guard present, still `SECURITY DEFINER`, not executable by `anon`/`authenticated`, client RPCs still granted), RLS on `student_merge_batches`, audit columns, delegation to the shared merge RPC, the `get_merge_conflicts` regression, **batch id ownership guard** (`batch_id_not_owned`, advisory lock taken before the check, guard before any merge, owner never rewritten) |
| `src/lib/__tests__/duplicateBatch.client.test.ts` | mock Supabase client | client wrappers, preview/summary/pairs/exclusions, refusals, staleness, execution, audits, individual workflow untouched |
| `src/pages/admin/__tests__/SafeBatchMergePanel*.test.tsx` | mock Supabase client (jsdom) | bilingual UI (EN/عربي), dry run first, confirmation gate, typed phrase, per-pair results, non-admin denial |

`src/lib/__tests__/pgDuplicateBatchHarness.ts` boots PGlite with the base schema,
the production security bridge and the loose-match helpers, then loads the real
migrations in order, so the SQL under test is the SQL that ships.

No production database is touched at any point: PGlite is in-process and
disposable, and the mock client only mutates in-memory demo tables.

---

## 7. Related files

* `supabase/migrations/20260925_safe_duplicate_batch.sql` — policy, evaluator,
  report/preview/execute RPCs, `student_merge_batches`, audit columns, grants, RLS
* `supabase/migrations/20260926_fix_get_merge_conflicts_exam_identity.sql` —
  quoted `"subjectId"` fix that unblocks the shared merge RPC
* `src/lib/db/duplicateStudents.ts` — batch types + thin RPC wrappers
* `src/pages/admin/SafeBatchMergePanel.tsx` — bilingual panel
* `src/pages/admin/DuplicateStudents.tsx` — page (individual workflow unchanged)
* `src/lib/i18n/AppLanguageContext.tsx` — `duplicateBatch.*` EN/عربي strings
* `src/lib/supabase.ts` — mock implementation of the three RPCs for preview mode
