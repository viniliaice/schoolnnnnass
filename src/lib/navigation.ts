// Sidebar navigation — the single source of truth for what each role sees.
//
// WHY THIS FILE EXISTS
// --------------------
// Sidebar.tsx used to carry a flat `navItems` list per role. Admin had 27
// rows, so every page was its own menu item and finding one meant scrolling
// the full height of the screen. This module keeps EXACTLY the same links —
// same paths, same per-role visibility — but organises them into a handful of
// collapsible sections plus a few "pinned" rows that stay visible at the top.
//
// __tests__/navigation.test.ts pins the pre-redesign path list per role, so
// dropping or re-routing a page from the menu fails the build.
//
// RULES
// -----
//  1. A path appears ONCE per role — either pinned or inside one section
//     (never both). The test suite enforces this.
//  2. Paths are never invented here. Every path must already be handled by
//     the matching `switch` in App.tsx and allowed by ROUTE_ACCESS.
//  3. `label` doubles as the i18n key: rendered as t(`nav.${label}`, label),
//     exactly like the old flat list. New labels need en + ar entries in
//     lib/i18n/AppLanguageContext.tsx.
//  4. Keep GROUP labels short (one word where possible). The column is 18rem
//     wide and the drawer is capped at 20rem, so a header like "Attendance &
//     Classwork" wraps onto two lines next to its icon, dot and chevron. The
//     rows inside carry the detail: 'Classroom' holds Record Attendance,
//     Assign Homework, Create Quiz and Grade Quizzes.
//  5. Section `id`s are stable across roles ('academic' means the same thing
//     for a teacher and an admin) because they are the localStorage keys for
//     the remembered expand/collapse state.

import {
  Activity,
  ArrowLeftRight,
  ArrowUpDown,
  Award,
  BarChart3,
  BellRing,
  BookOpen,
  BookOpenCheck,
  Calendar,
  CalendarCheck,
  CalendarRange,
  CarFront,
  ClipboardCheck,
  CreditCard,
  DatabaseBackup,
  FileBarChart,
  FileSpreadsheet,
  FileText,
  GitMerge,
  GraduationCap,
  HelpCircle,
  Layers,
  LayoutDashboard,
  ListChecks,
  Mail,
  NotepadText,
  Pencil,
  Settings,
  ShieldCheck,
  Users,
  type LucideIcon,
} from 'lucide-react';

import type { Role } from '../types';

export interface NavItem {
  /** English label; also the i18n key suffix (`nav.<label>`). */
  label: string;
  icon: LucideIcon;
  /** Route handled by App.tsx. Never rewritten by the sidebar redesign. */
  path: string;
}

export interface NavSection {
  /** Stable id, used as the expand/collapse state key. */
  id: string;
  /** English label; also the i18n key suffix (`nav.<label>`). */
  label: string;
  icon: LucideIcon;
  items: NavItem[];
}

export interface RoleNav {
  /** Always-visible rows rendered above the collapsible sections. */
  pinned: NavItem[];
  /** Collapsible groups, in display order. */
  sections: NavSection[];
}

/**
 * Menu per role.
 *
 * Grouping follows how the school actually works rather than the URL prefix:
 * students, academics, grades/exams, day-to-day classroom work, people,
 * transport & gate, communications, and admin-only tooling. Roles that do not
 * have pages for a group simply do not get the section — visibility is
 * unchanged from the old flat list.
 */
