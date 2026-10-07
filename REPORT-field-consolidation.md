# Safe duplicate batch — field consolidation (true conflict vs one-sided missing data)

Migration `20261008_safe_batch_field_consolidation.sql` · policy **v2**
Branch `arena/5dcf57e3-schoolnnnnass`

---

## 0. Headline

**PRODUCTION MERGE: NOT EXECUTED.** Nothing was written to any production
database. Everything below is either a read-only analysis, a PGlite rehearsal on
synthetic data, or a unit test.

The eligibility model changed from *"every populated field must already exist on
the keeper"* to a **safe union**:

| keeper | duplicate | verdict |
|---|---|---|
| has value | blank | preserve |
| blank | has value | **TRANSFER to the keeper** |
| value | same value | keep one |
| value | different value | **BLOCK** (true conflict) |
| blank | blank | nothing to do |

Consolidation is never the basis for a merge. Every strong duplicate-identity
condition from v1 still applies first (normalized-identical name, identical
class, exactly one parent-assigned keeper, ≤2 records in the group, no unhandled
child rows, no history conflict).

---

## 1. Current production classification — **NOT MEASURABLE FROM HERE**

I could not produce real production counts, and I am not going to invent them.
Verified this session:

```
$ ls -a | grep '^\.env'        → (none)
$ supabase/config.toml         → project_id = "schoolnnnnass", no remote ref
$ curl https://supabase.co     → 000 (exit 35, connection failed)
```

There is no `.env`, no Supabase project reference, and no network route to
Supabase from this sandbox. The production duplicate dataset is unreachable.

**The one command that produces the real numbers** (read-only, admin session
required, writes nothing):

```bash
export SUPABASE_URL=... SUPABASE_ANON_KEY=...
export SUPABASE_ADMIN_EMAIL=... SUPABASE_ADMIN_PASSWORD=...   # or SUPABASE_ADMIN_JWT
npm run safe-batch -- --target supabase --analyse
```

It prints the exact breakdown requested: verdict totals, a per-field
state × action matrix over every candidate pair, the values that will transfer,
and the full blocked / needs-review reason lists with counts.

> Prerequisite: `20261008_safe_batch_field_consolidation.sql` must be pushed
> first, because `--analyse` reads the per-field classification the new policy
> publishes. Against a database still on v1 it will report the v1 codes instead.

---

## 2. New policy simulation

The only dataset I can measure is the reproducible PGlite fixture that
`scripts/safe-duplicate-batch-run.mjs` seeds. Two runs were made.

### 2a. Default fixture — 254 / 24 / 0 (**unchanged**)

```
policy                         safe_batch_parent_assigned_keeper v2
candidate pairs examined       322
  SAFE (batch-mergeable)       254
    └ nothing to consolidate   254
    └ safe via transfer          0
  BLOCKED                        0
  NEEDS REVIEW                  24
```

This is the honest and important result: **the default fixture's duplicate
records are all blank**, so it contains no one-sided data and the policy change
moves nothing. 254 stays 254. Nothing was weakened to reach it.

### 2b. Same fixture + 44 one-sided pairs (`--consolidation-fixtures 40`)

`--consolidation-fixtures N` is a new opt-in seed that adds N pairs whose keeper
is *missing* a value the duplicate holds, plus 4 deliberate counter-examples.

```
candidate pairs examined       322
  SAFE (batch-mergeable)       294
    └ nothing to consolidate   254
    └ safe BECAUSE one-sided data transfers   40     ← the new behaviour
  BLOCKED (a true conflict)      3
  NEEDS REVIEW                  25                    ← 24 + 1 new counter-example

Per-field state across all examined pairs
  field         both_blank  keeper_only  duplicate_only  identical  conflict
  parentPhone          226           84              11          0         1
  transport            261           50              10          0         1
  familyId             288           23              11          0         0
  govId                249           63              10          0         0

What the policy DOES with each field
  field         keep  transfer  block  review
  parentPhone    310        10      2       0
  transport      311        10      1       0
  familyId       311        10      0       1
  govId          312        10      0       0
```

40 transfers = 10 per field, exactly matching the 40 seeded one-sided pairs.

---

## 3. Remaining BLOCKED — 3 (in the fixture run)

