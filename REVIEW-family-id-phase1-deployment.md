---
type: Review
title: Family ID Phase 1 — Review Packet & Gated Deployment Runbook
description: Reviewer guide and production deployment runbook for the Family ID stability, card-completeness and grade-on-card changes, gated on RPC-overload check, SECURITY DEFINER review, and split-family decisions
resource: schoolnnnnass/REVIEW-family-id-phase1-deployment.md
tags: [review, deployment, family-ids, security, runbook]
timestamp: 2026-08-19T00:00:00Z
---

# Family ID Phase 1 — Review Packet & Deployment Runbook

Branch: `arena/01a01959-schoolnnnnass` · Commit: `d0fdf16`
Status: **APPROVED FOR REVIEW — deployment gated** (3 gates below)
Spec: `SPEC-family-id-printing-implementation.md` · Design: `DESIGN-family-id-printing-FINAL.md`

Quality gates already green: `tsc --noEmit` clean · **314/314 tests** (baseline was 260) · `vite build` OK.

---

## 0. What a reviewer needs to know in 60 seconds

Three real defects are fixed, one claimed defect was **disproven and deliberately not "fixed"**, and one feature is added.

| Change | Why it matters |
|---|---|
| `generate_family_ids()` reuses a family's existing ID | A sibling enrolling later used to get a **second** `MBK-####`. The gate then showed an incomplete family — a child unaccounted for at dismissal |
| Stale 0-arg overload dropped | Two overloads existed; the **stale** one was applied last, so the app's "All" call was ambiguous |
| `mark_student_left()` no longer nulls `familyId` | Restoring a student used to mint a different ID |
| New `get_family_cards()` (SECURITY DEFINER, STABLE) | Supervisors printed cards **missing siblings**; office/supervisor printed a **blank parent name** |
| Grade chip on the card | Requested feature; source is `students.className` |
| Duplex layout **unchanged** | The claimed partial-page bug does not exist — measured. A regression test now locks the working behaviour |

**Everything below was verified by executing the migration on a real PostgreSQL 16 instance**, not by reading the SQL.

---

## 1. Verification evidence (real Postgres, not review-by-inspection)

I stood up PostgreSQL 16, recreated the live schema and the **pre-migration production state** (both overloads present, stale one last), applied the migration, and exercised it.

### 1.1 The critical bug, before and after

```
After first Generate:      Xalimo → 0001,  Ahmed → 0001
New sibling Yasmin enrols, admin runs Generate:
  {"familiesCreated": 0, "studentsJoined": 1, "studentsAssigned": 1}
  Xalimo → 0001,  Ahmed → 0001,  Yasmin → 0001
  distinct family IDs for one family = 1        ✅ PASS
```

### 1.2 Mark-left / restore

```
mark_student_left('s2', true)  → transport=LEFT, familyId=0001  (preserved)
mark_student_left('s2', false) + Generate → familyId=0001       ✅ PASS
```

### 1.3 Role matrix — measured by psql exit code, not by reading policy text

| Role | `get_family_cards` | `lookup_family` | `generate_family_ids` | `mark_student_left` |
|---|---|---|---|---|
| admin | 1 family | 2 students | ALLOWED | ALLOWED |
| supervisor | **1 family (complete roster)** | 2 students | BLOCKED | BLOCKED |
| office | 1 family | 2 students | BLOCKED | BLOCKED |
| teacher | **0** | **0** | BLOCKED | BLOCKED |
| parent | **0** | **0** | BLOCKED | BLOCKED |

The supervisor row is the fix for B4: previously a supervisor's card was built from RLS-scoped reads and silently omitted siblings outside their assigned classes. Confirmed the RPC returns the full roster **and** the parent name (`"parentName": "Xasan"`), which office/supervisor could never read before.

### 1.4 "Printing cannot write" is enforced by Postgres, not by convention

```sql
CREATE FUNCTION probe() RETURNS jsonb LANGUAGE sql STABLE ... AS $$ UPDATE students ... $$;
SELECT probe();
→ ERROR:  UPDATE is not allowed in a non-volatile function
```

`get_family_cards` is `STABLE`, so the print path is structurally incapable of creating or changing a family ID.

### 1.5 Behaviour on already-damaged data

| Scenario | Result |
|---|---|
| Run fixed Generate over already-split families | **No change** — idempotent, does not worsen |
| New sibling into an already-split family | Joins the **lowest** existing ID; no third ID minted |
| Restore a LEFT student whose ID was destroyed by the old code | Joins the family via the new reuse path |

### 1.6 Assertion suites

* `supabase/tests/rls-family-cards.sql` → **all 8 assertions passed** (rc=0)
* `supabase/tests/preflight-family-id-stability.sql` → runs clean; **Gate 3 correctly detected seeded damage** (2 split families, 5 students, 1 orphaned LEFT student)

