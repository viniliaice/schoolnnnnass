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
  it('renders every nav path exactly once (no lost or duplicated links)', async () => {
    const host = await mountSidebar('/dashboard');
    // Expand every category first — collapsed groups intentionally render no items.
    for (const group of ADMIN_NAV_GROUPS) {
      await click(host.querySelector(`[data-testid="admin-nav-group-${group.id}"]`)!);
    }
    const rendered = [...host.querySelectorAll('[data-testid="admin-nav-item"]')].map(el =>
      el.getAttribute('data-path'),
    );
    expect(rendered).toEqual(ADMIN_NAV_PATHS);
    expect(new Set(rendered).size).toBe(rendered.length);
  });

  it('renders all six categories with their headings', async () => {
    const host = await mountSidebar('/dashboard');
    for (const group of ADMIN_NAV_GROUPS) {
      const toggle = host.querySelector(`[data-testid="admin-nav-group-${group.id}"]`);
      expect(toggle, `category ${group.id}`).not.toBeNull();
      expect(toggle!.getAttribute('aria-expanded')).toBe('false');
    }
  });

  it('keeps Dashboard as a standalone top-level item', async () => {
    const host = await mountSidebar('/dashboard');
    const dashboard = host.querySelector('[data-path="/dashboard"]');
    expect(dashboard).not.toBeNull();
    expect(dashboard!.getAttribute('aria-current')).toBe('page');
  });
});

describe('AdminSidebar — active route highlighting', () => {
  it('marks the exact active page and auto-expands only its category', async () => {
    const host = await mountSidebar('/admin/lesson-plans');
    const active = host.querySelector('[data-path="/admin/lesson-plans"]');
    expect(active!.getAttribute('aria-current')).toBe('page');
    expect(host.querySelector('[data-testid="admin-nav-group-academic"]')!.getAttribute('aria-expanded')).toBe('true');
    // Other categories stay collapsed.
    expect(host.querySelector('[data-testid="admin-nav-group-students"]')!.getAttribute('aria-expanded')).toBe('false');
    expect(host.querySelector('[data-testid="admin-nav-group-transport"]')!.getAttribute('aria-expanded')).toBe('false');
  });

  it('keeps the parent item highlighted on nested routes (/admin/family-ids/setup)', async () => {
    const host = await mountSidebar('/admin/family-ids/setup');
    expect(host.querySelector('[data-path="/admin/family-ids"]')!.getAttribute('aria-current')).toBe('page');
    expect(host.querySelector('[data-testid="admin-nav-group-transport"]')!.getAttribute('aria-expanded')).toBe('true');
  });

  it('does not confuse look-alike prefixes (lesson-plans vs lesson-planner)', async () => {
    expect(isAdminRouteActive('/admin/lesson-planner', '/admin/lesson-plans')).toBe(false);
    expect(isAdminRouteActive('/admin/lesson-plans', '/admin/lesson-planner')).toBe(false);
    expect(isAdminRouteActive('/admin/monitor-marks', '/admin/monitor')).toBe(false);
    expect(isAdminRouteActive('/admin/family-ids/setup', '/admin/family-ids')).toBe(true);

    const host = await mountSidebar('/admin/lesson-planner');
    expect(host.querySelector('[data-path="/admin/lesson-planner"]')!.getAttribute('aria-current')).toBe('page');
    expect(host.querySelector('[data-path="/admin/lesson-plans"]')!.getAttribute('aria-current')).toBeNull();
  });
});

describe('AdminSidebar — expandable categories', () => {
  it('toggles a category without navigating anywhere', async () => {
    const host = await mountSidebar('/dashboard');
    const toggle = host.querySelector('[data-testid="admin-nav-group-students"]')!;

    await click(toggle);
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    expect(navigateMock).not.toHaveBeenCalled();

    // Category contents become visible/interactive.
    expect(host.querySelector('[data-path="/admin/students"]')).not.toBeNull();

    await click(toggle);
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(navigateMock).not.toHaveBeenCalled();
    expect(host.querySelector('[data-path="/admin/students"]')).toBeNull();
  });

  it('keeps manually opened categories open when another one is active', async () => {
    const host = await mountSidebar('/dashboard');
    await click(host.querySelector('[data-testid="admin-nav-group-communication"]')!);
    await click(host.querySelector('[data-testid="admin-nav-group-students"]')!);
    expect(host.querySelector('[data-testid="admin-nav-group-communication"]')!.getAttribute('aria-expanded')).toBe('true');
    expect(host.querySelector('[data-testid="admin-nav-group-students"]')!.getAttribute('aria-expanded')).toBe('true');
  });
});

describe('AdminSidebar — navigation contract', () => {
  it('navigates through the layout contract and highlights the new page', async () => {
    const host = await mountSidebar('/dashboard');
    await click(host.querySelector('[data-testid="admin-nav-group-students"]')!);
    await click(host.querySelector('[data-path="/admin/students"]')!);
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

    await click(host.querySelector('[data-testid="admin-nav-group-exams"]')!);
    const item = host.querySelector('[data-path="/admin/exam-reports"]')!;
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
  it('exposes logout in the footer and wires it to the session logout', async () => {
    const host = await mountSidebar('/dashboard');
    const footer = host.querySelector('[data-testid="admin-sidebar-footer"]')!;
    expect(footer.textContent).toContain('Adam Admin');
    const logoutButton = footer.querySelector('[data-testid="admin-sidebar-logout"]')!;
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
