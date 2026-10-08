// Central navigation configuration for the app sidebar.
//
// ONE definition per role (NAV_BY_ROLE) is consumed by:
//   1. <SidebarNav> — the desktop sidebar and the mobile drawer (same markup),
//   2. the sidebar page search,
//   3. the mobile top bar (current page title).
//
// Structure is intentionally two levels deep at most:
//   section  →  entry (item | group)  →  group items
//
// Sections are work areas ("People", "Academics", "Communication"), not
// database tables: a group collects pages a user thinks of together even when
// they live under different URL prefixes (e.g. Family IDs + Drivers + Staff).
//
// Access: every path still has to pass canAccessRoute() before it is rendered,
// so a mistake in this file can never expose a route the role guard denies.
// See src/lib/routing.ts for the route→role map and its SQL counterparts.

import type { LucideIcon } from 'lucide-react';
import {
  Activity,
  ArrowUpDown,
  Award,
  BadgeCheck,
  BellRing,
  BookOpen,
  BookOpenCheck,
  Bot,
  Calendar,
  CalendarCheck,
  CarFront,
  ClipboardCheck,
  ClipboardList,
  CreditCard,
  DatabaseBackup,
  Download,
  Eye,
  FileBarChart,
  FileSpreadsheet,
  FileText,
  FileUp,
  GitMerge,
  GraduationCap,
  HelpCircle,
  Layers,
  LayoutDashboard,
  ListChecks,
  Mail,
  Megaphone,
  NotepadText,
  Pencil,
  QrCode,
  ShieldCheck,
  Upload,
  UserCog,
  Users,
} from 'lucide-react';

import type { Role } from '../../types';
import { canAccessRoute } from '../../lib/routing';

export interface NavItem {
  /** Stable id — used for keys, search results and the active-trail lookup. */
  id: string;
  /** i18n key: `t(labelKey, fallback)`. */
  labelKey: string;
  /** English label — i18n fallback and the search index. */
  fallback: string;
  /** Route this entry opens (must exist in App.tsx). */
  path: string;
  icon: LucideIcon;
  /**
   * Extra paths that also count as "this page is open". Used for the legacy
   * deep links that open the same screen (e.g. the supervisor lesson-plan URL
   * for an admin, the old separate report URLs for parents) and for alias
   * routes that render the same page.
   */
  aliases?: string[];
  /** Extra search terms (synonyms users type but that the label lacks). */
  keywords?: string[];
}

export interface NavGroup {
  id: string;
  labelKey: string;
  fallback: string;
  icon: LucideIcon;
  items: NavItem[];
}

export type NavEntry = NavItem | NavGroup;

export interface NavSection {
  id: string;
  labelKey: string;
  fallback: string;
  entries: NavEntry[];
}

export function isNavGroup(entry: NavEntry): entry is NavGroup {
  return (entry as NavGroup).items !== undefined;
}

/** Flattened nav item — what the search works on and the title bar reads. */
export interface FlatNavItem extends NavItem {
  sectionId: string;
  sectionLabel: string;
  groupId?: string;
  groupLabel?: string;
}

const item = (
  id: string,
  labelKey: string,
  fallback: string,
  path: string,
  icon: LucideIcon,
  extra: Partial<Pick<NavItem, 'aliases' | 'keywords'>> = {},
): NavItem => ({ id, labelKey, fallback, path, icon, ...extra });

const group = (
  id: string,
  labelKey: string,
  fallback: string,
  icon: LucideIcon,
  items: NavItem[],
): NavGroup => ({ id, labelKey, fallback, icon, items });

// ── Shared entry builders ──────────────────────────────────────────────────
// Several pages exist for more than one role with a different URL prefix
// (teacher/supervisor quizzes, lesson-plan review, …). The builders keep the
// label + icon identical across roles so the same feature never appears under
// two different names.

const dashboard = (): NavItem =>
  item('dashboard', 'nav.Dashboard', 'Dashboard', '/dashboard', LayoutDashboard);

const gate = item('gate', 'nav.Dismissal Gate', 'Dismissal Gate', '/gate', ShieldCheck, {
  keywords: ['pickup', 'release', 'dismissal', 'gate', 'qr', 'family'],
});

const messages = item('messages', 'nav.Messages', 'Messages', '/messages', Mail, {
  keywords: ['chat', 'inbox', 'parent', 'contact'],
});