---

## 2. GATE 1 — Live RPC overload check *(blocking)*

**Run:**
```bash
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 \
  -f supabase/tests/preflight-family-id-stability.sql
```

**Read the "zero-arg callable candidate" result:**

| Rows | Meaning | Action |
|---|---|---|
| **2** | Ambiguous — this is the expected pre-migration state | Proceed; the migration's `DROP FUNCTION public.generate_family_ids()` resolves it |
| **1** | Already unambiguous | Confirm it is the `(text)` filtered body before proceeding |
| **0** | Neither is zero-arg callable | **Stop** — the app's "All" call is already failing; investigate first |

**After applying, re-run and require exactly one row:** `generate_family_ids(text)` with `reuses_existing_id = t`, `has_advisory_lock = t`, `reports_joined = t`.

> Note the migration drops **only** the 0-arg overload. If production somehow has a *third* signature, the preflight will show it and the drop must be extended before deploying.

---

## 3. GATE 2 — `SECURITY DEFINER` review *(blocking)*

`SECURITY DEFINER` runs with the **owner's** privileges and bypasses RLS, so each one needs justification. Four functions are touched.

| Function | DEFINER | Volatility | Why DEFINER is necessary | Role gate |
|---|---|---|---|---|
| `generate_family_ids(text)` | yes | VOLATILE | `students` is SELECT-only under RLS; the generator must write `familyId` | `admin` only |
| `mark_student_left(text,bool)` | yes | VOLATILE | Same — writes `transport` | `admin` only |
| `lookup_family(text)` | yes | STABLE | Gate staff must see a family's children regardless of class-scoped RLS | `admin`/`supervisor`/`office` |
| `get_family_cards(text[])` | yes | **STABLE** | The whole point: a card must be **complete** for every gate role, incl. parent name from `profiles` | `admin`/`supervisor`/`office` |

### 3.1 Adversarial testing of `get_family_cards` (executed, not reasoned)

| Attack | Result |
|---|---|
| `ARRAY[]::text[]` (empty) | 0 families |
| `NULL` argument | 0 families |
| `ARRAY['0001'' OR ''1''=''1']` (injection-shaped) | 0 families — parameterised, no dynamic SQL |
| `ARRAY['%']` / `ARRAY['.*']` (wildcard/regex) | 0 families — exact match after digit normalization |
| No profile / unknown profile id | 0 families |
| teacher / parent | 0 families |

**Bulk enumeration is possible for gate roles**: passing `ARRAY['0001'…'9999']` returns every family. This is **not a new exposure** — the already-shipped `lookup_family` has identical reach for the same three roles (verified side by side: both return 5/5 for supervisor+office, 0 for teacher/parent). Gate staff are trusted with exactly this data; it is what they read off the card at dismissal. Accepted, unchanged posture.

> Harness note: an early run appeared to show a role-without-profile bypass. That was an artifact of the test stub (`RESET` left an empty string rather than NULL). Re-tested with production-faithful `current_profile_id()`/`current_profile_role()` that both derive from a single `profiles` row — boundary is correct.

**Hardening — verified live, all four:**
- `search_path = public` pinned on every function (blocks search-path privilege escalation)
- `REVOKE ALL … FROM PUBLIC` + `GRANT EXECUTE … TO authenticated`; `public_can_execute = f` confirmed
- Every body role-gates via `current_profile_role()`
- `students` still has **no** direct INSERT/UPDATE/DELETE policy — RPC-only design intact
- The preflight's "red flags" query returned **0 rows**

**What a reviewer should scrutinise:**

1. **Scope of `get_family_cards`.** It returns any family by ID to any gate role. That matches `lookup_family`'s existing posture (already shipped and reviewed). It exposes: student name, class, transport, parent name, parent phone — exactly what is printed on the card. It does **not** accept a wildcard: an empty/NULL array returns `[]`.
2. **No `WITH CHECK`/injection surface.** Both new read functions are `LANGUAGE sql` with parameterised predicates; no dynamic SQL (`EXECUTE`/`format`) anywhere in this migration.
3. **Advisory lock.** `pg_advisory_xact_lock(hashtext('family_ids_generate'))` serialises Generate. It is transaction-scoped, so it releases on commit/rollback — no deadlock risk with other features (nothing else uses this key).
4. **Audit trail.** Generate and mark-left still write `audit_logs`. Note the pre-existing finding that `audit_logs` is world-readable/insertable (`00001_create_audit_logs.sql`) — **unchanged by this work**, tracked for Phase 3.

---

### 3.2 Can the reuse rule merge two legitimate households? (reviewer item 4)

Tested all four shapes against the migrated database:

