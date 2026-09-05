# Design review — Driver group header, dismissal gate

2026-09-05 · Branch `arena/01a071d8-schoolnnnnass` · Input: `SPEC-driver-group-header.md`
Purpose: settle the open design decisions *before* editing code, the way `DESIGN-transport-editing.md`
and `DESIGN-family-id-printing-FINAL.md` did for earlier passes.

Decisions below are all grounded in markup that already exists on the gate screen; nothing here
introduces a new visual token.

---

## D1. Row 2 alignment — full width vs right-aligned

| Option | Verdict |
|---|---|
| **(a) Full width `w-full`** | **CHOSEN.** The screen's other primary actions are full-width in the same column: Scan and Check (`GateScreen.tsx:298-320`) sit in `flex gap-3` as `flex-1` / `flex-[2]`. A thumb-sized 44px target also matches the gate's stated ≥44px rule. |
| (b) Right-aligned `ml-auto` | Rejected. The label is `Release all for maxmed ziyaad` — at `max-w-md` (`:243`) a right-aligned long label re-creates the exact squeeze being fixed, just on the other side. |
| (c) Keep the flex row, add `flex-wrap` | Rejected. Wrapping is what already produces the run-together block; it hides the problem instead of separating the rows. |

## D2. Avatar size

> **Revised after review (2026-09-05):** `h-12`/48px was implemented first, then bumped to
> **`h-15`/60px (+25%)** on request so the driver's photo reads clearly from the gate desk.
> 60px sits between the two `ManageDrivers` precedents below. Confirmed emitted by the build as
> `.h-15{height:calc(var(--spacing)*15)}` with `--spacing:.25rem` → 3.75rem = 60px. The initials
> glyph went `text-lg` → `text-xl` to keep the same visual proportion inside the larger circle.

| Option | Verdict |
|---|---|
| (a) `h-15 w-15` (60px) | **CHOSEN (revised).** 25% larger than the `h-12` list-row size; still smaller than the 64px page-header avatar, so it does not dominate the card. |
| (b) `h-12 w-12` (48px) | Original pick — verbatim `ManageDrivers.tsx:240-249`, the list-row shape and the only place that consumes a `resolvePickupPhotoUrls` map. Superseded by (a) for legibility at distance. |
| (c) `h-16 w-16` (64px) | Rejected — `ManageDrivers.tsx:125-134` uses that for a *page-level* header; here it would dominate a compact card and push the two text lines' optical centre down. |
| (d) `h-9 w-9` (36px) | Rejected — that is `AssignDriverPanel.tsx:118-120`, a dense search-result row. Too small to serve as the identity anchor for a whole group. |

## D3. Photo + fallback

Reuse the two-branch shape that already exists, driven by the map the screen already fills:

```jsx
{photoUrls.get(driverId) ? (
  <img src={photoUrls.get(driverId)} alt={driver?.name ?? driverId}
       className="h-15 w-15 shrink-0 rounded-full border border-slate-200 object-cover" />
) : (
  <span className="flex h-15 w-15 shrink-0 items-center justify-center rounded-full
                   bg-emerald-100 text-xl font-black text-emerald-800">
    {driver?.name.trim()[0]?.toUpperCase() ?? '?'}
  </span>
)}
```

Rationale: `resolvePickupPhotoUrls` **omits** entries whose signing failed
(`authorizedPickups.ts:199-204` — `if (url) map.set(id, url)`), so `undefined` is the normal "no photo"
signal and the initials branch is not an error path. Optional-chaining on `driver` preserves the
existing degenerate case where a driver id has no record in `driverById` (today that falls back to
rendering the raw `driverId`), so the avatar shows `?` instead of throwing on `.name`.

## D4. Text overflow

`min-w-0` on the text column and `truncate` on both lines — the `AssignDriverPanel.tsx:122-123`
convention. Without it a long driver name (`maxmed ziyaad` is short, but Somali names run long) would
wrap and re-introduce a third line inside row 1.

## D5. Responsive

No breakpoint added. Verified the screen has **zero** `sm:`/`md:`/`lg:` utilities
(`grep -no "\b(sm|md|lg|xl):" GateScreen.tsx` → no matches), and it is a fixed `max-w-md` fluid column.
The layout is therefore fluid-flex at every width: `60px avatar + gap + flexible text` degrades
gracefully to 320px, and row 2 is full width so it never competes for horizontal space. Adding a `md:`
variant here would be the only breakpoint on the screen and would fight its mobile-first design.

## D6. Badge treatment for the assigned count

Keep `{ids.length} {t.studentsAssigned}` at `text-xs text-slate-500` — unchanged. The `🚗 Driver pickup`
"badge" the brief points at is not a pill; it is inline emoji-prefixed text in a `text-sm text-slate-500`
line (`GateScreen.tsx:330-334`). The screen's only pill is the released marker (`:337`). Turning the
count into a new pill would introduce the one new style pattern the constraints rule out.

## D7. Testability

`BulkReleaseButtons` is module-private, so it cannot be rendered from a test. Export it (additive, one
word; `AGENTS.MD` rule 3 prefers extending over refactoring) and add
`src/lib/__tests__/gateGroupHeader.test.tsx` using `renderToStaticMarkup` — the repo's stated component
test convention (`familyIdCard.test.tsx:2-6`: "no jsdom or testing-library needed"; `@testing-library/react`
is not a dependency).

**Import risk checked before committing to this:** importing `GateScreen.tsx` from a test pulls in
`html5-qrcode`, `lib/supabase`, and `ToastContext`. Mitigation: `vi.mock` those three in the test file,
the same way `transportEditing.test.tsx:19` mocks `../supabase`. If the import still fails in the node
environment, fall back to asserting on the built markup through the existing `gate-utils` pure-function
tests and report the gap rather than shipping a fake test.

## D8. Out of scope (recorded so it is not mistaken for a regression)

- `bulkSummary` is one component-level value, so with ≥2 qualifying drivers the same "X / Y released"
  line renders in every group card. Pre-existing, data-shape not layout — untouched.
- The per-student rows below (`:334-370`) and their Release / Change driver / Remove driver controls —
  unchanged, per the brief.

---

## Implementation plan

1. `GateScreen.tsx`: add `photoUrls: Map<string,string>` to `BulkReleaseButtons`' props; pass it at the
   call site (`:392`); restructure the card body into row 1 (avatar + text) and row 2 (full-width
   button); export the component.
2. Add `src/lib/__tests__/gateGroupHeader.test.tsx` — identity row, action row, initials fallback,
   missing-driver-record fallback.
3. Verify: `npx tsc --noEmit`, `npx vitest --run`, `npx vite build`. Baseline to beat: tsc clean,
   507/507 in 54 files, build OK.
4. Write `REPORT-driver-group-header.md` with the two answers the brief asks for.
