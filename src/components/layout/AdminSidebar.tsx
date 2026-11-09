import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Activity, ArrowLeftRight, ArrowUpDown, BarChart3, BellRing, BookOpen, BookOpenCheck,
  Bot, Calendar, CalendarCheck, CalendarRange, CarFront, ChevronDown, ClipboardCheck,
  CreditCard, DatabaseBackup, Eye, FileBarChart, FileCheck, FileSpreadsheet, FileUp, GitMerge,
  GraduationCap, HelpCircle, Layers, LayoutDashboard, ListChecks, LogOut, Mail, Megaphone,
  Menu, NotepadText, PanelLeftClose, PanelLeftOpen, Pencil, ShieldCheck, UserMinus, UserRoundX, Users, UsersRound, X,
  type LucideIcon,
} from 'lucide-react';
import { useRole } from '../../context/RoleContext';
import { ThemeSwitcher } from '../ui/ThemeSwitcher';
import { useI18n } from '../../lib/i18n/AppLanguageContext';
import { cn } from '../../utils/cn';
import logo from '../../../assets/logo.png';

// ─── Navigation model ────────────────────────────────────────────────────────
// Single source of truth for the ADMIN sidebar only. Every path must exist in
// the admin route switch in src/App.tsx; `adminSidebarInventory.test.tsx`
// asserts this file never drops or duplicates one of the original links.

export interface AdminNavItem {
  label: string;
  path: string;
  icon: LucideIcon;
}

export interface AdminNavGroup {
  id: string;
  /** i18n key for the category heading. */
  labelKey: string;
  /** English fallback for the category heading. */
  label: string;
  items: AdminNavItem[];
}

/** Items pinned above every group — Dashboard first, Manage Users beside it. */
export const ADMIN_STANDALONE_ITEMS: AdminNavItem[] = [
  { label: 'Dashboard', path: '/dashboard', icon: LayoutDashboard },
  // Pinned next to Dashboard, above the Students category (product request):
  // user/role management is a top-of-sidebar action, not buried in Administration.
  { label: 'Manage Users', path: '/admin/users', icon: UsersRound },
];