| code | n | why |
|---|---|---|
| `parent_phone_conflict` | 1 | two different non-empty numbers — a human must choose |
| `transport_conflict` | 1 | `WALKER` vs bus `9` — a human must choose |
| `parent_phone_belongs_to_other_family` | 1 | the phone already belongs to a **different** parent's family; copying it would fuse two families |

`parent_phone_belongs_to_other_family` is **new in v2** and is the guard that
stops the transfer rule from being a blind copy. It fires when another student
already uses that normalized phone under a different `parentId`. It is in
`blockedCodes`, so it can never be downgraded to review by a client.

## 4. Remaining NEEDS REVIEW — 25 (24 unchanged + 1 new)

| code | n | why |
|---|---|---|
| `both_parents_unassigned` | 24 | neither record has a parent assigned — no keeper under the batch rule |
| `family_id_transfer_unproven` | 1 | only the duplicate has a family ID and the database cannot prove the keeper belongs to that family |

**The 24 were not touched.** They are excluded because neither record has a
parent, which has nothing to do with field consolidation, so the new policy
cannot and does not promote them.

---

## 4b. Family ID normalization guard (policy v3)

`normalize_family_id()` is `regexp_replace(raw,'\D','','g')`
(`20260802_family_ids.sql:55`), so a raw family ID containing **no digit at all**
— `HOUSE-RED`, `FAM-ABC` — normalizes to `''`. Policy v2 compared only the
normalized values, so it saw blank on that side, classified the pair
`both_blank`, marked it **SAFE**, transferred nothing, and the merge then
**deleted the duplicate** — destroying the value without it ever appearing in
`transferred_fields`. The "transferred values missing from keeper = 0" check
passed vacuously, because it only ever inspected values the policy knew it was
transferring.

Fixed in policy **v3**, without touching `normalize_family_id()`:

- A raw non-empty `familyId` that normalizes to `''` is **never** treated as
  blank. The pair goes to **individual review** with the stable code
  `family_id_invalid_normalization`. Not SAFE. Not blocked either — an unreadable
  value is not a proven family conflict.
- **Exception:** if both sides hold *byte-identical* raw values, the keeper
  survives holding them, so nothing can be lost and there is nothing to compare
  → `same_family_id`, SAFE. Without this the review workflow could never merge a
  pair it had just corrected by copying the value across.
- Every existing rule is unchanged: same → keep, proven → transfer, conflicting →
  blocked, unprovable → review.
- New audit column `student_merge_audits.removed_profile` retains the removed
  record's raw `familyId` / `parentPhone` / `transport` / `govId`, which is the
  only way to prove nothing vanished once the row is gone.
- `verify_safe_duplicate_batch_state()` gained a `dataPreservation` block that
  compares the removed record's **raw** family ID against the survivor and the
  transfer list. It deliberately applies **no** normalization filter — filtering
  on the normalized value would exclude exactly the rows it exists to catch. It
  also reports `familyIdsChecked` and `auditsUnverifiable`, so an empty result
  can never be mistaken for a clean one.

Measured on the rehearsal with the deliberately invalid fixture: the pair moved
from SAFE to **REVIEW** (safe 295 → 294, review 25 → 26), the batch merged 294
with `RAW family IDs lost = 0`, and the idempotent re-run merged 0.

Regression coverage: `duplicateBatch.familyIdNormalization.db.test.ts`, 17
real-PostgreSQL tests including a **negative control** that hand-writes the old
bug into an audit row and asserts the invariant reports `lostFamilyIds = 1`.

## 5. Per-field policy and the evidence behind it

### parentPhone
Both blank / keeper-only / identical → keep. Both different → **BLOCK**.
Keeper blank + duplicate has one → **transfer**, but only after proving no
other student already uses that normalized phone under a *different* parent.
The school's own family key (`20260819`) is `'p:'||parentId`, falling back to
`'t:'||normalize_phone(parentPhone)`, so such a phone genuinely belongs to
another family. The same phone on a **sibling of the same parent** is
corroboration and stays SAFE.

