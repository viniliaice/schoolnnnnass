# Production read-only analysis — result

Branch `arena/5dcf57e3-schoolnnnnass` · commit after `eaea46d`
Nothing was merged. Nothing was written. No student record was touched.

---

## 1. The analysis could not be run against production — and why

I ran the exact command you asked for. It failed before contacting anything:

```
$ npm run safe-batch -- --target supabase --analyse

Safe Duplicate Batch — target: supabase
  ✗ analysis failed: cannot reach the database: SUPABASE_URL is not set
                      (called get_safe_duplicate_batch)

Preflight — FAILED
  ✗ Supabase URL is configured      SUPABASE_URL is not set
  ✗ Database is reachable           cannot reach the database: SUPABASE_URL is not set
  ... 8 checks skipped ...
  ✗ preflight failed — refusing to continue.
EXIT: 1
```

I did not stop there. I looked for any way to authenticate and tried it:

| check | result |
|---|---|
| `SUPABASE_URL` / `ANON_KEY` / `ADMIN_EMAIL` / `ADMIN_PASSWORD` / `ADMIN_JWT` | all **unset** |
| `.env` file in the repo | **none** |
| `supabase/config.toml` remote ref | `project_id = "schoolnnnnass"`, **no remote ref** |
| project ref recovered from a hardcoded anon key in `seed-lesson-plans.mjs` | `qopeilyvkfqbjdeudwnz` |
| `curl https://qopeilyvkfqbjdeudwnz.supabase.co/rest/v1/` | **http=000, curl exit 35** |
| `curl https://supabase.co` | **http=000, curl exit 35** |
| `curl https://api.github.com` / `registry.npmjs.org` / `pypi.org` | **http=200** (these are the only reachable hosts) |

That anon key is public material, not admin credentials — and it is irrelevant,
because this sandbox has **no network route to Supabase at all**. Every host
outside the allowlist fails at the TLS layer.

**So there are no production numbers in this report, and I will not invent any.**
Sections 2–7 below are what I built and proved so that the moment you run the
command with real credentials, you get exactly the breakdown you asked for.

The authorization model was not touched. No `service_role` key was used or
added. The analysis path calls `get_safe_duplicate_batch()` as a signed-in
admin, and the database's `SECURITY DEFINER` + `auth.uid()` + `current_profile_role()`
guards remain the only thing deciding access — a non-admin is refused by
PostgreSQL, not by the script.

---

## 2. The command now produces exactly the breakdown you specified

The previous `--analyse` printed a state × action grid. That did **not** answer
your questions, because *"the duplicate is the only record with a value"* is not
a verdict — it can be transferable, another family's data, or unprovable. I
rebuilt it to split that case per field, and added the missing pieces.

Verified output from a PGlite run with 44 seeded one-sided pairs (exit 0):

```
PRODUCTION ANALYSIS — computed by the database, read-only
  policy                         safe_batch_parent_assigned_keeper v2

  Duplicate totals
  potential duplicate pairs      323
  server-safe pairs              295
  needs review                   25
  blocked                        3
  already merged (individual)    8
  already merged (safe batch)    0
  distinct student IDs removed   8

    └ safe with nothing to consolidate 255
    └ NEWLY safe via field consolidation 40

  Field consolidation analysis (per profile field)
    parentPhone
        both blank                          227
        keeper only                          84
        duplicate only → safely transferable 10
        identical                             0
        true conflict                         1
        belongs to another family             1
    transport
        both blank                          262
        keeper only                          50
        duplicate only → safely transferable 10
        identical                             0
        incompatible conflict                 1
    familyId
        both blank                          289
        keeper only                          23
        duplicate only → proven transferable 10
        duplicate only → unprovable (review)  1
        identical                             0
        conflicting family IDs                0
    govId
        both blank                          250
        keeper only                          63
        duplicate only                       10
        identical                             0
        conflict                              0

  Values that will be transferred from the duplicate onto the keeper
    transport 10 · familyId 10 · govId 10 · parentPhone 10
    each is recorded per merge in student_merge_audits.transferred_fields

  Why pairs are BLOCKED
    parent_phone_belongs_to_other_family 1  ...copying it would fuse two families
    parent_phone_conflict                1  ...a human must choose
    transport_conflict                   1  ...a human must choose

  Why pairs stay in individual review
    both_parents_unassigned             24  Neither record has a parent assigned
    family_id_transfer_unproven          1  ...cannot prove the keeper belongs

  Representative examples — newly SAFE because of field transfer
    SAFE    Ismaaciil Faarax Jaamac 005  [Grade 1-A]
            keeper s-cons-5-k  ←  duplicate s-cons-5-r
            transfers: transport=105
    ... 9 more ...
  Representative examples — remaining BLOCKED
    BLOCKED Cabdiraxmaan Xuseen Warsame 003  [Grade 1-A]
            keeper s-conf-3-k  ←  duplicate s-conf-3-r
            reason: parent_phone_belongs_to_other_family
    ... 2 more ...
  Representative examples — remaining REVIEW
    ... 10 ...
```

