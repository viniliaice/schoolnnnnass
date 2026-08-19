# Transport editing + "empty means WALKER"

Phase 2 follow-up. Inspection-first: this documents what the repo **already**
had, what was genuinely missing, and the smallest change that closed the gap.

---

## 1. The existing transport model (inspected, not invented)

`students.transport TEXT`, nullable, with one CHECK constraint. The final
writer is `20260802_mark_student_left.sql:18`:

```sql
CHECK ("transport" IS NULL
       OR "transport" IN ('WALKER','CAR','LEFT')
       OR "transport" ~ '^\d+$')
```

**The single most important finding: there is no `BUS` value in this system.**
A bus rider's transport *is* the route number — `'9'`. Grepping `'BUS'` across
`src/` and `supabase/` returns nothing.

Consequences, which shaped everything below:

| Question | Answer from the repo |
|---|---|
| Is the bus number stored separately? | **No.** No `busNumber` / `route` column exists. The number is the value. |
| Is transport student- or family-level? | **Student-level.** It is a column on `students`; a family is just a shared `familyId`. Mixed families are legal. |
| Existing write RPC? | **Yes** — `set_student_transport(p_student_id, p_transport)`, `20260802_family_ids.sql:179`. |
| Existing write permission? | **admin only**, enforced in SQL (`insufficient_privilege` for all other roles). |
| Existing edit UI? | **None.** `handleTransport()` existed in `FamilyIds.tsx` but was wired to nothing — dead code. |

So **no new table, column, enum or RPC was added.** The DB side already
supported this feature completely; only the UI and the empty-value rule were
missing.

---

## 2. `BUS` is a UI concept only

Staff pick from three choices; storage stays canonical:

```
UI choice          stored value
─────────────────────────────────
Walker          →  'WALKER'
Car             →  'CAR'
Bus + route 9   →  '9'
```

`src/lib/transport.ts` owns the mapping in both directions:

- `transportChoiceOf('9') === 'BUS'`, `busNumberOf('9') === '9'`
- `toStoredTransport('BUS','9') === '9'`
- `toStoredTransport('BUS','')  === null` → **Save is disabled**, so the CHECK
  constraint can never be violated from the UI.

The route field appears only when Bus is selected, exactly as specified.

---

## 3. Empty transport means WALKER

Implemented as **normalization at the read boundary**, not a bulk `UPDATE`.

```ts
normalizeTransport(null | undefined | '' | '  ') === 'WALKER'
```

No migration rewrites live rows: stored `NULL` stays `NULL`, only its
interpretation is fixed. That keeps the change reversible and avoids touching
production data — the repo gave no evidence a rewrite was necessary.

`'LEFT'` is deliberately **preserved** by the normalizer: it is a status, not a
transport mode, and five call sites filter on it.

Applied consistently at every surface named in the request:

| Surface | Where |
|---|---|
| Family ID card | `familyTransportLabel()`, `KidRow` → `transportLabel()` |
| Family ID table | `FamiliesTable` per-student cell |
| Transport filters | `familyRowMatchesTransport()` normalizes before matching |
| Dismissal gate | `gateTransportLabel()` (bilingual: `Lug` / `Walker`) |
| Student/family lookup | via `transportLabel()` |
| Print preview | `PrintCardsDialog` → `transportLabel()` |
| Any transport badge | all badges route through `transportLabel()` |
| Transport grouping | `buildFamilyRows()` aggregation |

A child who simply walks is never rendered as `—` anywhere again.

**Behaviour changes this caused** (two existing tests updated deliberately):
- `transportLabel(null)`: `'—'` → `'WALKER'`
- `familyTransportLabel([no transport])`: `'GAAR / CAR'` → `'WALKER'`.
  The `'GAAR / CAR'` placeholder is still reachable, but now only when *every*
  child in the family has LEFT.

---

## 4. Student vs family transport

Transport is **student-level and stays that way.** A family may legitimately be:

```
Ahmed Sheikh    G7    Bus 9
Amina Sheikh    G4    WALKER
Yasmin Sheikh   KG    CAR
```

- The table now renders transport **per student, row-for-row aligned with the
  names**, instead of one value for the family.
- `students[0].transport` is used **nowhere** — that was bug B6, already fixed
  in the card and the filter; this change removes the last instance in the
  table cell.
- The mixed-family summary format is `Bus 9 · WALKER · CAR` (dot-separated
  distinct modes, roster order) — the representation the printed card already
  established, reused rather than reinvented.
- A mixed family matches **every** filter it contains: it appears under Bus
  riders *and* Walkers *and* Car pickup.

---

## 5. Editing UX

```
Family row → per-student transport cell → ✎ → Walker / Car / Bus (+route) → Save
```

