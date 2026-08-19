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

**Admin only.** `canEditTransport(role)` in `src/lib/routing.ts`.

This deliberately mirrors `set_student_transport`, which raises
`insufficient_privilege` for every non-admin. The client check is convenience
only — **SQL remains the enforcement point.**

| Role | Browse / search / print families | Edit transport |
|---|---|---|
| admin | ✅ | ✅ |
| supervisor | ✅ | ❌ |
| office | ✅ | ❌ |
| teacher | ❌ | ❌ |
| parent | ❌ | ❌ |

The requirement that print/search-only roles must not gain student-write
access is satisfied and asserted in tests: office and supervisor render the
table with **zero** edit controls, while keeping full read and print.

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