const streams = item('streams', 'nav.Streams', 'Streams', '/streams', Activity, {
  keywords: ['activity', 'feed', 'updates'],
});

const myClasses = (path: string, keywords: string[] = []): NavItem =>
  item('my-classes', 'nav.My Classes', 'My Classes', path, GraduationCap, { keywords });

const unitPlans = (path: string): NavItem =>
  item('unit-plans', 'nav.Unit Plans', 'Unit Plans', path, Layers, { keywords: ['curriculum', 'units'] });

const attendance = (path: string): NavItem =>
  item('attendance', 'nav.Attendance', 'Attendance', path, CalendarCheck, { keywords: ['present', 'absent', 'roll'] });

const homework = (path: string): NavItem =>
  item('homework', 'nav.Homework', 'Homework', path, BookOpenCheck, { keywords: ['assignment', 'classwork'] });

const quizGroup = (create: string, grade: string): NavGroup =>
  group('quizzes', 'nav.Quizzes', 'Quizzes', HelpCircle, [
    item('quiz-create', 'nav.Create Quiz', 'Create Quiz', create, HelpCircle, { keywords: ['question', 'test'] }),
    item('quiz-grade', 'nav.Grade Quizzes', 'Grade Quizzes', grade, ClipboardCheck, {
      keywords: ['score', 'mark', 'attempts'],
    }),
  ]);

const lessonPlanGroup = (review: string, submissions: string, create?: string): NavGroup =>
  group('lesson-plans', 'nav.Lesson Plans', 'Lesson Plans', NotepadText, [
    item('lesson-plan-review', 'nav.Review Plans', 'Review Plans', review, ClipboardCheck, {
      keywords: ['approve', 'revision', 'ai review'],
    }),
    item('lesson-plan-submissions', 'nav.Submission Tracking', 'Submission Tracking', submissions, ListChecks, {
      keywords: ['submitted', 'missing', 'reminder'],
    }),
    ...(create
      ? [item('lesson-plan-create', 'nav.Create Plans', 'Create Plans', create, NotepadText, {
          keywords: ['planner', 'new plan', 'upload plan'],
        })]
      : []),
  ]);

// ── Role navigation ────────────────────────────────────────────────────────

