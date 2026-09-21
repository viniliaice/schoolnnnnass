// @vitest-environment jsdom
//
// Guard rails for the grouped sidebar (lib/navigation.ts).
//
// The redesign was allowed to reorganise the menu, NOT to change what it
// points at. These tests pin that contract:
//   * every role keeps exactly the set of links it had before grouping,
//   * every one of those links is still rendered by that role's switch in
//     App.tsx (so no sidebar row can 404 / fall through to the dashboard),
//   * no link is offered to a role that ROUTE_ACCESS denies,
//   * a path appears once per role — pinned rows are not repeated in a group,
//   * every label has an en + ar translation,
//   * the remembered expand/collapse state round-trips per role.

import { readdirSync, readFileSync } from 'node:fs';
import { relative, resolve } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';

import {
  NAV,
  NAV_ROLES,
  NAV_STATE_KEY,
  activeNavPath,
  activeSectionId,
  loadOpenSections,
  navForRole,
  navItemCount,
  navPathsForRole,
  openSectionsForPath,
  saveOpenSections,
  sectionIdForPath,
} from '../navigation';
import { DEFAULT_ROUTE, canAccessRoute } from '../routing';
import type { Role } from '../../types';

const repoRoot = resolve(__dirname, '../../..');
const appSource = readFileSync(resolve(repoRoot, 'src/App.tsx'), 'utf8');
const i18nSource = readFileSync(resolve(repoRoot, 'src/lib/i18n/AppLanguageContext.tsx'), 'utf8');

/**
 * The flat menu exactly as it shipped before the redesign
 * (git show eb39772:src/components/layout/Sidebar.tsx → `navItems`).
 */
const PRE_REDESIGN_NAV: Record<Role, string[]> = {
  admin: [
    '/dashboard', '/admin/users', '/admin/students', '/admin/class-import', '/admin/academic',
    '/admin/unit-plans', '/admin/lesson-plan-submissions', '/admin/lesson-plans',
    '/admin/lesson-planner', '/admin/bulk', '/admin/bulk-grades', '/admin/announcements',
    '/messages', '/streams', '/admin/attendance', '/admin/homework', '/admin/quizzes',
    '/admin/grade-quizzes', '/admin/exams', '/admin/grade-corrections', '/admin/class-progress',
    '/admin/promotion', '/admin/monitor', '/admin/ai-logs', '/admin/exam-reports',
    '/admin/family-ids', '/admin/drivers',
  ],
  teacher: [
    '/dashboard', '/teacher/students', '/teacher/lesson-plans', '/teacher/unit-plans',
    '/teacher/bulk-grades', '/teacher/all-results', '/teacher/exam-reports',
    '/teacher/announcements', '/messages', '/streams', '/teacher/attendance',
    '/teacher/homework', '/teacher/quizzes', '/teacher/grade-quizzes',
  ],
  parent: [
    '/dashboard', '/parent/children', '/parent/results', '/parent/quizzes', '/parent/monthly',
    '/parent/midterm', '/parent/final', '/messages', '/streams',
  ],
  supervisor: [
    '/dashboard', '/supervisor/students', '/supervisor/lesson-plan-submissions',
    '/supervisor/lesson-plans', '/supervisor/unit-plans', '/supervisor/verifications',
    '/supervisor/reports', '/messages', '/streams', '/supervisor/attendance',
    '/supervisor/homework', '/supervisor/quizzes', '/supervisor/grade-quizzes', '/gate',
    '/admin/family-ids', '/directory',
  ],
  office: ['/dashboard', '/gate', '/admin/family-ids', '/admin/drivers', '/directory', '/messages', '/streams'],
};

/** The `session.role === '<role>'` block of App.tsx. */
function routeBlockFor(role: Role): string {
  const marker = `session.role === '${role}'`;
  const start = appSource.indexOf(marker);
  expect(start, `App.tsx has no route switch for ${role}`).toBeGreaterThan(-1);
  const next = appSource.indexOf("session.role === '", start + marker.length);
  return appSource.slice(start, next === -1 ? appSource.length : next);
}