Editing happens **in place on the Family IDs screen**. No navigation to other
admin pages. Each student has their own pencil control, and the dialog is
scoped to one student id, so `set_student_transport` writes exactly one row —
a sibling can never be modified by accident. The dialog states the current
value and warns that siblings are unaffected.

Save is disabled when nothing changed, and when Bus has no route number.

---

## 6. Permissions

**admin + office.** `canEditTransport(role)` in `src/lib/routing.ts`, mirroring
`set_student_transport()` as redefined in
`supabase/migrations/20260820_office_transport_edit.sql`.

Office was added because transport corrections are front-desk work: the office
answers the parent's phone call. Requiring an admin for a routine correction
either delays the fix or pushes the school to share an admin login — worse for
security than granting this one narrow write.

| Role | Browse / search / print | Edit transport | Generate / merge / split / import |
|---|---|---|---|
| admin | ✅ | ✅ | ✅ |
| office | ✅ | ✅ | ❌ |
| supervisor | ✅ | ❌ | ❌ |
| teacher | ❌ | ❌ | ❌ |
| parent | ❌ | ❌ | ❌ |

`supervisor` is deliberately excluded — a gate/oversight role here, not data
entry. Add later if the school asks.

### The narrow-widening invariant

Office gained `set_student_transport` and **nothing else**. Still admin-only:
`generate_family_ids`, `assign_family_override`, `mark_student_left`,
`set_student_import_fields`. So a front-desk account can fix a transport value
but cannot create, merge or split a family.

Three extra guards came with the widening:

1. **`LEFT` is not settable** through this function (it fails validation), and
   office additionally **cannot change the transport of a student already
   marked `LEFT`** — re-enrolment is an admin decision, not a side effect of a
   transport edit.
2. **No direct `UPDATE` grant** on `public.students`. The write goes through
   the `SECURITY DEFINER` function, so validation and the audit row cannot be
   bypassed.
3. **Actor attribution.** The audit row now records `actorId`, `actorRole` and
   the `previous` value, so a wrong change is traceable and reversible. Before,
   it recorded only the student and the new value — acceptable with one
   writer, not with two.

Verified on a live Postgres: admin+office allowed; supervisor, teacher, parent
and anonymous all blocked with `insufficient_privilege`; `'LEFT'`, `'Bike'`,
`''` and `'0042; DROP TABLE students'` all rejected; every `familyId` unchanged
across all writes. Pinned by `supabase/tests/rls-office-transport.sql`, which
was falsified twice (a simulated privilege leak and removed attribution both
fail it).

---

## 7. Import interaction

Inspected rather than assumed. Existing rule, in
`set_student_import_fields`:

```sql
"transport" = COALESCE(v_transport, "transport")
```

and `applyTransportImport` sends `NULL` for `unknown` and `LEFT` cells.

So today:

| Sheet cell | Effect on a manual correction |
|---|---|
| `Bike`, `?` (unknown) | `NULL` sent → **manual value survives** |
| `LEFT` | `NULL` sent → **manual value survives** |
| blank / `NB` / `0` | `'WALKER'` sent → **manual value overwritten** |
| `9` | `'9'` sent → **manual value overwritten** |

**Decision: no `imported` vs `manual override` columns were added.** The sheet
winning is the existing intended business rule, and adding provenance columns
would be a schema change the repo does not justify. But the silent part was
genuinely unsafe, so the smallest safe fix is **observability**:

`transportOverwrites()` compares each matched row's sheet value against the
student's currently stored value (normalized, so blank-vs-WALKER is not a
false alarm) and the import preview shows an amber panel:

> **3 row(s) would change a transport already saved** — the sheet wins when it
> has a value, so applying these will replace manual corrections made in the
> app. Review them, or uncheck that bucket above.

Staff can then deselect the bucket. Nothing is destroyed silently.

---

## 8. Family ID stability

A transport edit is **purely** a transport assignment change. It cannot
generate, change, split or merge a Family ID. Guaranteed structurally:

- `set_student_transport` updates only the `transport` column; it never
  touches `familyId` and never calls the generator.
- The client payload is exactly `{p_student_id, p_transport}` — asserted in a
  test that the serialized payload contains no `family` substring at all.
- A test asserts the RPC is called **once** and that
  `generate_family_ids`, `assign_family_override` and `mark_student_left` are
  never among the calls.

## 9. Card behaviour

There is **no second transport source for printing.** The card reads
`student.transport` through the same `transportLabel()` as the table, so the
next print after an edit shows the new value:

```
Before:  Ahmed Sheikh  G7  WALKER
Edit:    Ahmed Sheikh  →  Bus 9
Print:   Ahmed Sheikh  G7  Bus 9
```

