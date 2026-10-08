// @vitest-environment jsdom
//
// Behaviour tests for the redesigned sidebar (desktop column + mobile drawer).
//
// These drive the real component the way the app does — through
// DashboardLayout's state-based navigation — and cover the acceptance list the
// redesign was built against: active-route detection, expandable groups that
// auto-open around the current route, the collapsed icon rail, the mobile
// drawer (open/close, Escape, backdrop, scroll lock, focus return, close on
// select), role filtering, page search, and the account/sign-out area.

import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';

// React 19 requires this flag before act() will flush effects in jsdom.
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
import { act, useState, type ReactNode, type ReactElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';

const { sessionRef, logoutSpy } = vi.hoisted(() => ({
  sessionRef: { current: null as null | Record<string, unknown> },
  logoutSpy: vi.fn(),
}));

vi.mock('../../../context/RoleContext', () => ({
  RoleProvider: ({ children }: { children: ReactNode }) => children,
  useRole: () => ({
    session: sessionRef.current,
    logout: logoutSpy,
    loading: false,
    error: null,
    isLoggedIn: Boolean(sessionRef.current),
    login: async () => undefined,
  }),
}));

import { I18nProvider } from '../../../lib/i18n/AppLanguageContext';
import { DashboardLayout } from '../DashboardLayout';
import {
  NAV_GROUPS_KEY_PREFIX,
  SIDEBAR_COLLAPSED_KEY,
  resolveOpenGroups,
  readNavGroupState,
  readSidebarCollapsed,
  writeNavGroupState,
  writeSidebarCollapsed,
} from '../../../lib/navPreferences';
import { Sidebar } from '../Sidebar';
import { buildNavigation, flattenNavigation } from '../navigation';
import type { Role } from '../../../types';

const ADMIN = { role: 'admin' as Role, userId: 'admin-1', userName: 'Amina Yusuf', email: 'a@mbk.edu' };
const TEACHER = { role: 'teacher' as Role, userId: 'tea-1', userName: 'Fatima Ali', email: 'f@mbk.edu' };
const PARENT = { role: 'parent' as Role, userId: 'par-1', userName: 'Hodan Jama', email: 'h@mbk.edu' };

const roots: Root[] = [];

interface Rendered {
  host: HTMLElement;
  unmount: () => void;
}

function render(element: ReactElement): Rendered {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  roots.push(root);
  act(() => {
    root.render(<I18nProvider>{element}</I18nProvider>);
  });
  return {
    host,
    unmount: () => {
      act(() => root.unmount());
      host.remove();
    },
  };
}

function renderSidebar(props: Partial<Parameters<typeof Sidebar>[0]> = {}) {
  return render(
    <Sidebar currentPath="/dashboard" onNavigate={() => undefined} breakpoint="lg" {...props} />,
  );
}

/**
 * Mounts the sidebar the way DashboardLayout does: the shell owns the current
 * path and hands it back on navigation, so a click really changes the page (and
 * with it the active item, the open group and the account panel).
 */
function renderShell(props: Partial<Parameters<typeof Sidebar>[0]> = {}) {
  function Shell() {
    const [path, setPath] = useState(props.currentPath ?? '/dashboard');
    return <Sidebar {...props} currentPath={path} onNavigate={setPath} breakpoint="lg" />;
  }
  return render(<Shell />);
}

/** Poll inside act() until `predicate()` holds — same pattern as the app's other jsdom suites. */
async function waitFor(predicate: () => boolean, label: string): Promise<void> {
  for (let i = 0; i < 60 && !predicate(); i++) {
    await act(async () => {
      await new Promise(resolve => setTimeout(resolve, 20));
    });
  }
  if (!predicate()) throw new Error(`timed out waiting for ${label}`);
}

async function click(element: Element | null | undefined): Promise<void> {
  if (!element) throw new Error('element to click is missing');
  await act(async () => {
    element.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
}

async function type(input: HTMLInputElement, value: string): Promise<void> {
  await act(async () => {
    // React reads `value` from the native setter; assigning directly keeps the
    // controlled input in sync the way a real keystroke would.
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
    setter?.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

const byTestId = (host: HTMLElement, id: string) => host.querySelector<HTMLElement>(`[data-testid="${id}"]`);
const sidebarColumn = (host: HTMLElement) => host.querySelector<HTMLElement>('#app-sidebar-nav');
const allItems = (host: HTMLElement) => [...host.querySelectorAll<HTMLElement>('[data-testid^="nav-item-"]')];

beforeEach(() => {
  localStorage.clear();
  document.body.innerHTML = '';
  document.body.style.overflow = '';
  sessionRef.current = ADMIN;
  logoutSpy.mockClear();
});

afterEach(async () => {
  for (const root of roots.splice(0)) {
    await act(async () => {
      root.unmount();
    });
  }
});

describe('navigation configuration', () => {
  it('gives every role a complete, duplicate-free destination list', () => {
    for (const role of ['admin', 'teacher', 'supervisor', 'office', 'parent'] as Role[]) {
      const items = flattenNavigation(buildNavigation(role));
      const paths = items.flatMap(item => [item.path, ...(item.aliases ?? [])]);
      expect(new Set(paths).size, `duplicate paths for ${role}`).toBe(paths.length);
      expect(items.length, `no destinations for ${role}`).toBeGreaterThan(0);
      for (const item of items) {
        // Every entry must carry an icon + label + unique id to render.
        expect(item.icon, `${item.id} icon`).toBeTruthy();
        expect(item.fallback.length, `${item.id} label`).toBeGreaterThan(0);
      }
    }
  });
});

describe('sidebar structure', () => {
  it('renders the desktop column with one section heading per navigation section', () => {
    const { host } = renderSidebar();

    const column = host.querySelector('#app-sidebar-nav');
    expect(column).not.toBeNull();
    expect(column?.getAttribute('aria-label')).toBe('Main navigation');

    const headings = [...host.querySelectorAll<HTMLElement>('.app-nav-section-title')].map(
      heading => heading.textContent,
    );
    expect(headings).toEqual(['Main', 'People', 'Academics', 'Oversight', 'Communication', 'System']);

    // Every leaf destination is rendered exactly once.
    const ids = allItems(host).map(item => item.dataset.testid);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toContain('nav-item-dashboard');
    expect(ids).toContain('nav-item-academic-setup');
  });

  it('renders a group as a destination row plus a disclosure button', () => {
    const { host } = renderSidebar({ currentPath: '/dashboard' });

    const row = byTestId(host, 'nav-group-lesson-plans');
    const toggle = byTestId(host, 'nav-group-lesson-plans-toggle');
    expect(row?.textContent).toBe('Lesson Plans');
    expect(toggle?.getAttribute('aria-expanded')).toBe('false');
    expect(toggle?.getAttribute('aria-controls')).toBe('nav-group-lesson-plans');

    const list = host.querySelector('#nav-group-lesson-plans');
    expect(list).not.toBeNull();
    expect(list?.querySelectorAll('li').length).toBe(3);

    // Closed groups are hidden from the tab order and from assistive tech.
    const submenu = list?.closest('.app-nav-submenu');
    expect(submenu?.hasAttribute('inert')).toBe(true);
  });
});

describe('active route detection', () => {
  it('marks the current page and nothing else', () => {
    const { host } = renderSidebar({ currentPath: '/admin/students' });

    const active = allItems(host).filter(item => item.getAttribute('aria-current') === 'page');
    expect(active.map(item => item.dataset.testid)).toEqual(['nav-item-students-all']);
    expect(active[0].dataset.active).toBe('true');
  });

  it('matches legacy aliases so old deep links keep their active state', () => {
    const { host } = renderSidebar({ currentPath: '/admin/class-subjects' });

    const active = allItems(host).filter(item => item.getAttribute('aria-current') === 'page');
    expect(active.map(item => item.dataset.testid)).toEqual(['nav-item-academic-setup']);
  });

  it('auto-opens the group that contains the current route', () => {
    const { host } = renderSidebar({ currentPath: '/admin/lesson-plan-submissions' });

    const toggle = byTestId(host, 'nav-group-lesson-plans-toggle');
    expect(toggle?.getAttribute('aria-expanded')).toBe('true');

    // The nested page is visible, and its parent row keeps the active context.
    expect(byTestId(host, 'nav-item-lesson-plan-submissions')).not.toBeNull();
    expect(byTestId(host, 'nav-group-lesson-plans')?.dataset.activeDescendant).toBe('true');
    const submenu = host.querySelector('#nav-group-lesson-plans')?.closest('.app-nav-submenu');
    expect(submenu?.hasAttribute('inert')).toBe(false);
  });

  it('keeps a group the user opened open across navigation', async () => {
    const { host } = renderSidebar({ currentPath: '/dashboard' });

    await click(byTestId(host, 'nav-group-exams-toggle'));
    expect(byTestId(host, 'nav-group-exams-toggle')?.getAttribute('aria-expanded')).toBe('true');

    // A route outside the group must not silently re-collapse it.
    const navigated: string[] = [];
    const second = renderSidebar({
      currentPath: '/admin/students',
      onNavigate: path => navigated.push(path),
    });
    expect(byTestId(second.host, 'nav-group-exams-toggle')?.getAttribute('aria-expanded')).toBe('true');
    second.unmount();
  });
});

describe('navigation', () => {
  it('navigates on select and never double-fires for the current page', async () => {
    const navigated: string[] = [];
    const { host } = renderSidebar({ currentPath: '/dashboard', onNavigate: path => navigated.push(path) });

    await click(byTestId(host, 'nav-item-directory'));
    expect(navigated).toEqual(['/directory']);

    navigated.length = 0;
    await click(byTestId(host, 'nav-item-dashboard')); // already current
    expect(navigated).toEqual([]);
  });

  it('opens a group from its parent row (one tap to the group landing page)', async () => {
    const navigated: string[] = [];
    const { host } = renderSidebar({ currentPath: '/dashboard', onNavigate: path => navigated.push(path) });

    await click(byTestId(host, 'nav-group-lesson-plans'));
    expect(navigated).toEqual(['/admin/lesson-plans']);
  });

  it('does not re-navigate when the parent row of the open group is clicked', async () => {
    const navigated: string[] = [];
    const { host } = renderSidebar({
      currentPath: '/admin/lesson-planner',
      onNavigate: path => navigated.push(path),
    });

    await click(byTestId(host, 'nav-group-lesson-plans'));
    // Already on that page: no duplicate history entry, no re-render storm.
    expect(navigated).toEqual([]);
  });
});

describe('collapsed desktop rail', () => {
  it('switches to icon-only rows, keeps every destination, and remembers the choice', async () => {
    const navigated: string[] = [];
    const { host } = renderSidebar({ currentPath: '/dashboard', onNavigate: path => navigated.push(path) });

    await click(byTestId(host, 'sidebar-collapse-toggle'));

    const column = sidebarColumn(host);
    expect(column?.dataset.collapsed).toBe('true');
    expect(localStorage.getItem('mbk-sidebar-collapsed')).toBe('true');

    // Labels are visually hidden, not removed — screen readers still read them.
    const labels = [...host.querySelectorAll<HTMLElement>('.app-nav-item > span')];
    expect(labels.length).toBeGreaterThan(0);
    expect(labels.every(label => label.className.includes('sr-only'))).toBe(true);

    // Nothing is lost: every top-level destination is still one tap away, and a
    // group's icon still lands on that group's page.
    const topLevel = allItems(host).filter(item => !item.className.includes('app-nav-item--nested'));
    expect(topLevel.length).toBe(18);

    await click(byTestId(host, 'nav-item-directory'));
    expect(navigated).toEqual(['/directory']);

    navigated.length = 0;
    await click(byTestId(host, 'nav-group-lesson-plans'));
    expect(navigated).toEqual(['/admin/lesson-plans']);

    // And it comes back.
    await click(byTestId(host, 'sidebar-collapse-toggle'));
    expect(sidebarColumn(host)?.dataset.collapsed).toBe('false');
    expect(localStorage.getItem('mbk-sidebar-collapsed')).toBe('false');
  });

  it('restores the persisted collapsed state on the next mount', () => {
    localStorage.setItem('mbk-sidebar-collapsed', 'true');
    const { host } = renderSidebar();
    expect(sidebarColumn(host)?.dataset.collapsed).toBe('true');
  });

  it('shows a tooltip for a collapsed rail row on hover and focus', async () => {
    const { host } = renderSidebar({ currentPath: '/dashboard' });
    await click(byTestId(host, 'sidebar-collapse-toggle'));

    const item = byTestId(host, 'nav-item-directory')!;
    await act(async () => {
      item.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
      item.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true }));
    });

    await waitFor(() => Boolean(host.querySelector('[role="tooltip"]')), 'the tooltip');
    expect(host.querySelector('[role="tooltip"]')?.textContent).toBe('Student Directory');
  });
});

describe('mobile drawer', () => {
  it('mounts a modal dialog, locks the page, and closes on Escape', async () => {
    let open = true;
    const onMobileOpenChange = (next: boolean) => {
      open = next;
    };
    const { host } = renderSidebar({
      currentPath: '/dashboard',
      mobileOpen: true,
      onMobileOpenChange,
    });

    const dialog = host.querySelector('#app-mobile-nav');
    expect(dialog?.getAttribute('role')).toBe('dialog');
    expect(dialog?.getAttribute('aria-modal')).toBe('true');
    expect(document.body.style.overflow).toBe('hidden');
    expect(host.querySelector('[data-testid="mobile-drawer-backdrop"]')).not.toBeNull();

    await act(async () => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });
    expect(open).toBe(false);
  });

  it('is not rendered at all while closed', () => {
    const { host } = renderSidebar({ mobileOpen: false, onMobileOpenChange: () => undefined });
    expect(host.querySelector('#app-mobile-nav')).toBeNull();
  });

  it('closes on backdrop click, on the close button, and after choosing a page', async () => {
    const changes: boolean[] = [];
    const onMobileOpenChange = (next: boolean) => changes.push(next);
    const navigated: string[] = [];
    const { host } = renderSidebar({
      currentPath: '/dashboard',
      mobileOpen: true,
      onMobileOpenChange,
      onNavigate: path => navigated.push(path),
    });

    await click(host.querySelector('[data-testid="mobile-drawer-backdrop"]'));
    expect(changes.at(-1)).toBe(false);

    await click(byTestId(host, 'drawer-close'));
    expect(changes.at(-1)).toBe(false);

    changes.length = 0;
    await click(byTestId(host, 'nav-item-messages'));
    expect(navigated).toEqual(['/messages']);
    expect(changes).toEqual([false]);
  });

  it('moves focus into the dialog and gives it back afterwards', async () => {
    const trigger = document.createElement('button');
    document.body.appendChild(trigger);
    trigger.focus();

    const { host, unmount } = renderSidebar({
      currentPath: '/dashboard',
      mobileOpen: true,
      onMobileOpenChange: () => undefined,
    });

    await waitFor(() => Boolean(document.activeElement && host.contains(document.activeElement)), 'drawer focus');
    const dialog = host.querySelector<HTMLElement>('#app-mobile-nav')!;
    expect(dialog.contains(document.activeElement)).toBe(true);

    unmount();
    expect(document.activeElement).toBe(trigger);
    // The scroll lock is released with the dialog.
    expect(document.body.style.overflow).toBe('');
  });

  it('keeps Tab inside the dialog', async () => {
    const { host } = renderSidebar({
      currentPath: '/dashboard',
      mobileOpen: true,
      onMobileOpenChange: () => undefined,
    });

    await waitFor(() => Boolean(host.querySelector('#app-mobile-nav')?.contains(document.activeElement)), 'drawer focus');
    const dialog = host.querySelector<HTMLElement>('#app-mobile-nav')!;
    const focusables = [...dialog.querySelectorAll<HTMLElement>('button, input, select')];
    const last = focusables[focusables.length - 1];
    last.focus();

    await act(async () => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true }));
    });
    expect(document.activeElement).toBe(focusables[0]);
  });

  it('gives every drawer row a touch-sized height (min-h-12 = 48px ≥ 44px)', () => {
    // jsdom has no layout engine, so the guarantee is asserted through the
    // mechanism: each row either carries min-h-12 itself or sits in a
    // min-h-12 group row, and the disclosure button is w-11 (44px) wide.
    const { host } = renderSidebar({
      currentPath: '/dashboard',
      mobileOpen: true,
      onMobileOpenChange: () => undefined,
    });
    const rows = [...host.querySelectorAll<HTMLElement>('#app-mobile-nav .app-nav-item')];
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      const sized =
        row.className.includes('min-h-12') ||
        Boolean(row.parentElement?.className.includes('min-h-12'));
      expect(sized, row.textContent ?? 'row').toBe(true);
    }

    const toggles = [...host.querySelectorAll<HTMLElement>('#app-mobile-nav .app-nav-item-toggle')];
    expect(toggles.length).toBeGreaterThan(0);
    for (const toggle of toggles) {
      expect(toggle.className).toContain('w-11');
      expect(toggle.className).toContain('min-h-12');
    }
  });
});