/** Every `case '/path':` inside that role's switch. */
function routedPathsFor(role: Role): string[] {
  return [...routeBlockFor(role).matchAll(/case '([^']+)':/g)].map(match => match[1]);
}

/**
 * True when opening `path` as `role` renders a page rather than falling
 * through. Office has no explicit '/dashboard' case — its `default:` renders
 * OfficeDashboard, which is exactly where DEFAULT_ROUTE sends the role, so
 * the pinned Dashboard row still works. Every other role lists it explicitly.
 */
function rendersPath(role: Role, path: string): boolean {
  if (routedPathsFor(role).includes(path)) return true;
  return path === DEFAULT_ROUTE[role] && /default:\s*return\s*</.test(routeBlockFor(role));
}

/** `nav.*` keys declared in one language block of the i18n dictionaries. */
function navKeysForLanguage(language: 'en' | 'ar'): Set<string> {
  const dictionaries = i18nSource.slice(
    i18nSource.indexOf('const dictionaries'),
    i18nSource.indexOf('const directionByLanguage'),
  );
  const split = dictionaries.indexOf('\n  ar: {');
  expect(split, 'i18n dictionaries no longer have an en/ar split').toBeGreaterThan(-1);
  const block = language === 'en' ? dictionaries.slice(0, split) : dictionaries.slice(split);
  return new Set([...block.matchAll(/'nav\.([^']+)':/g)].map(match => match[1]));
}

/** Every label a role sees: pinned rows, section headers, grouped rows. */
function labelsFor(role: Role): string[] {
  const nav = navForRole(role);
  return [
    ...nav.pinned.map(item => item.label),
    ...nav.sections.flatMap(section => [section.label, ...section.items.map(item => item.label)]),
  ];
}

/**
 * Pages that reached `main` AFTER the redesign, so they are legitimately absent
 * from the snapshot above. Each was placed in the group matching what the page
 * does rather than appended to the end of a menu:
 *   /admin/duplicate-students  (PR #62) merge duplicate student records → Students
 *   /admin/monitor-marks       (PR #62) marks-entry completion → Grades & Exams
 *   /supervisor/monitor-marks  (PR #62) same page, supervisor scope → Grades & Exams
 * Keeping them in a separate list means the parity guard still fails if a
 * pre-redesign page disappears, instead of being quietly re-snapshotted.
 */
const POST_REDESIGN_ADDITIONS: Record<Role, string[]> = {
  admin: ['/admin/duplicate-students', '/admin/monitor-marks'],
  teacher: [],
  parent: [],
  supervisor: ['/supervisor/monitor-marks'],
  office: [],
};

describe('sidebar parity — grouping hid rows, it did not remove pages', () => {
  for (const role of NAV_ROLES) {
    it(`${role} keeps every pre-redesign link, plus the pages main added later`, () => {
      const expected = [...PRE_REDESIGN_NAV[role], ...POST_REDESIGN_ADDITIONS[role]];
      expect([...navPathsForRole(role)].sort()).toEqual([...expected].sort());
      expect(navItemCount(role)).toBe(expected.length);
    });
  }

  it('collapses the 29-link admin menu into 11 top-level rows', () => {
    const nav = navForRole('admin');
    expect(navItemCount('admin')).toBe(29);
    expect(nav.pinned.length + nav.sections.length).toBe(11);
  });

  it('files the pages main added inside a group instead of pinning them', () => {
    const admin = navForRole('admin');
    const students = admin.sections.find(section => section.id === 'students')!;
    const grades = admin.sections.find(section => section.id === 'grades')!;
    expect(students.items.map(item => item.path)).toContain('/admin/duplicate-students');
    expect(grades.items.map(item => item.path)).toContain('/admin/monitor-marks');
    const supervisorGrades = navForRole('supervisor').sections.find(section => section.id === 'grades')!;
    expect(supervisorGrades.items.map(item => item.path)).toContain('/supervisor/monitor-marks');
    // The two monitoring pages are marks data, so they live in the same-named
    // group for both roles rather than under "Users & Staff" for one of them.
    expect(admin.pinned.map(item => item.path)).not.toContain('/admin/monitor-marks');
  });

  it('keeps the collapsed menu short for every role', () => {
    for (const role of NAV_ROLES) {
      const nav = navForRole(role);
      expect(nav.pinned.length + nav.sections.length, role).toBeLessThanOrEqual(11);
      expect(nav.pinned.length, `${role} pins too many rows`).toBeLessThanOrEqual(3);
    }
  });
});

describe('every sidebar link still resolves', () => {
  for (const role of NAV_ROLES) {
    it(`${role}: each menu path is rendered by its App.tsx switch`, () => {
      for (const path of navPathsForRole(role)) {
        expect(rendersPath(role, path), `${role} menu links to ${path}, which App.tsx does not render`).toBe(true);
      }
    });
  }

  it('does not route any role to a path ROUTE_ACCESS denies it', () => {
    for (const role of NAV_ROLES) {
      for (const path of navPathsForRole(role)) {
        expect(canAccessRoute(role, path), `${role} → ${path}`).toBe(true);
      }
    }
  });

  it('keeps the dismissal gate and directory away from teachers and parents', () => {
    for (const role of ['teacher', 'parent'] as const) {
      expect(navPathsForRole(role)).not.toContain('/gate');
      expect(navPathsForRole(role)).not.toContain('/directory');
      expect(navPathsForRole(role)).not.toContain('/admin/family-ids');
      expect(navPathsForRole(role)).not.toContain('/admin/drivers');
    }
  });

  it('never shows teachers or parents an /admin/* page', () => {
    for (const role of ['teacher', 'parent'] as const) {
      expect(navPathsForRole(role).filter(path => path.startsWith('/admin/')), role).toEqual([]);
    }
  });

  it('limits office to the two /admin/* pages it is allowed to open', () => {
    expect(navPathsForRole('office').filter(path => path.startsWith('/admin/')).sort())
      .toEqual(['/admin/drivers', '/admin/family-ids']);
  });

  it('keeps supervisor off driver management (class-scoped RLS only)', () => {
    expect(navPathsForRole('supervisor')).not.toContain('/admin/drivers');
    expect(canAccessRoute('supervisor', '/admin/drivers')).toBe(false);
  });

  it('keeps admin-only tools out of every other menu', () => {
    for (const path of ['/admin/users', '/admin/class-import', '/admin/grade-corrections', '/admin/bulk', '/admin/ai-logs', '/admin/promotion']) {
      for (const role of ['teacher', 'parent', 'supervisor', 'office'] as const) {
        expect(navPathsForRole(role), `${role} should not see ${path}`).not.toContain(path);
      }
    }
  });
});

describe('menu shape', () => {
  it('lists each path once per role — pinned rows are not duplicated in a group', () => {
    for (const role of NAV_ROLES) {
      const paths = navPathsForRole(role);
      expect(new Set(paths).size, `${role} repeats a menu entry`).toBe(paths.length);
    }
  });

  it('gives every section a unique id, a label, an icon and at least one item', () => {
    for (const role of NAV_ROLES) {
      const ids = new Set<string>();
      for (const section of navForRole(role).sections) {
        expect(ids.has(section.id), `${role} reuses section id ${section.id}`).toBe(false);
        ids.add(section.id);
        expect(section.label, `${role}/${section.id}`).toBeTruthy();
        expect(section.icon, `${role}/${section.id} has no icon`).toBeTruthy();
        expect(section.items.length, `${role}/${section.id} is empty`).toBeGreaterThan(0);
      }
    }
  });

  it('pins Dashboard first for every role', () => {
    for (const role of NAV_ROLES) {
      expect(navForRole(role).pinned[0]?.path, role).toBe('/dashboard');
    }
  });

  // App.tsx has alias routes on purpose (/admin/academic and
  // /admin/class-subjects render the same AcademicWorkspace, and admin can open
  // the supervisor lesson-plan paths). Only one of each may appear in a menu,
  // otherwise the same page is listed twice under two names.
  it('never gives a role two rows that render the same page component', () => {
    for (const role of NAV_ROLES) {
      // Identity includes the props: main folded the parent report pages into
      // one <ExamResults initialTab=… />, so the same component with different
      // props is a different destination, while the same component with the
      // same props under two paths is a duplicated menu entry.
      const identityByPath = new Map<string, string>();
      for (const match of routeBlockFor(role).matchAll(/case '([^']+)':\s*return\s*<([A-Za-z0-9_]+)((?:[^>]|\n)*?)>/g)) {
        const props = match[3].replace(/\s+/g, ' ').trim();
        identityByPath.set(match[1], props ? `${match[2]} ${props}` : match[2]);
      }
      const seen = new Map<string, string>();
      for (const path of navPathsForRole(role)) {
        const identity = identityByPath.get(path);
        if (!identity) continue; // rendered by the switch's `default:` branch
        const previous = seen.get(identity);
        expect(previous, `${role}: ${path} and ${previous} both render ${identity}`).toBeUndefined();
        seen.set(identity, path);
      }
      expect(seen.size, `${role}: no menu row resolved to a component`).toBeGreaterThan(3);
    }
  });

  it('keeps the unified Exam Results tabs as four distinct parent destinations', () => {
    const tabs = [...routeBlockFor('parent').matchAll(/case '(\/parent\/[^']+)':\s*return\s*<ExamResults([^>]*)>/g)]
      .map(match => match[2].replace(/\s+/g, ' ').trim());
    expect(tabs.length, 'expected /parent/results plus the three report tabs').toBe(4);
    expect(new Set(tabs).size, 'each tab must render differently').toBe(4);
  });

  it('reuses the same section ids across roles so saved state is portable', () => {
    expect(sectionIdForPath('admin', '/admin/lesson-plans')).toBe('academic');
    expect(sectionIdForPath('teacher', '/teacher/lesson-plans')).toBe('academic');
    expect(sectionIdForPath('supervisor', '/supervisor/lesson-plans')).toBe('academic');
    expect(sectionIdForPath('admin', '/messages')).toBe('communications');
    expect(sectionIdForPath('parent', '/messages')).toBe('communications');
  });

  it('maps a grouped path to its section and leaves pinned paths unmapped', () => {
    expect(sectionIdForPath('admin', '/admin/bulk-grades')).toBe('grades');
    expect(sectionIdForPath('admin', '/dashboard')).toBeUndefined();
    expect(sectionIdForPath('admin', '/admin/students')).toBeUndefined(); // pinned
    expect(openSectionsForPath('teacher', '/teacher/quizzes')).toEqual(['classroom']);
    expect(openSectionsForPath('teacher', '/dashboard')).toEqual([]);
  });

  // The column is 18rem and the drawer caps at 20rem, so a long header wraps
  // onto two lines next to its icon, dot and chevron. 'Attendance & Classwork'
  // did exactly that — the group is now 'Classroom' and the rows inside carry
  // the detail. These guards keep the menu on one line per row.
  it('keeps group labels short enough for a 20rem drawer', () => {
    for (const role of NAV_ROLES) {
      for (const section of navForRole(role).sections) {
        expect(section.label.length, `${role}/${section.id} label "${section.label}" is too long`).toBeLessThanOrEqual(16);
      }
    }
  });

  it('keeps row labels short enough to fit one line', () => {
    for (const role of NAV_ROLES) {
      for (const item of [...navForRole(role).pinned, ...navForRole(role).sections.flatMap(s => s.items)]) {
        expect(item.label.length, `${role} row "${item.label}" is too long`).toBeLessThanOrEqual(24);
      }
    }
  });

  it('tolerates an unexpected role value instead of crashing', () => {
    expect(navForRole('headmaster')).toEqual({ pinned: [], sections: [] });
    expect(navForRole(null)).toEqual({ pinned: [], sections: [] });
    expect(navPathsForRole(undefined)).toEqual([]);
    expect(navItemCount('headmaster')).toBe(0);
    expect(sectionIdForPath('headmaster', '/dashboard')).toBeUndefined();
  });

  it('exposes a NAV entry for every role in the type union', () => {
    expect(Object.keys(NAV).sort()).toEqual(['admin', 'office', 'parent', 'supervisor', 'teacher']);
    expect(NAV_ROLES.sort()).toEqual(['admin', 'office', 'parent', 'supervisor', 'teacher']);
  });
});

