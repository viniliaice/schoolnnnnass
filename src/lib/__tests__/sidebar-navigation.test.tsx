// @vitest-environment jsdom
//
// Render tests for the grouped sidebar.
//
// navigation.test.ts pins WHAT the menu contains; these pin HOW it behaves:
//   * pinned rows are always visible, grouped rows only when their section
//     is open (the 27-link admin menu renders as 11 rows),
//   * clicking a header expands/collapses and the choice survives a remount,
//   * the section holding the current page opens itself and marks the row
//     with aria-current="page",
//   * rows still call onNavigate with the untouched path,
//   * the filter narrows long menus and clears back to the full menu,
//   * role visibility is unchanged (no admin tools on a teacher menu, …),
//   * an unexpected role renders the chrome instead of crashing,
//   * below `lg` the menu is a drawer that locks scroll and closes on Escape.
//
// Convention follows lesson-plan-review-week-filter.test.tsx: createRoot +
// act, no testing-library. RoleContext is mocked because Sidebar only reads
// the session from it (and lib/supabase throws without env vars).

import { beforeEach, describe, expect, it, vi } from 'vitest';

// React 19 requires this flag before act() will flush effects in jsdom.
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

const mocks = vi.hoisted(() => ({
  session: { current: null as { role: string; userId: string; userName: string } | null },
  logout: vi.fn(),
}));

vi.mock('../../context/RoleContext', () => ({
  useRole: () => ({
    session: mocks.session.current,
    logout: mocks.logout,
    login: vi.fn(),
    user: null,
    isLoggedIn: Boolean(mocks.session.current),
    loading: false,
    error: null,
  }),
}));

import { I18nProvider } from '../i18n/AppLanguageContext';
import { Sidebar } from '../../components/layout/Sidebar';
import { NAV_STATE_KEY } from '../navigation';
import type { Role } from '../../types';

const navigate = vi.fn();

let host: HTMLDivElement;
let root: Root;
let role: Role;
let currentPath: string;

async function renderSidebar() {
  await act(async () => {
    root.render(
      <I18nProvider>
        <Sidebar currentPath={currentPath} onNavigate={navigate} />
      </I18nProvider>,
    );
  });
}

/** Fresh mount of the desktop sidebar for a role. */
async function mount(as: Role, path = '/dashboard') {
  role = as;
  currentPath = path;
  mocks.session.current = { role: as, userId: 'u-1', userName: 'Ayaan Nuur' };
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  await renderSidebar();
  return host;
}

/** Move to another page without remounting (what DashboardLayout does). */
async function goTo(path: string) {
  currentPath = path;
  await renderSidebar();
}

/** Throw the tree away and mount it again — proves state came from storage. */
async function remount() {
  await act(async () => {
    root.unmount();
  });
  host.remove();
  await mount(role, currentPath);
}

/** The desktop sidebar (the drawer renders a second copy when open). */
const aside = () => host.querySelector('aside') as HTMLElement;
const row = (label: string) => aside().querySelector<HTMLButtonElement>(`button[title="${label}"]`);
const hasRow = (label: string) => Boolean(row(label));
const sectionToggle = (id: string) =>
  aside().querySelector<HTMLButtonElement>(`button[aria-controls="nav-section-${id}"]`);
const isOpen = (id: string) => sectionToggle(id)?.getAttribute('aria-expanded') === 'true';
const activeRow = () => aside().querySelector<HTMLButtonElement>('button[aria-current="page"]');
const navRowCount = () => aside().querySelectorAll('nav button').length;
const storedState = () => JSON.parse(window.localStorage.getItem(NAV_STATE_KEY) ?? '{}') as Record<string, string[]>;

async function click(element: Element | null) {
  expect(element, 'expected the element to exist').toBeTruthy();
  await act(async () => {
    (element as HTMLElement).click();
  });
}