export const NAV_BY_ROLE: Record<Role, NavSection[]> = {
  admin: [
    {
      id: 'main',
      labelKey: 'nav.section.main',
      fallback: 'Main',
      entries: [dashboard(), gate],
    },
    {
      id: 'people',
      labelKey: 'nav.section.people',
      fallback: 'People',
      entries: [
        group('students', 'nav.Students', 'Students', GraduationCap, [
          item('students-all', 'nav.All Students', 'All Students', '/admin/students', Users, {
            keywords: ['roster', 'enrol', 'profile'],
          }),
          item('students-import', 'nav.Class Import', 'Class Import', '/admin/class-import', FileUp, {
            keywords: ['upload', 'spreadsheet', 'class update'],
          }),
          item('students-duplicates', 'nav.Duplicate Students', 'Duplicate Students', '/admin/duplicate-students', GitMerge, {
            keywords: ['merge', 'dup'],
          }),
          item('students-promotion', 'nav.Promote Classes', 'Promote Classes', '/admin/promotion', ArrowUpDown, {
            keywords: ['next year', 'promotion'],
          }),
        ]),
        item('academic-setup', 'nav.Academic Setup', 'Academic Setup', '/admin/academic', BookOpen, {
          // /admin/class-subjects renders the same Academic Workspace screen:
          // one entry instead of two doors to the same room.
          aliases: ['/admin/class-subjects'],
          keywords: ['subjects', 'terms', 'years', 'classes', 'curriculum'],
        }),
        item('directory', 'nav.Student Directory', 'Student Directory', '/directory', Users, {
          keywords: ['lookup', 'search student', 'read only'],
        }),
        group('families', 'nav.Family IDs', 'Family IDs', CreditCard, [
          item('families-browse', 'nav.Families & Cards', 'Families & Cards', '/admin/family-ids', CreditCard, {
            keywords: ['print', 'transport', 'pickup'],
          }),
          item('families-setup', 'nav.Generate & Setup', 'Generate & Setup', '/admin/family-ids/setup', QrCode, {
            keywords: ['import sheet', 'generator'],
          }),
        ]),
        item('drivers', 'nav.Drivers', 'Drivers', '/admin/drivers', CarFront, {
          keywords: ['transport', 'pickup', 'bus'],
        }),
        item('staff', 'nav.Staff Accounts', 'Staff Accounts', '/admin/users', UserCog, {
          keywords: ['users', 'teachers', 'roles', 'password', 'office'],
        }),
      ],
    },
    {
      id: 'academics',
      labelKey: 'nav.section.academics',
      fallback: 'Academics',
      entries: [
        lessonPlanGroup('/admin/lesson-plans', '/admin/lesson-plan-submissions', '/admin/lesson-planner'),
        unitPlans('/admin/unit-plans'),
        attendance('/admin/attendance'),
        homework('/admin/homework'),
        quizGroup('/admin/quizzes', '/admin/grade-quizzes'),
        group('exams', 'nav.Exams & Grades', 'Exams & Grades', FileBarChart, [
          item('exams-verify', 'nav.Verify Exams', 'Verify Exams', '/admin/exams', BadgeCheck, {
            keywords: ['approve', 'marks', 'entries'],
          }),
          item('grade-corrections', 'nav.Grade Corrections', 'Grade Corrections', '/admin/grade-corrections', Pencil, {
            keywords: ['fix grade', 'amend'],
          }),
          item('bulk-grades', 'nav.Bulk Upload Grades', 'Bulk Upload Grades', '/admin/bulk-grades', FileSpreadsheet, {
            keywords: ['excel', 'import', 'marks'],
          }),
          item('exam-reports', 'nav.Exam Reports', 'Exam Reports', '/admin/exam-reports', FileBarChart, {
            keywords: ['results', 'pdf', 'transcript'],
          }),
        ]),
      ],
    },
    {
      id: 'oversight',
      labelKey: 'nav.section.oversight',
      fallback: 'Oversight',
      entries: [
        item('class-progress', 'nav.Class Progress', 'Class Progress', '/admin/class-progress', Eye, {
          keywords: ['monthly', 'completion'],
        }),
        item('teacher-activity', 'nav.Teacher Activity', 'Teacher Activity', '/admin/monitor', Eye, {
          keywords: ['monitor', 'entries', 'supervision'],
        }),
        item('marks-monitor', 'nav.Marks Entry Monitor', 'Marks Entry Monitor', '/admin/monitor-marks', ClipboardList, {
          aliases: ['/supervisor/monitor-marks'],
          keywords: ['completion', 'missing marks', 'progress'],
        }),
        item('ai-logs', 'nav.AI Review Logs', 'AI Review Logs', '/admin/ai-logs', Bot, {
          keywords: ['lesson plan review', 'automation'],
        }),
      ],
    },
    {
      id: 'communication',
      labelKey: 'nav.section.communication',
      fallback: 'Communication',
      entries: [
        messages,
        streams,
        item('announcements', 'nav.Announcements', 'Announcements', '/admin/announcements', Megaphone, {
          keywords: ['class notice', 'broadcast'],
        }),
        item('teacher-notifications', 'nav.Teacher Notifications', 'Teacher Notifications', '/admin/teacher-notifications', BellRing, {
          keywords: ['push', 'reminder', 'send'],
        }),
      ],
    },
    {
      id: 'system',
      labelKey: 'nav.section.system',
      fallback: 'System',
      entries: [
        item('bulk-import', 'nav.Bulk Import', 'Bulk Import', '/admin/bulk', DatabaseBackup, {
          keywords: ['data', 'backup', 'import students'],
        }),
      ],
    },
  ],

  supervisor: [
    {
      id: 'main',
      labelKey: 'nav.section.main',
      fallback: 'Main',
      entries: [dashboard(), gate],
    },
    {
      id: 'teaching',
      labelKey: 'nav.section.teaching',
      fallback: 'Teaching',
      entries: [
        myClasses('/supervisor/students', ['students', 'roster']),
        lessonPlanGroup('/supervisor/lesson-plans', '/supervisor/lesson-plan-submissions'),
        unitPlans('/supervisor/unit-plans'),
        attendance('/supervisor/attendance'),
        homework('/supervisor/homework'),
        quizGroup('/supervisor/quizzes', '/supervisor/grade-quizzes'),
      ],
    },
    {
      id: 'exams',
      labelKey: 'nav.section.exams',
      fallback: 'Exams & Grades',
      entries: [
        item('exams-verify', 'nav.Verify Exams', 'Verify Exams', '/supervisor/verifications', BadgeCheck, {
          keywords: ['approve', 'marks', 'entries'],
        }),
        item('marks-monitor', 'nav.Marks Entry Monitor', 'Marks Entry Monitor', '/supervisor/monitor-marks', ClipboardList, {
          keywords: ['completion', 'missing marks', 'progress'],
        }),
        item('exam-reports', 'nav.Exam Reports', 'Exam Reports', '/supervisor/reports', FileBarChart, {
          keywords: ['results', 'pdf', 'transcript'],
        }),
      ],
    },
    {
      id: 'records',
      labelKey: 'nav.section.records',
      fallback: 'Records',
      entries: [
        item('directory', 'nav.Student Directory', 'Student Directory', '/directory', Users, {
          keywords: ['lookup', 'search student', 'read only'],
        }),
        item('families-browse', 'nav.Family IDs', 'Family IDs', '/admin/family-ids', CreditCard, {
          keywords: ['print', 'transport', 'pickup'],
        }),
      ],
    },
    {
      id: 'communication',
      labelKey: 'nav.section.communication',
      fallback: 'Communication',
      entries: [messages, streams],
    },
  ],

  teacher: [
    {
      id: 'main',
      labelKey: 'nav.section.main',
      fallback: 'Main',
      entries: [dashboard()],
    },
    {
      id: 'teaching',
      labelKey: 'nav.section.teaching',
      fallback: 'Teaching',
      entries: [
        myClasses('/teacher/students', ['students', 'roster']),
        item('lesson-plan-create', 'nav.Lesson Plans', 'Lesson Plans', '/teacher/lesson-plans', NotepadText, {
          keywords: ['planner', 'new plan', 'upload plan'],
        }),
        unitPlans('/teacher/unit-plans'),
        attendance('/teacher/attendance'),
        homework('/teacher/homework'),
        quizGroup('/teacher/quizzes', '/teacher/grade-quizzes'),
      ],
    },
    {
      id: 'grades',
      labelKey: 'nav.section.grades',
      fallback: 'Grades & Reports',
      entries: [
        item('upload-results', 'nav.Upload Results', 'Upload Results', '/teacher/results', Upload, {
          keywords: ['marks', 'enter grades', 'exam entry'],
        }),
        item('bulk-grades', 'nav.Bulk Upload Grades', 'Bulk Upload Grades', '/teacher/bulk-grades', FileSpreadsheet, {
          keywords: ['excel', 'import', 'marks'],
        }),
        item('my-submissions', 'nav.My Submissions', 'My Submissions', '/teacher/all-results', FileText, {
          keywords: ['results', 'history', 'sent'],
        }),
        item('exam-reports', 'nav.Exam Reports', 'Exam Reports', '/teacher/exam-reports', FileBarChart, {
          keywords: ['results', 'pdf', 'transcript'],
        }),
      ],
    },
    {
      id: 'communication',
      labelKey: 'nav.section.communication',
      fallback: 'Communication',
      entries: [
        messages,
        streams,
        item('announcements', 'nav.Announcements', 'Announcements', '/teacher/announcements', Megaphone, {
          keywords: ['class notice', 'broadcast'],
        }),
        item('notifications', 'nav.Notifications', 'Notifications', '/teacher/notifications', BellRing, {
          keywords: ['push', 'alerts', 'reminders'],
        }),
      ],
    },
    {
      id: 'system',
      labelKey: 'nav.section.system',
      fallback: 'System',
      entries: [
        item('install-app', 'nav.Install App', 'Install App', '/teacher/install', Download, {
          keywords: ['phone', 'pwa', 'offline'],
        }),
      ],
    },
  ],

  office: [
    {
      id: 'main',
      labelKey: 'nav.section.main',
      fallback: 'Main',
      entries: [dashboard(), gate],
    },
    {
      id: 'records',
      labelKey: 'nav.section.records',
      fallback: 'Records',
      entries: [
        item('families-browse', 'nav.Family IDs', 'Family IDs', '/admin/family-ids', CreditCard, {
          keywords: ['print', 'transport', 'pickup'],
        }),
        item('directory', 'nav.Student Directory', 'Student Directory', '/directory', Users, {
          keywords: ['lookup', 'search student', 'read only'],
        }),
        item('drivers', 'nav.Drivers', 'Drivers', '/admin/drivers', CarFront, {
          keywords: ['transport', 'pickup', 'bus'],
        }),
      ],
    },
    {
      id: 'communication',
      labelKey: 'nav.section.communication',
      fallback: 'Communication',
      entries: [messages, streams],
    },
  ],

  parent: [
    {
      id: 'main',
      labelKey: 'nav.section.main',
      fallback: 'Main',
      entries: [
        dashboard(),
        item('children', 'nav.My Children', 'My Children', '/parent/children', Users, {
          keywords: ['kids', 'family', 'attendance'],
        }),
      ],
    },
    {
      id: 'reports',
      labelKey: 'nav.section.reports',
      fallback: 'Reports',
      entries: [
        item('results', 'nav.Exam Results', 'Exam Results', '/parent/results', ClipboardList, {
          keywords: ['marks', 'grades', 'quiz'],
        }),
        item('results-monthly', 'nav.Monthly Reports', 'Monthly Reports', '/parent/monthly', Calendar),
        item('results-midterm', 'nav.Midterm Reports', 'Midterm Reports', '/parent/midterm', FileBarChart),
        item('results-final', 'nav.Final Reports', 'Final Reports', '/parent/final', Award),
      ],
    },
    {
      id: 'communication',
      labelKey: 'nav.section.communication',
      fallback: 'Communication',
      entries: [messages, streams],
    },
    {
      id: 'more',
      labelKey: 'nav.section.more',
      fallback: 'More',
      entries: [
        item('weekly-learning', 'nav.Weekly Learning', 'Weekly Learning', '/parent/weekly-learning', BookOpenCheck, {
          keywords: ['homework', 'this week'],
        }),
        item('take-quiz', 'nav.Take Quiz', 'Take Quiz', '/parent/quizzes', HelpCircle, {
          keywords: ['practice', 'test'],
        }),
        item('pickup-card', 'nav.Pickup Card', 'Pickup Card', '/parent/pickup-card', CreditCard, {
          keywords: ['gate', 'family id', 'qr'],
        }),
        item('more', 'nav.More', 'More', '/parent/more', HelpCircle, {
          keywords: ['settings', 'profile', 'language', 'appearance', 'install'],
        }),
      ],
    },
  ],
};

