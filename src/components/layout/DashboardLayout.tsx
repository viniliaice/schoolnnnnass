import { type ReactNode, useCallback, useEffect, useMemo, useState } from 'react';
import { Menu, Search } from 'lucide-react';
import { Sidebar } from './Sidebar';
import { useRole } from '../../context/RoleContext';
import { useI18n } from '../../lib/i18n/AppLanguageContext';
import { initialPathFromLocation, onNavigationRequest } from '../../lib/pwa/navigationBus';
import { OfflineIndicator } from '../pwa/OfflineIndicator';
import { UpdateBanner } from '../pwa/UpdateBanner';
import { LanguageSwitcher } from './LanguageSwitcher';
import {
  buildNavigation,
  findActiveItem,
  flattenNavigation,
  shouldShowSearch,
} from './navigation';

// Kept as a re-export: ParentAppShell (and older imports) read the switcher
// from this module.
export { LanguageSwitcher } from './LanguageSwitcher';

interface DashboardLayoutProps {
  children: (currentPath: string, navigate: (path: string) => void) => ReactNode;
  initialPath?: string;
  /** Paths rendered without sidebar/footer chrome (e.g. the mobile gate). */
  fullscreenPaths?: string[];
}

export function DashboardLayout({ children, initialPath = '/dashboard', fullscreenPaths = [] }: DashboardLayoutProps) {
  // Deep links: when a notification click (or a cold PWA launch) opens the
  // app on a known route such as /teacher/lesson-plans, honour the URL
  // instead of always landing on the dashboard.
  const [currentPath, setCurrentPath] = useState(() => initialPathFromLocation() ?? initialPath);
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const [searchSignal, setSearchSignal] = useState(0);
  const { t } = useI18n();
  const { session } = useRole();

  const applyPath = useCallback((path: string, updateUrl: boolean) => {
    setCurrentPath(path);
    // Any navigation closes the mobile drawer (a link inside it was chosen).
    setMobileNavOpen(false);
    if (updateUrl) {
      try {
        window.history.pushState({}, '', path);
      } catch {
        /* sandboxed iframe without allow-same-origin */
      }
    }
  }, []);

  const navigate = useCallback((path: string) => applyPath(path, true), [applyPath]);

  // Service-worker notification clicks on an already-open window post
  // NAVIGATE messages that arrive on this bus.
  useEffect(() => onNavigationRequest((path) => applyPath(path, true)), [applyPath]);

  // Keep in-app state in sync with browser back/forward.
  useEffect(() => {
    const onPopState = () => {
      setCurrentPath(initialPathFromLocation() ?? '/dashboard');
      setMobileNavOpen(false);
    };
    window.addEventListener('popstate', onPopState);
    return () => window.removeEventListener('popstate', onPopState);
  }, []);

  // Ctrl/Cmd+K opens the page search. The sidebar's own breakpoint decides
  // where: at lg+ the desktop column exists, so it un-collapses and takes the
  // caret; below that the slide-in drawer opens instead. Opening the drawer at
  // desktop widths would mount an invisible dialog and its scroll lock.
  useEffect(() => {
    const isDesktop = () =>
      typeof window.matchMedia === 'function'
        ? window.matchMedia('(min-width: 1024px)').matches
        : true;
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        if (!isDesktop()) setMobileNavOpen(true);
        setSearchSignal(signal => signal + 1);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  // A phone drawer must not survive a resize into the desktop layout: it would
  // stay mounted (invisible, but still holding the scroll lock and the focus
  // trap) behind the column that just appeared.
  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return;
    const desktop = window.matchMedia('(min-width: 1024px)');
    const onChange = () => {
      if (desktop.matches) setMobileNavOpen(false);
    };
    desktop.addEventListener('change', onChange);
    return () => desktop.removeEventListener('change', onChange);
  }, []);

  // Current page title for the mobile top bar — derived from the same nav
  // config the sidebar renders, so the bar can never disagree with the menu.
  const pageTitle = useMemo(() => {
    if (!session) return '';
    const sections = buildNavigation(session.role);
    const active = findActiveItem(sections, currentPath);
    return active ? t(active.labelKey, active.fallback) : t('nav.Dashboard', 'Dashboard');
  }, [currentPath, session, t]);

  const hasSearch = useMemo(() => {
    if (!session) return false;
    return shouldShowSearch(flattenNavigation(buildNavigation(session.role)));
  }, [session]);

  if (fullscreenPaths.includes(currentPath)) {
    return (
      <>
        <main className="app-shell min-h-screen bg-slate-100">{children(currentPath, navigate)}</main>
        <OfflineIndicator />
        <UpdateBanner />
      </>
    );
  }

  return (
    <div className="app-shell flex min-h-screen bg-slate-50">
      <OfflineIndicator />
      <UpdateBanner />
      <Sidebar
        currentPath={currentPath}
        onNavigate={navigate}
        mobileOpen={mobileNavOpen}
        onMobileOpenChange={setMobileNavOpen}
        focusSearchSignal={searchSignal}
      />
      <main className="relative flex-1 min-w-0 flex flex-col">
        {/* Mobile chrome: menu button, current page, page search. Tablet and
            desktop keep the floating language switcher instead. */}
        <header className="app-mobile-bar lg:hidden">
          <button
            type="button"
            onClick={() => setMobileNavOpen(true)}
            aria-label={t('nav.openMenu', 'Open menu')}
            aria-expanded={mobileNavOpen}
            aria-controls="app-mobile-nav"
            data-testid="mobile-menu-button"
            className="app-mobile-bar-button"
          >
            <Menu className="h-5 w-5" aria-hidden="true" />
          </button>
          <p className="app-mobile-bar-title" data-testid="mobile-page-title">
            {pageTitle}
          </p>
          {hasSearch && (
            <button
              type="button"
              onClick={() => {
                setMobileNavOpen(true);
                setSearchSignal(signal => signal + 1);
              }}
              aria-label={t('nav.search', 'Search pages')}
              data-testid="mobile-search-button"
              className="app-mobile-bar-button"
            >
              <Search className="h-[18px] w-[18px]" aria-hidden="true" />
            </button>
          )}
        </header>

        <LanguageSwitcher className="hidden lg:block" />
        <div className="p-4 lg:p-8 pt-4 lg:pt-20 max-w-7xl mx-auto flex-1 w-full">
          {children(currentPath, navigate)}
        </div>
        <footer className="border-t border-slate-200 py-3 px-4 text-center">
          <p className="text-sm text-slate-400" style={{ fontFamily: "'Dancing Script', cursive", fontSize: '1rem' }}>
            {t('app.madeBy')} <span className="font-bold text-indigo-500">Eng. Akso</span>
          </p>
          <p className="mt-1 text-xs">
            <a
              href="/privacy-policy"
              className="text-slate-500 underline underline-offset-2 transition-colors hover:text-indigo-600"
            >
              Privacy Policy
            </a>
          </p>
        </footer>
      </main>
    </div>
  );
}
