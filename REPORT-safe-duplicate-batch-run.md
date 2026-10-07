# Safe Duplicate Batch Merge — dry run, execution and production runbook

**Feature:** Admin → Duplicate Students → **Merge All Safe Duplicates**
**Date:** 2026-10-07
**Branch:** `arena/5dcf57e3-schoolnnnnass`

---

## 1. What the architecture is

The batch is decided by the database, never by the browser. The page and the
operator runner are thin transports for two `SECURITY DEFINER` RPCs.

| Object | File | Role |
| --- | --- | --- |
| `safe_duplicate_batch_policy()` | `supabase/migrations/20260925_safe_duplicate_batch.sql` | the documented policy — single source of truth for the keeper rule, the 18 required conditions, the exclusion codes and the confirmation phrase |
| `_safe_batch_evaluate_pair(a, b, group_size, deep)` | same | the eligibility contract for ONE pair. Chooses the keeper, runs every gate, returns evidence + a staleness fingerprint |
| `_safe_batch_candidate_pairs(deep)` | same | set-based candidate discovery (same grouping key as `get_duplicate_candidates`) |
| `_safe_batch_unhandled_child_rows(student)` | same | FK safety net — walks `pg_constraint` at runtime so a new table referencing `students` can never be silently cascaded away |
| `get_safe_duplicate_batch(limit, offset, include_excluded)` | same | summary-first, paginated eligibility report |
| `preview_safe_duplicate_batch(limit)` | same | **dry run** — `STABLE`, zero writes, returns the pairs, the assertions and a chunk plan |
| `merge_safe_duplicate_batch(pairs, chunk_size, phrase, reason, batch_id)` | same | **execution** — one atomic chunk per call, delegates each accepted pair to the existing `merge_duplicate_students_resolved()` |
| `student_merge_batches` | same | batch run metadata (owner, policy, per-chunk results) |
| `student_merge_audits.batch_id / batch_policy / batch_size / merge_kind` | same | batch provenance stamped onto the **existing** per-merge audit row |

Client transport (no eligibility logic):
`previewSafeDuplicateBatch`, `reviewedPairsFromPreview`, `runSafeDuplicateBatchChunk`
in `src/lib/db/duplicateStudents.ts`; UI in `src/pages/admin/SafeBatchMergePanel.tsx`,
mounted by `src/pages/admin/DuplicateStudents.tsx`.

**Keeper rule:** the *parent-assigned* record is kept, the unassigned duplicate is
merged into it and removed only after transactional verification. The keeper is
never chosen by record order, age, or a caller-supplied "canonical" label.

**Batch policy:** KEEP = parent-assigned record. MERGE = unassigned duplicate.
Anything ambiguous stays in the existing individual guided review
(`20260922` + `20260924`), which is untouched.

---

## 2. What changed in this session

The feature itself was already present and complete in the repository. Three
things were added/fixed:

1. **`src/lib/__tests__/webpush.test.ts`** — the suite was red before this work.
   The last commit (`2e61463`, *"Change VAPID return format from 'p' to 'k'"*)
   moved `server/lib/webpush.ts:226` to the RFC 8292 §4.1 form
   `vapid t=<jwt>, k=<key>`, but the test still asserted the pre-RFC `p=` alias.
   The assertion now parses the two parameters instead of substring-matching, so
   a base64 payload that happens to contain `p=` cannot make it flaky.
2. **`scripts/safe-duplicate-batch-run.mjs`** (new) — operator runner. Performs
   the preview → confirm → chunked-merge sequence and prints an auditable
   transcript. Two targets: `pglite` (real PostgreSQL in-process, seeded with a
   reproducible reproduction — no production data) and `supabase` (the live
   project). `--execute` refuses to start without `--yes`; the server
   additionally requires the typed phrase `MERGE SAFE DUPLICATES`.
   npm: `npm run safe-batch`, `npm run safe-batch:rehearse`.
3. **`src/lib/__tests__/duplicateBatch.pageVsServer.test.ts`** (new) — pins down
   the divergence found in §5 so nobody "fixes" one side and silently changes
   which students get merged.