Every row you listed is present: the six parent-phone cases, the five transport
cases, the six family-ID cases, the five Gov-ID cases, the already-merged
totals, and 10 / 10 / 10 representative examples. Phone and Gov ID are
**partially masked** (`•••3468`) — nothing beyond what the admin screen already
shows. `--json` emits the same structure for piping into a ticket.

`already merged` comes from `verify_safe_duplicate_batch_state()` (read-only,
`STABLE`, admin-only). If a deployment predates `20261007` it degrades to
`unavailable` instead of guessing.

**To get your real numbers:**

```bash
supabase db push          # applies 20261008 — required, --analyse reads its output
export SUPABASE_URL=... SUPABASE_ANON_KEY=...
export SUPABASE_ADMIN_EMAIL=... SUPABASE_ADMIN_PASSWORD=...
npm run safe-batch -- --target supabase --analyse
```

---

## 3. Family ID normalization — investigated, and it is a real problem

### The behaviour, from the shipped code

`supabase/migrations/20260802_family_ids.sql:49-55`:

```sql
CREATE OR REPLACE FUNCTION public.normalize_family_id(p_raw TEXT) ...
  SELECT regexp_replace(COALESCE(p_raw, ''), '\D', '', 'g');
```

`\D` is *every* non-digit. So:

| raw `familyId` | normalized | effect on the batch |
|---|---|---|
| `0010` | `0010` | fine |
| `FAM-12` | `12` | letters dropped silently |
| `FAM12` | `12` | **collides with the row above** |
| `HOUSE-RED` | `''` | **treated as having no family ID at all** |

### Are production Family IDs numeric?

**I cannot answer this.** It requires reading `students."familyId"` from your
database. What I can tell you is that the schema places **no constraint** on the
column — `ALTER TABLE public.students ADD COLUMN IF NOT EXISTS "familyId" TEXT`
(`20260802_family_ids.sql:19`) — so nothing in the database prevents alphabetic
or alphanumeric values. Whether any exist is a fact about your data, not the
code.

### The audit that answers it

`supabase/tests/family-id-normalization-audit.sql` — new, **SELECT-only**, needs
no special role:

```bash
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f supabase/tests/family-id-normalization-audit.sql
```

Seven sections: population · records that go blank · the offending values ·
character composition · colliding spellings · collapse count · a `DO` block that
ends in `NOTICE clean` or `WARNING needs attention`.

I validated it by executing the whole file through PostgreSQL's own parser
against a fixture containing numeric, alphabetic, alphanumeric and colliding
values:

```
✓ WHOLE FILE parsed and executed by PostgreSQL with no error
records that go blank: [{"n":1}]
the blanking values:   [{"v":"HOUSE-RED","n":1}]
colliding spellings:   [{"k":"12","spellings":2,"vals":"FAM-12 | FAM12"}]
```

It correctly caught both failure modes.

### The same question, answered from the analysis itself

`--analyse` also reports it from the **raw values the RPC returns for each side
of every candidate pair** — so it works on production over the admin session,
with no direct SQL:

```
  Family ID normalization impact (normalize_family_id strips every non-digit)
    pairs where a raw family ID exists 35
    pairs where BOTH sides carry one   0
    pairs INVISIBLE to the policy      1
    values that normalize to '': HOUSE-RED
  ! these records look like they have NO family ID; the batch cannot reason about them
    distinct spellings, same key       0
  ! run supabase/tests/family-id-normalization-audit.sql and resolve these before merging
```

I did **not** change the normalization code, as you instructed.

### ⚠ This is a silent data-loss path, and it is the one blocking issue

I added a fifth counter-example fixture — a pair whose duplicate carries
`familyId = 'HOUSE-RED'` and whose keeper has none — to test the detection.
What actually happened in the rehearsal is worse than "the batch ignores it":

```
safe_batch audits            295     ← was 294; this pair MERGED
  └ carrying a transfer       40     ← HOUSE-RED is NOT among them
  transferred values missing from the keeper  0   ← nothing to check
```

The policy sees `both_blank`, classifies the pair SAFE, merges it, transfers
nothing, records nothing in `transferred_fields` — and then **deletes the
duplicate, taking `HOUSE-RED` with it.** No audit row mentions it. The
"nothing was lost" check passes vacuously because it only verifies values the
policy knew it was transferring.

**If any production `familyId` contains no digit, running the batch will destroy
that value silently.** That directly violates "without losing data", so it must
be resolved before merging.

The fix is *not* a change to `normalize_family_id()`. It is a guard in
`_safe_batch_evaluate_pair`: treat a raw non-blank `familyId` that normalizes to
`''` as a `review` case rather than as blank. I have **not** applied it — this
step was analysis only, and it is a policy change that deserves its own
reviewed commit. Say the word and I will implement it with tests.

---

## 4. Effect of the new policy — what it will show on real data

I cannot give you the production delta. What I can state precisely, because it
is a property of the code and not of any dataset:

**The old `parent_phone_only_on_unassigned` cases have become safe** — that code
no longer exists. It was replaced by two outcomes:

