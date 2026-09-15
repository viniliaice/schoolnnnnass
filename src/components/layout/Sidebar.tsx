// Collapsible, role-based sidebar.
//
// The menu content lives in lib/navigation.ts — same paths and same per-role
// visibility as the old flat `navItems` list, just grouped. This component
// owns presentation and interaction:
//
//   * a few "pinned" rows stay visible; everything else sits in collapsible
//     groups, so admin sees 11 rows instead of 27,
//   * the group holding the current page opens itself and the row is
//     highlighted (aria-current="page") — sub-pages highlight their parent row,
//   * which groups are open is remembered per role in localStorage,
//   * long menus get a filter box that flattens the matches,
//   * below `lg` the same element becomes an off-canvas drawer: Escape,
//     backdrop or picking a page closes it, background scroll is locked and
//     focus is trapped inside until it closes.
//
// ONE instance only. The previous layout rendered the menu twice (static
// column + drawer), which duplicated every DOM id — the collapsible panels'
// `nav-section-*` ids and ThemeSwitcher's `id="theme-select"` — and mounted
// two independent ThemeSwitcher/nav states. The element below switches between
// "static column" and "drawer" with classes instead, so `aria-controls` always
// resolves to exactly one panel.
//
// Styling note: this markup lives inside `.theme-sidebar`, whose light-mode
// overrides in index.css key off `text-white/NN` and `[class*="bg-white/"]`
// class names. Stick to those tokens (or the `theme-nav-*` helpers) so both
// appearance modes stay legible.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ChevronDown, LogOut, Menu, Search, X } from 'lucide-react';

import { useRole } from '../../context/RoleContext';
import { useI18n } from '../../lib/i18n/AppLanguageContext';
import {
  activeNavPath,
  activeSectionId,
  loadOpenSections,
  navForRole,
  navItemCount,
  openSectionsForPath,
  saveOpenSections,
  type NavItem,
  type NavSection,
} from '../../lib/navigation';
import type { Role } from '../../types';
import { cn } from '../../utils/cn';
import { ThemeSwitcher } from '../ui/ThemeSwitcher';
import logo from '../../../assets/logo.png';

const roleColors: Record<Role, string> = {
  admin: 'from-indigo-600 to-indigo-800',
  teacher: 'from-teal-600 to-teal-800',
  parent: 'from-violet-600 to-violet-800',
  office: 'from-sky-600 to-sky-800',
  supervisor: 'from-amber-600 to-amber-800',
};

const roleBadgeColors: Record<Role, string> = {
  admin: 'bg-indigo-500/20 text-indigo-100',
  teacher: 'bg-teal-500/20 text-teal-100',
  parent: 'bg-violet-500/20 text-violet-100',
  supervisor: 'bg-amber-500/20 text-amber-100',
  office: 'bg-sky-500/20 text-sky-100',
};

/** Menus shorter than this are already scannable — no filter box needed. */
const FILTER_MIN_ITEMS = 10;

/** Breakpoint at which the drawer turns back into the static column. */
const DESKTOP_QUERY = '(min-width: 1024px)';

/** Everything that can take focus inside the drawer, for the Tab trap. */
const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

interface SidebarProps {
  currentPath: string;
  onNavigate: (path: string) => void;
}