// ── Derived navigation ─────────────────────────────────────────────────────

/**
 * Role navigation with every entry the role may not open removed, empty groups
 * collapsed away. The per-role config above is already role-specific; this is
 * the defence-in-depth pass that keeps the menu and the route guard in sync if
 * someone adds a link to a guarded path.
 */
export function buildNavigation(role: Role): NavSection[] {
  const sections = NAV_BY_ROLE[role] ?? [];

  return sections
    .map(section => {
      const entries = section.entries
        .map(entry => {
          if (!isNavGroup(entry)) {
            return canAccessRoute(role, entry.path) ? entry : null;
          }
          const items = entry.items.filter(child => canAccessRoute(role, child.path));
          return items.length > 0 ? { ...entry, items } : null;
        })
        .filter((entry): entry is NavEntry => entry !== null);

      return { ...section, entries };
    })
    .filter(section => section.entries.length > 0);
}

/** Paths that identify an item: the route itself plus its aliases. */
export function itemPaths(item: NavItem): string[] {
  return [item.path, ...(item.aliases ?? [])];
}

/**
 * The item a path belongs to, if any. Exact match first, then the longest
 * prefix match, so `/admin/family-ids/setup/anything` still highlights the
 * setup page and a deep link to an aliased URL highlights its page too.
 */
