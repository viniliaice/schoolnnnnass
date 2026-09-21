// @vitest-environment jsdom
//
// End-to-end sweep of the redesigned sidebar.
//
// No headless browser is available in this environment, so this is the closest
// substitute: it drives the REAL <App /> — real DashboardLayout, real Sidebar,
// the real per-role switch in App.tsx, the real ROUTE_ACCESS guard and the
// app's built-in preview backend (tests have no VITE_SUPABASE_* env, so
// lib/supabase serves its demo data) — and clicks EVERY sidebar row for EVERY
// role.
//
// Per row it asserts:
//   * the row exists in the menu (expanding its group first),
//   * aria-current moves onto the row that was clicked,
//   * <main> renders real content — not a blank screen, not the "Unknown role"
//     fallback, and not a silent fall-through to the role's dashboard,
//   * for every page with a known heading, that heading is actually on screen
//     (so a row cannot land on the wrong page),
//   * the fullscreen /gate route drops the chrome and its Back button returns.
//
// Only RoleContext is mocked (to choose the signed-in role) plus html5-qrcode
// (the gate scanner needs a camera). Everything else is the shipped app.

import { beforeEach, describe, expect, it, vi } from 'vitest';

// React 19 requires this flag before act() will flush effects in jsdom.
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
import { act } from 'react';
import type { ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';

const mocks = vi.hoisted(() => ({
  session: { current: null as { role: string; userId: string; userName: string } | null },
}));

vi.mock('../../context/RoleContext', () => ({
  RoleProvider: ({ children }: { children: React.ReactNode }) => children,
  useRole: () => ({
    session: mocks.session.current,
    isLoggedIn: Boolean(mocks.session.current),
    loading: false,
    error: null,
    login: async () => undefined,
    logout: async () => undefined,
    user: null,
  }),
}));

vi.mock('html5-qrcode', () => ({
  Html5Qrcode: class {
    start() {}
    stop() {}
    clear() {}
  },
}));

// Vitest resolves @react-pdf/renderer to its NODE build, whose
// <PDFDownloadLink> throws ("web specific API") on render. In a real browser
// Vite picks the web build, so this is a test-environment gap, not an app bug:
// stub only that component and keep the rest of the library real.
vi.mock('@react-pdf/renderer', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  type DownloadLinkChildren =
    | ReactNode
    | ((state: { loading: boolean; blob: null; url: null }) => ReactNode);
  return {
    ...actual,
    PDFDownloadLink: ({ children, fileName, className }: {
      children?: DownloadLinkChildren;
      fileName?: string;
      className?: string;
    }) => (
      <a href="#pdf" download={fileName} className={className}>
        {typeof children === 'function' ? children({ loading: false, blob: null, url: null }) : children}
      </a>
    ),
  };
});

import App from '../../App';
import { queryClient } from '../queryClient';
import { NAV_ROLES, navForRole } from '../navigation';
import type { Role } from '../../types';

/** Heading text each page renders — taken from the page components themselves. */
const PAGE_MARKERS: Record<string, string> = {
  '/admin/students': 'Manage Students',
  '/admin/class-import': 'Student Class Update',
  '/admin/academic': 'Academic Workspace',
  '/admin/lesson-plans': 'Lesson Plan Review',
  '/admin/lesson-plan-submissions': 'Lesson Plan Submission',
  '/admin/lesson-planner': 'Lesson Plan',
  '/admin/unit-plans': 'Unit Plans',
  '/admin/class-progress': 'Class Progress by Month',
  '/admin/bulk-grades': 'Bulk Upload Grades',
  '/admin/exams': 'Exam Verification Center',
  '/admin/grade-corrections': 'Grade Corrections',
  '/admin/exam-reports': 'Exam Reports',
  '/admin/attendance': 'Record Attendance',
  '/admin/homework': 'Assign Homework',
  '/admin/quizzes': 'Create Quiz',
  '/admin/grade-quizzes': 'Grade Quizzes',
  '/admin/users': 'Manage Users',
  '/admin/monitor': 'Monitor Teacher Entries',
  '/admin/family-ids': 'Family IDs',
  '/admin/drivers': 'Manage Drivers',
  '/admin/announcements': 'Class Announcement Board',
  '/admin/promotion': 'Class Promotion',
  '/admin/bulk': 'Bulk Import',
  '/admin/ai-logs': 'AI Review Monitoring',
  '/messages': 'Secure Messages',
  '/streams': 'Attendance & Homework Streams',
  '/directory': 'Student Directory',
  '/teacher/students': 'My Classes',
  '/teacher/bulk-grades': 'Bulk Upload Grades',
  '/teacher/all-results': 'My Submissions',
  '/teacher/exam-reports': 'Exam Reports',
  '/teacher/announcements': 'Class Announcement Board',
  '/teacher/attendance': 'Record Attendance',
  '/teacher/homework': 'Assign Homework',
  '/teacher/quizzes': 'Create Quiz',
  '/teacher/grade-quizzes': 'Grade Quizzes',
  '/teacher/unit-plans': 'Unit Plans',
  '/supervisor/students': 'My Classes',
  '/supervisor/lesson-plans': 'Lesson Plan Review',
  '/supervisor/lesson-plan-submissions': 'Lesson Plan Submission',
  '/supervisor/unit-plans': 'Unit Plans',
  '/supervisor/verifications': 'Exam Verification Center',
  '/supervisor/reports': 'Exam Reports',
  '/supervisor/attendance': 'Record Attendance',
  '/supervisor/homework': 'Assign Homework',
  '/supervisor/quizzes': 'Create Quiz',
  '/supervisor/grade-quizzes': 'Grade Quizzes',
  '/parent/children': 'My Children',
  '/parent/results': 'Exam Results',
  '/parent/quizzes': 'Quizzes',
  // main unified the three parent report pages into one <ExamResults> with an
  // initialTab, so the heading is shared and the tab proves which page opened.
  '/parent/monthly': 'Exam Results',
  '/parent/midterm': 'Exam Results',
  '/parent/final': 'Exam Results',
  // Added to main after the redesign (PR #62).
  '/admin/duplicate-students': 'Duplicate Students',
  '/admin/monitor-marks': 'Monitor Marks Entries',
  '/supervisor/monitor-marks': 'Monitor Marks Entries',
};

