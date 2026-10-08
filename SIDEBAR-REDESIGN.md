# Sidebar navigation redesign — final report

Branch: `arena/ec005910-schoolnnnnass` · commit `26056ab` · live preview: the dev server running on port 5173

---

## 1. The new navigation structure

One centralized configuration now drives every role: `src/components/layout/navigation.ts`
(`buildNavigation(role)` → `NavSection[]`, plus `findActiveItem`, `flattenNavigation`,
`searchNavigation`, `groupsForPath`, `filterNavigationByMatches`). Sections are the top
level; groups are the only nesting level (max 1 level deep, per the brief).

**admin — 33 destinations in 6 sections**

| Section | Entries |
|---|---|
| **Main** | Dashboard · Dismissal Gate |
| **People** | ▸ **Students** (All Students · Class Import · Duplicate Students · Promote Classes) · Academic Setup · Student Directory · ▸ **Family IDs** (Families & Cards · Generate & Setup) · Drivers · Staff Accounts |
| **Academics** | ▸ **Lesson Plans** (Review Plans · Submission Tracking · Create Plans) · Unit Plans · Attendance · Homework · ▸ **Quizzes** (Create Quiz · Grade Quizzes) · ▸ **Exams & Grades** (Verify Exams · Grade Corrections · Bulk Upload Grades · Exam Reports) |
| **Oversight** | Class Progress · Teacher Activity · Marks Entry Monitor · AI Review Logs |
| **Communication** | Messages · Streams · Announcements · Teacher Notifications |
| **System** | Bulk Import |

**teacher — 17 destinations**: Main (Dashboard) · **Teaching** (My Classes · Lesson Plans ·
Unit Plans · Attendance · Homework · ▸ Quizzes) · **Grades & Reports** (Upload Results ·
Bulk Upload Grades · My Submissions · Exam Reports) · **Communication** (Messages · Streams ·
Announcements · Notifications) · **System** (Install App)

**supervisor — 17 destinations**: Main (Dashboard · Dismissal Gate) · **Teaching** (My Classes ·
▸ Lesson Plans · Unit Plans · Attendance · Homework · ▸ Quizzes) · **Exams & Grades**
(Verify Exams · Marks Entry Monitor · Exam Reports) · **Records** (Student Directory ·
Family IDs) · **Communication** (Messages · Streams)

**office — 7 destinations**: Main (Dashboard · Dismissal Gate) · **Records** (Family IDs ·
Student Directory · Drivers) · **Communication** (Messages · Streams)

**parent — 12 destinations** (shell: `ParentAppShell`, sidebar from md/768px up, bottom nav
below): Main (Dashboard · My Children) · **Reports** (Exam Results · Monthly · Midterm ·
Final) · **Communication** (Messages · Streams) · **More** (Weekly Learning · Take Quiz ·
Pickup Card · More)

## 2. What was reorganized, and why

- **Sections instead of a flat 30-item list.** Admin went from one undifferentiated list to
  six named sections ordered by how often they are used (Main → People → Academics →
  Oversight → Communication → System). Section headings are `<h2>` inside
  `nav[aria-label]`, so screen-reader users get the same grouping.
- **Three expandable groups where pages belong together**: Students, Family IDs, Lesson
  Plans, Quizzes, Exams & Grades (admin); Lesson Plans + Quizzes (supervisor); Quizzes
  (teacher). Each group row is *also* a destination (its primary page, or the page you are
  already on), so nothing costs an extra click.
- **Orphan routes rescued.** `/teacher/results` (Upload Results) was reachable only from
  `AcademicReminderPanel.tsx:107`; it is now a first-class teacher entry. Parent's
  `/parent/more`, `/parent/quizzes`, `/parent/weekly-learning`, `/parent/pickup-card` were
  reachable only from the "More" page — they now form the parent **More** section.
- **The duplicate door is an alias, not a second entry.** `/admin/class-subjects` and
  `/admin/academic` are the same page; the config keeps the legacy path as an `alias`, so an
  old bookmark still opens the page *and* lights up the right sidebar row.