describe('page search', () => {
  it('filters destinations, force-opens the matching group, and restores on clear', async () => {
    const navigated: string[] = [];
    const { host } = renderSidebar({ currentPath: '/dashboard', onNavigate: path => navigated.push(path) });

    const input = byTestId(host, 'nav-search-input-desktop') as HTMLInputElement;
    expect(input).not.toBeNull();

    await type(input, 'family');
    await waitFor(() => allItems(host).length < 33, 'the filtered list');

    const visible = allItems(host).map(item => item.textContent);
    expect(visible).toContain('Families & Cards');
    expect(visible).not.toContain('Attendance');
    // The group holding the match is opened so the match is reachable.
    expect(byTestId(host, 'nav-group-families-toggle')?.getAttribute('aria-expanded')).toBe('true');

    await click(byTestId(host, 'nav-item-families-browse'));
    expect(navigated).toEqual(['/admin/family-ids']);

    await type(input, '');
    await waitFor(() => allItems(host).length === 33, 'the restored list');
  });

  it('reports an empty result instead of an empty menu', async () => {
    const { host } = renderSidebar();
    const input = byTestId(host, 'nav-search-input-desktop') as HTMLInputElement;
    await type(input, 'zzzz-no-such-page');

    await waitFor(() => Boolean(host.querySelector('[role="status"]')), 'the empty state');
    expect(host.querySelector('[role="status"]')?.textContent).toBe('No pages found');
  });

  it('focuses the search field when the shell asks it to', async () => {
    const { host } = renderSidebar({ focusSearchSignal: 1 });
    await waitFor(() => document.activeElement === byTestId(host, 'nav-search-input-desktop'), 'search focus');
    expect(document.activeElement).toBe(byTestId(host, 'nav-search-input-desktop'));
  });
});

