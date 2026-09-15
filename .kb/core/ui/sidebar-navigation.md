---
title: "Sidebar Navigation"
type: UI Component
tags: [core, ui, navigation, sidebar, layout]
timestamp: 2026-09-15T00:00:00Z
description: "Role-based sidebar: collapsible menu groups, remembered expand state, mobile drawer, and the menu filter."
linked_concepts:
  - "core:ui/manage-users"
  - "lesson-plans:ui/sidebar-routing"
---

# Sidebar Navigation

- **Component:** `src/components/layout/Sidebar.tsx`
- **Menu config:** `src/lib/navigation.ts` (`NAV`, one entry per role)
- **Mounted by:** `src/components/layout/DashboardLayout.tsx`
- **Route guard:** `src/lib/routing.ts` (`ROUTE_ACCESS`, `canAccessRoute`)
- **Tests:** `src/lib/__tests__/navigation.test.ts`, `src/lib/__tests__/sidebar-navigation.test.tsx`

## Why it is grouped

The sidebar used to render one row per page from a flat `navItems` list — 27 rows
for an admin, so the menu needed a full screen of scrolling and every page
competed for attention. The 2026-09-15 redesign keeps **the same links and the
same per-role visibility** but organises them:

* **Pinned rows** — the 2–3 pages a role uses constantly (always `Dashboard`
  first) render above the groups and never collapse.
* **Collapsible groups** — everything else lives in a named section with one
  icon. Admin goes from 27 rows to 11 (3 pinned + 8 group headers); teacher 14 →
  6; parent 9 → 5; supervisor 16 → 8; office 7 → 4.

No route changed, so `App.tsx`, `ROUTE_ACCESS` and every in-page `navigate()`
call behave exactly as before.

## Section ids

Ids are shared across roles so the same word means the same thing everywhere
(and so remembered state is portable):

| id | label | typical contents |
|----|-------|------------------|
| `students` | Students | class import, promotion |
| `academic` | Academic | lesson plans, submission tracking, unit plans, class progress |
| `grades` | Grades & Exams | bulk grades, exam verification, grade corrections, exam reports |
| `classroom` | Attendance & Classwork | attendance, homework, quiz creation + grading |
| `users` | Users & Staff | manage users, monitor teacher |
| `transport` | Transport & Gate | family IDs, drivers, student directory |
| `communications` | Communications | announcements, messages, streams |
| `administration` | Administration | bulk import, AI review logs |
| `reports` | Reports & Results | parent monthly / midterm / final / exam results |
| `quizzes` | Quizzes | parent take-quiz |

A path appears **once** per role: either pinned or inside one group, never both.

## Remembered expand/collapse state

`localStorage["school-nav-sections"]` holds `{ [role]: string[] }` — the open
section ids per role, so an admin's choices never leak into a teacher's menu on
a shared device. Helpers live in `lib/navigation.ts`:

* `loadOpenSections(role)` → stored ids, or `null` when nothing is stored yet.
  `null` and `[]` are different: `[]` means "I collapsed everything", and must
  survive a reload. Unknown ids (a renamed section) are dropped on read.
* `saveOpenSections(role, ids)` → persists, filtered to ids that still exist.
* `openSectionsForPath(role, path)` → first-visit default: only the group that
  owns the current page is open.

Navigating into a closed group opens it, so the page you land on is never
hidden. The very first render is deliberately exempt — a remembered collapse
wins over the auto-open, and the group header still shows a dot so you can see
where you are.

## Current-page highlight

The active row gets `aria-current="page"` plus the filled-pill treatment; the
group that contains it gets a white dot and a slightly brighter header. The row
is scrolled into view (`block: 'nearest'`) inside the nav's own scroll area.

## Menu filter

Roles with 10+ menu rows (`FILTER_MIN_ITEMS` in `Sidebar.tsx` — admin, teacher,
supervisor) get a search box above the nav. It matches the English label and the
translated one, flattens the results under their group headers, and clears
itself after a navigation. Parent and office menus are short enough to skip it.

## Responsive behaviour

* **≥ `lg` (1024px):** static `w-64` column, `sticky top-0`, `h-screen`, with
  the nav scrolling independently of the page.
* **< `lg` (phones and portrait tablets):** the column is replaced by a
  hamburger (`aria-label="Open menu"`) that opens a modal drawer —
  `role="dialog" aria-modal="true"`, backdrop click or `Escape` closes it, and
  `document.body.style.overflow` is locked while it is open. Choosing a page
  closes the drawer.
* **RTL:** the drawer anchors to the inline start (`start-0`, `slideLeft`
  keyframes in Arabic), group indentation uses logical properties
  (`ms-`/`ps-`/`border-s`), and the chevron rotates the other way.

## Theming

The markup lives inside `.theme-sidebar`, whose light-mode overrides in
`src/index.css` key off `text-white/NN` and `[class*="bg-white/"]` class names.
New sidebar UI must reuse those tokens or the `theme-nav-dot` /
`theme-nav-filter` helpers, otherwise it becomes invisible in light mode.

## Adding a page to the menu

1. Add the route to the role's `switch` in `src/App.tsx`.
2. Guard it in `ROUTE_ACCESS` (`src/lib/routing.ts`) if it is not owned by that
   role's switch alone.
3. Add one `NavItem` to the right section in `NAV` (`src/lib/navigation.ts`) —
   or to `pinned` if it is a daily-driver. Do not add the same path twice.
4. Add `'nav.<Label>'` to **both** the `en` and `ar` dictionaries in
   `src/lib/i18n/AppLanguageContext.tsx`.
5. `npm run validate` — `navigation.test.ts` fails if the new path is not
   rendered by App.tsx, is denied by `ROUTE_ACCESS`, is duplicated, or is
   missing a translation.

# Citations

[1] [Source: Sidebar.tsx](https://github.com/org/repo/blob/main/src/components/layout/Sidebar.tsx)
[2] [Source: navigation.ts](https://github.com/org/repo/blob/main/src/lib/navigation.ts)
[3] [Source: routing.ts](https://github.com/org/repo/blob/main/src/lib/routing.ts)