/** Report tab that must be selected for the unified Exam Results paths. */
const PAGE_TABS: Record<string, string> = {
  '/parent/monthly': 'results-tab-monthly',
  '/parent/midterm': 'results-tab-midterm',
  '/parent/final': 'results-tab-final',
};

let host: HTMLDivElement;
let root: Root;

const main = () => document.querySelector('main');
const mainText = () => (main()?.textContent ?? '').replace(/\s+/g, ' ').trim();
const sidebar = () => host.querySelector('aside');
const rowFor = (label: string) => sidebar()?.querySelector<HTMLButtonElement>(`button[title="${label}"]`) ?? null;
const litRow = () => sidebar()?.querySelector<HTMLButtonElement>('button[aria-current="page"]') ?? null;

async function flush() {
  await act(async () => {
    await new Promise(resolve => setTimeout(resolve, 0));
  });
}

/** Flush until the page text stops changing (at least `min` rounds). */
async function settle(min = 4, max = 80) {
  let previous = '';
  let stable = 0;
  for (let i = 0; i < max; i++) {
    await flush();
    const now = mainText();
    stable = i >= min && now === previous ? stable + 1 : 0;
    previous = now;
    if (stable >= 2) return;
  }
}

async function click(element: HTMLElement | null) {
  if (!element) throw new Error('nothing to click');
  await act(async () => {
    element.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
}

async function mountApp(role: Role) {
  mocks.session.current = { role, userId: `${role}-1`, userName: 'Audit User' };
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root.render(<App />);
  });
  await settle();
  return host;
}

async function unmountApp() {
  await act(async () => {
    root.unmount();
  });
  host.remove();
}

/** Open the group that holds `label` (if it is grouped) and return its row. */
async function openRow(label: string, sectionId?: string) {
  let row = rowFor(label);
  if (!row && sectionId) {
    const header = sidebar()?.querySelector<HTMLButtonElement>(
      `button[aria-controls="nav-section-${sectionId}"]`,
    );
    if (!header) throw new Error(`no group header for "${sectionId}" (looking for "${label}")`);
    if (header.getAttribute('aria-expanded') !== 'true') await click(header);
    row = rowFor(label);
  }
  if (!row) throw new Error(`sidebar has no row labelled "${label}"`);
  return row;
}

beforeEach(() => {
  // App uses the module-level query client, so each test starts from a cold
  // cache instead of inheriting the previous test's pages.
  queryClient.clear();
  document.body.innerHTML = '';
  document.body.style.overflow = '';
  window.localStorage.clear();
});

