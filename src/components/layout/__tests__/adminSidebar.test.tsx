// @vitest-environment jsdom
//
// Behaviour tests for the redesigned ADMIN sidebar (src/components/layout/
// AdminSidebar.tsx). The admin layout is state-driven (DashboardLayout owns
// currentPath and history), so these tests mount the sidebar directly with a
// given path and assert grouping, active-route highlighting, expandable
// categories, the mobile drawer lifecycle and the desktop collapse rail.
//
// Visual/pixel behaviour at specific viewport widths is CSS-driven (see the
// `.admin-sidebar*` rules in src/index.css) and covered by the static
// inventory test + manual verification; these tests verify DOM behaviour.

import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

const logoutMock = vi.fn();
const navigateMock = vi.fn();

vi.mock('../../../context/RoleContext', () => ({
  useRole: () => ({
    session: { role: 'admin', userId: 'u1', userName: 'Adam Admin' },
    logout: logoutMock,
  }),
}));

vi.mock('../../../lib/i18n/AppLanguageContext', () => ({
  useI18n: () => ({
    language: 'en',
    direction: 'ltr',
    t: (key: string, fallback?: string) => fallback ?? key,
  }),
}));

import { AdminSidebar, ADMIN_NAV_GROUPS, ADMIN_NAV_PATHS, isAdminRouteActive } from '../AdminSidebar';

const ROOTS: Root[] = [];

async function mountSidebar(currentPath: string) {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  ROOTS.push(root);
  await act(async () => {
    root.render(<AdminSidebar currentPath={currentPath} onNavigate={navigateMock} />);
  });
  return host;
}

function click(el: Element) {
  return act(async () => {
    el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
  });
}

function pressEscape() {
  return act(async () => {
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
  });
}

beforeEach(() => {
  logoutMock.mockReset();
  navigateMock.mockReset();
  window.localStorage.clear();
  document.body.innerHTML = '';
});

afterEach(() => {
  return act(async () => {
    for (const root of ROOTS.splice(0)) root.unmount();
  });
});