export const NAV: Record<Role, RoleNav> = {
  admin: {
    pinned: [
      { label: 'Dashboard', icon: LayoutDashboard, path: '/dashboard' },
      { label: 'Manage Students', icon: GraduationCap, path: '/admin/students' },
      { label: 'Manage Academic', icon: BookOpen, path: '/admin/academic' },
    ],
    sections: [
      {
        id: 'students',
        label: 'Students',
        icon: GraduationCap,
        items: [
          { label: 'Class Updates / Import', icon: ArrowLeftRight, path: '/admin/class-import' },
          { label: 'Promote Classes', icon: ArrowUpDown, path: '/admin/promotion' },
          // Merging duplicate student records is a student-record operation, so
          // it sits with the import and promotion tools rather than under
          // Administration.
          { label: 'Duplicate Students', icon: GitMerge, path: '/admin/duplicate-students' },
        ],
      },
      {
        id: 'academic',
        label: 'Academic',
        icon: BookOpen,
        items: [
          // Admin reviews lesson plans with the same rights as a supervisor.
          // "Submission Tracking" answers who has/hasn't submitted; "Lesson
          // Plans" is the review page itself.
          { label: 'Lesson Plans', icon: NotepadText, path: '/admin/lesson-plans' },
          { label: 'Submission Tracking', icon: ListChecks, path: '/admin/lesson-plan-submissions' },
          { label: 'Lesson Plan Upload', icon: CalendarRange, path: '/admin/lesson-planner' },
          { label: 'Unit Plans', icon: Layers, path: '/admin/unit-plans' },
          { label: 'Class Progress', icon: Calendar, path: '/admin/class-progress' },
        ],
      },
      {
        id: 'grades',
        label: 'Grades & Exams',
        icon: Award,
        items: [
          { label: 'Bulk Upload Grades', icon: FileSpreadsheet, path: '/admin/bulk-grades' },
          { label: 'Exam Verification', icon: ClipboardCheck, path: '/admin/exams' },
          { label: 'Grade Corrections', icon: Pencil, path: '/admin/grade-corrections' },
          { label: 'Exam Reports', icon: FileBarChart, path: '/admin/exam-reports' },
          // Tracks whether teachers have entered quiz / homework / CA marks.
          // It is marks data (not staff management), and `grades` exists for
          // both admin and supervisor, so the same page sits in the same-named
          // group for both roles.
          { label: 'Monitor Marks Entries', icon: BarChart3, path: '/admin/monitor-marks' },
        ],
      },
      {
        id: 'classroom',
        label: 'Classroom',
        icon: CalendarCheck,
        items: [
          { label: 'Record Attendance', icon: CalendarCheck, path: '/admin/attendance' },
          { label: 'Assign Homework', icon: BookOpenCheck, path: '/admin/homework' },
          { label: 'Create Quiz', icon: HelpCircle, path: '/admin/quizzes' },
          { label: 'Grade Quizzes', icon: ClipboardCheck, path: '/admin/grade-quizzes' },
        ],
      },
      {
        id: 'users',
        label: 'Users & Staff',
        icon: Users,
        items: [
          { label: 'Manage Users', icon: Users, path: '/admin/users' },
          { label: 'Monitor Teacher', icon: ClipboardCheck, path: '/admin/monitor' },
        ],
      },
      {
        id: 'transport',
        label: 'Transport',
        icon: CarFront,
        items: [
          { label: 'Family IDs', icon: CreditCard, path: '/admin/family-ids' },
          { label: 'Manage Drivers', icon: CarFront, path: '/admin/drivers' },
        ],
      },
      {
        id: 'communications',
        label: 'Communications',
        icon: BellRing,
        items: [
          { label: 'Announcements', icon: BellRing, path: '/admin/announcements' },
          { label: 'Messages', icon: Mail, path: '/messages' },
          { label: 'Streams', icon: Activity, path: '/streams' },
        ],
      },
      {
        id: 'administration',
        label: 'Administration',
        icon: Settings,
        items: [
          { label: 'Bulk Import', icon: DatabaseBackup, path: '/admin/bulk' },
          { label: 'AI Review Logs', icon: Activity, path: '/admin/ai-logs' },
        ],
      },
    ],
  },

  teacher: {
    pinned: [
      { label: 'Dashboard', icon: LayoutDashboard, path: '/dashboard' },
      { label: 'My Classes', icon: GraduationCap, path: '/teacher/students' },
    ],
    sections: [
      {
        id: 'academic',
        label: 'Academic',
        icon: BookOpen,
        items: [
          { label: 'Lesson Plans', icon: NotepadText, path: '/teacher/lesson-plans' },
          { label: 'Unit Plans', icon: Layers, path: '/teacher/unit-plans' },
        ],
      },
      {
        id: 'grades',
        label: 'Grades & Exams',
        icon: Award,
        items: [
          { label: 'Bulk Upload', icon: FileSpreadsheet, path: '/teacher/bulk-grades' },
          { label: 'My Submissions', icon: FileText, path: '/teacher/all-results' },
          { label: 'Exam Reports', icon: FileBarChart, path: '/teacher/exam-reports' },
        ],
      },
      {
        id: 'classroom',
        label: 'Classroom',
        icon: CalendarCheck,
        items: [
          { label: 'Record Attendance', icon: CalendarCheck, path: '/teacher/attendance' },
          { label: 'Assign Homework', icon: BookOpenCheck, path: '/teacher/homework' },
          { label: 'Create Quiz', icon: HelpCircle, path: '/teacher/quizzes' },
          { label: 'Grade Quizzes', icon: ClipboardCheck, path: '/teacher/grade-quizzes' },
        ],
      },
      {
        id: 'communications',
        label: 'Communications',
        icon: BellRing,
        items: [
          { label: 'Announcements', icon: BellRing, path: '/teacher/announcements' },
          { label: 'Messages', icon: Mail, path: '/messages' },
          { label: 'Streams', icon: Activity, path: '/streams' },
        ],
      },
    ],
  },

  parent: {
    pinned: [
      { label: 'Dashboard', icon: LayoutDashboard, path: '/dashboard' },
      { label: 'My Children', icon: Users, path: '/parent/children' },
    ],
    sections: [
      {
        id: 'reports',
        label: 'Reports',
        icon: FileBarChart,
        items: [
          { label: 'Exam Results', icon: BookOpen, path: '/parent/results' },
          { label: 'Monthly Reports', icon: Calendar, path: '/parent/monthly' },
          { label: 'Midterm Reports', icon: FileBarChart, path: '/parent/midterm' },
          { label: 'Final Reports', icon: Award, path: '/parent/final' },
        ],
      },
      {
        id: 'quizzes',
        label: 'Quizzes',
        icon: HelpCircle,
        items: [{ label: 'Take Quiz', icon: HelpCircle, path: '/parent/quizzes' }],
      },
      {
        id: 'communications',
        label: 'Communications',
        icon: Mail,
        items: [
          { label: 'Messages', icon: Mail, path: '/messages' },
          { label: 'Streams', icon: Activity, path: '/streams' },
        ],
      },
    ],
  },

  supervisor: {
    pinned: [
      { label: 'Dashboard', icon: LayoutDashboard, path: '/dashboard' },
      { label: 'My Classes', icon: GraduationCap, path: '/supervisor/students' },
      { label: 'Dismissal Gate', icon: ShieldCheck, path: '/gate' },
    ],
    sections: [
      {
        id: 'academic',
        label: 'Academic',
        icon: BookOpen,
        items: [
          // "Submission Tracking" answers who has/hasn't submitted this week;
          // "Lesson Plans" is the detailed review page.
          { label: 'Lesson Plans', icon: NotepadText, path: '/supervisor/lesson-plans' },
          { label: 'Submission Tracking', icon: ListChecks, path: '/supervisor/lesson-plan-submissions' },
          { label: 'Unit Plans', icon: Layers, path: '/supervisor/unit-plans' },
        ],
      },
      {
        id: 'grades',
        label: 'Grades & Exams',
        icon: Award,
        items: [
          { label: 'Exam Verifications', icon: ClipboardCheck, path: '/supervisor/verifications' },
          { label: 'Exam Reports', icon: FileBarChart, path: '/supervisor/reports' },
          { label: 'Monitor Marks Entries', icon: BarChart3, path: '/supervisor/monitor-marks' },
        ],
      },
      {
        id: 'classroom',
        label: 'Classroom',
        icon: CalendarCheck,
        items: [
          { label: 'Record Attendance', icon: CalendarCheck, path: '/supervisor/attendance' },
          { label: 'Assign Homework', icon: BookOpenCheck, path: '/supervisor/homework' },
          { label: 'Create Quiz', icon: HelpCircle, path: '/supervisor/quizzes' },
          { label: 'Grade Quizzes', icon: ClipboardCheck, path: '/supervisor/grade-quizzes' },
        ],
      },
      {
        id: 'transport',
        label: 'Transport',
        icon: CarFront,
        items: [
          { label: 'Family IDs', icon: CreditCard, path: '/admin/family-ids' },
          { label: 'Student Directory', icon: Users, path: '/directory' },
        ],
      },
      {
        id: 'communications',
        label: 'Communications',
        icon: Mail,
        items: [
          { label: 'Messages', icon: Mail, path: '/messages' },
          { label: 'Streams', icon: Activity, path: '/streams' },
        ],
      },
    ],
  },

  office: {
    pinned: [
      { label: 'Dashboard', icon: LayoutDashboard, path: '/dashboard' },
      { label: 'Dismissal Gate', icon: ShieldCheck, path: '/gate' },
    ],
    sections: [
      {
        id: 'transport',
        label: 'Transport',
        icon: CarFront,
        items: [
          { label: 'Family IDs', icon: CreditCard, path: '/admin/family-ids' },
          { label: 'Manage Drivers', icon: CarFront, path: '/admin/drivers' },
          { label: 'Student Directory', icon: Users, path: '/directory' },
        ],
      },
      {
        id: 'communications',
        label: 'Communications',
        icon: Mail,
        items: [
          { label: 'Messages', icon: Mail, path: '/messages' },
          { label: 'Streams', icon: Activity, path: '/streams' },
        ],
      },
    ],
  },
};