describe('account area', () => {
  it('opens an account panel with profile, role, theme and language', async () => {
    const { host } = renderSidebar();

    const trigger = byTestId(host, 'account-trigger-desktop');
    expect(trigger?.getAttribute('aria-expanded')).toBe('false');

    await click(trigger);
    const panel = host.querySelector('#app-account-menu');
    expect(panel?.textContent).toContain('Amina Yusuf');
    expect(panel?.textContent).toContain('Admin');
    expect(panel?.querySelector('select')).not.toBeNull(); // theme
    expect(panel?.querySelector('.app-language-inline')).not.toBeNull(); // language

    await act(async () => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });
    expect(host.querySelector('#app-account-menu')).toBeNull();
  });

  it('closes the account panel when the page changes', async () => {
    const { host } = renderShell({ currentPath: '/dashboard' });
    await click(byTestId(host, 'account-trigger-desktop'));
    expect(host.querySelector('#app-account-menu')).not.toBeNull();

    await click(byTestId(host, 'nav-item-directory'));
    expect(byTestId(host, 'nav-item-directory')?.getAttribute('aria-current')).toBe('page');
    expect(host.querySelector('#app-account-menu')).toBeNull();
  });

  it('keeps sign-out separate from the navigation list and wired to logout', async () => {
    const { host } = renderSidebar();
    const signOut = byTestId(host, 'signout-desktop');
    expect(signOut).not.toBeNull();
    expect(signOut?.closest('.app-sidebar-footer')).not.toBeNull();
    expect(signOut?.closest('.app-nav-list')).toBeNull();

    await click(signOut);
    expect(logoutSpy).toHaveBeenCalledTimes(1);
  });
});

