# Report — Driver group header layout on the dismissal gate

2026-09-05 · Branch `arena/01a071d8-schoolnnnnass` · Base `23ba781` (main)
Artifacts: `INVESTIGATION-driver-group-header.md` → `SPEC-driver-group-header.md` → `DESIGN-driver-group-header.md` → this report.

---

## The two answers the brief asked for

### 1. Which file/component actually owns this markup?

**`BulkReleaseButtons` — a module-private function component at the bottom of
`src/pages/admin/gate/GateScreen.tsx` (was `:555`, now `:568`), rendered from `GateScreen` at `:392`.**

It is *not* a separate file. The gate folder contains only `GateScreen.tsx` and
`AssignDriverPanel.tsx`. The component's name says "bulk release buttons" but it renders the whole
driver-group card — the header above a driver's assigned students — and it is rendered **before** the
per-student rows inside the `status === 'found'` panel. It was the only candidate; there is no other
"driver group wrapper" in the repo.

Root cause, confirmed in the pre-change markup: the identity text and the `Release all for <name>`
button were **siblings in one flex row** — `flex items-center justify-between gap-3`. The button is
`shrink-0` and its label is long (`Release all for maxmed ziyaad`), so inside the screen's `max-w-md`
column (`GateScreen.tsx:243`) it took its full intrinsic width and compressed the `min-w-0` text column
until everything wrapped into the run-together block in the report.

### 2. Was the driver photo already fetched at this level?

**Yes — already fetched, and previously thrown away. No new fetch was needed.**

`grep -n "photoUrls" src/pages/admin/gate/GateScreen.tsx` on the pre-change file returned exactly three
lines: `:60` (declare state), `:76` (reset), `:94` (set). **Zero reads in the render tree.** `loadPickups`
already calls `resolvePickupPhotoUrls(list)` on the *whole* `getFamilyPickups(familyId)` result, so the
map already held a signed URL for every pickup person in the family — including the driver in the group
header. The gate screen was signing photos on every lookup and displaying none of them.

So this was a **one-prop pass-through of existing data**, not a new fetch path:
`GateScreen` now passes `photoUrls={photoUrls}` at `:396`, and the card reads
`photoUrls.get(driverId)` at `:622`/`:624`. `resolvePickupPhotoUrls`, `getPickupPhotoSignedUrl`, the
3600s TTL and `loadPickups` are all untouched.

`resolvePickupPhotoUrls` **omits** entries whose signing failed (`authorizedPickups.ts:203`), so a
missing map entry is the normal "no photo" signal — which is why the initials avatar is a plain
`else` branch, not an error state.

### Naming correction to the brief

The brief refers to "the initials-avatar fallback already built for `AddDriverPanel`". **There is no
`AddDriverPanel` in the repo** — `find src -iname "*AddDriver*"` returns nothing. The gate's driver
dialog is `AssignDriverPanel.tsx`, whose avatar is initials-only at `h-9 w-9` (`:118-120`). The pattern
I actually reused is the photo-or-initials two-branch shape from `ManageDrivers.tsx` — the only other
place in the repo that consumes a `resolvePickupPhotoUrls` map — at its **list-row** size
(`:240-249`), which fits a compact card header — at **60px** rather than that row's 48px (see below).
`AUDIT-add-driver-gate.md` describes an
earlier `AddDriverPanel` with photo capture; the landed code is the search-and-pick `AssignDriverPanel`.

---

## What changed

`src/pages/admin/gate/GateScreen.tsx` only — **+45 / −13 lines**, all inside `BulkReleaseButtons`
plus the one prop at the call site.

**Row 1 — identity** (`:618-639`): `flex items-center gap-3` holding the avatar then the text.
- Avatar **60px** (`h-15 w-15`), `rounded-full`; photo branch `border border-slate-200 object-cover` with
  `alt={driver?.name ?? driverId}`; fallback branch `bg-emerald-100 text-xl font-black text-emerald-800`
  showing `driver?.name.trim()[0]?.toUpperCase() ?? '?'`.
- Text column `min-w-0 flex-1` with `truncate` on both lines (the `AssignDriverPanel` convention), so a
  long name ellipsises instead of wrapping into a third line.
- Name · phone and count keep their exact original classes (`text-sm font-bold text-slate-800`,
  `text-xs text-slate-500`) — no new tokens.

**Avatar size (+25%, revised after review).** The slot first landed at `h-12`/48px and was then bumped to
`h-15`/60px on request. `h-15` is not in a static Tailwind scale, so it was verified against the real
build rather than assumed: the emitted CSS is `.h-15{height:calc(var(--spacing)*15)}` with
`--spacing:.25rem` → 3.75rem = **60px**, against `.h-12{height:calc(var(--spacing)*12)}` = 48px. Both
branches share the one slot so the row height is identical with and without a photo, and the initials
glyph went `text-lg` → `text-xl` to hold its proportion in the larger circle. The two size assertions in
the test were confirmed to **fail** against the pre-bump code (2 failed / 6 passed).

**Row 2 — action** (`:640-648`): the button moved out of the flex row to its own line, `mt-3 w-full`,
keeping its original primary-action classes verbatim
(`min-h-[44px] rounded-xl bg-emerald-800 px-4 text-sm font-black text-white shadow-sm transition
active:scale-95 disabled:opacity-50`). Full width rather than right-aligned because the screen's other
primary actions (Scan / Check, `:298-320`) are full width in the same narrow column, and a right-aligned
long label at `max-w-md` would reproduce the original squeeze. 44px preserves the screen's stated
≥44px touch-target rule.

