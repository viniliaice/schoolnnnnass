// Static inventory + wiring guards for the ADMIN sidebar redesign.
//
// These tests parse the actual sources (same approach as
// fixedPositionChrome.test.ts) to guarantee, independent of any refactor:
//
//   1. every admin link that existed in the ORIGINAL shared Sidebar.tsx
//      still exists in the new AdminSidebar.tsx — nothing was dropped;
//   2. the new sidebar never duplicates a path (e.g. /admin/academic and
//      /admin/class-subjects render the SAME AcademicWorkspace page, so only
//      one of them may be linked);
//   3. every link the admin sidebar offers is handled by the admin route
//      switch in App.tsx (no dead links);
//   4. AdminSidebar is wired through DashboardLayout's renderSidebar prop for
//      the admin role only, and teacher/supervisor/office/parent keep the
//      original shared Sidebar.

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { ADMIN_NAV_PATHS, ADMIN_NAV_GROUPS } from '../AdminSidebar';

const repoRoot = new URL('../../../../', import.meta.url);

const read = (relative: string) => readFileSync(new URL(relative, repoRoot), 'utf8');

/** The original role-keyed nav tables still live in the shared Sidebar. */
const sharedSidebarSource = () => read('src/components/layout/Sidebar.tsx');
const adminSidebarSource = () => read('src/components/layout/AdminSidebar.tsx');
const appSource = () => read('src/App.tsx');
const layoutSource = () => read('src/components/layout/DashboardLayout.tsx');
const cssSource = () => read('src/index.css');

/** Paths of the legacy admin sidebar entries, parsed from Sidebar.tsx. */
function legacyAdminPaths(): string[] {
  const source = sharedSidebarSource();
  const adminBlock = source.match(/admin:\s*\[(.*?)\]/s)?.[1];
  expect(adminBlock, 'Sidebar.tsx still declares an admin nav array').toBeTruthy();
  return [...adminBlock!.matchAll(/path:\s*'([^']+)'/g)].map(match => match[1]);
}