describe('sub-pages resolve to their parent menu row', () => {
  it('maps a setup sub-page to its row and group', () => {
    expect(activeNavPath('admin', '/admin/family-ids/setup')).toBe('/admin/family-ids');
    expect(activeSectionId('admin', '/admin/family-ids/setup')).toBe('transport');
    expect(openSectionsForPath('admin', '/admin/family-ids/setup')).toEqual(['transport']);
  });

  it('returns an exact match unchanged', () => {
    expect(activeNavPath('teacher', '/teacher/quizzes')).toBe('/teacher/quizzes');
    expect(activeSectionId('teacher', '/teacher/quizzes')).toBe('classroom');
  });

  it('prefers the deepest matching parent', () => {
    expect(activeNavPath('admin', '/admin/family-ids/setup/print')).toBe('/admin/family-ids');
  });

  it('does not match a sibling that merely shares a prefix', () => {
    // '/admin/bulk' must never claim '/admin/bulk-grades'.
    expect(activeNavPath('admin', '/admin/bulk-grades')).toBe('/admin/bulk-grades');
    expect(activeNavPath('admin', '/admin/bulk/preview')).toBe('/admin/bulk');
    expect(activeNavPath('admin', '/admin/quizzes-draft')).toBeUndefined();
  });

  it('gives up on pages no row points at', () => {
    expect(activeNavPath('teacher', '/teacher/results')).toBeUndefined();
    expect(activeSectionId('teacher', '/teacher/results')).toBeUndefined();
    expect(activeNavPath('parent', '/admin/users')).toBeUndefined();
  });
});