export function Sidebar({ currentPath, onNavigate }: SidebarProps) {
  const { session, logout } = useRole();
  const { t, direction } = useI18n();

  // Every hook runs before the `!session` bail-out below so the hook order
  // stays stable while the session resolves.
  const role = session?.role ?? null;
  const nav = useMemo(() => navForRole(role), [role]);
  const itemCount = useMemo(() => navItemCount(role), [role]);
  const showFilter = itemCount >= FILTER_MIN_ITEMS;
  const isRtl = direction === 'rtl';

  const [mobileOpen, setMobileOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [openSections, setOpenSections] = useState<string[]>(() =>
    role ? loadOpenSections(role) ?? openSectionsForPath(role, currentPath) : [],
  );

  const asideRef = useRef<HTMLElement | null>(null);
  const toggleRef = useRef<HTMLButtonElement | null>(null);
  const closeRef = useRef<HTMLButtonElement | null>(null);
  const activeRowRef = useRef<HTMLButtonElement | null>(null);
  const drawerWasOpen = useRef(false);
  const previousPath = useRef(currentPath);

  // Signing in (or a role change) swaps the whole menu: reload the remembered
  // state for the new role so roles never inherit each other's choices.
  useEffect(() => {
    if (!role) return;
    setOpenSections(loadOpenSections(role) ?? openSectionsForPath(role, currentPath));
    setQuery('');
  }, [role]); // eslint-disable-line react-hooks/exhaustive-deps

  // "Where am I?" — navigating into a closed group opens it, so the page you
  // land on is never hidden. The first render is deliberately skipped: a
  // remembered "I collapsed that" must survive a reload (the group still shows
  // its dot, so the current page stays identifiable). A manual collapse also
  // wins until the path changes again.
  useEffect(() => {
    if (!role) return;
    if (previousPath.current === currentPath) return;
    previousPath.current = currentPath;
    const id = activeSectionId(role, currentPath);
    if (!id) return;
    setOpenSections(previous => (previous.includes(id) ? previous : [...previous, id]));
  }, [role, currentPath]);

  // Remember the expanded/collapsed state across reloads.
  useEffect(() => {
    if (!role) return;
    saveOpenSections(role, openSections);
  }, [role, openSections]);

  // Drawer semantics: lock the page behind it, close on Escape, and keep Tab
  // cycling inside the dialog instead of wandering into hidden content.
  useEffect(() => {
    if (!mobileOpen) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setMobileOpen(false);
        return;
      }
      if (event.key !== 'Tab') return;
      const node = asideRef.current;
      if (!node) return;
      const focusable = Array.from(node.querySelectorAll<HTMLElement>(FOCUSABLE));
      if (focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      const active = document.activeElement;
      if (event.shiftKey && (active === first || !node.contains(active))) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && (active === last || !node.contains(active))) {
        event.preventDefault();
        first.focus();
      }
    };

    // The drawer covers the page, so mark what sits behind it inert: assistive
    // tech then cannot wander into content the dialog is hiding, matching the
    // focus trap already in place for the keyboard.
    const behind = asideRef.current?.parentElement?.querySelector<HTMLElement>('main');
    const wasInert = behind?.inert ?? false;
    if (behind) behind.inert = true;

    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    document.addEventListener('keydown', onKeyDown);
    return () => {
      if (behind) behind.inert = wasInert;
      document.body.style.overflow = previousOverflow;
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [mobileOpen]);

  // Growing the window past `lg` while the drawer is open would leave the page
  // with no visible menu at all (the drawer is `lg:hidden`, and it IS the
  // column), so the drawer closes and the static layout takes over.
  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return;
    const desktop = window.matchMedia(DESKTOP_QUERY);
    const onChange = (event: MediaQueryListEvent) => {
      if (event.matches) setMobileOpen(false);
    };
    desktop.addEventListener('change', onChange);
    return () => desktop.removeEventListener('change', onChange);
  }, []);

  // Move focus into the dialog when it opens and hand it back to the hamburger
  // when it closes, so keyboard users are never left on a hidden control.
  useEffect(() => {
    if (mobileOpen) {
      drawerWasOpen.current = true;
      closeRef.current?.focus();
      return;
    }
    if (drawerWasOpen.current) {
      drawerWasOpen.current = false;
      toggleRef.current?.focus();
    }
  }, [mobileOpen]);

  // Keep the highlighted row in view once its group has opened.
  useEffect(() => {
    const element = activeRowRef.current;
    if (!element || typeof element.scrollIntoView !== 'function') return;
    element.scrollIntoView({ block: 'nearest' });
  }, [currentPath, openSections, query]);

  const navigateTo = useCallback(
    (path: string) => {
      onNavigate(path);
      setMobileOpen(false);
      setQuery('');
    },
    [onNavigate],
  );

  const toggleSection = useCallback((id: string) => {
    setOpenSections(previous =>
      previous.includes(id) ? previous.filter(sectionId => sectionId !== id) : [...previous, id],
    );
  }, []);

  if (!session) return null;

  // A profile row with an unexpected role value (NULL, casing/whitespace
  // drift, a role added before the office migration) yields an empty menu
  // instead of crashing the map below. Fall back loudly but safely.
  if (itemCount === 0) {
    console.warn('[Sidebar] unknown role in session — nav hidden:', session.role);
  }

  const needle = query.trim().toLowerCase();
  const filtering = needle.length > 0;
  const label = (value: string) => t(`nav.${value}`, value);
  const matches = (value: string) =>
    !filtering || value.toLowerCase().includes(needle) || label(value).toLowerCase().includes(needle);

  const visiblePinned = filtering ? nav.pinned.filter(item => matches(item.label)) : nav.pinned;
  const visibleSections: NavSection[] = filtering
    ? nav.sections
        .map(section => ({ ...section, items: section.items.filter(item => matches(item.label)) }))
        .filter(section => section.items.length > 0)
    : nav.sections;
  const noMatches = filtering && visiblePinned.length === 0 && visibleSections.length === 0;

  // Sub-pages (e.g. /admin/family-ids/setup) keep their parent row lit.
  const currentNavPath = activeNavPath(role, currentPath);

  const renderItem = (item: NavItem, nested = false) => {
    const isCurrent = currentPath === item.path;
    const isParentOfCurrent = !isCurrent && item.path === currentNavPath;
    return (
      <button
        key={item.path}
        ref={isCurrent || isParentOfCurrent ? activeRowRef : undefined}
        type="button"
        onClick={() => navigateTo(item.path)}
        aria-current={isCurrent ? 'page' : isParentOfCurrent ? 'true' : undefined}
        title={label(item.label)}
        className={cn(
          'flex w-full max-lg:min-h-11 items-center gap-2.5 px-3 text-left font-medium transition-all duration-200',
          nested ? 'rounded-lg py-2 text-[13px]' : 'rounded-xl py-2.5 text-sm',
          isCurrent || isParentOfCurrent
            ? 'bg-white/20 text-white shadow-lg shadow-black/10 backdrop-blur-sm'
            : 'text-white/70 hover:bg-white/10 hover:text-white',
        )}
      >
        <item.icon className={cn('shrink-0', nested ? 'h-4 w-4' : 'h-5 w-5')} />
        <span className="min-w-0 flex-1 leading-snug">{label(item.label)}</span>
      </button>
    );
  };

  const renderSection = (section: NavSection) => {
    // While filtering, matches are shown expanded and the header becomes a
    // plain label — toggling would be meaningless.
    const isOpen = filtering || openSections.includes(section.id);
    const containsActive = section.items.some(item => item.path === currentNavPath);
    const panelId = `nav-section-${section.id}`;

    return (
      <div key={section.id}>
        {filtering ? (
          <div className="flex w-full items-center gap-2.5 px-3 pb-1 pt-2 text-sm font-semibold text-white/70">
            <section.icon className="h-5 w-5 shrink-0" />
            <span className="min-w-0 flex-1">{label(section.label)}</span>
          </div>
        ) : (
          <button
            type="button"
            onClick={() => toggleSection(section.id)}
            aria-expanded={isOpen}
            aria-controls={panelId}
            title={label(section.label)}
            className={cn(
              'flex w-full max-lg:min-h-11 items-center gap-2.5 rounded-xl px-3 py-2.5 text-left text-sm font-semibold transition-all duration-200',
              containsActive ? 'bg-white/10 text-white' : 'text-white/70 hover:bg-white/10 hover:text-white',
            )}
          >
            <section.icon className="h-5 w-5 shrink-0" />
            <span className="min-w-0 flex-1 leading-snug">{label(section.label)}</span>
            {/* Dot = "the page you are on is in here". Count = "how much is
                hidden". Showing both would crowd the header, so the dot wins. */}
            {containsActive ? (
              <span className="theme-nav-dot h-1.5 w-1.5 shrink-0 rounded-full" aria-hidden="true" />
            ) : (
              !isOpen && (
                <span className="max-lg:hidden shrink-0 text-xs font-medium text-white/50" aria-hidden="true">
                  {section.items.length}
                </span>
              )
            )}
            <ChevronDown
              aria-hidden="true"
              className={cn(
                'h-4 w-4 shrink-0 opacity-70 transition-transform duration-200',
                isOpen ? 'rotate-0' : isRtl ? 'rotate-90' : '-rotate-90',
              )}
            />
          </button>
        )}

        {/* The panel stays in the DOM (hidden) while collapsed: aria-controls
            must resolve to a real element, and screen readers announce the
            disclosure correctly either way. */}
        <div
          id={panelId}
          hidden={!isOpen}
          className="ms-3 mt-0.5 space-y-0.5 border-s border-white/20 ps-2.5"
        >
          {isOpen && section.items.map(item => renderItem(item, true))}
        </div>
      </div>
    );
  };

  return (
    <>
      {/* Hamburger — below `lg` this is the only way to reach the menu.
          `start-4` (not `left-4`) keeps the trigger on the same side as the
          drawer it opens: the drawer is anchored to `start-0` and flips with
          the document direction. Identical to `left-4` in LTR. */}
      <button
        ref={toggleRef}
        type="button"
        onClick={() => setMobileOpen(true)}
        aria-label={t('nav.openMenu', 'Open menu')}
        aria-expanded={mobileOpen}
        aria-controls="app-sidebar"
        className="lg:hidden fixed top-4 start-4 z-40 p-2.5 bg-white rounded-xl shadow-lg border border-slate-200 text-slate-600 hover:text-slate-900"
      >
        <Menu className="w-5 h-5" />
      </button>

      {mobileOpen && (
        <div
          id="nav-backdrop"
          className="lg:hidden fixed inset-0 z-50 bg-black/50 backdrop-blur-[2px]"
          onClick={() => setMobileOpen(false)}
          aria-hidden="true"
        />
      )}

      <aside
        id="app-sidebar"
        ref={asideRef}
        role={mobileOpen ? 'dialog' : undefined}
        aria-modal={mobileOpen ? true : undefined}
        aria-label={t('nav.menu', 'Main navigation')}
        className={cn(
          'theme-sidebar flex-col bg-linear-to-b',
          roleColors[session.role] ?? roleColors.admin,
          mobileOpen
            ? cn(
                'fixed inset-y-0 start-0 z-50 flex w-[86%] max-w-xs shadow-2xl lg:hidden',
                isRtl ? 'animate-[slideLeft_0.2s_ease-out]' : 'animate-[slideRight_0.2s_ease-out]',
              )
            : 'sticky top-0 hidden h-screen w-72 shrink-0 lg:flex',
        )}
      >
        {mobileOpen && (
          <button
            ref={closeRef}
            type="button"
            onClick={() => setMobileOpen(false)}
            aria-label={t('nav.closeMenu', 'Close menu')}
            className="lg:hidden absolute end-2.5 top-2.5 z-10 flex h-11 w-11 items-center justify-center rounded-xl bg-white/20 text-white transition hover:bg-white/10"
          >
            <X className="h-4 w-4" />
          </button>
        )}

        {/* Logo */}
        <div className="p-4 pb-1 lg:p-5 lg:pb-2">
          <div className="flex flex-col items-center gap-1">
            <img
              src={logo}
              alt="MBK International School"
              className="h-14 w-14 object-contain lg:h-20 lg:w-20"
            />
            <h1 className="text-sm font-bold text-white tracking-tight text-center">MBK International School</h1>
            <span className={cn('text-xs px-2 py-0.5 rounded-full font-medium', roleBadgeColors[session.role])}>
              {t(`role.${session.role}`, session.role.charAt(0).toUpperCase() + session.role.slice(1))}
            </span>
          </div>
        </div>

        {/* User */}
        <div className="px-3 pb-2 lg:px-5">
          <div className="bg-white/10 rounded-xl p-3 backdrop-blur-sm">
            <div className="flex items-center gap-3">
              <div className="w-9 h-9 rounded-full bg-white/20 flex items-center justify-center text-white font-bold text-sm shrink-0">
                {session.userName.split(' ').map(n => n[0]).join('').substring(0, 2)}
              </div>
              <div className="min-w-0 flex-1">
                <p className="text-sm font-semibold text-white truncate">{session.userName}</p>
                <p className="text-xs text-white/60">{t('session.active')}</p>
              </div>
              <button
                type="button"
                onClick={logout}
                aria-label={t('session.signOut')}
                className="shrink-0 w-9 h-9 max-lg:h-11 max-lg:w-11 rounded-lg flex items-center justify-center text-white/50 hover:text-white hover:bg-white/10 transition-all"
              >
                <LogOut className="w-4 h-4" />
              </button>
            </div>
          </div>
        </div>

        {/* Appearance */}
        <div className="px-3 pb-2">
          <ThemeSwitcher compact />
        </div>

        {/* Menu filter — only for roles whose menu is long enough to need it */}
        {showFilter && (
          <div className="px-3 pb-2">
            <div className="relative">
              <Search
                aria-hidden="true"
                className="pointer-events-none absolute start-3 top-1/2 h-4 w-4 -translate-y-1/2 text-white/50"
              />
              <input
                type="search"
                value={query}
                onChange={event => setQuery(event.target.value)}
                placeholder={t('nav.filterPlaceholder', 'Filter menu…')}
                aria-label={t('nav.filter', 'Filter menu')}
                className="theme-nav-filter w-full max-lg:min-h-11 rounded-xl border border-white/20 bg-white/10 py-2 pe-3 ps-9 text-xs text-white focus:border-white/40 focus:outline-none"
              />
            </div>
          </div>
        )}

        {/* Nav */}
        <nav
          aria-label={t('nav.menu', 'Main navigation')}
          className="flex-1 overflow-y-auto overscroll-contain px-3 pb-6"
        >
          <div className="space-y-1">
            {visiblePinned.map(item => renderItem(item))}

            {visiblePinned.length > 0 && visibleSections.length > 0 && (
              <div className="my-2 border-t border-white/20" aria-hidden="true" />
            )}

            {visibleSections.map(section => renderSection(section))}

            {noMatches && (
              <p className="px-3 py-6 text-center text-xs text-white/60">
                {t('nav.noMatches', 'No menu items match your search.')}
              </p>
            )}
          </div>
        </nav>
      </aside>
    </>
  );
}