describe('role filtering', () => {
  it('hides destinations a role may not open', () => {
    sessionRef.current = TEACHER;
    const { host } = renderSidebar();
    const labels = allItems(host).map(item => item.textContent);
    expect(labels).not.toContain('All Students');
    expect(labels).not.toContain('Dismissal Gate');
    expect(labels).toContain('My Classes');
    expect(labels).toContain('Upload Results');

    sessionRef.current = PARENT;
    const parent = renderSidebar();
    const parentLabels = allItems(parent.host).map(item => item.textContent);
    expect(parentLabels).toEqual([
      'Dashboard',
      'My Children',
      'Exam Results',
      'Monthly Reports',
      'Midterm Reports',
      'Final Reports',
      'Messages',
      'Streams',
      'Weekly Learning',
      'Take Quiz',
      'Pickup Card',
      'More',
    ]);
    parent.unmount();
  });

  it('never renders a destination the role cannot access', () => {
    for (const session of [ADMIN, TEACHER, PARENT]) {
      sessionRef.current = session;
      const { host, unmount } = renderSidebar({ currentPath: '/dashboard' });
      for (const item of allItems(host)) {
        const testid = item.dataset.testid!;
        const id = testid.replace('nav-item-', '');
        // A gated path must never be offered to a role that cannot open it.
        const gated: Record<string, string[]> = {
          'gate': ['admin', 'supervisor', 'office'],
          'academic-setup': ['admin'],
          'students-all': ['admin'],
          'class-import': ['admin'],
          'duplicate-students': ['admin'],
          'families-browse': ['admin', 'supervisor', 'office'],
          'families-setup': ['admin'],
          'drivers': ['admin', 'office'],
          'grade-corrections': ['admin'],
          'lesson-plans-review': ['admin'],
          'lesson-plan-submissions': ['admin'],
          'marks-monitor': ['admin'],
          'directory': ['admin', 'supervisor', 'office'],
        };
        const allowed = gated[id];
        if (allowed) expect(allowed, `${id} for ${session.role}`).toContain(session.role);
      }
      unmount();
    }
  });
});

