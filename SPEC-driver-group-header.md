---
type: Spec
title: Driver group header layout — dismissal gate
description: Implementation-ready spec for restructuring the driver-group header on /gate into an identity row (photo + name · phone + assigned count) and a separate full-width action row
resource: schoolnnnnass/SPEC-driver-group-header.md
tags: [spec, dismissal-gate, layout, bulk-release, driver-group]
timestamp: 2026-09-05T00:00:00Z
---

# Spec — Driver group header on the dismissal gate

Generated 2026-09-05 · Branch: `arena/01a071d8-schoolnnnnass` · Repo: `viniliaice/schoolnnnnass`
Authoritative input: `INVESTIGATION-driver-group-header.md`
Status: **IMPLEMENTATION-READY — layout/markup only**

## 1. Problem

On `/gate`, for a family with ≥2 students sharing a driver, `BulkReleaseButtons`
(`src/pages/admin/gate/GateScreen.tsx:555`) renders the driver's identity text and the
`Release all for <name>` button as **siblings in one flex row**
(`flex items-center justify-between gap-3`, `:602`). Inside the `max-w-md` column (`:243`) the
`shrink-0` button's long label compresses the text column, so name · phone, the assigned count and the
button wrap into one run-together block. The driver's photo is never rendered, even though its signed
URL is already resolved and held in `photoUrls` (`:60`, set at `:94`, read nowhere).

## 2. Goals / non-goals

**Goals**
- G1 — Two visually distinct rows: row 1 = identity (photo + name · phone + count), row 2 = the Release-all action on its own line.
- G2 — Render the driver photo to the immediate left of the text, using the already-resolved signed URL, with the repo's initials-avatar fallback.
- G3 — Hold at the narrowest gate-device width (320px) without a new breakpoint.
- G4 — Cover this section with a render test (none exists today).

**Non-goals (explicit)**
- No change to `recordRelease`, `handleBulkRelease`, `buildBulkReleasePlan`, `summarizeBulk`, `getFamilyPickups`, `resolvePickupPhotoUrls`, or `getPickupPhotoSignedUrl`. No RPC, schema, or migration change.
- No change to the per-student rows (`:334-370`) or their Release / Change driver / Remove driver controls.
- No new i18n keys (EN/Soomaali strings `releaseAllFor`, `studentsAssigned` already exist in both locales, `gateStrings.ts:153-154` / `225-226`).
- No new Tailwind breakpoint on this screen.
- Not fixing the pre-existing quirk that one `bulkSummary` is rendered inside every group card when several drivers qualify (see §7).

## 3. Required structure

```
<div card  rounded-xl border-emerald-300 bg-white p-3>            ← unchanged
  <div ROW 1  flex items-center gap-3>
     photo | initials avatar   60px, rounded-full, left          ← NEW (existing pattern)
     <div min-w-0>
        name · phone          truncate, font-bold text-slate-800 ← unchanged tokens
        N students assigned   text-xs text-slate-500             ← unchanged tokens
     </div>
  </div>
  <button ROW 2  mt-3 w-full min-h-[44px] bg-emerald-800 …>      ← moved to its own row, full width
     Release all for <name>
  </button>
  <p bulk summary mt-2>                                          ← unchanged
</div>
```

### Row 1 — identity
- Avatar: `h-15 w-15 shrink-0 rounded-full` — photo branch `border border-slate-200 object-cover` with `alt={driver?.name ?? driverId}`; fallback branch `flex items-center justify-center bg-emerald-100 text-xl font-black text-emerald-800` showing `driver?.name.trim()[0]?.toUpperCase() ?? '?'`. The shape is `ManageDrivers.tsx:240-249` verbatim; the size is **60px** (`h-15` = 15 × `--spacing`/`.25rem` in Tailwind v4), 25% up from the 48px `h-12` first landed, so the driver's face reads clearly from behind the gate desk. Both branches share the one slot, so the row height never shifts between a driver with a photo and one without.
- Photo lookup: `photoUrls.get(driverId)`. `undefined` (no photo, or signing failed — the resolver omits failures) → initials fallback. Not an error state.
- Name line stays `{driver ? `${driver.name} · ${driver.phoneNumber}` : driverId}` with `driverId` as the existing degenerate fallback.
- Count line stays `{ids.length} {t.studentsAssigned}`.
- Text column `min-w-0`; both lines `truncate` (the `AssignDriverPanel.tsx:122-123` convention) so a long name degrades to an ellipsis instead of wrapping into the row below.

### Row 2 — action
- Own block, `mt-3`, `w-full`, carrying the existing primary-button classes unchanged: `min-h-[44px] rounded-xl bg-emerald-800 px-4 text-sm font-black text-white shadow-sm transition active:scale-95 disabled:opacity-50`.
- Full width, not right-aligned: the screen's other primary actions (Scan / Check, `:298-320`) are full-width in the same narrow column, and at `max-w-md` a right-aligned long label would reproduce the squeeze. 44px keeps the ≥44px touch-target rule from the screen header comment.
- Label, `disabled={busy}`, and `onClick={() => onBulk(driverId, ids)}` unchanged.

## 4. Data flow (unchanged, by constraint)

One additive prop. `GateScreen` already owns `photoUrls`; it passes the map into
`BulkReleaseButtons`, which reads `photoUrls.get(driverId)`. No new state, effect, RPC, or storage call;
`loadPickups`, `resolvePickupPhotoUrls` and the signing TTL are untouched.

## 5. Files touched

| File | Change |
|---|---|
| `src/pages/admin/gate/GateScreen.tsx` | Restructure the group-card body in `BulkReleaseButtons`; add a `photoUrls` prop to its signature and pass it at the call site (`:392`); export the component so it is render-testable. |
| `src/lib/__tests__/gateGroupHeader.test.tsx` | **New.** `renderToStaticMarkup` render tests for the header (repo convention, no jsdom). |

No other file changes. No dependency added.

## 6. Acceptance criteria

1. Photo, name · phone, and count occupy row 1 with the photo immediately left of the text; the Release-all button is the only thing on row 2, full width.
2. With no signed URL for the driver, an initials avatar renders in the same 60px slot — no layout shift, no broken `<img>`.
3. A driver whose record is missing from `driverById` still renders (raw `driverId`), and still renders an avatar (`?` initial) rather than crashing.
4. `groups.length === 0` still renders nothing.
5. Per-student rows byte-identical in behaviour; `recordRelease` call sites untouched.
6. `npx tsc --noEmit`, `npx vitest --run`, `npx vite build` all clean; test count does not regress from the 507/507 baseline.

## 7. Known pre-existing issue, deliberately out of scope

`bulkSummary` is a single component-level value, so when two or more drivers qualify for bulk release
the same "X / Y released" line renders inside **every** group card. That predates this change and is a
data-shape question (per-driver summaries), not layout. Left alone here; noted so it is not mistaken for
a regression introduced by the restructure.