No change was made to the eligibility rules, the keeper rule or the merge
logic. Broadening eligibility to hit a target count would be the wrong fix.

---

## 3. Dry run (executed)

`npm run safe-batch` — real PostgreSQL (PGlite), the four shipped duplicate-merge
migrations applied, seeded to reproduce the reported screen.

```
Safe preview (dry run) — computed by the database, not by this script
  policy                         safe_batch_parent_assigned_keeper
  keeper rule                    The parent-assigned record will be kept. The unassigned duplicate will be merged into it.
  candidate pairs                278
  ELIGIBLE (safe merges)         254
  excluded                       24
    └ needs individual review    24
    └ blocked                    0
  records to be removed          254
  Student IDs preserved          254
  chunk plan                     11 chunk(s) × 25 (atomic per chunk)
  dry run / writes               true / 0

  Why the excluded pairs stay in individual review
      24 × both_parents_unassigned — Neither record has a parent assigned — no keeper under the batch rule

  ✓ every server-side safety assertion holds across all eligible rows
  ✓ preview reports dryRun=true, writesPerformed=0
  ✓ preview wrote nothing — 20 public tables byte-identical before and after
```

Per-pair evidence returned by the dry run (sample):

```
s-safe-36-k>s-safe-36-r
  Abdi Kaafi Xasan 036  [Grade 1-A]
  KEEP   s-safe-36-k  (parent-assigned: true, parent Parent Of 36)
  MERGE  s-safe-36-r  (parent: unassigned)
  enrollment action: consolidate   history preserved: exams 1+2, attendance 1+3, quizzes 0+1, releases 0+1
  evidence: candidate_group_has_exactly_two_records, same_normalized_name, same_current_class,
            exactly_one_parent_assigned, keeper_is_parent_assigned, gov_id_keeper_only,
            parent_phone_keeper_only, no_transport, no_family_id, parent_profile_exists,
            enrollment_consolidate, no_history_conflicts, history_transfer_safe
```

**Zero-write proof.** The runner snapshots `count(*)` and an md5 of every row of
every base table in `public` before and after the preview. 20 tables,
byte-identical. `preview_safe_duplicate_batch()` is also declared `STABLE`
(`supabase/migrations/20260925_safe_duplicate_batch.sql`), and
`supabase/tests/safe-duplicate-batch.sql:29` fails the run if any of the three
RPCs is ever marked `IMMUTABLE` — eligibility must be recomputed from live rows.

---

## 4. Execution + idempotency (executed)

`npm run safe-batch:rehearse` (`--execute --yes --rerun`):

```
Batch merge — 254 pairs, 11 atomic chunk(s)
  completed in 3.1s across 11 chunk(s)

  successfully merged            254
  skipped after re-check         0
  blocked by the server          0
  failed                         0

Database state after the batch (read back from the server)
  candidate pairs remaining      24
  still eligible                 0
  needs individual review        24
  blocked                        0
  students                       310          (564 seeded − 254 removed)
  merge audits (total)           262
    └ stamped safe_batch         254
    └ pre-existing individual    8
  duplicate groups (page count)  24
  orphaned child rows            0

Idempotency re-run (same batch id, same reviewed list)
  successfully merged            0
  ✓ re-run merged nothing: no duplicate merges, no duplicate history, no duplicate audits
  ✓ exactly 254 safe_batch audit rows — one per merged student
```

The 24 needs-review pairs were never offered and were never touched. The 8
pre-existing individual merges kept `merge_kind = 'individual'` and were not
re-processed. `orphaned child rows = 0` means every FK-linked row across exams,
attendance, homework, quiz attempts, report comments, release log, promotions and
enrollments still resolves to a live student.

**Observed, worth knowing:** a re-run appends one `students.merge_batch` row to
`audit_logs` even though it merged nothing. That is an *invocation* log, not a
merge record — no student row, audit row or relationship is duplicated. It is
deliberately kept so an administrator can see that the batch was invoked.

---

