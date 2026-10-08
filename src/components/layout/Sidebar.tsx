// App sidebar — desktop column + mobile drawer, one navigation definition.
//
// Desktop (lg+, and md+ inside the parent shell):
//   fixed-width sticky column; sections + collapsible groups from
//   ./navigation.ts; independent scroll area for the links; the account area
//   sits at the bottom, visually separated from primary navigation.
//   The column can be collapsed to an icon rail with tooltips; the choice is
//   remembered (src/lib/navPreferences.ts) and the content area reflows to the
//   new width because the sidebar is a flex sibling, not an overlay.
//
// Mobile (<lg):
//   a full-height slide-in drawer with a backdrop, ≥44px rows, safe-area
//   padding, Escape/Tab handling, scroll lock and focus restoration to the
//   element that opened it. The trigger lives in DashboardLayout's top bar and
//   is passed in as a controlled `mobileOpen`; the legacy uncontrolled mode
//   (floating button) is kept for shells that do not render a header.
//
// The same <SidebarNav> renders in both places, so a page can never appear on
// one and be missing from the other.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ChevronUp, LogOut, Menu, PanelLeftClose, PanelLeftOpen, Search, X } from 'lucide-react';
import { useRole } from '../../context/RoleContext';
import type { Role } from '../../types';
import { cn } from '../../utils/cn';
import { ThemeSwitcher } from '../ui/ThemeSwitcher';
import { LanguageSwitcher } from './LanguageSwitcher';
import { useI18n } from '../../lib/i18n/AppLanguageContext';
import {
  readSidebarCollapsed,
  resolveOpenGroups,
  writeNavGroupState,
  writeSidebarCollapsed,
} from '../../lib/navPreferences';
import {
  buildNavigation,
  filterNavigationByMatches,
  flattenNavigation,
  groupIdsOf,
  groupsForPath,
  searchNavigation,
  shouldShowSearch,
} from './navigation';
import { SidebarNav } from './SidebarNav';
import logo from '../../../assets/logo.png';

interface SidebarProps {
  currentPath: string;
  onNavigate: (path: string) => void;
  /** Breakpoint at which the desktop sidebar becomes visible and mobile chrome hides.
   *  `lg` (1024px) matches the staff DashboardLayout; `md` (768px) is used by the
   *  parent shell so tablets also get the sidebar. */
  breakpoint?: 'md' | 'lg';
  /**
   * When false, the slide-over drawer is not rendered — used by the parent
   * shell, which shows its own phone chrome (header + bottom navigation) and
   * wants ONLY the desktop sidebar column from this component.
   */
  mobileToggle?: boolean;
  /** Controlled drawer state, owned by the shell that renders the menu button. */
  mobileOpen?: boolean;
  onMobileOpenChange?: (open: boolean) => void;
  /** Increment to move focus into the page search (Ctrl/Cmd+K, header button). */
  focusSearchSignal?: number;
}

const KNOWN_ROLES = new Set<Role>(['admin', 'teacher', 'parent', 'supervisor', 'office']);

const ROLE_BADGE_FALLBACK: Record<Role, string> = {
  admin: 'Admin',
  teacher: 'Teacher',
  parent: 'Parent',
  supervisor: 'Supervisor',
  office: 'Office',
};