| Case | Shape | Result |
|---|---|---|
| **A** | Two households, **different `parentId`**, same phone | **2 IDs — not merged.** `parentId` wins over phone |
| **B** | Two households, neither has `parentId`, same phone, same run | 1 ID — merged. **Pre-existing behaviour**, unchanged by this PR (verified against the old body) |
| **C** | Existing `parentId` family + newcomer with **phone only**, same phone | 1 ID — newcomer joins. **This is the one behaviour the reuse rule widens** |
| **D** | Same shape as C, but genuinely the same household (sibling imported from the sheet) | 1 ID — correct, and the main reason the fix exists |

**Cases C and D are byte-identical in the data** (`parent=hA/phone=X` + `parent=NULL/phone=X`). No algorithm can separate them; only a person knows whether one phone means one household.

What actually changed: phone-collision merging already existed (Case B) — the reuse rule extends it **across runs** rather than only within a single run. It is a widening in time, not a new class of merge.

**Mitigation shipped in this review:** `generate_family_ids` now returns `phoneJoins[]` — every join made on a **phone key only** (`parentId` joins are unambiguous and are not flagged). The admin page renders an amber "please check" panel listing family ID, phone, and student names, with a pointer to reassign a wrong one. Verified: Case C is flagged, Case D-by-`parentId` produces `phoneJoins: []`.

This is the right trade: refusing phone-keyed joins would reintroduce the family-splitting bug for the common case, and auto-merging silently is what we are guarding against. The join proceeds (consistent with existing behaviour) and is made visible.

## 4. GATE 3 — Historical split families *(blocking, human decision)*

The fix prevents **new** splits. Families already split by the old code must be reconciled by a person — merging two real families is a judgement call, so nothing is automated.

**Step 1 — get the list** (sections 3a–3d of the preflight):