describe('every sidebar row opens its page', () => {
  for (const role of NAV_ROLES) {
    it(
      `${role}: all ${navForRole(role).pinned.length + navForRole(role).sections.length} top-level rows work`,
      async () => {
        await mountApp(role);
        const dashboardText = mainText();
        expect(dashboardText.length, `${role} dashboard rendered blank`).toBeGreaterThan(40);

        const nav = navForRole(role);
        const rows = [
          ...nav.pinned.map(item => ({ ...item, section: undefined as string | undefined })),
          ...nav.sections.flatMap(section => section.items.map(item => ({ ...item, section: section.id }))),
        ];

        for (const target of rows) {
          const row = await openRow(target.label, target.section);
          await click(row);

          if (target.path === '/gate') {
            // Fullscreen route: DashboardLayout renders it without any chrome.
            await settle();
            expect(sidebar(), '/gate must render without the sidebar').toBeNull();
            expect(mainText()).toContain('Back');
            const back = [...(main()?.querySelectorAll('button') ?? [])].find(button =>
              button.textContent?.includes('Back'),
            );
            await click(back ?? null);
            await settle();
            expect(sidebar(), 'the gate Back button must restore the sidebar').not.toBeNull();
            continue;
          }

          // The row that was clicked is now the current page…
          await settle();
          expect(litRow()?.getAttribute('title'), `${role} → ${target.path} did not highlight its row`)
            .toBe(target.label);

          // …and <main> shows a real page rather than nothing / the fallback.
          const text = mainText();
          expect(text.length, `${role} → ${target.path} rendered a blank page`).toBeGreaterThan(40);
          expect(text, `${role} → ${target.path} hit the "Unknown role" fallback`).not.toContain('Unknown role');
          if (target.path === '/dashboard') {
            expect(text, `${role} → /dashboard did not return to the dashboard`).toBe(dashboardText);
          } else {
            // A path App.tsx does not handle falls through to `default:` and
            // silently re-renders the dashboard — that is the 404-equivalent
            // this catches.
            expect(text, `${role} → ${target.path} fell through to the dashboard`).not.toBe(dashboardText);
          }
          const marker = PAGE_MARKERS[target.path];
          if (marker) {
            expect(text, `${role} → ${target.path} did not render "${marker}"`).toContain(marker);
          }
          const tab = PAGE_TABS[target.path];
          if (tab) {
            expect(
              main()?.querySelector('[role="tab"][aria-selected="true"]')?.getAttribute('data-testid'),
              `${role} → ${target.path} opened the wrong Exam Results tab`,
            ).toBe(tab);
          }
        }
      },
      240_000,
    );
  }
});

describe('audit workflow: Dashboard → Students → Academic → Lesson Plans → Exam Reports → Administration', () => {
  it('walks an admin through every group in the brief without losing the menu', async () => {
    await mountApp('admin');
    expect(mainText()).toContain('Admin Dashboard');

    // Students group → Manage Students
    await click(await openRow('Class Updates / Import', 'students'));
    await settle();
    expect(mainText()).toContain('Student Class Update');

    await click(rowFor('Manage Students')); // pinned, always visible
    await settle();
    expect(mainText()).toContain('Manage Students');
    expect(litRow()?.getAttribute('title')).toBe('Manage Students');

    // Academic group → Academic Workspace → Lesson Plans
    await click(rowFor('Manage Academic')); // pinned
    await settle();
    expect(mainText()).toContain('Academic Workspace');

    await click(await openRow('Lesson Plans', 'academic'));
    await settle();
    expect(mainText()).toContain('Lesson Plan Review');
    expect(sidebar()?.querySelector('button[aria-controls="nav-section-academic"]')?.getAttribute('aria-expanded'))
      .toBe('true');

    // Grades group → Exam Reports
    await click(await openRow('Exam Reports', 'grades'));
    await settle();
    expect(mainText()).toContain('Exam Reports');

    // There is no Settings page in this app; Administration holds the
    // system/admin tools (Bulk Import, AI Review Logs).
    await click(await openRow('AI Review Logs', 'administration'));
    await settle();
    expect(mainText()).toContain('AI Review Monitoring');

    // Both groups visited along the way stayed open, and every visited row is
    // still reachable — the menu never lost its place.
    expect(sidebar()?.querySelector('button[aria-controls="nav-section-grades"]')?.getAttribute('aria-expanded'))
      .toBe('true');
    expect(sidebar()?.querySelector('button[aria-controls="nav-section-administration"]')?.getAttribute('aria-expanded'))
      .toBe('true');
    expect(litRow()?.getAttribute('title')).toBe('AI Review Logs');
    expect(rowFor('Dashboard')).not.toBeNull();
  }, 240_000);

  it('lands back on the dashboard after a reload, keeping the remembered groups', async () => {
    await mountApp('admin');
    await click(await openRow('Exam Reports', 'grades'));
    await settle();
    expect(mainText()).toContain('Exam Reports');

    // The app keeps `currentPath` in component state — there is no URL sync —
    // so a reload always restarts at /dashboard. The menu state, however, is
    // persisted and must come back with the group still open.
    await unmountApp();
    await mountApp('admin');
    expect(mainText()).toContain('Admin Dashboard');
    expect(sidebar()?.querySelector('button[aria-controls="nav-section-grades"]')?.getAttribute('aria-expanded'))
      .toBe('true');
    expect(rowFor('Exam Reports')).not.toBeNull();
    expect(litRow()?.getAttribute('title')).toBe('Dashboard');
  }, 240_000);
});