describe('responsive contract', () => {
  it('shows the desktop column only at the sidebar breakpoint', () => {
    const { host } = renderSidebar();
    const wrapper = host.querySelector('.app-sidebar-shell');
    // Staff shell: the column appears at lg (1024px); below that the drawer does.
    expect(wrapper?.className).toContain('hidden');
    expect(wrapper?.className).toContain('lg:block');
    expect(wrapper?.className).not.toContain('md:block');
  });

  it('uses md for the parent shell, whose tablets get the column', () => {
    const { host } = renderSidebar({ breakpoint: 'md', mobileOpen: true, onMobileOpenChange: () => undefined });
    expect(host.querySelector('.app-sidebar-shell')?.className).toContain('md:block');
    expect(host.querySelector('[data-testid="mobile-drawer-root"]')?.className).toContain('md:hidden');
  });

  it('keeps the drawer hidden at the breakpoint where the column takes over', () => {
    const { host } = renderSidebar({ mobileOpen: true, onMobileOpenChange: () => undefined });
    expect(host.querySelector('[data-testid="mobile-drawer-root"]')?.className).toContain('lg:hidden');
  });

  it('does not render the drawer when the shell opts out of the mobile toggle', () => {
    // ParentAppShell: phone chrome + bottom navigation, so this component must
    // render ONLY the desktop column — no drawer, no floating hamburger.
    const { host } = renderSidebar({ mobileToggle: false, mobileOpen: true, onMobileOpenChange: () => undefined });
    expect(host.querySelector('[data-testid="mobile-drawer-root"]')).toBeNull();
    expect(host.querySelector('[data-testid="mobile-menu-button"]')).toBeNull();
    expect(host.querySelector('#app-sidebar-nav')).not.toBeNull();
    // The desktop column is a <div> scroll area, so this component contributes
    // no <nav> of its own here — ParentAppShell keeps exactly one.
    expect(host.querySelectorAll('nav').length).toBe(0);
  });
});