export const ADMIN_NAV_GROUPS: AdminNavGroup[] = [
  {
    id: 'students',
    labelKey: 'navGroup.students',
    label: 'Students',
    items: [
      { label: 'Manage Students', path: '/admin/students', icon: GraduationCap },
      { label: 'Duplicate Students', path: '/admin/duplicate-students', icon: GitMerge },
      { label: 'Class Updates / Import', path: '/admin/class-import', icon: ArrowLeftRight },
      // Former Students / Student Cleanup: the upload + review flow, then the
      // directory of students already marked as former (restore / history).
      // Same order and labels as the legacy admin nav in Sidebar.tsx, which
      // adminSidebarInventory.test.ts parses as the source of truth.
      { label: 'Student Cleanup', path: '/admin/student-cleanup', icon: FileUp },
      { label: 'Former Students', path: '/admin/former-students', icon: UserMinus },
      { label: 'Bulk Import', path: '/admin/bulk', icon: DatabaseBackup },
    ],
  },
  {
    id: 'academic',
    labelKey: 'navGroup.academic',
    label: 'Academic',
    items: [
      { label: 'Manage Academic', path: '/admin/academic', icon: BookOpen },
      { label: 'Record Attendance', path: '/admin/attendance', icon: CalendarCheck },
      { label: 'Assign Homework', path: '/admin/homework', icon: BookOpenCheck },
      { label: 'Class Progress', path: '/admin/class-progress', icon: Calendar },
      { label: 'Unit Plans', path: '/admin/unit-plans', icon: Layers },
      { label: 'Lesson Plans', path: '/admin/lesson-plans', icon: NotepadText },
      { label: 'Lesson Plan Upload', path: '/admin/lesson-planner', icon: CalendarRange },
      { label: 'Submission Tracking', path: '/admin/lesson-plan-submissions', icon: ListChecks },
    ],
  },
  {
    id: 'exams',
    labelKey: 'navGroup.exams',
    label: 'Exams & Marks',
    items: [
      { label: 'Create Quiz', path: '/admin/quizzes', icon: HelpCircle },
      { label: 'Grade Quizzes', path: '/admin/grade-quizzes', icon: ClipboardCheck },
      { label: 'Exam Verification', path: '/admin/exams', icon: FileCheck },
      { label: 'Monitor Marks Entries', path: '/admin/monitor-marks', icon: BarChart3 },
      { label: 'Grade Corrections', path: '/admin/grade-corrections', icon: Pencil },
      { label: 'Exam Reports', path: '/admin/exam-reports', icon: FileBarChart },
      { label: 'Bulk Upload Grades', path: '/admin/bulk-grades', icon: FileSpreadsheet },
    ],
  },
  {
    id: 'communication',
    labelKey: 'navGroup.communication',
    label: 'Communication',
    items: [
      { label: 'Messages', path: '/messages', icon: Mail },
      { label: 'Streams', path: '/streams', icon: Activity },
      { label: 'Announcements', path: '/admin/announcements', icon: Megaphone },
      { label: 'Teacher Notifications', path: '/admin/teacher-notifications', icon: BellRing },
    ],
  },
  {
    id: 'transport',
    labelKey: 'navGroup.transport',
    label: 'Transport & Operations',
    items: [
      { label: 'Dismissal Gate', path: '/gate', icon: ShieldCheck },
      { label: 'Family IDs', path: '/admin/family-ids', icon: CreditCard },
      { label: 'No-Parent Students', path: '/admin/family-ids/no-parent', icon: UserRoundX },
      { label: 'Manage Drivers', path: '/admin/drivers', icon: CarFront },
      { label: 'Student Directory', path: '/directory', icon: Users },
    ],
  },
  {
    id: 'administration',
    labelKey: 'navGroup.administration',
    label: 'Administration',
    items: [
      { label: 'Monitor Teacher', path: '/admin/monitor', icon: Eye },
      { label: 'Promote Classes', path: '/admin/promotion', icon: ArrowUpDown },
      { label: 'AI Review Logs', path: '/admin/ai-logs', icon: Bot },
    ],
  },
];

/** Every admin nav path, flattened — used by tests and the active-state lookup. */
export const ADMIN_NAV_PATHS: string[] = [
  ...ADMIN_STANDALONE_ITEMS.map(item => item.path),
  ...ADMIN_NAV_GROUPS.flatMap(group => group.items.map(item => item.path)),
];

/**
 * Active-route match: exact hit, or a nested page under the item's path
 * (e.g. /admin/family-ids/setup keeps "Family IDs" highlighted). The trailing
 * slash guard keeps look-alike prefixes apart (/admin/lesson-plans must NOT
 * match /admin/lesson-planner). Dashboard only matches exactly.
 */
export function isAdminRouteActive(currentPath: string, itemPath: string): boolean {
  if (currentPath === itemPath) return true;
  if (itemPath === '/dashboard') return false;
  return currentPath.startsWith(`${itemPath}/`);
}

/**
 * The single nav item that should be highlighted for `currentPath`.
 *
 * Longest match wins: `/admin/family-ids/no-parent` is nested under
 * `/admin/family-ids`, and prefix matching alone would light up BOTH the
 * Families item and the No-Parent item. Nested pages with no nav item of their
 * own (e.g. `/admin/family-ids/setup`) still highlight their parent.
 */
export function activeAdminNavPath(currentPath: string): string | null {
  const matches = ADMIN_NAV_PATHS.filter(path => isAdminRouteActive(currentPath, path));
  if (matches.length === 0) return null;
  return matches.reduce((best, path) => (path.length > best.length ? path : best));
}

/** The group that owns `currentPath`, if any — drives auto-expansion. */
export function groupIdForPath(currentPath: string): string | null {
  for (const group of ADMIN_NAV_GROUPS) {
    if (group.items.some(item => isAdminRouteActive(currentPath, item.path))) return group.id;
  }
  return null;
}