/** Every role, in the order the app renders them. Handy for tests/loops. */
export const NAV_ROLES: Role[] = ['admin', 'teacher', 'parent', 'supervisor', 'office'];

/**
 * Nav for a role, tolerant of an unexpected role value (NULL, casing or
 * whitespace drift, a role added before the office migration). Returns an
 * empty menu instead of crashing the sidebar — the caller decides whether to
 * warn.
 */
export function navForRole(role: Role | string | null | undefined): RoleNav {
  return NAV[role as Role] ?? { pinned: [], sections: [] };
}

/** Every path a role can reach from the sidebar (pinned + grouped). */
export function navPathsForRole(role: Role | string | null | undefined): string[] {
  const nav = navForRole(role);
  return [...nav.pinned, ...nav.sections.flatMap(section => section.items)].map(item => item.path);
}

/** Total number of menu rows a role would see if every section were open. */
export function navItemCount(role: Role | string | null | undefined): number {
  const nav = navForRole(role);
  return nav.pinned.length + nav.sections.reduce((total, section) => total + section.items.length, 0);
}

/** The section that owns `path`, or undefined for pinned/unknown paths. */
export function sectionIdForPath(role: Role | string | null | undefined, path: string): string | undefined {
  return navForRole(role).sections.find(section => section.items.some(item => item.path === path))?.id;
}