export function findActiveItem(sections: NavSection[], path: string): FlatNavItem | null {
  const candidates: Array<{ flat: FlatNavItem; matched: string }> = [];

  for (const section of sections) {
    for (const entry of section.entries) {
      if (isNavGroup(entry)) {
        for (const child of entry.items) {
          for (const candidate of itemPaths(child)) {
            if (path === candidate || path.startsWith(`${candidate}/`)) {
              candidates.push({
                flat: {
                  ...child,
                  sectionId: section.id,
                  sectionLabel: section.fallback,
                  groupId: entry.id,
                  groupLabel: entry.fallback,
                },
                matched: candidate,
              });
            }
          }
        }
      } else {
        for (const candidate of itemPaths(entry)) {
          if (path === candidate || path.startsWith(`${candidate}/`)) {
            candidates.push({
              flat: { ...entry, sectionId: section.id, sectionLabel: section.fallback },
              matched: candidate,
            });
          }
        }
      }
    }
  }

  if (candidates.length === 0) return null;

  candidates.sort((a, b) => b.matched.length - a.matched.length);
  return candidates[0].flat;
}

/** Flat list of every destination a role can reach — used by the search. */
export function flattenNavigation(sections: NavSection[]): FlatNavItem[] {
  const flat: FlatNavItem[] = [];

  for (const section of sections) {
    for (const entry of section.entries) {
      if (isNavGroup(entry)) {
        for (const child of entry.items) {
          flat.push({
            ...child,
            sectionId: section.id,
            sectionLabel: section.fallback,
            groupId: entry.id,
            groupLabel: entry.fallback,
          });
        }
      } else {
        flat.push({ ...entry, sectionId: section.id, sectionLabel: section.fallback });
      }
    }
  }

  return flat;
}

