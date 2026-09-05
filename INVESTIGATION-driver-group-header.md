# Investigation — Driver group header on the dismissal gate

Date: 2026-09-05 · Branch: `arena/01a071d8-schoolnnnnass` · Base: `23ba781` (main)
Scope: the "driver group" block rendered above each driver's assigned students on `/gate` — who owns the markup, whether the driver photo is available at that level, and what the existing style/responsive conventions are.

Method: targeted reads of `src/pages/admin/gate/GateScreen.tsx`, `src/pages/admin/gate/AssignDriverPanel.tsx`, `src/pages/admin/drivers/ManageDrivers.tsx`, `src/lib/db/authorizedPickups.ts`, `src/lib/i18n/gateStrings.ts`, plus greps for breakpoint and avatar patterns. No production code modified in this pass. Baseline re-confirmed green before any edit: **`tsc --noEmit` clean, 507/507 tests in 54 files, `vite build` OK**.

> Note on tooling: this repo has no `gstack` skill installed — `skills-lock.json` lists only `vercel-react-best-practices`, and `AGENTS.MD` references an `okf` skill at `.opencode/skill/okf` (not present). The workflow below follows the same investigate → spec → design-review → implement sequence and the same root-level artifact naming (`INVESTIGATION-*.md`, `SPEC-*.md`, `DESIGN-*.md`) used by the earlier passes (`INVESTIGATION-family-ids.md`, `AUDIT-add-driver-gate.md`).

---

## 1. Which component owns this markup

**`BulkReleaseButtons`** — a module-private (non-exported) function component at the bottom of
`src/pages/admin/gate/GateScreen.tsx:555`, rendered from `GateScreen` at `:392`.

It is *not* a separate file. The gate folder holds only two files:

```
src/pages/admin/gate/GateScreen.tsx      628 lines
src/pages/admin/gate/AssignDriverPanel.tsx 141 lines
```

The component's JSDoc: `/** Bulk "Release all for X" buttons — only for drivers shared by ≥2 eligible students. */`. Despite the name, it is the whole driver-group card, and it renders **before** the per-student rows inside the `status === 'found'` result card. So the "driver group header wrapper above each driver's list of assigned students" in the prompt *is* this component — there is no other candidate.

Its grouping logic (`:566-588`) collects driver ids from `assignmentByStudent`, runs `buildBulkReleasePlan` per driver, drops already-released students, and keeps only groups of `ids.length >= 2`. That logic is correct and out of scope.

### The current header markup (`GateScreen.tsx:601-616`, verbatim)

```jsx
<div className="rounded-xl border border-emerald-300 bg-white p-3">
  <div className="flex items-center justify-between gap-3">
    <div className="min-w-0">
      <div className="text-sm font-bold text-slate-800">
        {driver ? `${driver.name} · ${driver.phoneNumber}` : driverId}
      </div>
      <div className="text-xs text-slate-500">{ids.length} {t.studentsAssigned}</div>
    </div>
    <button
      onClick={() => onBulk(driverId, ids)}
      disabled={busy}
      className="min-h-[44px] shrink-0 rounded-xl bg-emerald-800 px-4 text-sm font-black text-white shadow-sm transition active:scale-95 disabled:opacity-50"
    >
      {busy ? t.releasing : `${t.releaseAllFor} ${driver?.name ?? ''}`}
    </button>
  </div>
```

**Root cause of the reported squeeze, confirmed:** the identity text and the `Release all for <name>`
button are **siblings in the same flex row** (`flex items-center justify-between gap-3`). The button
label is `Release all for maxmed ziyaad` — long — and the container is `max-w-md` (`GateScreen.tsx:243`).
The button is `shrink-0`, so it takes its full intrinsic width and the `min-w-0` text column is
compressed into whatever is left; the label then wraps and the three lines collapse into the run-together
block the report describes. There is no photo anywhere in this component.

## 2. Was the driver photo already fetched at this level?

**Yes — already fetched, and currently thrown away. No new fetch path is needed.** This is the key finding.

| Evidence | Location |
|---|---|
| `const [photoUrls, setPhotoUrls] = useState<Map<string, string>>(new Map());` | `GateScreen.tsx:60` |
| `resolvePickupPhotoUrls(list).then(setPhotoUrls).catch(() => setPhotoUrls(new Map()))` inside `loadPickups` | `GateScreen.tsx:94-96` |
| Cleared on reset: `setPhotoUrls(new Map())` | `GateScreen.tsx:76` |
| Read in the render tree | **nowhere** |

`grep -n "photoUrls" src/pages/admin/gate/GateScreen.tsx` returns exactly three lines: 60 (declare), 76 (reset), 94 (set). **Zero reads.** `resolvePickupPhotoUrls` is called with the *whole* `getFamilyPickups(familyId)` list, so the map already contains a signed URL for every pickup person in the family — including the driver shown in the group header. The gate screen signs the photos on every lookup and never displays a single one.

So the fix is purely "pass the existing map down one prop and render it" — no resolver change, no new RPC, no new storage call.

Resolver contract (`src/lib/db/authorizedPickups.ts:182-205`):
- `getPickupPhotoSignedUrl(photoPath)` → `string | null`, TTL 3600s, private bucket `authorized-pickups`.
- `resolvePickupPhotoUrls<T extends {id, photoPath}>(pickups)` → `Map<string,string>`, parallel, **omits** entries whose signing failed. So `photoUrls.get(id)` being `undefined` is the normal "no photo" signal — the initials fallback is not an error path.