- **Icon collisions fixed** (one style, one size, 18px, stroke 2): Announcements `Megaphone`
  vs Teacher Notifications `BellRing`; Verify Exams `BadgeCheck` vs Grade Quizzes
  `ClipboardCheck`; `CreditCard` Family IDs / Pickup Card; `CarFront` drivers; `UserCog`
  staff; `NotepadText` lesson plans; `GraduationCap` students; `BookOpen` Academic Setup;
  `Layers` Unit Plans; `FileSpreadsheet` bulk grades; `DatabaseBackup` bulk import;
  `Activity` streams; `Mail` messages.
- **Role filtering stays centralized and verified**: `buildNavigation(role)` only emits
  destinations the role may open. A new test walks every rendered row for admin/teacher/
  parent against `ROUTE_ACCESS` and fails if a gated page is ever offered to a role that
  cannot open it.

## 3. Desktop behaviour

- Sticky 17rem (272px) column, `flex` sibling of `<main>` — the content area reflows when the
  sidebar collapses, so there is no layout jump and no overlay.
- Independent scroll area (`.app-nav-scroll`, `overscroll-behavior: contain`), so a long nav
  never drags the page.
- **Collapsed rail (4.5rem)**: icon-only rows, tooltips on hover *and* focus
  (`role="tooltip"`, fixed-position so it is never clipped by the scroll container), state
  persisted in `mbk-sidebar-collapsed`. A collapsed group is one icon that opens the group's
  page. Ctrl/Cmd+K leaves the rail automatically.
- **Active state** = background tint + accent icon + 3px accent bar + semibold text +
  `aria-current="page"` — four non-colour cues, so it never depends on colour alone. A parent
  group of the active page keeps accent context (`data-active-descendant`).
- **Account area at the bottom**, separated from the nav by a border: avatar + name + role
  badge, expanding into a panel (`#app-account-menu`) with theme switcher and EN/ع switcher;
  **Sign Out** sits below it, never inside the nav list.
- **Page search** (≥12 destinations): filters labels, paths, section/group names and
  keywords; force-opens the group holding a match; `ArrowDown` jumps into the results;
  `Escape` clears. Ctrl/Cmd+K anywhere focuses it.

## 4. Mobile behaviour

Below `lg` (1024px) the sidebar is not a shrunken desktop column — it is a full-height
slide-in drawer: `role="dialog"`, `aria-modal="true"`, `min(84vw, 20rem)` wide (268px at a
320px viewport), dimmed backdrop, RTL-aware slide animation, safe-area padding top and
bottom, 48px rows (`min-h-12`, ≥44px) and a 44px-wide disclosure button.

- Opens from the new top bar (`app-mobile-bar`: menu button · current page title · search).
- Closes on: item select, backdrop click, close button, `Escape`, and a resize into the
  desktop layout (so an invisible dialog can never keep the scroll lock).
- Body scroll lock while open; focus moves into the dialog and returns to the trigger on
  close; `Tab` is trapped inside; closed groups are `inert` (out of the tab order and the
  a11y tree).
- The parent shell keeps its own phone chrome (header + `parent-bottom-nav`); this component
  renders **only** the desktop column there (`mobileToggle={false}`), so its single-`<nav>`
  invariant holds.

## 5. Accessibility improvements

- Landmark + headings: `nav[aria-label]` → `<h2>` section headings (still read when the rail
  shows only a divider) → `ul`/`li`.
- Correct semantics: destinations are `<button>`s (the app navigates through state, a real
  `<a>` would reload and drop the session); disclosure buttons carry `aria-expanded` +
  `aria-controls` + a spoken label ("Toggle Lesson Plans").
- `aria-current="page"` on the active row; active state never colour-only.
- Visible focus (existing `focus-visible` ring), keyboard-reachable everything, Escape closes
  drawer/panel, focus trap and focus restoration in the drawer.
- Contrast measured across all 3 themes × light/dark from the actual CSS tokens: idle nav
  text **9.95–12.67:1**, hover **13.85–17.03:1**, active **12.18–16.29:1**, section headings
  **5.88–8.81:1**, role badge/avatar **4.97–7.01:1** (the badge text colour is mixed toward
  the theme's own text colour specifically to clear 4.5:1 for 10px uppercase text — it was
  3.68:1 before).