/** Group ids that must be open for `path` to be visible. */
export function groupsForPath(sections: NavSection[], path: string): string[] {
  const active = findActiveItem(sections, path);
  return active?.groupId ? [active.groupId] : [];
}

/** Group ids present in a navigation tree (used for open-state persistence). */
export function groupIdsOf(sections: NavSection[]): string[] {
  const ids: string[] = [];
  for (const section of sections) {
    for (const entry of section.entries) {
      if (isNavGroup(entry)) ids.push(entry.id);
    }
  }
  return ids;
}

/**
 * Navigation filtered down to the items a search matched: keeps the section and
 * group headings of every hit (so results stay in context) and drops the rest.
 */
export function filterNavigationByMatches(sections: NavSection[], matchedIds: string[]): NavSection[] {
  const matched = new Set(matchedIds);

  return sections
    .map(section => {
      const entries = section.entries
        .map(entry => {
          if (!isNavGroup(entry)) return matched.has(entry.id) ? entry : null;
          const items = entry.items.filter(child => matched.has(child.id));
          return items.length > 0 ? { ...entry, items } : null;
        })
        .filter((entry): entry is NavEntry => entry !== null);

      return { ...section, entries };
    })
    .filter(section => section.entries.length > 0);
}

/**
 * Case-insensitive search over label, translation, path, keywords and the
 * section/group a page lives in. Returns the matching items in navigation
 * order, so results read like the menu.
 */
export function searchNavigation(
  items: FlatNavItem[],
  query: string,
  translate: (key: string, fallback: string) => string,
): FlatNavItem[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return items;

  const terms = needle.split(/\s+/).filter(Boolean);

  return items.filter(entry => {
    const haystack = [
      entry.fallback,
      translate(entry.labelKey, entry.fallback),
      entry.path,
      entry.sectionLabel,
      entry.groupLabel ?? '',
      ...(entry.keywords ?? []),
    ]
      .join(' ')
      .toLowerCase();

    return terms.every(term => haystack.includes(term));
  });
}

/** True when the sidebar should offer the page search (many destinations). */
export function shouldShowSearch(items: FlatNavItem[]): boolean {
  return items.length >= 12;
}

/** Section/group headings of a flattened item, for search result subtitles. */
export function breadcrumbFor(
  entry: FlatNavItem,
  sections: NavSection[],
  translate: (key: string, fallback: string) => string,
): string {
  const label = (id: string, scope: 'section' | 'group'): string => {
    for (const section of sections) {
      if (scope === 'section' && section.id === id) return translate(section.labelKey, section.fallback);
      for (const candidate of section.entries) {
        if (scope === 'group' && isNavGroup(candidate) && candidate.id === id) {
          return translate(candidate.labelKey, candidate.fallback);
        }
      }
    }
    return id;
  };

  const section = label(entry.sectionId, 'section');
  return entry.groupId ? `${section} · ${label(entry.groupId, 'group')}` : section;
}