describe('hard-coded shortcuts elsewhere in the app stay reachable', () => {
  // Dashboards and a few pages hard-code their own jump links (OfficeDashboard
  // TOOLS, the dashboard quick-action cards, the Family IDs setup button). They
  // are a second, informal navigation definition, so they must not drift away
  // from the sidebar: anything they link to has to be a real route AND either a
  // menu row or a sub-page of one.
  const ROUTE_PREFIX = /^\/(admin|teacher|parent|supervisor|dashboard|gate|directory|messages|streams)(\/|$)/;

  function hardcodedTargets(): Array<{ file: string; path: string }> {
    const found: Array<{ file: string; path: string }> = [];
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = resolve(dir, entry.name);
        if (entry.isDirectory()) {
          if (entry.name !== '__tests__') walk(full);
        } else if (entry.name.endsWith('.tsx')) {
          const source = readFileSync(full, 'utf8');
          for (const match of source.matchAll(/'(\/[a-z0-9\-/]+)'/g)) {
            if (ROUTE_PREFIX.test(match[1])) found.push({ file: relative(repoRoot, full), path: match[1] });
          }
        }
      }
    };
    walk(resolve(repoRoot, 'src/pages'));
    return found;
  }

  const targets = hardcodedTargets();

  // Parents are the one role whose primary navigation is not the staff sidebar:
  // main gives phones a bottom nav (PARENT_BOTTOM_NAV in ParentAppShell) whose
  // "More" tab is a hub for the secondary pages, and keeps the sidebar for
  // tablets/desktops only. So a parent page counts as reachable when the
  // sidebar OR those two surfaces link to it.
  function parentSurfacePaths(): string[] {
    return [
      'src/components/layout/ParentAppShell.tsx',
      'src/pages/parent/MorePage.tsx',
    ].flatMap(file => {
      const source = readFileSync(resolve(repoRoot, file), 'utf8');
      return [...source.matchAll(/'(\/[a-z0-9\-/]+)'/g)]
        .map(match => match[1])
        .filter(path => ROUTE_PREFIX.test(path));
    });
  }

  it('found the hard-coded jump links to check', () => {
    expect(targets.length).toBeGreaterThan(5);
    expect(targets.map(target => target.path)).toContain('/gate');
    expect(targets.map(target => target.path)).toContain('/admin/family-ids/setup');
  });

  it('reads the parent bottom nav and its More hub as real navigation surfaces', () => {
    const surfaces = parentSurfacePaths();
    expect(surfaces.length, 'expected the parent nav surfaces to be parsed').toBeGreaterThan(3);
    expect(surfaces).toContain('/parent/more');
    expect(surfaces).toContain('/parent/weekly-learning');
    // The escape hatch is parent-only: it must not swallow staff routes.
    expect(surfaces.some(path => path.startsWith('/admin')), 'parent surfaces leaked an admin path').toBe(false);
  });

  it('each one is rendered by some role and reachable from that sidebar', () => {
    const everyMenuPath = NAV_ROLES.flatMap(role => navPathsForRole(role));
    const parentSurfaces = parentSurfacePaths();
    const covers = (list: string[], path: string) =>
      list.some(entry => path === entry || path.startsWith(`${entry}/`));

    for (const target of targets) {
      const renderedBy = NAV_ROLES.filter(role => rendersPath(role, target.path));
      expect(renderedBy.length, `${target.file} links to ${target.path}, which no role renders`).toBeGreaterThan(0);

      const reachable =
        covers(everyMenuPath, target.path) ||
        (renderedBy.includes('parent') && covers(parentSurfaces, target.path));
      expect(
        reachable,
        `${target.file} links to ${target.path}, which no sidebar row reaches ` +
          `(and no parent bottom-nav/More surface either)`,
      ).toBe(true);
    }
  });
});