describe('staff shell (DashboardLayout)', () => {
  function renderLayout() {
    function Layout() {
      return <DashboardLayout>{path => <p data-testid="page">{path}</p>}</DashboardLayout>;
    }
    return render(<Layout />);
  }

  it('opens the drawer from the top bar, navigates, and closes it again', async () => {
    const { host } = renderLayout();

    const burger = byTestId(host, 'mobile-menu-button');
    expect(burger?.getAttribute('aria-controls')).toBe('app-mobile-nav');

    await click(burger);
    expect(host.querySelector('#app-mobile-nav')).not.toBeNull();
    expect(document.body.style.overflow).toBe('hidden');

    await click(byTestId(host, 'nav-item-messages'));
    expect(byTestId(host, 'page')?.textContent).toBe('/messages');
    expect(host.querySelector('#app-mobile-nav')).toBeNull();
    expect(document.body.style.overflow).toBe('');
    // The top bar names the page you are on.
    expect(byTestId(host, 'mobile-page-title')?.textContent).toBe('Messages');
  });

  it('names the current page in the top bar, including a nested one', () => {
    // Deep link (notification click / cold PWA launch) straight into a group.
    window.history.pushState({}, '', '/admin/lesson-plans');
    const { host } = renderLayout();
    expect(byTestId(host, 'page')?.textContent).toBe('/admin/lesson-plans');
    expect(byTestId(host, 'mobile-page-title')?.textContent).toBe('Review Plans');
    // The group holding it is open, so the page is visible in the menu.
    expect(byTestId(host, 'nav-group-lesson-plans-toggle')?.getAttribute('aria-expanded')).toBe('true');
    window.history.pushState({}, '', '/');
  });

  it('puts Ctrl/Cmd+K in the page search without opening the drawer at desktop widths', async () => {
    // jsdom has no matchMedia; the shell treats that as "desktop", which is the
    // safe direction (never mount an invisible dialog over the column).
    const { host } = renderLayout();

    await act(async () => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', ctrlKey: true, bubbles: true }));
    });

    expect(host.querySelector('#app-mobile-nav')).toBeNull();
    await waitFor(
      () => document.activeElement === byTestId(host, 'nav-search-input-desktop'),
      'the page search to take focus',
    );
  });

  it('closes the drawer when the viewport grows into the desktop layout', async () => {
    // Minimal matchMedia stub so the shell can watch the breakpoint.
    const listeners = new Set<() => void>();
    const media = { matches: false, addEventListener: (_: string, fn: () => void) => listeners.add(fn), removeEventListener: () => undefined };
    Object.defineProperty(window, 'matchMedia', {
      configurable: true,
      value: (query: string) => (query.includes('1024') ? media : { matches: false, addEventListener: () => undefined, removeEventListener: () => undefined }),
    });

    try {
      const { host } = renderLayout();
      await click(byTestId(host, 'mobile-menu-button'));
      expect(host.querySelector('#app-mobile-nav')).not.toBeNull();

      media.matches = true;
      await act(async () => {
        for (const listener of listeners) listener();
      });

      expect(host.querySelector('#app-mobile-nav')).toBeNull();
      expect(document.body.style.overflow).toBe('');
    } finally {
      Object.defineProperty(window, 'matchMedia', { configurable: true, value: undefined });
    }
  });
});