### transport
`students.transport` is a **scalar** — `students_transport_check` allows
`WALKER | CAR | LEFT | ^\d+$` (a bus number). There is no relational bus or
route table keyed on it. The real driver↔student relationship is
`authorized_pickup_students`, which `merge_duplicate_students_resolved()`
already moves with `ON CONFLICT DO NOTHING` (lines 706–709). So copying the
scalar is the *complete* preservation — no relationship is left behind, and
`_safe_batch_unhandled_child_rows()` still guards any FK child. Incompatible
non-empty values still **BLOCK**.

### familyId — deliberately the most conservative
There is **no families table**; `familyId` is a TEXT column on `students`
(`20260802_office_role.sql`), grouped by the family key above under the
invariant "one family key → one family ID for the lifetime of the key"
(`20260819`). So "same family" is provable **only** from sibling records sharing
the keeper's parent.

- Sibling of the keeper's own parent already holds that exact ID → **transfer**
  (`family_id_from_removed_preserved`, proof recorded in `fieldStates`).
- Keeper's parent already belongs to a **different** family ID → **BLOCK**
  (`family_id_conflict`).
- Not provable either way → **review** (`family_id_transfer_unproven`).
  Absence of evidence is not evidence; a family relationship is never replaced
  on a guess.

`merge_duplicate_students_resolved()` never writes `familyId` at all, so the
batch's post-merge step is the only place a proven family consolidation can
happen — implemented there.

### govId
Unchanged from v1: transferred when the keeper is blank and no third student
owns it, now also recorded in the audit.

### A real bug found and fixed
`merge_safe_duplicate_batch()` force-restored the keeper's profile bytes after
the shared RPC ran:

```sql
v_expected_phone := v_keeper."parentPhone";   -- would have UNDONE any transfer
```

Left alone, every phone transfer would have been silently reverted to blank. It
is now resolved-value aware for phone, transport and familyId.

---

## 6. Data preservation and audit

Every value copied off the removed record is stamped on its audit row:

```sql
ALTER TABLE public.student_merge_audits ADD COLUMN IF NOT EXISTS transferred_fields JSONB;
ALTER TABLE public.student_merge_audits ADD COLUMN IF NOT EXISTS field_states JSONB;
```

`transferred_fields` is `{"parentPhone":"…","transport":"…","govId":"…",…}` —
field name and value. `field_states` keeps the full classification, so a later
reader can see *why* each field was kept, transferred or blocked. The batch
response carries the same record inline per merged pair.

Measured in the fixture run, read back from the server:

```
safe_batch audits            294
  └ carrying a transfer       40
      familyId                10
      govId                   10
      parentPhone             10
      transport               10
transferred values missing from the keeper   0
✓ every transferred value is present on the surviving Student ID — nothing was discarded
```

That last line is a new standing check in the runner: it joins
`transferred_fields` back to the surviving `students` row and fails the run if
any transferred value is missing.

---

## 7. Safety verification — dry run performed zero writes

```
✓ Preview is zero-write     dryRun=true, writesPerformed=0, 20 tables byte-identical=true
```

The digests are captured *inside* `runPreflight` immediately before and after the
preview call, so the comparison is not vacuous. `runAnalysis` is read-only too —
it only calls `get_safe_duplicate_batch()`.

Full fixture rehearsal (`--execute --yes --rerun --consolidation-fixtures 40 --allow-blocked 3`),
exit 0, "Result: all checks passed":

```
merged / skipped / blocked / failed    294 / 0 / 0 / 0
still eligible after the batch           0
needs individual review                 25   (unchanged by the batch)
orphaned child rows                      0
safe_batch audit rows                  294   one per merged student
re-run merged                            0   idempotent
transferred values missing               0
```

Default rehearsal (`--analyse --execute --yes --rerun`), exit 0, all checks
passed: **254 merged, 0 skipped, 0 blocked, 0 failed; 24 needs review unchanged;
re-run 0; 254 audit rows.**

`--allow-blocked N` is new and only affects the preflight *reporting* tolerance
for blocked pairs the operator has already reviewed. It never changes
eligibility: blocked pairs stay excluded by the database either way. The default
is still `0`, which is why the deliberate counter-example fixtures make the
preflight fail unless the operator states the number.

---

## 8. Tests

`src/lib/__tests__/duplicateBatch.fieldConsolidation.db.test.ts` — **25 tests,
all passing**, against real PostgreSQL (PGlite) with the actual shipped
migrations. No mocks. It covers all 18 required cases plus 7 counter-examples:

