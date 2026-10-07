# Safe Duplicate Batch — alignment, production preflight and runbook

**Feature:** Admin → Duplicate Students → **Merge All Safe Duplicates**
**Date:** 2026-10-07
**Branch:** `arena/5dcf57e3-schoolnnnnass`

---

## 0. Reverted: the out-of-scope `webpush.test.ts` change

In the previous round I edited `src/lib/__tests__/webpush.test.ts`. That was
wrong — it has nothing to do with this feature. It is now byte-identical to
`2e61463`:

```
$ git show 2e61463:src/lib/__tests__/webpush.test.ts | diff - src/lib/__tests__/webpush.test.ts
IDENTICAL to original (revert confirmed)
```

**Consequence you should know about:** that test fails on the base commit, so
`npm run validate` is red on exactly one test, for a reason that predates this
work. Commit `2e61463` ("Change VAPID return format from 'p' to 'k'") moved
`server/lib/webpush.ts:226` to the RFC 8292 §4.1 form `vapid t=<jwt>, k=<key>`
but left the assertion expecting the pre-RFC `p=` alias. The one-line fix is
`expect(auth).toContain(\`p=${vapid.publicKey}\`)` → parse the two parameters and
assert the second is `k=<publicKey>`. I have left it alone; apply it separately
if you want the suite green.

---

## 1. Code status

### The page now shows the database's number, and says so

`src/pages/admin/DuplicateStudents.tsx`

The six existing cards are computed by `evaluatePair()` in the browser
(`DuplicateStudents.tsx:157`). They stay — they are useful for scanning a list —
but they are now labelled as estimates, and a separate server-authoritative
banner sits above them:

```
Safe to Merge — server verified                                   254
Computed by the database (SECURITY DEFINER). This is the only number
that controls batch execution.
24 need individual review   0 blocked   278 candidate pairs

[278 Potential Duplicates] [278 Ready to Review] [254 High Confidence]
                                                    └ hint: page estimate — not the batch count
[24 Needs Review] [0 Blocked] [8 Merged]

The six cards above are a client-side classification for scanning the list.
They are not eligibility and they never authorise a merge — "Safe to Merge —
server verified" is the number the batch uses, and the database recomputes it
again the moment you confirm.
```

The count comes from `getSafeDuplicateBatch({ limit: 1, includeExcluded: false })`
— the same `SECURITY DEFINER` evaluation the batch runs, asked for its summary
only. `limit 1` is safe because `summary` is computed over *all* candidate pairs;
only `rows`/`excludedRows` are paginated.

A failure (non-admin, RPC unavailable) never breaks the page: the banner shows
`—` plus the server's own refusal, and the guided review below still works.

### The dry run states plainly that nothing changed

`src/pages/admin/SafeBatchMergePanel.tsx` — after a preview:

> Safe preview completed. No records were modified.

`data-testid="safe-batch-no-writes"`, EN + AR (`duplicateBatch.previewNoWrites`).

### New read-only post-run verification RPC

`supabase/migrations/20261007_safe_batch_post_run_verification.sql`

`verify_safe_duplicate_batch_state()` — `STABLE`, `SECURITY DEFINER`, admin-only,
no writes. It exists because the rehearsal could verify by running SQL and
production cannot: a client only has PostgREST. Without it, "verify after the
batch" would be something only the rehearsal can do.

It recomputes the eligibility counts by **calling `get_safe_duplicate_batch()`**,
so the numbers it reports cannot drift from the contract that decides what gets
merged. It also walks `pg_constraint` at runtime for every FK pointing at
`public.students`, so a table added later is covered, and reports:

authoritative counts · students · audits by `merge_kind` · distinct removed IDs ·
batch run totals · `students.merge_batch` audit logs · orphaned child rows with
per-table detail · students with more than one open enrollment.

The eligibility contract, keeper rule, grants and policies from `20260925` are
untouched.

### Production preflight, extracted so the tests exercise the real code

`scripts/lib/safeBatchPreflight.mjs` (new) — `runPreflight(ctx, opts)`. Ten
checks, any failure refuses execution:

| # | Check | How it is answered |
| --- | --- | --- |
| 1 | Supabase URL is configured | `--target supabase` requires `https://…` |
| 2 | Database is reachable | `current_profile_role()` answers |
| 3 | Session is valid | a real access token is present |
| 4 | **Actor is an admin** | `public.current_profile_role() = 'admin'` — asked of PostgreSQL |
| 5 | Required RPCs exist | `pg_proc` catalogue lookup (5 RPCs) |
| 6 | Preview succeeds | `preview_safe_duplicate_batch(2000)` returned |
| 7 | Preview is zero-write | `dryRun`/`writesPerformed` **and** a digest of every public table taken immediately around the call |
| 8 | Safe count is reported by the database | `summary.safeCount` present |
| 9 | No unexpected blocked records | `summary.blockedCount = 0` |
| 10 | Operator explicitly confirmed | `--execute --yes` |