async function setFilter(value: string) {
  const input = aside().querySelector('input[type="search"]') as HTMLInputElement;
  expect(input, 'expected the menu filter to exist').toBeTruthy();
  await act(async () => {
    // React tracks the value property, so the native setter has to be used
    // for the controlled input to see the change.
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;
    setter?.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

beforeEach(() => {
  navigate.mockClear();
  mocks.logout.mockClear();
  window.localStorage.clear();
  document.body.innerHTML = '';
  document.body.style.overflow = '';
  vi.restoreAllMocks();
});

describe('collapsed by default', () => {
  it('renders the admin menu as pinned rows + section headers, not 27 links', async () => {
    await mount('admin');
    expect(hasRow('Dashboard')).toBe(true);
    expect(hasRow('Manage Students')).toBe(true);
    expect(hasRow('Manage Academic')).toBe(true);
    // 3 pinned rows + 8 group headers
    expect(navRowCount()).toBe(11);
    // grouped pages are not in the DOM until their group is opened
    expect(hasRow('Manage Users')).toBe(false);
    expect(hasRow('AI Review Logs')).toBe(false);
    expect(hasRow('Family IDs')).toBe(false);
  });

  it('labels every group as collapsed with its page count', async () => {
    await mount('admin');
    expect(isOpen('administration')).toBe(false);
    expect(sectionToggle('grades')?.textContent).toContain('Grades & Exams');
    expect(sectionToggle('grades')?.textContent).toContain('4');
  });

  it('keeps short menus (office) free of the filter box', async () => {
    await mount('office');
    expect(aside().querySelector('input[type="search"]')).toBeNull();
    expect(hasRow('Dismissal Gate')).toBe(true); // pinned for gate staff
    expect(navRowCount()).toBe(4); // 2 pinned + 2 groups
  });

  it('gives long menus a filter box', async () => {
    await mount('admin');
    expect(aside().querySelector('input[type="search"]')).toBeTruthy();
  });

  it('lists a pinned page once — never again inside its group', async () => {
    await mount('admin');
    expect(aside().querySelectorAll('button[title="Manage Students"]').length).toBe(1);
    await click(sectionToggle('students'));
    expect(aside().querySelectorAll('button[title="Manage Students"]').length).toBe(1);
  });
});

describe('expand / collapse', () => {
  it('reveals a group\'s pages when its header is clicked', async () => {
    await mount('admin');
    await click(sectionToggle('administration'));
    expect(isOpen('administration')).toBe(true);
    expect(hasRow('Bulk Import')).toBe(true);
    expect(hasRow('AI Review Logs')).toBe(true);
  });

  it('hides them again on the second click', async () => {
    await mount('admin');
    await click(sectionToggle('administration'));
    await click(sectionToggle('administration'));
    expect(isOpen('administration')).toBe(false);
    expect(hasRow('AI Review Logs')).toBe(false);
  });

  it('remembers an opened group across remounts', async () => {
    await mount('admin');
    await click(sectionToggle('grades'));
    expect(storedState().admin).toContain('grades');

    await remount();
    expect(isOpen('grades')).toBe(true);
    expect(hasRow('Bulk Upload Grades')).toBe(true);
  });

  it('remembers a collapsed group across remounts', async () => {
    await mount('admin', '/admin/bulk-grades'); // grades opens itself
    expect(isOpen('grades')).toBe(true);

    await click(sectionToggle('grades'));
    expect(storedState().admin).not.toContain('grades');

    await remount();
    expect(isOpen('grades')).toBe(false);
    expect(hasRow('Bulk Upload Grades')).toBe(false);
  });

  it('stores state per role so one role never inherits another\'s menu', async () => {
    await mount('admin');
    await click(sectionToggle('grades'));
    await mount('teacher');
    expect(storedState().teacher ?? []).not.toContain('grades');
    expect(isOpen('grades')).toBe(false);

    await mount('admin');
    expect(isOpen('grades')).toBe(true);
  });
});

describe('current page', () => {
  it('opens the group that owns the page and marks the row as current', async () => {
    await mount('admin', '/admin/bulk-grades');
    expect(isOpen('grades')).toBe(true);
    expect(hasRow('Bulk Upload Grades')).toBe(true);
    expect(activeRow()?.getAttribute('title')).toBe('Bulk Upload Grades');
  });

  it('opens the new group when the user navigates elsewhere', async () => {
    await mount('admin', '/dashboard');
    expect(isOpen('transport')).toBe(false);

    await goTo('/admin/drivers');
    expect(isOpen('transport')).toBe(true);
    expect(activeRow()?.getAttribute('title')).toBe('Manage Drivers');
  });

  it('leaves an already-collapsed group alone until the path changes', async () => {
    await mount('admin', '/admin/exam-reports');
    await click(sectionToggle('grades')); // user collapses the active group
    expect(isOpen('grades')).toBe(false);

    await goTo('/admin/exam-reports'); // same page re-rendered
    expect(isOpen('grades')).toBe(false);
  });

  it('marks a pinned row as current without opening any group', async () => {
    await mount('teacher', '/teacher/students');
    expect(activeRow()?.getAttribute('title')).toBe('My Classes');
    expect(isOpen('academic')).toBe(false);
  });
});

describe('navigation is unchanged', () => {
  it('calls onNavigate with the grouped page\'s path', async () => {
    await mount('teacher');
    await click(sectionToggle('classroom'));
    await click(row('Record Attendance'));
    expect(navigate).toHaveBeenCalledWith('/teacher/attendance');
  });

  it('calls onNavigate from a pinned row too', async () => {
    await mount('parent');
    await click(row('My Children'));
    expect(navigate).toHaveBeenCalledWith('/parent/children');
  });

  it('reaches every admin page through at most one expand + one click', async () => {
    await mount('admin');
    for (const [section, label, path] of [
      ['students', 'Promote Classes', '/admin/promotion'],
      ['academic', 'Submission Tracking', '/admin/lesson-plan-submissions'],
      ['grades', 'Grade Corrections', '/admin/grade-corrections'],
      ['classroom', 'Grade Quizzes', '/admin/grade-quizzes'],
      ['users', 'Manage Users', '/admin/users'],
      ['transport', 'Family IDs', '/admin/family-ids'],
      ['communications', 'Announcements', '/admin/announcements'],
      ['administration', 'AI Review Logs', '/admin/ai-logs'],
    ] as const) {
      navigate.mockClear();
      await click(sectionToggle(section));
      await click(row(label));
      expect(navigate, `${label} should still open ${path}`).toHaveBeenCalledWith(path);
    }
  });
});

describe('filter box', () => {
  it('narrows the menu to matching pages across every group', async () => {
    await mount('admin');
    await setFilter('quiz');
    expect(hasRow('Create Quiz')).toBe(true);
    expect(hasRow('Grade Quizzes')).toBe(true);
    expect(hasRow('AI Review Logs')).toBe(false);
    expect(hasRow('Manage Students')).toBe(false); // pinned, but not matching
  });

  it('matches the translated label as well as the English one', async () => {
    window.localStorage.setItem('mbk-language', 'ar');
    await mount('admin');
    await setFilter('السائقين'); // "drivers" in Arabic
    // Rows are titled with the translated label in Arabic mode.
    expect(aside().querySelector('button[title="إدارة السائقين"]')).toBeTruthy();
    expect(aside().querySelector('button[title="إدارة المستخدمين"]')).toBeNull();
  });

  it('says so when nothing matches, and restores the menu when cleared', async () => {
    await mount('admin');
    await setFilter('zzzz');
    expect(aside().textContent).toContain('No menu items match your search.');
    await setFilter('');
    expect(navRowCount()).toBe(11);
  });

  it('navigates from a filtered row and clears the filter', async () => {
    await mount('admin');
    await setFilter('drivers');
    await click(row('Manage Drivers'));
    expect(navigate).toHaveBeenCalledWith('/admin/drivers');
    expect((aside().querySelector('input[type="search"]') as HTMLInputElement).value).toBe('');
  });
});

describe('role-based visibility', () => {
  it('shows a teacher no admin or gate pages', async () => {
    await mount('teacher');
    const text = aside().textContent ?? '';
    for (const forbidden of ['Manage Users', 'Family IDs', 'Dismissal Gate', 'Student Directory', 'Bulk Import']) {
      expect(text, `teacher menu should not offer ${forbidden}`).not.toContain(forbidden);
    }
    expect(hasRow('My Classes')).toBe(true);
  });

  it('shows a parent only their own pages', async () => {
    await mount('parent');
    expect(hasRow('My Children')).toBe(true);
    await click(sectionToggle('reports'));
    expect(hasRow('Final Reports')).toBe(true);
    await click(sectionToggle('quizzes'));
    navigate.mockClear();
    await click(row('Take Quiz'));
    expect(navigate).toHaveBeenCalledWith('/parent/quizzes');

    const text = aside().textContent ?? '';
    expect(text).not.toContain('Manage Students');
    expect(text).not.toContain('Dismissal Gate');
  });

  it('gives a supervisor the gate and directory but not driver management', async () => {
    await mount('supervisor');
    expect(hasRow('Dismissal Gate')).toBe(true);
    await click(sectionToggle('transport'));
    expect(hasRow('Student Directory')).toBe(true);
    expect(hasRow('Family IDs')).toBe(true);
    expect(aside().textContent).not.toContain('Manage Drivers');
  });

  it('gives office the gate tools and nothing else', async () => {
    await mount('office');
    await click(sectionToggle('transport'));
    expect(hasRow('Manage Drivers')).toBe(true);
    expect(hasRow('Family IDs')).toBe(true);
    expect(hasRow('Student Directory')).toBe(true);
    expect(aside().textContent).not.toContain('Manage Users');
    expect(aside().textContent).not.toContain('Exam Reports');
  });

  it('renders the chrome without crashing on an unexpected role', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    mocks.session.current = { role: 'headmaster', userId: 'u-9', userName: 'Unknown Role' };
    role = 'admin';
    currentPath = '/dashboard';
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    await renderSidebar();

    expect(navRowCount()).toBe(0);
    expect(aside().textContent).toContain('MBK International School');
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('unknown role'), 'headmaster');
  });

  it('renders nothing at all while signed out', async () => {
    mocks.session.current = null;
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    await renderSidebar();
    expect(host.querySelector('aside')).toBeNull();
    expect(host.textContent).toBe('');
  });
});

describe('mobile drawer', () => {
  const hamburger = () => host.querySelector<HTMLButtonElement>('button[aria-label="Open menu"]');
  const dialog = () => host.querySelector<HTMLElement>('[role="dialog"]');

  it('opens as a modal drawer that locks background scrolling', async () => {
    await mount('admin');
    expect(dialog()).toBeNull();
    await click(hamburger());
    expect(dialog()?.getAttribute('aria-modal')).toBe('true');
    expect(document.body.style.overflow).toBe('hidden');
  });

  it('closes on Escape and unlocks scrolling', async () => {
    await mount('admin');
    await click(hamburger());
    await act(async () => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    });
    expect(dialog()).toBeNull();
    expect(document.body.style.overflow).toBe('');
  });

  it('closes on the backdrop', async () => {
    await mount('admin');
    await click(hamburger());
    await click(dialog()?.parentElement?.querySelector('[aria-hidden="true"]') ?? null);
    expect(dialog()).toBeNull();
  });

  it('closes after a page is chosen', async () => {
    await mount('teacher');
    await click(hamburger());
    const drawerRow = dialog()?.querySelector<HTMLButtonElement>('button[title="My Classes"]');
    await click(drawerRow ?? null);
    expect(navigate).toHaveBeenCalledWith('/teacher/students');
    expect(dialog()).toBeNull();
  });

  it('keeps the drawer menu in step with the desktop one', async () => {
    await mount('admin');
    await click(sectionToggle('grades')); // expand on desktop
    await click(hamburger());
    expect(dialog()?.querySelector('button[title="Bulk Upload Grades"]')).toBeTruthy();
  });
});

describe('i18n', () => {
  it('translates group headers and rows in Arabic', async () => {
    window.localStorage.setItem('mbk-language', 'ar');
    await mount('admin');
    expect(sectionToggle('grades')?.textContent).toContain('الدرجات والاختبارات');
    await click(sectionToggle('grades'));
    expect(row('تصحيحات الدرجات')?.getAttribute('aria-current')).toBeNull();
    expect(aside().querySelectorAll('button[title="تصحيحات الدرجات"]').length).toBe(1);
  });

  it('flips the document direction for the Arabic menu', async () => {
    window.localStorage.setItem('mbk-language', 'ar');
    await mount('admin');
    expect(document.documentElement.dir).toBe('rtl');
  });
});