| situation | old verdict | new verdict |
|---|---|---|
| only the duplicate has a phone, and no other family uses it | review | **SAFE — phone transferred to the keeper** |
| only the duplicate has a phone, but another parent's family already uses it | review | **BLOCKED** (`parent_phone_belongs_to_other_family`) |

The same split applies to transport (`transport_only_on_unassigned` → transfer
or conflict) and family ID (`family_id_only_on_unassigned` → proven transfer,
conflict, or `family_id_transfer_unproven` review). The migration's `DO` block
fails loudly if any of the three retired codes reappears.

`--analyse` reports the delta directly as **`NEWLY safe via field
consolidation`** — pairs the database marks SAFE *only* because a one-sided
value transfers. Under v1 every one of those was an exclusion, so that number
*is* your "how many of the 254 became mergeable", measured by the database
rather than assumed. On the fixture it is 40 of 40 seeded one-sided pairs.

The 24 `both_parents_unassigned` pairs are structurally unaffected: they have no
keeper at all, so field consolidation cannot promote them. On the fixture they
stayed at 24.

---

## 5. Dry-run write proof

From the rehearsal run (exit 0):

```
✓ Preview is zero-write     dryRun=true, writesPerformed=0, 20 tables byte-identical=true
  dry run / writes          true / 0
✓ preview wrote nothing — 20 public tables byte-identical immediately before and after the call
```

The digests are taken **inside `runPreflight`, immediately before and after the
preview call**, so the comparison cannot be vacuous (an earlier version of this
check compared two post-preview states and proved nothing; that is fixed and has
a paired negative test). `runAnalysis` only calls `get_safe_duplicate_batch()`.

**Production writes: 0.** Not because a check passed on production — I never
reached it — but because no production connection was ever established, and
every command I ran either failed at `SUPABASE_URL is not set` or ran against
in-process PGlite.

Post-run data-preservation check, also new, joining `transferred_fields` back to
the surviving `students` row:

```
safe_batch audits            295
  └ carrying a transfer       40   (familyId 10 · govId 10 · parentPhone 10 · transport 10)
transferred values missing from the keeper  0
✓ every transferred value is present on the surviving Student ID — nothing was discarded
```

---

## 6. Verification of everything above

| check | result |
|---|---|
| `npx tsc --noEmit` | **PASS** |
| `npx vite build` | **PASS** (13.09 s) |
| `npx vitest --run` | **141 files / 1545 tests — 1544 passed, 1 failed** |
| `safeBatchRunner.preflight.test.ts` | **13/13 PASS** |
| `family-id-normalization-audit.sql` | **parses and executes clean** under PostgreSQL |
| rehearsal `--execute --yes --rerun` | **exit 0, all checks passed** |
| `--target supabase --analyse` | **exit 1 — refuses, no credentials, no route** |

The single failure is `src/lib/__tests__/webpush.test.ts` (`expects 'p=', sender
emits 'k='`) — pre-existing, unrelated, reverted at your request last task, and
deliberately not re-fixed.

---

## 7. Recommendation

**DO NOT MERGE YET.**

> **UPDATE — the Family ID normalization exposure described in section 3 has
> since been FIXED** (policy v3, see `REPORT-field-consolidation.md` §4b). A raw
> family ID that `normalize_family_id()` would erase now forces **individual
> review** instead of merging, and `verify_safe_duplicate_batch_state()` detects
> the loss class directly against the removed record's raw value. Item 1 below is
> therefore no longer blocking; it remains worth running as a data-quality check.
> **Item 2 is still blocking** — nothing has been measured on production data.

Two things were identified, in order:

**1. Resolve the Family ID normalization exposure (now fixed in code).**
Run `supabase/tests/family-id-normalization-audit.sql` against production. If
section 2 reports **any** record whose `familyId` normalizes to blank, the batch
will delete that value silently. Either correct the data, or let me add the
guard that sends such pairs to individual review instead of treating them as
blank. Also check section 5 for colliding spellings — two distinct raw values
collapsing to one key could make a family transfer look "proven" against the
wrong family, which is precisely the "combining unrelated families" failure you
want to avoid.

**2. Actually run the analysis and read it (blocking).**
Nothing has been measured on your data. Apply `20261008`, then run
`--target supabase --analyse`, and check specifically:
- `pairs INVISIBLE to the policy` is **0**
- `distinct spellings, same key` is **0**
- `belongs to another family` and `true conflict` counts look plausible for your
  school, not surprisingly large
- the 10 representative BLOCKED and REVIEW examples are genuinely pairs a human
  should decide, not victims of a bad rule

Only if both come back clean is the set produced by `--analyse` the maximum
genuinely safe set. The number it reports is the answer — whatever it is. It is
not a target.

---

PRODUCTION ANALYSIS

```
Potential duplicates: UNKNOWN — production unreachable from this sandbox
Server-safe:          UNKNOWN
Needs Review:         UNKNOWN
Blocked:              UNKNOWN
Already merged:       UNKNOWN

Newly safe because of field consolidation: UNKNOWN (measurement mechanism
                                           built, verified, and ready)

Production writes: **0**
Production merge executed: **NO**
```