Check 4 is the important one: it uses the **same function the batch RPCs use**,
so the preflight cannot disagree with the server about who is allowed in. It does
not authorise anything — `merge_safe_duplicate_batch()` re-checks the role, the
phrase, every pair's eligibility and every fingerprint regardless.

### Production authentication — solved without weakening anything

The audit was right that `service_role` cannot work: the RPCs resolve the actor
with `auth.uid()`, a service-role call carries no user, `current_profile_role()`
is NULL and every RPC refuses. The fix is **not** to relax that — it is to obtain
a genuine authenticated admin identity, using the project's own pattern
(`createUser` in `src/lib/db/profiles.ts`, `createAuthedClient` in
`src/lib/supabase.ts`):

```
SUPABASE_ADMIN_EMAIL + SUPABASE_ADMIN_PASSWORD
  → supabase.auth.signInWithPassword()
  → every request pinned to that user's access token
or SUPABASE_ADMIN_JWT
  → an existing admin access token
```

Then preflight check 4 confirms the role *in the database*. A service-role key
is still refused, by the database, exactly as before.

### Execution gating

Before any merge the runner prints the authoritative numbers and refuses to
continue unless every preflight check passed:

```
  DATABASE VERIFIED: 254 pairs currently eligible for safe merge.
  24 pairs require individual review.
  0 blocked.
  This operation will modify student records.
```

`--execute` requires `--yes`; the server additionally requires the typed phrase
`MERGE SAFE DUPLICATES`. Execution is still one atomic chunk per RPC call, driven
by the server's own preview rows, never by a client-decided list.

### Bug found and fixed in this round

Moving the preview into the preflight left the runner comparing two table
digests taken **after** the preview had already run — a zero-write proof that
proved nothing. `runPreflight` now returns the digests it captured immediately
around the preview call, and a test asserts the check is not vacuous (it fails
when a table changes, passes when it does not).

---

## 2. Test status

| Command | Result |
| --- | --- |
| `npx tsc --noEmit` | **PASS** |
| `npx tsc -p tsconfig.api.json` | **PASS** |
| `npx vitest --run` | **140 files / 1520 tests — 1519 passed, 1 failed** |
| `npx vite build` | **PASS** (`dist/index.html` 6,144.51 kB) |
| `npm run validate` | **FAILS** on the one pre-existing `webpush.test.ts` failure (§0) |

The single failure is `webpush.test.ts › sends with a VAPID Authorization header
and reports 410 as expired` — the reverted, pre-existing, unrelated failure.

The duplicate-students subset alone — the 5 `duplicateBatch.*.db` files,
`duplicateBatch.client`, `duplicateBatch.pageVsServer`,
`safeBatchRunner.preflight`, both `SafeBatchMergePanel` component tests, both
`DuplicateStudents` page tests, the 4 `duplicateStudents.*` files — is
**15 files / 241 tests, all passing**.

New/extended tests this round:

| File | Tests | Proves |
| --- | --- | --- |
| `src/lib/__tests__/safeBatchRunner.preflight.test.ts` (new) | 13 | the runner refuses unauthenticated execution, refuses a non-admin, refuses when unreachable / unconfigured / blocked / unconfirmed, and never asks for a preview without an admin. The three PostgreSQL cases run `current_profile_role()` in real PGlite |
| `src/pages/admin/__tests__/DuplicateStudents.serverCount.test.tsx` (new) | 5 | the page renders the number `get_safe_duplicate_batch` returned, labels the client count as an estimate, states which number controls the batch, shows both when they differ, and invents nothing for a non-admin |
| `src/lib/__tests__/duplicateBatch.pageVsServer.test.ts` | +1 (7) | a pair the page approves but the server excludes is **absent from the preview rows**, so divergence can never reach execution |
| `src/pages/admin/__tests__/SafeBatchMergePanel.test.tsx` | extended | the dry run renders "No records were modified." |

Requirement → test map:

| Requirement | Where |
| --- | --- |
| Page displays the server-authoritative safe count | `DuplicateStudents.serverCount.test.tsx` (5) |
| Client/server divergence cannot affect execution | `duplicateBatch.pageVsServer.test.ts` (7) |
| Dry run performs zero writes | preflight check 7 + its non-vacuity test; `duplicateBatch.execution.db.test.ts › preview performs zero writes` |
| Non-admin cannot preview | `duplicateBatch.security.db.test.ts`; preflight tests |
| Non-admin cannot execute | `duplicateBatch.execution.db.test.ts › denies anon, teacher, parent and supervisor` |
| Execution re-checks eligibility | `duplicateBatch.execution.db.test.ts › skips a candidate that changed between preview and execution` |
| Already merged pairs are idempotent | `duplicateBatch.security.db.test.ts`; runner `--rerun` |
| Needs Review remains untouched | runner post-run asserts the count is unchanged; `duplicateBatch.eligibility.db.test.ts` |
| Student history survives | `duplicateBatch.execution.db.test.ts › leaves third-party history rows untouched` |
| Concurrent execution is safe | `duplicateBatch.security.db.test.ts` batch-ownership block |
| Runner refuses unauthenticated execution | `safeBatchRunner.preflight.test.ts` (13) |