// ─── Collapse preference (desktop rail) ─────────────────────────────────────

const COLLAPSE_STORAGE_KEY = 'mbk-admin-sidebar-collapsed';

function readCollapsedPreference(): boolean {
  if (typeof window === 'undefined') return false;
  try {
    return window.localStorage.getItem(COLLAPSE_STORAGE_KEY) === '1';
  } catch {
    return false;
  }
}

function writeCollapsedPreference(collapsed: boolean) {
  try {
    window.localStorage.setItem(COLLAPSE_STORAGE_KEY, collapsed ? '1' : '0');
  } catch {
    /* private mode — preference simply won't persist */
  }
}

// ─── Component ───────────────────────────────────────────────────────────────

interface AdminSidebarProps {
  currentPath: string;
  onNavigate: (path: string) => void;
}

/**
 * The Admin-role sidebar (desktop + mobile drawer). Rendered by
 * DashboardLayout only for admin sessions via its `renderSidebar` prop —
 * every other role keeps the original shared Sidebar component untouched.
 *
 * Navigation goes through the SAME state-based routing contract as before
 * (DashboardLayout owns currentPath/history); no react-router involvement.
 */
export function AdminSidebar({ currentPath, onNavigate }: AdminSidebarProps) {
  const { session, logout } = useRole();
  const { t } = useI18n();
  const [mobileOpen, setMobileOpen] = useState(false);
  const [collapsed, setCollapsed] = useState<boolean>(readCollapsedPreference);
  const [openGroups, setOpenGroups] = useState<Set<string>>(
    () => new Set([groupIdForPath(currentPath)].filter((id): id is string => id !== null)),
  );
  const drawerRef = useRef<HTMLDivElement>(null);

  const handleNavigate = useCallback(
    (path: string) => {
      onNavigate(path);
      setMobileOpen(false);
    },
    [onNavigate],
  );

  // Keep the category that owns the active page expanded. Opening other
  // categories manually is never undone — we only ever ADD the active one.
  useEffect(() => {
    const id = groupIdForPath(currentPath);
    if (!id) return;
    setOpenGroups(previous => {
      if (previous.has(id)) return previous;
      const next = new Set(previous);
      next.add(id);
      return next;
    });
  }, [currentPath]);

  const toggleGroup = useCallback((id: string) => {
    setOpenGroups(previous => {
      const next = new Set(previous);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const toggleCollapsed = useCallback(() => {
    setCollapsed(previous => {
      writeCollapsedPreference(!previous);
      return !previous;
    });
  }, []);

  // Drawer lifecycle: lock page scroll behind it, close on Escape, close when
  // the viewport grows onto the desktop breakpoint, and move focus into it.
  useEffect(() => {
    if (!mobileOpen) return;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setMobileOpen(false);
    };
    window.addEventListener('keydown', onKeyDown);
    // jsdom (tests) and some old WebViews don't implement matchMedia — the
    // auto-close-on-desktop nicety is optional everywhere else.
    const desktopQuery = typeof window.matchMedia === 'function'
      ? window.matchMedia('(min-width: 1024px)')
      : null;
    const onDesktopChange = (event: MediaQueryListEvent) => {
      if (event.matches) setMobileOpen(false);
    };
    desktopQuery?.addEventListener?.('change', onDesktopChange);
    drawerRef.current?.focus();
    return () => {
      document.body.style.overflow = previousOverflow;
      window.removeEventListener('keydown', onKeyDown);
      desktopQuery?.removeEventListener?.('change', onDesktopChange);
    };
  }, [mobileOpen]);

  if (!session) return null;

  const roleLabel = t(`role.${session.role}`, session.role.charAt(0).toUpperCase() + session.role.slice(1));
  const initials = session.userName.split(' ').map(n => n[0]).join('').substring(0, 2).toUpperCase();
  const navigationLabel = t('adminSidebar.navigation', 'Admin navigation');

  // Computed once per render so exactly one item is highlighted.
  const activeNavPath = activeAdminNavPath(currentPath);

  const renderItem = (item: AdminNavItem, options: { rail?: boolean } = {}) => {
    const { rail = false } = options;
    const label = t(`nav.${item.label}`, item.label);
    const active = activeNavPath === item.path;
    const Icon = item.icon;
    return (
      <button
        key={item.path}
        type="button"
        data-path={item.path}
        data-testid="admin-nav-item"
        aria-current={active ? 'page' : undefined}
        aria-label={label}
        title={label}
        onClick={() => handleNavigate(item.path)}
        className={cn(
          'admin-sidebar__item',
          rail && 'admin-sidebar__item--rail',
          active && 'admin-sidebar__item--active',
        )}
      >
        <Icon className="admin-sidebar__item-icon" aria-hidden="true" />
        {!rail && <span className="admin-sidebar__item-label">{label}</span>}
      </button>
    );
  };

  const renderPanel = ({
    rail,
    showClose,
    isMobileRail,
  }: {
    rail: boolean;
    showClose?: boolean;
    isMobileRail?: boolean;
  }) => (
    <div className={cn('admin-sidebar', rail && 'admin-sidebar--rail')}>
      {/* Brand */}
      <div className="admin-sidebar__header">
        <img src={logo} alt="MBK International School" className={cn('admin-sidebar__logo', rail && 'admin-sidebar__logo--rail')} />
        {!rail && (
          <div className="admin-sidebar__brand">
            <p className="admin-sidebar__school">MBK International School</p>
            <span className="admin-sidebar__role">{roleLabel}</span>
          </div>
        )}
        {isMobileRail ? (
          <button
            type="button"
            className="admin-sidebar__icon-button admin-sidebar-toggle"
            data-testid="admin-sidebar-toggle"
            onClick={() => setMobileOpen(true)}
            aria-label={t('adminSidebar.openMenu', 'Open navigation menu')}
            aria-expanded={mobileOpen}
            aria-controls="admin-sidebar-drawer"
            title={t('adminSidebar.openMenu', 'Open navigation menu')}
          >
            <Menu className="h-5 w-5" aria-hidden="true" />
          </button>
        ) : showClose ? (
          <button
            type="button"
            className="admin-sidebar__icon-button admin-sidebar__close"
            data-testid="admin-sidebar-close"
            onClick={() => setMobileOpen(false)}
            aria-label={t('adminSidebar.closeMenu', 'Close navigation menu')}
            title={t('adminSidebar.closeMenu', 'Close navigation menu')}
          >
            <X className="h-5 w-5" aria-hidden="true" />
          </button>
        ) : (
          <button
            type="button"
            className="admin-sidebar__icon-button admin-sidebar__collapse"
            data-testid="admin-sidebar-collapse"
            onClick={toggleCollapsed}
            aria-label={collapsed ? t('adminSidebar.expand', 'Expand sidebar') : t('adminSidebar.collapse', 'Collapse sidebar')}
            aria-pressed={collapsed}
            title={collapsed ? t('adminSidebar.expand', 'Expand sidebar') : t('adminSidebar.collapse', 'Collapse sidebar')}
          >
            {collapsed ? <PanelLeftOpen className="h-5 w-5" aria-hidden="true" /> : <PanelLeftClose className="h-5 w-5" aria-hidden="true" />}
          </button>
        )}
      </div>

      {/* Navigation — the only scrollable region */}
      <nav className="admin-sidebar__nav" aria-label={navigationLabel}>
        {ADMIN_STANDALONE_ITEMS.map(item => renderItem(item, { rail }))}
        {ADMIN_NAV_GROUPS.map(group => {
          if (rail) {
            // Collapsed rail: keep every link reachable as an icon (with a
            // tooltip), with a thin divider marking where each category starts.
            return (
              <div className="admin-sidebar__rail-section" key={group.id} title={t(group.labelKey, group.label)}>
                <div className="admin-sidebar__rail-divider" role="presentation" />
                {group.items.map(item => renderItem(item, { rail }))}
              </div>
            );
          }
          const expanded = openGroups.has(group.id);
          const panelId = `admin-sidebar-group-${group.id}`;
          return (
            <div className="admin-sidebar__group" key={group.id}>
              <button
                type="button"
                className="admin-sidebar__group-toggle"
                data-testid={`admin-nav-group-${group.id}`}
                aria-expanded={expanded}
                aria-controls={panelId}
                onClick={() => toggleGroup(group.id)}
              >
                <span className="admin-sidebar__group-label">{t(group.labelKey, group.label)}</span>
                <ChevronDown className="admin-sidebar__chevron" aria-hidden="true" />
              </button>
              {expanded && (
                <div className="admin-sidebar__group-items" id={panelId}>
                  {group.items.map(item => renderItem(item))}
                </div>
              )}
            </div>
          );
        })}
      </nav>

      {/* Profile / session — distinct bottom section */}
      <div className="admin-sidebar__footer" data-testid="admin-sidebar-footer">
        {rail ? (
          <div className="admin-sidebar__footer-rail">
            <span className="admin-sidebar__avatar" title={`${session.userName} · ${roleLabel}`}>{initials}</span>
            <button
              type="button"
              className="admin-sidebar__icon-button admin-sidebar__logout"
              data-testid="admin-sidebar-logout"
              onClick={logout}
              title={t('session.signOut', 'Sign Out')}
              aria-label={t('session.signOut', 'Sign Out')}
            >
              <LogOut className="h-5 w-5" aria-hidden="true" />
            </button>
          </div>
        ) : (
          <>
            <div className="admin-sidebar__user">
              <span className="admin-sidebar__avatar" aria-hidden="true">{initials}</span>
              <span className="admin-sidebar__user-meta">
                <span className="admin-sidebar__user-name">{session.userName}</span>
                <span className="admin-sidebar__user-role">{roleLabel}</span>
              </span>
              <button
                type="button"
                className="admin-sidebar__icon-button admin-sidebar__logout"
                data-testid="admin-sidebar-logout"
                onClick={logout}
                title={t('session.signOut', 'Sign Out')}
                aria-label={t('session.signOut', 'Sign Out')}
              >
                <LogOut className="h-5 w-5" aria-hidden="true" />
              </button>
            </div>
            <ThemeSwitcher compact />
          </>
        )}
      </div>
    </div>
  );

  return (
    <>
      {/* Mobile persistent mini icon rail — visible below desktop breakpoint (<1024px) */}
      <aside
        className="admin-sidebar-mobile-rail"
        data-testid="admin-sidebar-mobile-rail"
        aria-label={navigationLabel}
      >
        {renderPanel({ rail: true, isMobileRail: true })}
      </aside>

      {/* Mobile drawer + backdrop */}
      {mobileOpen && (
        <div className="admin-sidebar-mobile-root">
          <div
            className="admin-sidebar-backdrop"
            data-testid="admin-sidebar-backdrop"
            onClick={() => setMobileOpen(false)}
            aria-hidden="true"
          />
          <div
            className="admin-sidebar-drawer"
            id="admin-sidebar-drawer"
            role="dialog"
            aria-modal="true"
            aria-label={navigationLabel}
            data-testid="admin-sidebar-drawer"
            ref={drawerRef}
            tabIndex={-1}
          >
            {renderPanel({ rail: false, showClose: true })}
          </div>
        </div>
      )}

      {/* Desktop column — the flex sibling that main content resizes against (≥1024px) */}
      <div
        className="admin-sidebar-desktop"
        data-testid="admin-sidebar-desktop"
        data-collapsed={collapsed}
      >
        {renderPanel({ rail: collapsed, showClose: false })}
      </div>
    </>
  );
}