* **3a** headline counts
* **3b** the decision list: one row per split family, with `keep_id_suggested` (the lowest/oldest number — most likely already printed and in parents' hands) and `ids_to_merge_away`
* **3c** cross-key cases: siblings linked by `parentId` vs by phone — extra care
* **3d** students marked LEFT whose ID was already destroyed

Example of real output against seeded damage:

```
 family_key  | keep_id_suggested |   all_ids   | ids_to_merge_away | students | roster
-------------+-------------------+-------------+-------------------+----------+---------------------------
 p:p2        | 0005              | {0005,0012} | {0012}            |        3 | Hodan (0005); Yusuf (0005); Sagal (0012)
 t:699887766 | 0020              | {0020,0021} | {0021}            |        2 | Amina (0020); Khadar (0021)
```

**Step 2 — decide per family.** For each row, confirm it is genuinely **one** family (a shared phone can legitimately be two households — the design has always flagged this) and record the decision.

**Step 3 — merge via the existing admin UI.** `/admin/family-ids` → *Unattached/Assign* → `assign_family_override(studentId, keepId)`. That path is already audit-logged and 4-digit-guarded. Move the minority students onto `keep_id_suggested`.

**Step 4 — reprint.** Any family whose number changed needs a new card. After Phase 2 ships this is a row-level *Print*; today, filter and print from the existing print section.

**Step 5 — re-run the preflight.** 3a should report `split_families = 0`.

> **Deliberate scope choice:** no automated merge script. An incorrect auto-merge would give two different households the same gate credential — strictly worse than the bug being fixed.

---

## 5. Deployment runbook

```bash
# 1. PREFLIGHT (read-only; safe any time). Save the output.
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 \
  -f supabase/tests/preflight-family-id-stability.sql | tee preflight-before.txt
#    → GATE 1: note overload count · GATE 2: red-flag query must be empty
#    → GATE 3: capture the split-family list

# 2. BACKUP (the migration rewrites 4 functions; data is untouched, but snapshot anyway)

# 3. APPLY
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 \
  -f supabase/migrations/20260819_family_id_stability_and_cards.sql

# 4. ASSERT
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 \
  -f supabase/tests/rls-family-cards.sql          # expect: all assertions passed

# 5. RE-PREFLIGHT
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 \
  -f supabase/tests/preflight-family-id-stability.sql | tee preflight-after.txt
#    → exactly ONE generate_family_ids(text); zero red flags

# 6. SMOKE TEST (admin account)
#    a. /admin/family-ids → Generate → toast reports "N joined an existing family" where applicable
#    b. Print cards → each student row shows a grade chip (G7 / KG / F-A)
#    c. Mixed-transport family footer reads e.g. "Bus 9 · WALKER"
#    d. /gate → type a known family ID → all siblings listed
#    e. Log in as OFFICE → print the same family → parent name present, same sibling count

# 7. GATE 3 remediation → merge decided families → reprint affected cards
```

**Rollback.** Functions only; no schema/data change. Re-apply the previous definitions from
`20260802_generate_transport_filter.sql` + `20260802_mark_student_left.sql` + `20260802_fix_live_role_check.sql`, then `DROP FUNCTION public.get_family_cards(text[])`. Frontend calls `get_family_cards` for card data, so roll back the app together with the DB (or leave the function in place — it is read-only and harmless).

**Frontend/DB ordering.** The app now reads cards via `get_family_cards`. Apply the **migration first**, then deploy the frontend. If the frontend ships first, the Print action errors (visibly, with the RPC message) — it does not fail silently or print a wrong card.

---

## 5.1 Review execution log (all items run against PostgreSQL 16)

Full gated sequence executed on a clean database seeded with the **pre-migration production state** (both overloads) plus realistic damaged data.

| # | Item | Result |
|---|---|---|
| 1 | Preflight, all three gates | ✅ Before: Gate 1 **2 candidates (ambiguous)**, Gate 2 **4 red flags**, Gate 3 **2 split families + 1 orphaned LEFT** |
| 2 | Gate 1 zero-candidate rule | ✅ Not triggered (2 before, 1 after). Rule documented for production |
| 3 | `get_family_cards` security | ✅ `search_path=public` pinned, PUBLIC revoked, role-gated, `STABLE`; 6 adversarial inputs all returned 0 families (see §3.1) |
| 4 | Household merge safety | ✅ Analysed 4 cases; Case C widening identified and mitigated with `phoneJoins` review panel (see §3.2) |
| 5 | Split families not auto-merged | ✅ Generate over split data: **byte-identical before/after**; preflight still reports 2 for human decision |
| 6 | Migration before frontend | ✅ Applied first; rc=0; 8/8 RLS assertions pass |
| 7 | Preflight after migration | ✅ Gate 1 **exactly 1** `generate_family_ids(text)` with reuse+lock+joined; Gate 2 **0 red flags** |
| 8 | Suite / typecheck / build | ✅ **298/298**, `tsc` clean, `vite build` OK |
| 9 | Functional smoke | ✅ See below |

**Smoke results (item 9):**

- **Generation:** new sibling → `{"studentsJoined": 1, "familiesCreated": 0}`, all three siblings on `0001`
- **LEFT/restore:** `transport=LEFT id=0001` → restore → `id=0001` (preserved)
- **Card retrieval:** admin / supervisor / office **all return the identical complete card** — parent name `Xasan Maxamed Cabdi`, 3 siblings, classes and transport intact; teacher and parent get 0
- **LEFT exclusion:** card and gate both drop to 2 students while the ID is retained
- **Phone consistency:** card `0612345678` == gate `0612345678`
- **Grade display (real PDF):** `Ahmed Xasan|G3` · `Xalimo Xasan|G7` · `Yasmin Xasan|KG`
- **Mixed transport:** footer badge `WALKER · Bus 9`

## 6. Reviewer checklist

**Correctness**
- [ ] `generate_family_ids` reuses an existing ID (`v_existing` lookup precedes allocation)
- [ ] Group-key resolution matches the established rules (`parentId` → else normalized phone)
- [ ] `mark_student_left` preserves `familyId` in **both** directions
- [ ] LEFT filter applied in **all four** readers: `lookup_family`, `get_family_cards`, `groupStudentsByFamily`, `buildFamilyCardData`
- [ ] Advisory lock present; `studentsJoined` reported and surfaced in the UI

**Security**
- [ ] All four functions: DEFINER justified, `search_path` pinned, PUBLIC revoked, role-gated
- [ ] `get_family_cards` is `STABLE` (printing cannot write)
- [ ] No dynamic SQL; `students` still has no direct write policy

**Card / feature**
- [ ] Grade sourced from `students.className`; `formatGradeLabel` does not collide with `getGrade(score)`
- [ ] Grade chip is inside each student's row (cannot detach from the wrong student)
- [ ] Duplex behaviour **unchanged**; regression test locks it

**Process**
- [ ] Gate 1 output attached
- [ ] Gate 2 red-flag query empty
- [ ] Gate 3 list reviewed, decision recorded per family, reprints planned

---

## 7. Known-and-accepted (not introduced here)

| Item | Status |
|---|---|
| `audit_logs` world-readable/insertable | Pre-existing; Phase 3 |
| `canAccessRoute()` never called at runtime | Pre-existing; Phase 2 (matters when `/setup` route lands) |
| Two households legitimately sharing a phone | By design; surfaced by preflight 3c, resolved via admin override |
| Root `supabase-schema.sql` is a stale snapshot | Pre-existing; documented in `INVESTIGATION-family-ids.md` |
| Print UX (search/select/print-by-students) | **Phase 2** — spec'd, not in this commit |