---

## 10. Files touched

| File | Change |
|---|---|
| `src/lib/transport.ts` | `normalizeTransport`, `transportChoiceOf`, `busNumberOf`, `toStoredTransport`, `TransportChoice`; `transportLabel` normalizes |
| `src/lib/routing.ts` | `canEditTransport()` |
| `src/lib/i18n/gateStrings.ts` | gate badge normalizes |
| `src/lib/print/familyRows.ts` | aggregation + filter normalize |
| `src/lib/print/familyCards.tsx` | card footer normalizes |
| `src/lib/import/transportImport.ts` | `currentTransport` on matched rows; `transportOverwrites()` |
| `src/pages/admin/family-ids/EditTransportDialog.tsx` | **new** — the edit dialog |
| `src/pages/admin/family-ids/FamiliesTable.tsx` | per-student transport + edit control |
| `src/pages/admin/FamilyIds.tsx` | wires `handleTransport` (was dead code); overwrite warning panel |

No migration. No new table, column or RPC.

---

# CORRECTION (required): transport filtering and printing are STUDENT-level

Transport belongs to the individual student, never automatically to the whole
family. This correction makes filtering, selection, counting and **printing**
all operate on student records.

## The two print modes are now distinct

```
FAMILY PRINT            = print the complete active family
STUDENT/TRANSPORT PRINT = print only the selected/matching students
```

`resolvePrintBatch()` no longer applies one rule to both:

| Source | Renders |
|---|---|
| `{kind:'families', familyIds}` | the **full** active roster of each family |
| `{kind:'students', studentIds}` | **only** those students; unselected siblings counted in `omittedSiblings`, never rendered |

A card still groups by family — that is the physical artifact — but in student
mode it lists only the selected members.

## The bug this fixed was in THREE layers, not one

Fixing the resolver alone would not have worked:

1. **`resolvePrintBatch()`** expanded every family to its full roster for both
   source kinds (old rule 4). Fixed by the mode split above.
2. **`useCardPdf`** passed only `familyIds` to `getFamilyCards()`, and that RPC
   deliberately returns the **complete** family. So a narrowed selection
   re-expanded at PDF build time. Fixed with an optional
   `RestrictTo = Map<familyId, Set<studentId>>` applied to the server's answer
   — parent name/phone still come from the server, only the student list
   narrows. Family mode passes `undefined` and prints everyone.
3. **"Print all"** in `FamiliesTable` always sent `{kind:'families'}`, so
   filtering to WALKER and pressing Print printed the bus-riding siblings.
   It now sends `{kind:'students', studentIds}` whenever a transport is
   selected.

## The transport dropdown is student-level and route-aware

Built from the data via `transportOptions(rows)`:

```
All students · Walkers · Car pickup · Any bus · Bus 17 · Bus 18 · …
```

`'bus'` (any bus) and `` `bus:17` `` (that route only) are distinct selections.
Helpers in `familyRows.ts`: `studentMatchesTransport`,
`studentsMatchingTransport`, `busRouteOptions`, `familyRowMatchesSelection`.

When a transport is active:
- the family row stays visible (staff keep family context), but
- counts, selection and print all derive from the matching **students**, and
- the Print button reads e.g. *"Print 2 Bus 17 students"*.

## Partial families are disclosed, never silent

The dialog shows an amber note — *"Printing selected students only. Siblings
who are not part of this selection are left off the card."* — and each card
line carries a `+N siblings not printed` badge. `describePrintBatch()` reports
`N unselected siblings not printed`.

## Empty transport

Unchanged: NULL/empty → WALKER. Such a student appears under the WALKER
filter, prints through a WALKER selection, is WALKER on the card, and appears
under neither BUS nor CAR.

## Tests

`src/lib/print/__tests__/transportPrintScope.test.tsx` (25 tests) covers the
mandated MBK-0003 scenario exactly:

| Test | Expected | Result |
|---|---|---|
| 1 — WALKER filter | 1 student: Cabdale | ✅ |
| 2 — BUS 17 filter | 2 students: Axmed, Maxamed | ✅ |
| 3 — WALKER print | card has Cabdale G10; **not** Axmed/Maxamed | ✅ |
| 4 — BUS 17 print | card has Axmed G11 + Maxamed G9; **not** Cabdale | ✅ |
| 5 — family print | all three siblings | ✅ |

Tests 3 and 4 assert on the **rendered card markup**, not just the resolver, so
a regression in any of the three layers fails them. Falsified: reverting the
mode split fails 6 tests.

Two pre-existing `printBatch.test.ts` tests were updated deliberately — they
asserted the old expand-always behaviour that this correction removes.