describe('AdminSidebar — navigation inventory renders', () => {
  it('renders every nav path exactly once on desktop sidebar when expanded (no lost or duplicated links)', async () => {
    const host = await mountSidebar('/dashboard');
    const desktop = host.querySelector('[data-testid="admin-sidebar-desktop"]')!;
    // Expand every category first — collapsed groups intentionally render no items.
    for (const group of ADMIN_NAV_GROUPS) {
      await click(desktop.querySelector(`[data-testid="admin-nav-group-${group.id}"]`)!);
    }
    const rendered = [...desktop.querySelectorAll('[data-testid="admin-nav-item"]')].map(el =>
      el.getAttribute('data-path'),
    );
    expect(rendered).toEqual(ADMIN_NAV_PATHS);
    expect(new Set(rendered).size).toBe(rendered.length);
  });

  it('renders every nav path as icon items on the mobile persistent rail (no lost or duplicated links)', async () => {
    const host = await mountSidebar('/dashboard');
    const mobileRail = host.querySelector('[data-testid="admin-sidebar-mobile-rail"]')!;
    const rendered = [...mobileRail.querySelectorAll('[data-testid="admin-nav-item"]')].map(el =>
      el.getAttribute('data-path'),
    );
    expect(rendered).toEqual(ADMIN_NAV_PATHS);
    expect(new Set(rendered).size).toBe(rendered.length);
  });

  it('renders all six categories with their headings on desktop', async () => {
    const host = await mountSidebar('/dashboard');
    const desktop = host.querySelector('[data-testid="admin-sidebar-desktop"]')!;
    for (const group of ADMIN_NAV_GROUPS) {
      const toggle = desktop.querySelector(`[data-testid="admin-nav-group-${group.id}"]`);
      expect(toggle, `category ${group.id}`).not.toBeNull();
      expect(toggle!.getAttribute('aria-expanded')).toBe('false');
    }
  });

  it('keeps Dashboard as a standalone top-level item on desktop and mobile rail', async () => {
    const host = await mountSidebar('/dashboard');
    const desktopDashboard = host.querySelector('[data-testid="admin-sidebar-desktop"] [data-path="/dashboard"]');
    expect(desktopDashboard).not.toBeNull();
    expect(desktopDashboard!.getAttribute('aria-current')).toBe('page');

    const mobileDashboard = host.querySelector('[data-testid="admin-sidebar-mobile-rail"] [data-path="/dashboard"]');
    expect(mobileDashboard).not.toBeNull();
    expect(mobileDashboard!.getAttribute('aria-current')).toBe('page');
  });

  it('pins Manage Users next to Dashboard and above the Students category', async () => {
    const host = await mountSidebar('/dashboard');
    const desktop = host.querySelector('[data-testid="admin-sidebar-desktop"]')!;
    // Rendered without expanding any category…
    const dashboard = desktop.querySelector('[data-path="/dashboard"]')!;
    const manageUsers = desktop.querySelector('[data-path="/admin/users"]');
    expect(manageUsers).not.toBeNull();
    expect(manageUsers!.getAttribute('aria-current')).toBeNull();
    // …immediately after Dashboard (both are direct children of the nav)…
    expect(manageUsers!.previousElementSibling).toBe(dashboard);
    // …and before the first category heading in document order.
    const studentsToggle = desktop.querySelector('[data-testid="admin-nav-group-students"]')!;
    expect(
      manageUsers!.compareDocumentPosition(studentsToggle) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });
});

describe('AdminSidebar — active route highlighting', () => {
  it('marks the exact active page and auto-expands only its category', async () => {
    const host = await mountSidebar('/admin/lesson-plans');
    const desktop = host.querySelector('[data-testid="admin-sidebar-desktop"]')!;
    const active = desktop.querySelector('[data-path="/admin/lesson-plans"]');
    expect(active!.getAttribute('aria-current')).toBe('page');
    expect(desktop.querySelector('[data-testid="admin-nav-group-academic"]')!.getAttribute('aria-expanded')).toBe('true');
    // Other categories stay collapsed.
    expect(desktop.querySelector('[data-testid="admin-nav-group-students"]')!.getAttribute('aria-expanded')).toBe('false');
    expect(desktop.querySelector('[data-testid="admin-nav-group-transport"]')!.getAttribute('aria-expanded')).toBe('false');
  });

  it('highlights the active item on the mobile persistent rail', async () => {
    const host = await mountSidebar('/admin/lesson-plans');
    const mobileRail = host.querySelector('[data-testid="admin-sidebar-mobile-rail"]')!;
    const active = mobileRail.querySelector('[data-path="/admin/lesson-plans"]');
    expect(active).not.toBeNull();
    expect(active!.getAttribute('aria-current')).toBe('page');
    expect(active!.classList.contains('admin-sidebar__item--active')).toBe(true);

    const inactive = mobileRail.querySelector('[data-path="/admin/students"]')!;
    expect(inactive.getAttribute('aria-current')).toBeNull();
    expect(inactive.classList.contains('admin-sidebar__item--active')).toBe(false);
  });

  it('keeps the parent item highlighted on nested routes (/admin/family-ids/setup)', async () => {
    const host = await mountSidebar('/admin/family-ids/setup');
    const desktop = host.querySelector('[data-testid="admin-sidebar-desktop"]')!;
    expect(desktop.querySelector('[data-path="/admin/family-ids"]')!.getAttribute('aria-current')).toBe('page');
    expect(desktop.querySelector('[data-testid="admin-nav-group-transport"]')!.getAttribute('aria-expanded')).toBe('true');

    const mobileRail = host.querySelector('[data-testid="admin-sidebar-mobile-rail"]')!;
    expect(mobileRail.querySelector('[data-path="/admin/family-ids"]')!.getAttribute('aria-current')).toBe('page');
  });

  it('does not confuse look-alike prefixes (lesson-plans vs lesson-planner)', async () => {
    expect(isAdminRouteActive('/admin/lesson-planner', '/admin/lesson-plans')).toBe(false);
    expect(isAdminRouteActive('/admin/lesson-plans', '/admin/lesson-planner')).toBe(false);
    expect(isAdminRouteActive('/admin/monitor-marks', '/admin/monitor')).toBe(false);
    expect(isAdminRouteActive('/admin/family-ids/setup', '/admin/family-ids')).toBe(true);

    const host = await mountSidebar('/admin/lesson-planner');
    const desktop = host.querySelector('[data-testid="admin-sidebar-desktop"]')!;
    expect(desktop.querySelector('[data-path="/admin/lesson-planner"]')!.getAttribute('aria-current')).toBe('page');
    expect(desktop.querySelector('[data-path="/admin/lesson-plans"]')!.getAttribute('aria-current')).toBeNull();

    const mobileRail = host.querySelector('[data-testid="admin-sidebar-mobile-rail"]')!;
    expect(mobileRail.querySelector('[data-path="/admin/lesson-planner"]')!.getAttribute('aria-current')).toBe('page');
    expect(mobileRail.querySelector('[data-path="/admin/lesson-plans"]')!.getAttribute('aria-current')).toBeNull();
  });
});

describe('AdminSidebar — expandable categories', () => {
  it('toggles a category without navigating anywhere', async () => {
    const host = await mountSidebar('/dashboard');
    const desktop = host.querySelector('[data-testid="admin-sidebar-desktop"]')!;
    const toggle = desktop.querySelector('[data-testid="admin-nav-group-students"]')!;

    await click(toggle);
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    expect(navigateMock).not.toHaveBeenCalled();

    // Category contents become visible/interactive in desktop sidebar.
    expect(desktop.querySelector('[data-path="/admin/students"]')).not.toBeNull();

    await click(toggle);
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(navigateMock).not.toHaveBeenCalled();
    expect(desktop.querySelector('[data-path="/admin/students"]')).toBeNull();
  });

  it('keeps manually opened categories open when another one is active', async () => {
    const host = await mountSidebar('/dashboard');
    const desktop = host.querySelector('[data-testid="admin-sidebar-desktop"]')!;
    await click(desktop.querySelector('[data-testid="admin-nav-group-communication"]')!);
    await click(desktop.querySelector('[data-testid="admin-nav-group-students"]')!);
    expect(desktop.querySelector('[data-testid="admin-nav-group-communication"]')!.getAttribute('aria-expanded')).toBe('true');
    expect(desktop.querySelector('[data-testid="admin-nav-group-students"]')!.getAttribute('aria-expanded')).toBe('true');
  });
});

describe('AdminSidebar — mobile persistent icon rail', () => {
  it('renders persistent rail with accessible labels, visible tooltips and category dividers', async () => {
    const host = await mountSidebar('/dashboard');
    const mobileRail = host.querySelector('[data-testid="admin-sidebar-mobile-rail"]')!;
    expect(mobileRail).not.toBeNull();
    expect(mobileRail.getAttribute('aria-label')).toBe('Admin navigation');

    const items = mobileRail.querySelectorAll('[data-testid="admin-nav-item"]');
    expect(items.length).toBe(ADMIN_NAV_PATHS.length);
    items.forEach(item => {
      expect(item.getAttribute('aria-label')).toBeTruthy();
      expect(item.getAttribute('title')).toBeTruthy();
    });

    const sections = mobileRail.querySelectorAll('.admin-sidebar__rail-section');
    expect(sections.length).toBe(ADMIN_NAV_GROUPS.length);
    expect(sections[0].getAttribute('title')).toBe('Students');
    expect(sections[1].getAttribute('title')).toBe('Academic');
  });

  it('navigates directly on single tap from mobile rail', async () => {
    const host = await mountSidebar('/dashboard');
    const mobileRail = host.querySelector('[data-testid="admin-sidebar-mobile-rail"]')!;
    const studentLink = mobileRail.querySelector('[data-path="/admin/students"]')!;
    await click(studentLink);
    expect(navigateMock).toHaveBeenCalledTimes(1);
    expect(navigateMock).toHaveBeenCalledWith('/admin/students');
  });

  it('renders hamburger menu button in mobile rail header', async () => {
    const host = await mountSidebar('/dashboard');
    const mobileRail = host.querySelector('[data-testid="admin-sidebar-mobile-rail"]')!;
    const toggle = mobileRail.querySelector('[data-testid="admin-sidebar-toggle"]');
    expect(toggle).not.toBeNull();
    expect(toggle!.getAttribute('aria-expanded')).toBe('false');
    expect(toggle!.getAttribute('aria-controls')).toBe('admin-sidebar-drawer');
  });
});

describe('AdminSidebar — navigation contract', () => {
  it('navigates through the layout contract and highlights the new page', async () => {
    const host = await mountSidebar('/dashboard');
    const desktop = host.querySelector('[data-testid="admin-sidebar-desktop"]')!;
    await click(desktop.querySelector('[data-testid="admin-nav-group-students"]')!);
    await click(desktop.querySelector('[data-path="/admin/students"]')!);
    expect(navigateMock).toHaveBeenCalledTimes(1);
    expect(navigateMock).toHaveBeenCalledWith('/admin/students');
  });
});

describe('AdminSidebar — mobile drawer', () => {
  it('opens from the menu button, locks page scroll, closes on Escape', async () => {
    const host = await mountSidebar('/dashboard');
    const toggle = host.querySelector('[data-testid="admin-sidebar-toggle"]')!;
    expect(toggle.getAttribute('aria-expanded')).toBe('false');

    await click(toggle);
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    const drawer = host.querySelector('[data-testid="admin-sidebar-drawer"]');
    expect(drawer).not.toBeNull();
    expect(drawer!.getAttribute('role')).toBe('dialog');
    expect(drawer!.getAttribute('aria-modal')).toBe('true');
    expect(document.body.style.overflow).toBe('hidden');

    await pressEscape();
    expect(host.querySelector('[data-testid="admin-sidebar-drawer"]')).toBeNull();
    expect(document.body.style.overflow).toBe('');
  });

  it('closes when the backdrop is tapped', async () => {
    const host = await mountSidebar('/dashboard');
    await click(host.querySelector('[data-testid="admin-sidebar-toggle"]')!);
    expect(host.querySelector('[data-testid="admin-sidebar-drawer"]')).not.toBeNull();

    await click(host.querySelector('[data-testid="admin-sidebar-backdrop"]')!);
    expect(host.querySelector('[data-testid="admin-sidebar-drawer"]')).toBeNull();
    expect(document.body.style.overflow).toBe('');
  });

  it('closes after successful navigation', async () => {
    const host = await mountSidebar('/dashboard');
    await click(host.querySelector('[data-testid="admin-sidebar-toggle"]')!);

    const drawer = host.querySelector('[data-testid="admin-sidebar-drawer"]')!;
    await click(drawer.querySelector('[data-testid="admin-nav-group-exams"]')!);
    const item = drawer.querySelector('[data-path="/admin/exam-reports"]')!;
    await click(item);
    expect(navigateMock).toHaveBeenCalledWith('/admin/exam-reports');
    expect(host.querySelector('[data-testid="admin-sidebar-drawer"]')).toBeNull();
    expect(document.body.style.overflow).toBe('');
  });

  it('close button closes the drawer', async () => {
    const host = await mountSidebar('/dashboard');
    await click(host.querySelector('[data-testid="admin-sidebar-toggle"]')!);
    await click(host.querySelector('[data-testid="admin-sidebar-close"]')!);
    expect(host.querySelector('[data-testid="admin-sidebar-drawer"]')).toBeNull();
  });
});

describe('AdminSidebar — bottom profile section', () => {
  it('exposes logout in desktop footer and wires it to session logout', async () => {
    const host = await mountSidebar('/dashboard');
    const desktopFooter = host.querySelector('[data-testid="admin-sidebar-desktop"] [data-testid="admin-sidebar-footer"]')!;
    expect(desktopFooter.textContent).toContain('Adam Admin');
    const logoutButton = desktopFooter.querySelector('[data-testid="admin-sidebar-logout"]')!;
    await click(logoutButton);
    expect(logoutMock).toHaveBeenCalledTimes(1);
  });

  it('exposes logout in mobile rail footer and wires it to session logout', async () => {
    const host = await mountSidebar('/dashboard');
    const mobileFooter = host.querySelector('[data-testid="admin-sidebar-mobile-rail"] [data-testid="admin-sidebar-footer"]')!;
    expect(mobileFooter.querySelector('.admin-sidebar__avatar')!.textContent).toBe('AA');
    const logoutButton = mobileFooter.querySelector('[data-testid="admin-sidebar-logout"]')!;
    await click(logoutButton);
    expect(logoutMock).toHaveBeenCalledTimes(1);
  });

  it('exposes logout in mobile drawer footer and wires it to session logout', async () => {
    const host = await mountSidebar('/dashboard');
    await click(host.querySelector('[data-testid="admin-sidebar-toggle"]')!);
    const drawerFooter = host.querySelector('[data-testid="admin-sidebar-drawer"] [data-testid="admin-sidebar-footer"]')!;
    expect(drawerFooter.textContent).toContain('Adam Admin');
    const logoutButton = drawerFooter.querySelector('[data-testid="admin-sidebar-logout"]')!;
    await click(logoutButton);
    expect(logoutMock).toHaveBeenCalledTimes(1);
  });
});

describe('AdminSidebar — desktop collapse rail', () => {
  it('collapses to an icon rail, persists the preference, and expands again', async () => {
    const host = await mountSidebar('/dashboard');
    const desktop = host.querySelector('[data-testid="admin-sidebar-desktop"]')!;
    expect(desktop.getAttribute('data-collapsed')).toBe('false');
    expect(desktop.querySelector('.admin-sidebar__item-label')).not.toBeNull();

    await click(desktop.querySelector('[data-testid="admin-sidebar-collapse"]')!);
    expect(desktop.getAttribute('data-collapsed')).toBe('true');
    expect(window.localStorage.getItem('mbk-admin-sidebar-collapsed')).toBe('1');
    // Every link stays reachable as an icon — nothing is dropped in rail mode.
    expect(desktop.querySelectorAll('[data-testid="admin-nav-item"]').length).toBe(ADMIN_NAV_PATHS.length);
    expect(desktop.querySelector('.admin-sidebar__item-label')).toBeNull();
    // Logout remains available in the rail.
    expect(desktop.querySelector('[data-testid="admin-sidebar-footer"] .admin-sidebar__logout')).not.toBeNull();

    await click(desktop.querySelector('[data-testid="admin-sidebar-collapse"]')!);
    expect(desktop.getAttribute('data-collapsed')).toBe('false');
    expect(window.localStorage.getItem('mbk-admin-sidebar-collapsed')).toBe('0');
  });

  it('restores a previously saved collapsed preference', async () => {
    window.localStorage.setItem('mbk-admin-sidebar-collapsed', '1');
    const host = await mountSidebar('/dashboard');
    expect(host.querySelector('[data-testid="admin-sidebar-desktop"]')!.getAttribute('data-collapsed')).toBe('true');
  });
});