export function Sidebar({
  currentPath,
  onNavigate,
  mobileToggle = true,
  breakpoint = 'lg',
  mobileOpen,
  onMobileOpenChange,
  focusSearchSignal = 0,
}: SidebarProps) {
  const { session, logout } = useRole();
  const { t } = useI18n();

  const role: Role = session?.role ?? 'admin';
  const sections = useMemo(() => buildNavigation(role), [role]);
  const flatItems = useMemo(() => flattenNavigation(sections), [sections]);
  const showSearch = shouldShowSearch(flatItems);
  const activeGroupIds = useMemo(() => groupsForPath(sections, currentPath), [sections, currentPath]);

  const [collapsed, setCollapsed] = useState<boolean>(() => readSidebarCollapsed());
  const [groupState, setGroupState] = useState<Record<string, boolean>>(() =>
    resolveOpenGroups(role, groupIdsOf(sections), groupsForPath(sections, currentPath)),
  );
  const [uncontrolledMobileOpen, setUncontrolledMobileOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [tooltip, setTooltip] = useState<{ label: string; top: number; left: number; rtl: boolean } | null>(null);
  const [accountOpen, setAccountOpen] = useState(false);

  const desktopSearchInputRef = useRef<HTMLInputElement | null>(null);
  const drawerSearchInputRef = useRef<HTMLInputElement | null>(null);
  const desktopNavRef = useRef<HTMLDivElement | null>(null);
  const drawerNavRef = useRef<HTMLElement | null>(null);
  const drawerRef = useRef<HTMLDivElement | null>(null);
  const accountPanelRef = useRef<HTMLElement | null>(null);
  const accountTriggerRef = useRef<HTMLButtonElement | null>(null);
  const restoreFocusRef = useRef<HTMLElement | null>(null);
  const tooltipTimerRef = useRef<number | null>(null);

  const isControlled = mobileOpen !== undefined;
  const drawerOpen = mobileToggle && (isControlled ? Boolean(mobileOpen) : uncontrolledMobileOpen);

  const setDrawerOpen = useCallback(
    (open: boolean) => {
      if (!isControlled) setUncontrolledMobileOpen(open);
      onMobileOpenChange?.(open);
    },
    [isControlled, onMobileOpenChange],
  );

  // ── Preferences ─────────────────────────────────────────────────────────
  useEffect(() => {
    writeSidebarCollapsed(collapsed);
  }, [collapsed]);

  // Role changes (sign out → sign in as another role) reset the group state.
  useEffect(() => {
    setGroupState(resolveOpenGroups(role, groupIdsOf(sections), groupsForPath(sections, currentPath)));
    setQuery('');
    // Only the role matters here; sections/path are derived from it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [role]);

  // ── Keep the current page visible ────────────────────────────────────────
  // Opening the group that holds the active route on every route change means a
  // refresh (or a deep link) inside a nested page never hides the page itself.
  useEffect(() => {
    if (activeGroupIds.length === 0) return;
    setGroupState(previous => {
      if (activeGroupIds.every(id => previous[id] === true)) return previous;
      const next = { ...previous };
      for (const id of activeGroupIds) next[id] = true;
      writeNavGroupState(role, next);
      return next;
    });
  }, [activeGroupIds, role]);

  const toggleGroup = useCallback(
    (groupId: string) => {
      setGroupState(previous => {
        const next = { ...previous, [groupId]: !previous[groupId] };
        writeNavGroupState(role, next);
        return next;
      });
    },
    [role],
  );

  // ── Mobile drawer: focus, Escape, Tab, scroll lock ───────────────────────
  useEffect(() => {
    if (!drawerOpen) return;

    restoreFocusRef.current = (document.activeElement as HTMLElement | null) ?? null;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';

    // Focus the drawer itself so the dialog is announced and the first Tab
    // reaches the close button.
    const focusTimer = window.setTimeout(() => drawerRef.current?.focus(), 0);

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.stopPropagation();
        setDrawerOpen(false);
        return;
      }
      if (event.key !== 'Tab') return;
      const focusables = drawerRef.current?.querySelectorAll<HTMLElement>(
        'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
      );
      if (!focusables || focusables.length === 0) return;
      const first = focusables[0];
      const last = focusables[focusables.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };

    document.addEventListener('keydown', onKeyDown);
    return () => {
      window.clearTimeout(focusTimer);
      document.removeEventListener('keydown', onKeyDown);
      document.body.style.overflow = previousOverflow;
      const previous = restoreFocusRef.current;
      if (previous && typeof previous.focus === 'function') previous.focus();
    };
  }, [drawerOpen, setDrawerOpen]);

  // Account panel: Escape + outside pointer.
  useEffect(() => {
    if (!accountOpen) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setAccountOpen(false);
    };
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node | null;
      if (target && !accountPanelRef.current?.contains(target) && !accountTriggerRef.current?.contains(target)) {
        setAccountOpen(false);
      }
    };
    document.addEventListener('keydown', onKeyDown);
    document.addEventListener('pointerdown', onPointerDown);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      document.removeEventListener('pointerdown', onPointerDown);
    };
  }, [accountOpen]);

  // Close the account panel whenever the page changes.
  useEffect(() => {
    setAccountOpen(false);
  }, [currentPath]);

  // Focus whichever search field the user can actually see: the drawer's when
  // the drawer is open (phones), the column's otherwise.
  const focusSearchField = useCallback(() => {
    const target = drawerOpen ? drawerSearchInputRef.current : desktopSearchInputRef.current;
    target?.focus();
  }, [drawerOpen]);

  // Ctrl/Cmd+K (or the header button) puts the caret in the page search. On the
  // desktop column it also leaves the icon rail, otherwise there is no input to
  // focus yet.
  useEffect(() => {
    if (!focusSearchSignal || !showSearch) return;
    if (!drawerOpen) setCollapsed(false);
    const timer = window.setTimeout(focusSearchField, 0);
    return () => window.clearTimeout(timer);
  }, [focusSearchSignal, showSearch, drawerOpen, focusSearchField]);

  const handleTooltip = useCallback((label: string, target: HTMLElement) => {
    if (tooltipTimerRef.current) window.clearTimeout(tooltipTimerRef.current);
    tooltipTimerRef.current = window.setTimeout(() => {
      const rect = target.getBoundingClientRect();
      const rtl = typeof document !== 'undefined' && document.documentElement.dir === 'rtl';
      setTooltip({
        label,
        top: rect.top + rect.height / 2,
        left: rtl ? rect.left - 12 : rect.right + 12,
        rtl,
      });
    }, 140);
  }, []);

  const hideTooltip = useCallback(() => {
    if (tooltipTimerRef.current) window.clearTimeout(tooltipTimerRef.current);
    setTooltip(null);
  }, []);

  useEffect(
    () => () => {
      if (tooltipTimerRef.current) window.clearTimeout(tooltipTimerRef.current);
    },
    [],
  );

  const handleNavigate = useCallback(
    (path: string) => {
      hideTooltip();
      setDrawerOpen(false);
      if (path === currentPath) return; // no duplicate history entries / double navigation
      onNavigate(path);
    },
    [currentPath, hideTooltip, onNavigate, setDrawerOpen],
  );

  // ── Search filtering ────────────────────────────────────────────────────
  const searchResults = useMemo(
    () => (query.trim() ? searchNavigation(flatItems, query, t) : null),
    [flatItems, query, t],
  );

  const visibleSections = useMemo(
    () => (searchResults ? filterNavigationByMatches(sections, searchResults.map(result => result.id)) : sections),
    [sections, searchResults],
  );

  const expandedGroups = useMemo(() => {
    if (!searchResults) return groupState;
    const forced: Record<string, boolean> = { ...groupState };
    for (const result of searchResults) if (result.groupId) forced[result.groupId] = true;
    return forced;
  }, [groupState, searchResults]);

  if (!session) return null;

  if (!KNOWN_ROLES.has(session.role)) {
    console.warn('[Sidebar] unknown role in session — nav hidden:', session.role);
  }

  const initials = session.userName
    .split(' ')
    .map(part => part[0])
    .join('')
    .substring(0, 2)
    .toUpperCase();
  const roleLabel = t(`role.${session.role}`, ROLE_BADGE_FALLBACK[session.role] ?? session.role);
  const isRail = collapsed;

  const navProps = {
    currentPath,
    translate: t,
    expandedGroups,
    onToggleGroup: toggleGroup,
    onNavigate: handleNavigate,
  };

  const searchField = (variant: 'desktop' | 'drawer') => {
    if (!showSearch) return null;

    if (variant === 'desktop' && isRail) {
      return (
        <button
          type="button"
          aria-label={t('nav.search', 'Search pages')}
          data-testid="nav-search-expand"
          onClick={() => {
            setCollapsed(false);
            window.setTimeout(focusSearchField, 0);
          }}
          className="app-nav-search-compact"
        >
          <Search className="app-nav-icon" aria-hidden="true" />
        </button>
      );
    }

    return (
      <div className="app-nav-search" role="search">
        <Search className="app-nav-search-icon" aria-hidden="true" />
        <input
          ref={variant === 'desktop' ? desktopSearchInputRef : drawerSearchInputRef}
          type="search"
          value={query}
          onChange={event => setQuery(event.target.value)}
          onKeyDown={event => {
            if (event.key === 'Escape') {
              if (query) {
                event.stopPropagation();
                setQuery('');
              }
              return;
            }
            if (event.key === 'ArrowDown') {
              const container = variant === 'desktop' ? desktopNavRef.current : drawerNavRef.current;
              const first = container?.querySelector<HTMLElement>('button');
              if (first) {
                event.preventDefault();
                first.focus();
              }
            }
          }}
          placeholder={t('nav.searchPlaceholder', 'Search pages…')}
          aria-label={t('nav.search', 'Search pages')}
          className="app-nav-search-input"
          data-testid={`nav-search-input-${variant}`}
        />
        {query && (
          <button
            type="button"
            onClick={() => {
              setQuery('');
              focusSearchField();
            }}
            aria-label={t('nav.clearSearch', 'Clear search')}
            className="app-nav-search-clear"
          >
            <X className="h-3.5 w-3.5" aria-hidden="true" />
          </button>
        )}
      </div>
    );
  };

  const accountPanel = (variant: 'desktop' | 'drawer') => (
    <section
      className={cn('app-account-panel', variant === 'desktop' && isRail && 'app-account-panel--rail')}
      aria-label={t('nav.account', 'Account')}
      ref={accountPanelRef}
      id="app-account-menu"
      data-testid={`account-panel-${variant}`}
    >
      <div className="app-account-identity">
        <span className="app-avatar" aria-hidden="true">
          {initials}
        </span>
        <span className="min-w-0">
          <span className="app-account-name">{session.userName}</span>
          <span className="app-role-badge">{roleLabel}</span>
        </span>
      </div>
      <LanguageSwitcher variant="inline" />
      <ThemeSwitcher />
    </section>
  );

  const footer = (variant: 'desktop' | 'drawer') => {
    const rail = variant === 'desktop' && isRail;
    return (
      <div className="app-sidebar-footer">
        <div className="relative">
          {accountOpen && accountPanel(variant)}
          <button
            type="button"
            ref={variant === 'desktop' ? accountTriggerRef : undefined}
            aria-expanded={accountOpen}
            aria-controls="app-account-menu"
            aria-label={`${t('nav.account', 'Account')} — ${session.userName} (${roleLabel})`}
            data-testid={`account-trigger-${variant}`}
            onClick={() => setAccountOpen(open => !open)}
            className={cn('app-account-trigger', rail && 'justify-center px-0')}
          >
            <span className="app-avatar" aria-hidden="true">
              {initials}
            </span>
            {!rail && (
              <>
                <span className="min-w-0 flex-1 text-left">
                  <span className="app-account-name">{session.userName}</span>
                  <span className="app-account-role">{roleLabel}</span>
                </span>
                <ChevronUp className="app-account-chevron" aria-hidden="true" />
              </>
            )}
          </button>
        </div>
        <button
          type="button"
          onClick={logout}
          title={t('session.signOut', 'Sign Out')}
          className={cn('app-signout-button', rail && 'justify-center px-0')}
          data-testid={`signout-${variant}`}
        >
          <LogOut className="h-[18px] w-[18px] shrink-0" aria-hidden="true" />
          <span className={rail ? 'sr-only' : 'app-signout-label'}>{t('session.signOut', 'Sign Out')}</span>
        </button>
      </div>
    );
  };

  const header = (variant: 'desktop' | 'drawer') => {
    const rail = variant === 'desktop' && isRail;
    const collapseToggleLabel = isRail
      ? t('nav.expandSidebar', 'Expand sidebar')
      : t('nav.collapseSidebar', 'Collapse sidebar');

    return (
      <div className="app-sidebar-header">
        <img src={logo} alt="" className="app-sidebar-logo" />
        {!rail && (
          <span className="min-w-0 flex-1">
            <span className="app-sidebar-school">{t('app.school', 'MBK International School')}</span>
            <span className="app-role-badge">{roleLabel}</span>
          </span>
        )}
        {variant === 'desktop' ? (
          <button
            type="button"
            onClick={() => {
              hideTooltip();
              setCollapsed(value => !value);
            }}
            aria-label={collapseToggleLabel}
            aria-expanded={!isRail}
            aria-controls="app-sidebar-nav"
            title={collapseToggleLabel}
            data-testid="sidebar-collapse-toggle"
            className="app-icon-button"
            onMouseEnter={event => handleTooltip(collapseToggleLabel, event.currentTarget)}
            onMouseLeave={hideTooltip}
            onFocus={event => handleTooltip(collapseToggleLabel, event.currentTarget)}
            onBlur={hideTooltip}
          >
            {isRail ? (
              <PanelLeftOpen className="h-[18px] w-[18px]" aria-hidden="true" />
            ) : (
              <PanelLeftClose className="h-[18px] w-[18px]" aria-hidden="true" />
            )}
          </button>
        ) : (
          <button
            type="button"
            onClick={() => setDrawerOpen(false)}
            aria-label={t('nav.closeMenu', 'Close menu')}
            className="app-icon-button"
            data-testid="drawer-close"
          >
            <X className="h-5 w-5" aria-hidden="true" />
          </button>
        )}
      </div>
    );
  };

  const desktopColumn = (
    <div className={cn('app-sidebar-shell', breakpoint === 'md' ? 'hidden md:block' : 'hidden lg:block')}>
      <aside
        id="app-sidebar-nav"
        className="app-sidebar"
        data-collapsed={isRail ? 'true' : 'false'}
        data-role={session.role}
        aria-label={t('nav.menu', 'Main navigation')}
      >
        {header('desktop')}
        {searchField('desktop')}
        <div className="app-nav-scroll" ref={desktopNavRef}>
          <SidebarNav
            {...navProps}
            sections={visibleSections}
            collapsed={isRail}
            variant="desktop"
            onTooltip={handleTooltip}
            onTooltipHide={hideTooltip}
            emptyMessage={t('nav.noResults', 'No pages found')}
            idPrefix={isRail ? 'nav-rail' : 'nav'}
          />
        </div>
        {footer('desktop')}
      </aside>
    </div>
  );

  const drawer = drawerOpen ? (
    <div
      className={cn('app-drawer-root', breakpoint === 'md' ? 'md:hidden' : 'lg:hidden')}
      data-testid="mobile-drawer-root"
    >
      <button
        type="button"
        tabIndex={-1}
        aria-hidden="true"
        className="app-drawer-backdrop"
        onClick={() => setDrawerOpen(false)}
        data-testid="mobile-drawer-backdrop"
      />
      <div
        id="app-mobile-nav"
        role="dialog"
        aria-modal="true"
        aria-label={t('nav.menu', 'Main navigation')}
        className="app-drawer-panel"
        ref={drawerRef}
        tabIndex={-1}
        data-role={session.role}
        data-testid="mobile-drawer"
      >
        {header('drawer')}
        {searchField('drawer')}
        <nav ref={drawerNavRef} aria-label={t('nav.menu', 'Main navigation')}>
          <SidebarNav
            {...navProps}
            sections={visibleSections}
            variant="drawer"
            emptyMessage={t('nav.noResults', 'No pages found')}
            idPrefix="drawer"
          />
        </nav>
        {footer('drawer')}
      </div>
    </div>
  ) : null;

  return (
    <>
      {/* Legacy floating trigger: only when this component owns the drawer
          state. Shells with a top bar (DashboardLayout) render their own
          button and control `mobileOpen`. */}
      {mobileToggle && !isControlled && (
        <button
          type="button"
          onClick={() => setDrawerOpen(true)}
          aria-label={t('nav.openMenu', 'Open menu')}
          aria-expanded={drawerOpen}
          aria-controls="app-mobile-nav"
          data-testid="mobile-menu-button"
          className={cn('app-menu-button', breakpoint === 'md' ? 'md:hidden' : 'lg:hidden')}
        >
          <Menu className="h-5 w-5" aria-hidden="true" />
        </button>
      )}

      {drawer}
      {desktopColumn}

      {tooltip && (
        <div
          role="tooltip"
          className="app-nav-tooltip"
          style={{
            top: tooltip.top,
            left: tooltip.left,
            transform: tooltip.rtl ? 'translate(-100%, -50%)' : 'translate(0, -50%)',
          }}
        >
          {tooltip.label}
        </div>
      )}
    </>
  );
}