- i18n: 55 new keys in both English and Arabic, including every section heading and all new
  labels; the sidebar is fully RTL (logical properties throughout, RTL drawer animation).

## 6. Responsive breakpoints

Verified by code contract + automated behaviour tests (no headless browser is available in
this sandbox, so the matrix below is asserted through the mechanism rather than pixels —
see §7):

| Width | Result |
|---|---|
| 320 / 360 / 375 / 390 / 414 | top bar + drawer (268–348px), no horizontal scroll, labels truncate rather than clip, ≥44px targets |
| 768 | parent shell gets the column; staff shell keeps the top bar + drawer |
| 1024 | staff column appears, drawer unmounts, floating language pill appears |
| 1280 / 1440 / large | column + `max-w-7xl` content, comfortable measure |

The width rules are `min(84vw, 20rem)` for the drawer, `17rem`/`4.5rem` for the column, and
`flex-1 min-w-0` + `max-w-7xl mx-auto` for the content — nothing is wider than the viewport
at 320px, and no label is clipped (they truncate with ellipsis).

## 7. Tests and checks run

| Check | Result |
|---|---|
| `npm run typecheck` | **0 errors** |
| `npm run typecheck:api` | **0 errors** |
| `npm run test:ci` | **146 files / 1577 tests passed** (baseline was 145 / 1539; +38 new, 0 regressions) |
| `npm run build` | **OK** — `dist/index.html` 6,197.37 kB (gzip 2,608.49 kB), baseline 6,162.73 kB |
| New suite `src/components/layout/__tests__/sidebar.test.tsx` | **38 tests** covering: section headings, duplicate-free destination lists per role, group destination + disclosure + `inert`, active-route detection incl. legacy aliases, auto-open of the group containing the route, group state surviving navigation, no double navigation, rail collapse/persist/tooltip, drawer modal + scroll lock + Escape + backdrop + close-on-select + focus move/restore + Tab trap + ≥44px sizing, page search (filter / force-open / empty state / focus), account panel + sign-out, role filtering vs `ROUTE_ACCESS`, per-role preference isolation, blocked-storage fallbacks, responsive breakpoint contract, and the full shell flow (burger → navigate → title, Ctrl/Cmd+K, resize closes drawer) |
| `npm run dev` | running on 0.0.0.0:5173, served CSS contains every `app-*` class; no React warnings in the jsdom suites that mount the real `<App/>` |

`src/lib/__tests__/fixedPositionChrome.test.ts`, `parentBottomNav.test.ts` and `routing.test.ts`
(the pinned `ROUTE_ACCESS` key list) all still pass unchanged.

## 8. Remaining issues / known limitations

1. **No real-browser pass.** This sandbox has no Chromium/Firefox and no network access to
   install one, so the responsive matrix and the visual/animation checks in §6 are asserted
   through CSS/DOM contracts and jsdom behaviour tests, not through measured pixels. The live
   preview on port 5173 is the fastest way to confirm the look at 320–1440px.
2. **Collapsed rail hides group children** (by design): a collapsed group is one icon that
   opens the group's page, so e.g. "Grade Corrections" needs the sidebar expanded or the
   Exams & Grades landing page first. A hover flyout submenu would remove that step; it was
   left out to avoid shipping an unverifiable hover-intent interaction.
3. **Drawer does not `inert` the page behind it.** Keyboard users are protected by the focus
   trap and Escape; pointer users by the backdrop. Marking the rest of the app `inert` would
   need the drawer to own a portal root.
4. **Longest labels** ("Bulk Upload Grades", "Teacher Notifications") truncate with an
   ellipsis below ~200px of row width (i.e. only inside the collapsed→expanded transition or
   an unusually narrow column); the tooltip/title-free label is still fully readable at every
   supported width.
5. Bundle grew ~35 kB (0.6%) from the nav config + tests-free components; the single-file
   build is still ~2.6 MB gzipped.
