# Investigation — Family ID MBK-0305 covers two households

Date: 2026-11-09 · Branch: `arena/9fbe20fc-schoolnnnnass` (follow-up to `arena/b8854764-schoolnnnnass`, PR #83) · Scope: `/admin/family-ids`, `generate_family_ids()`, `split_family_members()`, `assign_student_parent()`, family-card printing.

> **Update (same day).** Office staff can now perform the split themselves — the front desk is
> who spots and prints a merged card, so requiring an admin turned a two-click repair into a
> queue. `20261109b_office_split_family.sql` widens the RPC to `('admin','office')`; generation,
> manual override, mark-left and the sheet import remain admin-only. Everything else in this
> document is unchanged.

## 1. What was reported

The office opened **Setup & Generate → Aqoonsiga qoyska → MBK-0305** and found 8 students from what they know to be **two different families** on one card:

| Student | Class | Parent account on the record |
|---|---|---|
| Akram salebaan cabdi | G2-B | `ikraanmaxmedaxmed` |
| barwaaqo maxamed heeban | G2-C | `ikraan cabdi khaliif` |
| Cabdiraxmaan Maxamed Heebaan | G6-A | `ikraan cabdi khaliif` |
| CabdiWaasac Maxamed Heebaan | G4-B | `ikraan cabdi khaliif` |
| Cawale Maxamed Heebaan | G8-B | `ikraan cabdi khaliif` |
| Marwa suleban cabdi | G6-B | *(no parent account)* |
| Safa sulayman cabdi | G9-A | `ikraanmaxmedaxmed` |
| Sudaysi sulayman cabdi | G9-B | `ikraanmaxmedaxmed` |

## 2. Confirmed cause (verified against the live database, read-only)

The Family ID is **frozen at generation time and never re-evaluated**. `generate_family_ids()`
(`supabase/migrations/20260819_family_id_stability_and_cards.sql`) groups every student that has no
ID yet by one key:

```sql
CASE
  WHEN s."parentId" IS NOT NULL THEN 'p:' || s."parentId"
  WHEN normalize_phone(s."parentPhone") <> '' THEN 't:' || normalize_phone(s."parentPhone")
  ELSE NULL
END AS family_key
```

…and writes **one** `MBK-####` per key. Nothing ever revisits that decision:

* `assign_student_parent()` only writes `students."parentId"` — it does not touch `"familyId"`.
* `set_student_transport()` only writes `students."transport"`.
* `generate_family_ids()` skips every student that already holds an ID
  (`WHERE s."familyId" IS NULL`), so a corrected household is never re-grouped.

That is the whole bug: **the household data can change after the ID is issued, but the ID cannot.**

### How MBK-0305 got its two households

Timeline reconstructed from `audit_logs` and the row timestamps:

| When (UTC) | Event |
|---|---|
| 2026-03-24 10:02 | Parent account **`ikraan cabdi khaliif`** created. |
| 2026-03-24 11:11 | All 8 students imported (same batch). |
| 2026-08-02 20:14 | **Generate #1** — 486 families / 1,049 students assigned. MBK-0305 is issued here. |
| 2026-09-07 16:44 | **Generate** — 191 new families, 3 joined an existing family, **3 phone joins** reported. |
| 2026-09-07 16:59 | Second parent account **`ikraanmaxmedaxmed`** created (+46728665957) — *after* the ID existed. |
| 2026-11-08 08:59–09:02 | Office re-links students to `ikraanmaxmedaxmed` (`students.parent_assignment`). Family ID untouched. |
| 2026-11-08 09:13 | Admin override puts Marwa (no parent) into 0305 (`family_ids.override`). |

So at the moment MBK-0305 was issued, the students were one group — either all under the single
parent account that existed in March, or parentless and sharing one phone number, which the
generator treats as a family key (`'t:'`). The office then corrected the household in
`parentId`, but the MBK number stayed. **An ID is not a household; it is a photograph of the
household at the moment Generate ran.**

### How widespread is it *right now*

```sql
SELECT normalize_family_id("familyId") AS family_id,
       count(DISTINCT "parentId") AS parent_accounts,
       count(*) AS students
  FROM students
 WHERE "familyId" IS NOT NULL AND transport <> 'LEFT' AND "parentId" IS NOT NULL
 GROUP BY 1
 HAVING count(DISTINCT "parentId") > 1;
```

Result on 2026-11-09: **exactly one row — 0305** (2 parent accounts, 8 students). The reported
family is the only current instance, but the mechanism is systemic: any phone-shared group from a
Generate run is exposed, and `phoneJoins` in the generate result only *reports* cross-run phone
joins — nothing forces a review, and the warning disappears with the toast.

### Why it could not be fixed from the UI

The only existing repair was `assign_family_override(p_student_id, p_family_id)` behind a
`window.prompt`. To separate two families an admin had to:

1. find a free 4-digit number by hand (typing an ID that is already in use **silently merges two
   families** — the opposite of the intent, and that is exactly how a 5th group could be joined
   to 0305), and
2. repeat it one student at a time, with no record of which group was moved.

There was no bulk, safe, or auditable "separate these students" operation.

## 3. What was shipped on this branch

### 3.1 `split_family_members()` — the missing repair operation

`supabase/migrations/20261109_split_family_members.sql`

* **admin + office** (`current_profile_role() IN ('admin','office')`; generation, override, mark-left and the sheet import stay admin-only);
* allocates the **next free number itself** under the same
  `pg_advisory_xact_lock('family_ids_generate')` as the generator — no manual typing, no collision,
  no race with a Generate run;
* validates that **every selected student is currently in the family being split** (a stale screen
  cannot move someone else's student);
* **refuses to move everyone** — at least one student must remain, so no empty/phantom family is
  left behind;
* writes **only** `familyId`; parent account, phone, transport and status are untouched;
* writes an audit row `family_ids.split` with the old ID, the new ID and the student ids.

### 3.2 "Split…" in the Family IDs table (admin + office)

* `src/pages/admin/family-ids/SplitFamilyDialog.tsx` — groups the family's students **by parent
  account** (the only exact signal; Somali names are spelled inconsistently — `salebaan` /
  `suleban`, `maxamed` / `maxamad` — so surname grouping would mislead), with
  *Select group* shortcuts, a running "N move / M stay" summary, and the server's own guards
  surfaced inline.
* `FamiliesTable.tsx` — a **Split** button on every family with 2+ students, highlighted when the
  family holds more than one parent account, plus an amber **"N parents"** badge on the Family ID.
  That badge is how staff find the next 0305: it flags the exact condition with no heuristics.

### 3.3 "No parent" tab (the requested office screen)

* `src/pages/admin/family-ids/NoParentStudents.tsx`, reachable as a **tab on Family IDs** and as a
  deep link **`/admin/family-ids/no-parent`** (admin, supervisor, office), plus sidebar entries and
  an Office Dashboard card ("Ardayda aan waalid lahayn").
* Lists active students with **no parent account** (search by name/class/phone/MBK, class filter),
  and splits the count into *already has a Family ID* vs *still needs one*.
* Live count on 2026-11-09: **289 of 1,284 active students** have no parent account; 286 of them
  already hold a Family ID (only 3 hold none). That is the review list behind the "3 Unattached"
  figure — "unattached" only ever meant *no parent and no phone*, never *no parent*.
* Read-only by construction. Parent assignment stays in **Manage Students**
  (`assign_student_parent`, admin + office) — no new write path was invented for this screen.

## 4. Separate MBK-0305 — exact steps

1. Open **Family IDs** (admin **or office** login) and search `0305` (or `MBK-0305`).
2. The row shows **"2 parents"**. Press **Split**.
3. In the dialog choose the group that belongs to the other household. For the reported case the
   data splits cleanly as:
   * `ikraan cabdi khaliif` → barwaaqo, Cabdiraxmaan, CabdiWaasac, Cawale (Maxamed Heebaan) — 4
   * `ikraanmaxmedaxmed` → Akram salebaan cabdi, Safa sulayman cabdi, Sudaysi sulayman cabdi — 3
   * *no parent account* → Marwa suleban cabdi — 1 (same father as Akram: Salebaan Cabdi)
4. Confirm. The selected students receive a brand-new `MBK-####`; everyone else keeps 0305.
   **Print the replacement card** for the new family (the old printed card still lists all 8).
5. Repeat if a third group is involved: a family with 3 groups needs two splits (each split
   allocates one new number).

Nothing is deleted, no history is lost, and the split is reversible with **Split** again or by
assigning students back with **Assign**.

## 5. Guardrails & follow-ups

* **Printing is still non-mutating** — `get_family_cards()` is `STABLE`, and the split path is the
  only place that changes an ID from this screen (admin + office, audited with the actor and
  their role).
* **Generator behaviour was deliberately not changed.** Auto-splitting phone-shared groups would
  create duplicate IDs for real siblings imported with a shared parent phone. Instead the ambiguity
  is now visible (parent-count badge) and repairable (Split).
* Suggested next step (not in this change): make `assign_student_parent()` warn when the student's
  current family already holds a different parent account, so a correction cannot silently leave a
  merged card behind. It should warn, not auto-split — one household can legitimately have two
  parent logins.
* The `phoneJoins` report from Generate remains toast-only. A review queue for those joins would
  close the *same-run* phone merge path, which the parent-count badge cannot see (parentless
  students).

## 6. Tests added

| File | Covers |
|---|---|
| `src/lib/__tests__/familySplit.db.test.ts` | **Executes both shipped migrations on real PostgreSQL (PGlite)**: office can split while teacher/anon cannot, membership guard, leave-one guard, `MAX+1` 4-digit allocation, only `familyId` changes, audit row (with `byRole`), malformed legacy ID cannot break allocation, admin still works. |
| `src/lib/__tests__/splitFamilyDialog.page.test.tsx` | the reported MBK-0305 shape end-to-end: "2 parents" badge → Split → group by parent account → RPC called with the chosen ids; the whole-family move is blocked; office sees the action (but not Generate) while a supervisor does not. |
| `src/lib/__tests__/familyMergeSplit.test.ts` | no-parent filtering (LEFT/former excluded), distinct parent accounts per family, split RPC client contract (normalization, dedupe, empty selection, server error). |
| `src/lib/__tests__/noParentStudents.page.test.tsx` | the tab renders only parentless active students, reports "already have"/"still need" counts, and never exposes the print surface. |
| `src/lib/__tests__/routing.test.ts` | `/admin/family-ids/no-parent` is open to admin/supervisor/office and closed to teacher/parent; `canSplitFamily` allows admin + office only and does not widen generation. |

Preview parity: `src/lib/supabase.ts` now implements `split_family_members` on the in-memory
demo roster (same guards and `MAX+1` allocation), so the split flow can be demonstrated without a
backend.