/**
 * The menu row that represents `path`.
 *
 * Exact match first, otherwise the deepest menu path that `path` is a child of
 * — '/admin/family-ids/setup' resolves to '/admin/family-ids', so a sub-page
 * reached *from* a menu row keeps that row highlighted and its group open
 * instead of leaving the sidebar with no idea where you are.
 */
export function activeNavPath(role: Role | string | null | undefined, path: string): string | undefined {
  const paths = navPathsForRole(role);
  if (paths.includes(path)) return path;
  let best: string | undefined;
  for (const candidate of paths) {
    if (path.startsWith(`${candidate}/`) && (!best || candidate.length > best.length)) best = candidate;
  }
  return best;
}

/** The section holding the row for `path` (child pages included). */
export function activeSectionId(role: Role | string | null | undefined, path: string): string | undefined {
  const resolved = activeNavPath(role, path);
  return resolved ? sectionIdForPath(role, resolved) : undefined;
}

/* ------------------------------------------------------------------ *
 * Remembered expand/collapse state
 * ------------------------------------------------------------------ */

/**
 * localStorage key. One object keyed by role, so an admin's choices never
 * leak into a teacher's menu on a shared device.
 */
export const NAV_STATE_KEY = 'school-nav-sections';

type StoredNavState = Record<string, string[]>;

function readStoredState(): StoredNavState {
  if (typeof window === 'undefined') return {};
  try {
    const raw = window.localStorage.getItem(NAV_STATE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as StoredNavState) : {};
  } catch {
    // Corrupt/private-mode storage must never white-screen the app.
    return {};
  }
}

/**
 * Section ids the user left open, or `null` when nothing is stored yet.
 *
 * `null` and `[]` mean different things: `[]` is a real choice ("I collapsed
 * everything"), so callers must not treat it as "first visit". Ids that no
 * longer exist (a renamed or removed section) are dropped on read.
 */
export function loadOpenSections(role: Role | string | null | undefined): string[] | null {
  if (typeof window === 'undefined') return null;
  const stored = readStoredState()[String(role)];
  if (!Array.isArray(stored)) return null;
  const known = new Set(navForRole(role).sections.map(section => section.id));
  return stored.filter((id): id is string => typeof id === 'string' && known.has(id));
}

/** Persist which sections are open for this role. */
export function saveOpenSections(role: Role | string | null | undefined, openIds: string[]): void {
  if (typeof window === 'undefined') return;
  try {
    const state = readStoredState();
    state[String(role)] = navForRole(role).sections
      .map(section => section.id)
      .filter(id => openIds.includes(id));
    window.localStorage.setItem(NAV_STATE_KEY, JSON.stringify(state));
  } catch {
    // Storage full or blocked — expand/collapse just won't be remembered.
  }
}

/**
 * First-visit default: only the group holding the current page is open, so a
 * freshly loaded sidebar is short instead of showing all 27 admin links.
 */
export function openSectionsForPath(role: Role | string | null | undefined, path: string): string[] {
  const id = activeSectionId(role, path);
  return id ? [id] : [];
}