both phones blank · only keeper · only duplicate (transferable) · identical ·
different → blocked · sibling-corroborated phone · phone of another family →
blocked · only-duplicate transport · incompatible transport → blocked ·
only-duplicate family ID with DB proof · unprovable family ID → review ·
keeper's parent in another family → blocked · different family IDs → blocked ·
only-duplicate Gov ID · Gov ID of a third student → blocked · different Gov IDs
→ blocked · transferred values on the keeper after merge · proven family ID
transferred · no data lost (safe union) · audit names every transferred field ·
empty transfer set audited as empty · re-run idempotent · preview zero writes ·
execution re-checks eligibility and refuses a stale list · non-admin refused.

Two pre-existing tests asserted the **old** rule and were updated to the new
contract: *"excludes when only the unassigned record has a phone"* → *"treats a
phone that only the unassigned record has as transferable"*, and the matching
transport test.

### Full validation

| check | result |
|---|---|
| `npx tsc --noEmit` | **PASS** |
| `npx tsc -p tsconfig.api.json` | **PASS** |
| `npx vite build` | **PASS** (built in 13.09 s) |
| `npx vitest --run` | **141 files / 1545 tests — 1544 passed, 1 failed** |
| duplicate-batch subset (8 files) | **155 tests, all passing** |
| `npm run safe-batch:rehearse` (default) | **exit 0, all checks passed** |

The single failure is `src/lib/__tests__/webpush.test.ts` (`expects 'p=' but the
sender emits 'k='`). It is **pre-existing and unrelated** to this work; it was
reverted at your request in the previous task and has deliberately not been
re-fixed. `npm run validate` is therefore red on that one test by design.

---

## 9. What changed

| file | change |
|---|---|
| `supabase/migrations/20261008_safe_batch_field_consolidation.sql` | new — policy v2: `_safe_batch_evaluate_pair`, `merge_safe_duplicate_batch`, `get_safe_duplicate_batch`, `safe_duplicate_batch_policy`; 2 new audit columns; DO-block assertions |
| `src/lib/__tests__/duplicateBatch.fieldConsolidation.db.test.ts` | new — 25 real-PostgreSQL tests |
| `src/lib/__tests__/duplicateBatch.eligibility.db.test.ts` | 2 tests moved from the old rule to the new contract |
| `src/lib/__tests__/pgDuplicateBatchHarness.ts` | loads the new migration |
| `scripts/safe-duplicate-batch-run.mjs` | `--analyse`, `--consolidation-fixtures`, `--allow-blocked`; post-run transferred-value verification |
| `src/lib/supabase.ts` | client-side mock classifier mirrors policy v2; reason text now reads *"Parent phone can be safely transferred to the keeper"* |

The three new functions were produced by **extracting them from `20260925` and
patching programmatically**, then diffing to prove only the intended lines
changed — `merge_safe_duplicate_batch` differs by exactly 5 hunks. No
hand-transcription of ~450 lines.

### UI wording
`parent_phone_only_on_unassigned` / `transport_only_on_unassigned` /
`family_id_only_on_unassigned` are **retired** and no longer emitted. The
migration's DO block fails loudly if they come back. The new texts are
*"Parent phone can be safely transferred to the keeper"*, and the equivalent for
transport, family ID and Gov ID. Genuine conflicts still render as blocked.

---

## 10. Production runbook (still NOT executed)

```bash
# 0. Apply the migration, then the raw-SQL suite
supabase db push
psql -v ON_ERROR_STOP=1 -f supabase/tests/safe-duplicate-batch.sql

# 1. READ-ONLY analysis — this is where the real numbers come from
npm run safe-batch -- --target supabase --analyse

# 2. Dry run (zero writes)
npm run safe-batch -- --target supabase

# 3. Execute — ONLY after reading the analysis and the dry run
npm run safe-batch -- --target supabase --execute --yes --rerun

# 4. Verify and reload the Duplicate Students page
```

**There is no rollback.** Take a PITR snapshot or `pg_dump` first.
If step 1 reports blocked pairs you have already reviewed, `--allow-blocked N`
states the number for the preflight report; blocked pairs remain excluded either
way.

---

## 11. Production merge: **NOT EXECUTED**