describe('Admin sidebar inventory', () => {
  it('keeps every original admin link (nothing lost, no duplicates)', () => {
    const legacy = legacyAdminPaths();
    expect(legacy.length).toBeGreaterThanOrEqual(30);

    const missing = legacy.filter(path => !ADMIN_NAV_PATHS.includes(path));
    expect(missing, 'original admin links dropped in the redesign').toEqual([]);

    expect(new Set(ADMIN_NAV_PATHS).size).toBe(ADMIN_NAV_PATHS.length);
  });

  it('links each destination once — /admin/class-subjects is the same page as /admin/academic', () => {
    // Both routes export AcademicWorkspace (see ManageClassSubjects.tsx), so
    // showing both would be a duplicate link to one page.
    expect(ADMIN_NAV_PATHS).toContain('/admin/academic');
    expect(ADMIN_NAV_PATHS).not.toContain('/admin/class-subjects');
  });

  it('resolves every offered link through the App.tsx admin route switch', () => {
    const source = appSource();
    const allCases = new Set([...source.matchAll(/case\s+'([^']+)':/g)].map(match => match[1]));
    const unroutable = ADMIN_NAV_PATHS.filter(path => !allCases.has(path));
    expect(unroutable, 'sidebar links with no route case in App.tsx').toEqual([]);
  });

  it('adds only routes the admin role is actually allowed to open', () => {
    const routingSource = read('src/lib/routing.ts');
    // /gate and /directory list admin in ROUTE_ACCESS; the remaining added
    // links already existed in the legacy admin sidebar.
    expect(routingSource).toMatch(/'\/gate':\s*\['admin'/);
    expect(routingSource).toMatch(/'\/directory':\s*\['admin'/);
  });

  it('groups the navigation into the documented categories', () => {
    expect(ADMIN_NAV_GROUPS.map(group => group.id)).toEqual([
      'students',
      'academic',
      'exams',
      'communication',
      'transport',
      'administration',
    ]);
    // Standalone pinning: Dashboard first, Manage Users beside it (above the
    // Students category) — Manage Users must NOT also live in Administration.
    expect(ADMIN_NAV_PATHS[0]).toBe('/dashboard');
    expect(ADMIN_NAV_PATHS[1]).toBe('/admin/users');
    const administration = ADMIN_NAV_GROUPS.find(group => group.id === 'administration')!;
    expect(administration.items.map(item => item.path)).not.toContain('/admin/users');
  });
});

describe('Admin sidebar wiring (admin only — other roles untouched)', () => {
  it('renders AdminSidebar through DashboardLayout renderSidebar for admin sessions only', () => {
    const app = appSource();
    expect(app).toContain("import { AdminSidebar } from './components/layout/AdminSidebar';");
    // Guarded by the admin role check…
    expect(app).toMatch(/session\.role === 'admin'\s*\?\s*\(currentPath, navigate\) => <AdminSidebar/);
    // …and undefined for every other role.
    expect(app).toMatch(/: undefined\s*\n\s*\}/);
  });

  it('keeps the shared Sidebar as the default for teacher/supervisor/office', () => {
    const layout = layoutSource();
    expect(layout).toContain("renderSidebar ? renderSidebar(currentPath, navigate) : <Sidebar currentPath={currentPath} onNavigate={navigate} />");
    // The shared Sidebar component itself must not have been repurposed.
    expect(sharedSidebarSource()).toMatch(/export function Sidebar\(/);
    expect(sharedSidebarSource()).toContain("path: '/admin/duplicate-students'"); // legacy admin list intact
  });

  it('AdminSidebar never renders for the parent app', () => {
    const app = appSource();
    const parentBlock = app.match(/if \(session\.role === 'parent'\) \{[\s\S]*?ParentAppShell/);
    expect(parentBlock).toBeTruthy();
    expect(parentBlock![0]).not.toContain('AdminSidebar');
  });

  it('ships dedicated responsive CSS (desktop column, drawer, safe areas, 44px targets)', () => {
    const css = cssSource();
    expect(css).toMatch(/\.admin-sidebar-desktop\s*\{/);
    expect(css).toMatch(/\.admin-sidebar-drawer\s*\{/);
    expect(css).toMatch(/\.admin-sidebar-toggle\s*\{/);
    expect(css).toMatch(/min-height:\s*2\.75rem/);            // 44px touch targets
    expect(css).toMatch(/env\(safe-area-inset-bottom/);        // mobile safe areas
    expect(css).toMatch(/env\(safe-area-inset-top/);
    expect(css).toMatch(/min\(19\.5rem,\s*86vw\)/);            // drawer fits 320px phones
    expect(css).toMatch(/width:\s*var\(--asb-width\)/);        // main content resizes via flex width
    expect(css).toMatch(/\.admin-sidebar-desktop\[data-collapsed="true"\]/);
  });

  it('hides the mobile toggle + drawer with its own desktop media query (layer-proof)', () => {
    const css = cssSource();
    // Tailwind v4 puts utilities in @layer utilities; the toggle's unlayered
    // `display: grid` would otherwise override the layered `lg:hidden` at
    // ≥1024px (the reported tablet/laptop bug). Hiding must therefore live
    // in an unlayered min-width media query.
    const mediaBlock = css.match(/@media \(min-width: 64rem\)\s*\{[^@]*?\.admin-sidebar-toggle[^}]*\}[^}]*\}/s)?.[0] ?? '';
    expect(mediaBlock, 'expected a min-width:64rem block hiding the toggle').not.toBe('');
    expect(mediaBlock).toContain('display: none');
    expect(mediaBlock).toContain('.admin-sidebar-mobile-root');
    // And the base rule must keep the button visible below the breakpoint.
    const baseRule = css.match(/\.admin-sidebar-toggle\s*\{[^}]*\}/s)?.[0] ?? '';
    expect(baseRule).toContain('display: grid');
  });
});