## 5. Finding: the page's "High Confidence" counter is not the batch's safe count

`DuplicateStudents.tsx:157` computes `highConfidence` with the **client-side**
classifier `evaluatePair()`. The batch uses the **database** contract. They are
different contracts and they diverge in both directions. Measured, not inferred
— `src/lib/__tests__/duplicateBatch.pageVsServer.test.ts` runs both classifiers
over the same live rows:

| Case | Page says | Database says |
| --- | --- | --- |
| Parent-assigned vs unassigned, nothing conflicting | High Confidence | **eligible** ✓ agree |
| Same, but both records have attendance on the same date | High Confidence | **blocked** (`attendance_conflict`) |
| Three records share name + class | High Confidence | **review** (`group_has_more_than_two_records`) |
| Only the *unassigned* record carries a Gov ID | Needs Review | **eligible** (`gov_id_from_removed_preserved`) |
| Two different Gov IDs | Blocked | **blocked** (`gov_id_conflict`) ✓ agree |

The page cannot see history, enrollment state or group size; the database can.
Conversely the database is *more* permissive in exactly one place: when only the
unassigned record has a Gov ID the page demotes the pair, but the batch moves
that Gov ID onto the keeper rather than discarding it, so it is provably safe.

**Consequence for the operator:** treat 254 as an estimate. The authoritative
number is whatever `preview_safe_duplicate_batch()` returns, and the dry run is
the only thing that establishes it. This is the intended direction of travel —
the eligibility rules were not broadened to make the counter land on 254.

---

## 6. Production runbook

> **Not executed.** This sandbox has no Supabase credentials for the project
> (there is no `.env`; `src/lib/supabase.ts` falls back to
> `https://placeholder.supabase.co`) and no network route to `supabase.co`
> (`curl https://supabase.co` → TLS failure, exit 35). The live 254 merges must
> therefore be run by an administrator. Everything below is the exact sequence.

**Step 0 — apply the migration** (idempotent; modifies no student row):

```
supabase db push          # or paste supabase/migrations/20260925_safe_duplicate_batch.sql
                          # into the SQL editor
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f supabase/tests/safe-duplicate-batch.sql
```

The second command is read-only and asserts the three RPCs exist, are
`SECURITY DEFINER`, are granted to `authenticated`, and that the three internal
helpers are **not** executable by `anon`/`authenticated`.

**Step 1 — rehearse locally** (optional but recommended): `npm run safe-batch:rehearse`.

**Step 2 — dry run against production:**

```
export SUPABASE_URL="https://<ref>.supabase.co"
export SUPABASE_ANON_KEY="<anon key>"
export SUPABASE_ADMIN_JWT="<access token of a user whose public.profiles.role = 'admin'>"
node scripts/safe-duplicate-batch-run.mjs --target supabase
```

The **service_role key does not work** and must not be used: the RPCs resolve the
actor with `auth.uid()`, which a service-role call does not carry, so
`current_profile_role()` is NULL and every RPC refuses. Take the token from a
signed-in administrator's browser session (`supabase.auth.getSession()`).

Check before going further: `ELIGIBLE (safe merges)` is the real number; every
safety assertion is `true`; `dry run / writes` is `true / 0`; the excluded
breakdown only contains reasons you accept.

**Step 3 — execute** (equivalently: the **Merge All Safe Duplicates** panel —
three confirmations + the typed phrase `MERGE SAFE DUPLICATES`):

```
node scripts/safe-duplicate-batch-run.mjs --target supabase --execute --yes --rerun
```

`--rerun` immediately repeats the same batch to prove idempotency. Expect
`0 merged` on the second pass.

**Step 4 — verify.** The script prints the post-state. Independently, in the SQL
editor:

```sql
select merge_kind, count(*) from public.student_merge_audits group by 1;
select count(*) from public.student_merge_batches;
select * from public.student_merge_batches order by created_at desc limit 5;
select count(*) from public.students;
```

Then reload the Duplicate Students page: **High Confidence** should drop to the
residual, **Needs Review** should still show the excluded pairs, and **Merged**
should have grown by the merged count.