describe('menu labels are translated', () => {
  const en = navKeysForLanguage('en');
  const ar = navKeysForLanguage('ar');

  it('has an English and an Arabic string for every row and header', () => {
    for (const role of NAV_ROLES) {
      for (const label of labelsFor(role)) {
        expect(en.has(label), `missing en 'nav.${label}'`).toBe(true);
        expect(ar.has(label), `missing ar 'nav.${label}'`).toBe(true);
      }
    }
  });

  it('does not translate the same label to two different English strings', () => {
    const seen = new Map<string, string>();
    for (const role of NAV_ROLES) {
      for (const section of navForRole(role).sections) {
        for (const item of section.items) {
          const previous = seen.get(item.path);
          if (previous) expect(previous, `${item.path} is labelled two ways`).toBe(item.label);
          seen.set(item.path, item.label);
        }
      }
    }
  });
});

describe('remembered expand/collapse state', () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it('reports "nothing stored yet" so the caller can apply its default', () => {
    expect(loadOpenSections('admin')).toBeNull();
  });

  it('round-trips per role without leaking between roles', () => {
    saveOpenSections('admin', ['grades', 'transport']);
    saveOpenSections('teacher', ['classroom']);
    expect(loadOpenSections('admin')).toEqual(['grades', 'transport']);
    expect(loadOpenSections('teacher')).toEqual(['classroom']);
  });

  it('keeps "I collapsed everything" distinct from "first visit"', () => {
    saveOpenSections('admin', []);
    expect(loadOpenSections('admin')).toEqual([]);
    expect(loadOpenSections('teacher')).toBeNull();
  });

  it('drops section ids that no longer exist', () => {
    window.localStorage.setItem(NAV_STATE_KEY, JSON.stringify({ admin: ['grades', 'finance', 42, null] }));
    expect(loadOpenSections('admin')).toEqual(['grades']);
  });

  it('survives corrupt storage without throwing', () => {
    window.localStorage.setItem(NAV_STATE_KEY, '{not json');
    expect(loadOpenSections('admin')).toBeNull();
    expect(() => saveOpenSections('admin', ['grades'])).not.toThrow();
    expect(loadOpenSections('admin')).toEqual(['grades']);
  });

  it('defaults a first visit to just the group holding the current page', () => {
    expect(loadOpenSections('admin') ?? openSectionsForPath('admin', '/admin/drivers')).toEqual(['transport']);
    expect(loadOpenSections('admin') ?? openSectionsForPath('admin', '/dashboard')).toEqual([]);
  });
});