---

## 3. Production status

**Production was NOT executed.** No Supabase credentials exist in this
environment (no `.env`; the client falls back to
`https://placeholder.supabase.co`) and there is no network route out — `curl
https://supabase.co` fails at TLS. No production row was read, changed or
merged, and no production dry run was performed.

Everything below is rehearsal against real PostgreSQL (PGlite) with the shipped
migrations and a dataset seeded to reproduce the reported screen.

---

## 4. Authoritative count (rehearsal, not production)

```
Preflight — all checks passed
  ✓ Supabase URL is configured        pglite (in-process PostgreSQL, shipped migrations)
  ✓ Database is reachable             current_profile_role() answered
  ✓ Authentication session is valid   admin-1 (profiles.role = admin)
  ✓ Current actor is an admin         current_profile_role() = 'admin'
  ✓ Required RPCs exist               5 RPCs present (policy 'safe_batch_parent_assigned_keeper')
  ✓ Preview succeeds                  278 candidate pairs evaluated
  ✓ Preview is zero-write             dryRun=true, writesPerformed=0, 20 tables byte-identical=true
  ✓ Safe count is reported by the DB  safeCount=254 (server-authoritative)
  ✓ No unexpected blocked records     blockedCount=0
  ✓ Operator explicitly confirmed     not required for a read-only dry run

candidate pairs 278 │ ELIGIBLE 254 │ needs review 24 │ blocked 0
✓ preview wrote nothing — 20 public tables byte-identical immediately before and after the call

  DATABASE VERIFIED: 254 pairs currently eligible for safe merge.
  24 pairs require individual review.
  0 blocked.
  This operation will modify student records.
```

## 5. Merge result (rehearsal)

```
Batch merge — 254 pairs, 11 atomic chunk(s), 3.0s

  merged 254 / skipped 0 / blocked 0 / failed 0

Post-run verification (verify_safe_duplicate_batch_state, read-only RPC)
  still eligible (safe)          0
  needs individual review        24        ← unchanged, never offered
  blocked                        0
  candidate pairs remaining      24
  students                       310       (564 seeded − 254 removed)
  merge audits (total)           262
    └ safe_batch                 254
    └ individual                 8         ← the 8 pre-existing merges, untouched
    └ distinct removed IDs       262
  batch runs                     1 (merged 254 / skipped 0 / blocked 0)
  orphaned child rows            0
  students w/ >1 open enrollment 0

Idempotency re-run — merged 0
  ✓ re-run merged 0 newly eligible pairs
  ✓ exactly 254 safe_batch audit rows, unchanged by the re-run
```

Refusal paths also verified: `--target supabase` with no credentials exits 1
after a failed preflight and calls nothing but `current_profile_role()`;
`--execute` without `--yes` exits 1 immediately.

---

## 6. What "done" still requires

The success condition is a production sequence, and only the first link exists
today — in rehearsal:

| Step | State |
| --- | --- |
| production dry run verified | **NOT DONE** — needs credentials + network |
| authenticated admin execution | **NOT DONE** |
| database re-check | implemented and rehearsed |
| successful batch merge | rehearsed only |
| post-run verification | implemented and rehearsed |
| idempotency re-check | implemented and rehearsed |

### Runbook

**Step 0 — apply both migrations** (idempotent; modify no student row):

```
supabase db push      # 20260925_safe_duplicate_batch.sql
                      # 20261007_safe_batch_post_run_verification.sql
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f supabase/tests/safe-duplicate-batch.sql
```

**Step 1 — production dry run:**

```
export SUPABASE_URL="https://<ref>.supabase.co"
export SUPABASE_ANON_KEY="<anon key>"
export SUPABASE_ADMIN_EMAIL="admin@school.example"
export SUPABASE_ADMIN_PASSWORD="<password>"       # or SUPABASE_ADMIN_JWT instead
node scripts/safe-duplicate-batch-run.mjs --target supabase
```

Read the preflight and the `DATABASE VERIFIED` block. `ELIGIBLE` is the real
number — it may not be 254, and that is correct: the page's High Confidence
counter is a client-side estimate and the database is stricter (it also sees
attendance/exam/quiz collisions, enrollment state and group size) and more
permissive in one place (a Gov ID held only by the unassigned record is moved
onto the keeper). Take a Supabase PITR snapshot before the next step.

**Step 2 — execute:**

```
node scripts/safe-duplicate-batch-run.mjs --target supabase --execute --yes --rerun
```

The script stops itself if any post-run invariant is violated (anything still
eligible, Needs Review count changed, orphaned rows, audit count ≠ merged count,
re-run merging anything). Exit code is non-zero on any violation.

**Step 3 — reload the page.** "Safe to Merge — server verified" should read 0,
"Needs Review" should still show the excluded pairs, "Merged" should have grown
by the merged count.

**Rollback:** none by design — a merge deletes the duplicate record. Safety is
prevention plus a full audit trail (`student_merge_audits` with the removed
Student ID, before/after counts and batch provenance for every merge).