**Rollback:** there is none by design — a merge deletes the duplicate record.
Take a Supabase PITR snapshot / `pg_dump` before Step 3. The safety model is
prevention, not undo: nothing enters the batch unless the database proves it
safe, and every merge writes a `student_merge_audits` row carrying the removed
Student ID, both records' before/after counts and the batch provenance.

---

## 7. Test coverage

Full suite: `npm run validate` (`typecheck` + `typecheck:api` + `test:ci` + `build`).

**Verified result:** `typecheck` clean, `typecheck:api` clean, `test:ci`
**138 files / 1501 tests passed, 0 failed**, `vite build` succeeded.
The duplicate-students subset alone — the 5 `duplicateBatch.*.db` files,
`duplicateBatch.client`, `duplicateBatch.pageVsServer`, both
`SafeBatchMergePanel` component tests, the 4 `duplicateStudents.*` files and
`DuplicateStudents.test.tsx` — is **13 files / 222 tests, all passing**, and the
`.db` ones execute the shipped SQL in real PostgreSQL rather than mocking it.

| # | Requirement | Test |
| --- | --- | --- |
| 1 | Safe high-confidence pair is eligible | `duplicateBatch.eligibility.db.test.ts` › *includes parent-assigned vs unassigned…* |
| 2 | Needs Review pair is excluded | same › *different parent phones → Needs individual review*; *both records are unassigned* |
| 3 | Blocked pair is excluded | same › *conflicting Gov IDs*, *third student*, *exam/attendance/quiz/release/report conflicts* |
| 4 | Already-merged pair is excluded / idempotent | `duplicateBatch.client.test.ts` › *safe no-op when run again*; `duplicateBatch.security.db.test.ts` › *same admin retrying the same batch id is idempotent* |
| 5 | Non-admin cannot preview | `duplicateBatch.security.db.test.ts` › *cannot list candidate pairs school-wide*, *a real JWT-role session is denied…* |
| 6 | Non-admin cannot execute | `duplicateBatch.execution.db.test.ts` › *denies anon, teacher, parent and supervisor for every batch RPC* |
| 7 | Eligibility is calculated server-side | `duplicateBatch.pageVsServer.test.ts` (all 6); `…client.test.ts` › *maps the preview into the advisory reviewed list without re-deciding anything* |
| 8 | Execution re-checks eligibility | `duplicateBatch.execution.db.test.ts` › *skips a candidate that changed between preview and execution*; *re-evaluates live state even when the client sends no fingerprints* |
| 9 | Student history is preserved | same › *leaves third-party history rows untouched*; `…eligibility…` › *accepts a duplicate with real history when nothing conflicts* |
| 10 | FK relationships remain valid | `…eligibility…` › *excludes a duplicate with rows in a student relationship the merge does not move*; runner's `orphaned child rows = 0` |
| 11 | Conflicting data is not silently lost | `…eligibility…` › *preserves a Gov ID that only exists on the unassigned record (never discarded)* + every `*_conflict` exclusion |
| 12 | Re-running does not duplicate data | `duplicateBatch.security.db.test.ts` › *aggregate totals equal the chunk results…* + the runner's `--rerun` |
| 13 | One failed merge does not corrupt others | `duplicateBatch.execution.db.test.ts` › *rolls the WHOLE chunk back when one merge fails after writes* |
| 14 | Concurrent execution is safe | `duplicateBatch.security.db.test.ts` › *admin B is refused on batch X*, *a legacy batch row with a NULL admin_id can never be adopted*; `…execution…` › *reports already-resolved pairs instead of failing when another admin merged first* |
| 15 | Preview performs zero writes | `duplicateBatch.execution.db.test.ts` › *preview performs zero writes*; `…client.test.ts` › *performs no writes at all during preview*; runner's 20-table digest comparison |

Plus `supabase/tests/safe-duplicate-batch.sql`, executed inside PGlite by
`duplicateBatch.sqlAssertions.db.test.ts` and safe to run against production.