**Data flow: unchanged, as constrained.** No edit to `recordRelease`, `handleBulkRelease`,
`handleRelease`, `buildBulkReleasePlan`, `summarizeBulk`, `getFamilyPickups`, `resolvePickupPhotoUrls`
or `getPickupPhotoSignedUrl`. No state, effect, RPC, schema or migration change. No new i18n key
(`releaseAllFor` / `studentsAssigned` already exist in both EN and Soomaali).

**Per-student rows: untouched.** Verified — the three remaining `justify-between` uses in the file are at
`:271` (header), `:414` and `:441` (the excluded and eligible student cards), all *before*
`BulkReleaseButtons` at `:568`. The `RAYAAN AXMAD NUUR` / `SULAYMAN AXMAD NUUR` blocks and their
Release / Change driver / Remove driver controls are byte-identical.

**Responsive: no breakpoint added, deliberately.** The screen has **zero** `sm:`/`md:`/`lg:` utilities
(`grep -no "\b(sm|md|lg|xl):" GateScreen.tsx` → no matches); it is a fixed `max-w-md` fluid column that
adapts with `min-w-0` / `shrink-0` / `truncate`. The new layout is fluid at every width and holds at
320px; adding a `md:` variant would have been the only breakpoint on the screen.

**Style: no new pattern.** Avatar tokens copied from `ManageDrivers`; button classes unchanged; the
assigned count stayed plain `text-xs text-slate-500` rather than becoming a pill, because the
`🚗 Driver pickup` "badge" is itself just inline text in a `text-sm text-slate-500` line (`:330-334`) —
the screen's only pill is the released marker (`:337`).

---

## Tests

**No existing component or snapshot test covered this section** — nothing to update, nothing deleted.
Confirmed by grep: the only gate tests are `gate-utils.test.ts` (pure `buildBulkReleasePlan` /
eligibility functions, unaffected by markup) and `family-ids.test.ts`; neither renders `GateScreen`.

**Added `src/lib/__tests__/gateGroupHeader.test.tsx` — 8 tests**, using the repo's stated component-test
convention `renderToStaticMarkup` (`familyIdCard.test.tsx:2-6`: "no jsdom or testing-library needed";
`@testing-library/react` is not a dependency). `BulkReleaseButtons` was made `export` for this — a
one-word additive change, per `AGENTS.MD` rule 3 ("extend, don't rewrite").

Coverage: photo immediately left of name · phone; assigned count on the identity row; initials fallback
when no URL resolved; avatar still renders when the driver record is missing (the raw-`driverId`
degenerate case); photo → identity → button DOM order; `w-full` + `min-h-[44px]` on the action row;
**a `justify-between` regression guard against the old squeezed layout**; label unchanged; empty render
when no driver is shared by ≥2 eligible students; bulk summary still renders after the action row.

**The tests were proven to fail against the old markup.** I temporarily restored the pre-fix card body
(keeping the export and the new prop) and re-ran: **4 failed / 4 passed** — `expected … to contain
'<img'`, `'rounded-full bg-emerald-100'`, `'>?</span>'`, `'w-full'`. The fix was then restored from a
copy and re-verified. So the suite exercises the changed path rather than restating it.

---

## Verification

`node_modules` was absent and `npm ci` initially failed — **not** a registry problem. Every tarball was
a cache hit; the only failure was the `supabase` CLI devDependency's postinstall downloading its binary
from `release-assets.githubusercontent.com`, a host this sandbox cannot reach. That package is used for
migrations, not for this change, so I installed with `--ignore-scripts` and then ran esbuild's own
`install.js` (vite needs its binary): 345 packages, `esbuild --version` → `0.25.12`.

| Check | Baseline (pre-change) | After |
|---|---|---|
| `npx tsc --noEmit` | exit 0 | **exit 0** |
| `npx vitest --run` | 507 passed / 54 files | **515 passed / 55 files** (+8 tests, +1 file, 0 failures) |
| `npx vite build` | ✓ built, exit 0 | **✓ built, exit 0** (2523 modules, `dist/index.html` 5,700.05 kB) |

Visual check: I rendered the real `BulkReleaseButtons` with `renderToStaticMarkup` into a static page
styled by **this branch's own compiled Tailwind CSS** (extracted from `dist/index.html`), covering
with-photo, initials-fallback, long-name truncation, and post-release states at both 448px and 320px.
It is being served as a live preview on port 4173. The rendered markup confirms the intended structure,
e.g. `<span class="flex h-15 w-15 shrink-0 items-center justify-center rounded-full bg-emerald-100
text-xl font-black text-emerald-800">M</span><div class="min-w-0 flex-1"><div class="truncate text-sm
font-bold text-slate-800">maxmed ziyaad · 06…`.

**What I could not check:** the signed URL path end-to-end against live Supabase storage is not
reachable from this sandbox, so the photo branch is verified with an injected URL rather than a real
signed one. The resolver itself is already covered by `authorizedPickups.test.ts:256-295`.

---

## Left open deliberately

`bulkSummary` is a single component-level value, so when two or more drivers qualify for bulk release
the same "X / Y released" line renders inside **every** group card. That predates this change, is a
data-shape question (per-driver summaries) rather than layout, and is out of scope here — recorded so it
is not mistaken for a regression from the restructure.