describe('preferences', () => {
  it('remembers which groups the user opened, per role', async () => {
    const { host } = renderSidebar({ currentPath: '/dashboard' });
    await click(byTestId(host, 'nav-group-quizzes-toggle'));
    expect(JSON.parse(localStorage.getItem('mbk-nav-groups:admin') ?? '{}')).toEqual({ quizzes: true });

    // Another role starts from its own state — admin's choice is not inherited.
    sessionRef.current = TEACHER;
    const teacher = renderSidebar();
    expect(byTestId(teacher.host, 'nav-group-quizzes-toggle')?.getAttribute('aria-expanded')).toBe('false');
    expect(localStorage.getItem(`${NAV_GROUPS_KEY_PREFIX}teacher`)).toBeNull();

    await click(byTestId(teacher.host, 'nav-group-quizzes-toggle'));
    expect(byTestId(teacher.host, 'nav-group-quizzes-toggle')?.getAttribute('aria-expanded')).toBe('true');
    expect(JSON.parse(localStorage.getItem(`${NAV_GROUPS_KEY_PREFIX}teacher`) ?? '{}')).toEqual({ quizzes: true });
    expect(JSON.parse(localStorage.getItem(`${NAV_GROUPS_KEY_PREFIX}admin`) ?? '{}')).toEqual({ quizzes: true });
    teacher.unmount();
  });

  it('falls back to defaults when storage throws on every access', () => {
    // Safari private mode / a sandboxed iframe without allow-same-origin.
    const original = window.localStorage;
    const blocked: Storage = {
      getItem: () => {
        throw new Error('blocked');
      },
      setItem: () => {
        throw new Error('blocked');
      },
      removeItem: () => {
        throw new Error('blocked');
      },
      clear: () => undefined,
      key: () => null,
      length: 0,
    } as unknown as Storage;
    Object.defineProperty(window, 'localStorage', { configurable: true, value: blocked });

    try {
      expect(readSidebarCollapsed()).toBe(false);
      expect(() => writeSidebarCollapsed(true)).not.toThrow();
      expect(readNavGroupState('admin')).toEqual({});
      expect(() => writeNavGroupState('admin', { quizzes: true })).not.toThrow();
      // The active route still wins over the (unreadable) stored state.
      expect(resolveOpenGroups('admin', ['quizzes'], ['quizzes'])).toEqual({ quizzes: true });
    } finally {
      Object.defineProperty(window, 'localStorage', { configurable: true, value: original });
    }
  });

  it('still renders and toggles when reads throw but writes work', async () => {
    const original = window.localStorage;
    const getItem = vi.spyOn(window.localStorage, 'getItem').mockImplementation(() => {
      throw new Error('blocked');
    });

    try {
      const { host } = renderSidebar();
      expect(host.querySelector('#app-sidebar-nav')).not.toBeNull();
      await click(byTestId(host, 'sidebar-collapse-toggle'));
      expect(sidebarColumn(host)?.dataset.collapsed).toBe('true');
      expect(localStorage.getItem(SIDEBAR_COLLAPSED_KEY)).toBe('true');
    } finally {
      getItem.mockRestore();
      Object.defineProperty(window, 'localStorage', { configurable: true, value: original });
    }
  });
});