## 3. Existing avatar pattern to reuse

The prompt refers to "the initials-avatar fallback already built for `AddDriverPanel`". **Correction:** there is no `AddDriverPanel` in the repo — `find src -iname "*AddDriver*"` returns nothing. The gate's driver dialog is `AssignDriverPanel.tsx` (`AUDIT-add-driver-gate.md` describes an earlier `AddDriverPanel` with photo capture; the landed code is the search-and-pick `AssignDriverPanel`, which has no photo UI at all).

Two real, existing patterns:

| Where | Markup | Size |
|---|---|---|
| `AssignDriverPanel.tsx:118-120` (initials only, no photo) | `<span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-emerald-100 text-sm font-black text-emerald-800">{d.name.trim()[0]?.toUpperCase() ?? '?'}</span>` | 36px |
| `ManageDrivers.tsx:125-134` (photo + initials fallback) | `<img src={photoUrls.get(id)} alt={name} className="h-16 w-16 shrink-0 rounded-full border border-slate-200 object-cover" />` else `<span className="flex h-16 w-16 shrink-0 items-center justify-center rounded-full bg-emerald-100 text-2xl font-black text-emerald-800">…</span>` | 64px |
| `ManageDrivers.tsx:240-249` (photo + fallback, **list row**) | same shape at `h-12 w-12` / `text-lg` | 48px |

The reusable shape is identical in all three: `rounded-full` + `bg-emerald-100` + `font-black text-emerald-800` for the fallback; `rounded-full border border-slate-200 object-cover` + `alt={name}` for the photo. `ManageDrivers.tsx` is the only place that consumes `photoUrls` from a `resolvePickupPhotoUrls` map, and it is the direct precedent for this change.

## 4. Visual language + button conventions

From `GateScreen.tsx` (all verified by grep, no invented tokens):

- **Primary action button:** `min-h-[44px] rounded-xl bg-emerald-800 text-sm font-black text-white shadow-sm transition active:scale-95 disabled:opacity-50` — used by per-student Release (`:341`) and Release-all (`:609`).
- **Secondary/outline buttons:** `min-h-[36px] rounded-lg border border-slate-300 bg-white px-3 text-xs font-bold text-slate-600` (Change driver, `:351`), rose variant for Remove driver (`:361`).
- **Layout width:** `<main className="mx-auto flex w-full max-w-md flex-1 flex-col px-4 pb-6">` (`:243`) — a single narrow column, ~448px max, ~350px of usable content width after padding. This is why a full-width action row reads better than a right-aligned one.
- **Badge style:** the `🚗 Driver pickup` "badge" is *not* a pill — it is inline emoji-prefixed text inside a `text-sm text-slate-500` line (`:334`, built at `:330-332`). The only true pill on the screen is the released marker `rounded-full bg-emerald-700 px-3 py-1 text-xs font-black text-white` (`:337`). So the assigned-count should stay plain small text, not become a new pill.
- **Card:** `rounded-xl border border-emerald-300 bg-white p-3` for driver group; `rounded-xl border border-emerald-200 bg-white p-3` for an eligible student.

## 5. Responsive / breakpoint pattern

**There is none, and none should be added.** Verified:

```
grep -no "\b(sm|md|lg|xl):[a-z0-9\[\]-]*" src/pages/admin/gate/GateScreen.tsx   → no matches
grep -c "sm:\|md:" src/pages/admin/gate/AssignDriverPanel.tsx                   → 0
```

The gate screen is mobile-first with **zero** Tailwind breakpoints; it adapts with fluid flex plus
`min-w-0` / `shrink-0` / `truncate`, inside the fixed `max-w-md` column. `AssignDriverPanel` uses
`truncate` on its name/phone lines for exactly this reason. The group-header fix must therefore be a
fluid two-row layout that holds at 320px, following the same `min-w-0` + `truncate` convention — not a
new `md:` variant.

## 6. Test coverage of this section

**None exists — nothing to update, nothing to delete.** Verified by grep: the files matching
`GateScreen|BulkRelease|releaseAllFor|studentsAssigned` are `App.tsx` (routing), `gate-utils.ts`,
`gateStrings.ts`, `FamilyIds.tsx`, `FamilyIdCard.tsx`, `db/familyIds.ts` and the two `__tests__` files
`gate-utils.test.ts` / `family-ids.test.ts`. Neither test file renders `GateScreen`.

- `gate-utils.test.ts:67-86` covers `buildBulkReleasePlan` (the grouping logic) — **pure functions only, untouched by a markup change**.
- The repo's component-test convention is `renderToStaticMarkup` from `react-dom/server` (`familyIdCard.test.tsx:2-6` states this explicitly: "no jsdom or testing-library needed"). `@testing-library/react` is **not** a dependency.
- Obstacle: `BulkReleaseButtons` is not exported, so it cannot be rendered from a test as-is. Exporting it is a one-word additive change (consistent with `AGENTS.MD` rule 3, "extend, don't rewrite") and is what makes this section testable at all.

## 7. Answers to the prompt's two verification questions

1. **Which file/component owns this markup?** `BulkReleaseButtons` in `src/pages/admin/gate/GateScreen.tsx:555-628`, rendered at `:392`. Not a separate file, not exported today.
2. **Was the driver photo already fetched at this level?** **Yes.** `resolvePickupPhotoUrls` already signs every family pickup's photo at `GateScreen.tsx:94` into `photoUrls` (`:60`), which is never read in render. The group-header photo is a one-prop pass-through of existing data — no new fetch, no resolver change.
