import { type ReactNode, useCallback, useEffect, useState } from 'react';
import { Languages } from 'lucide-react';
import { Sidebar } from './Sidebar';
import { useI18n, type AppLanguage } from '../../lib/i18n/AppLanguageContext';
import { initialPathFromLocation, onNavigationRequest } from '../../lib/pwa/navigationBus';
import { OfflineIndicator } from '../pwa/OfflineIndicator';
import { UpdateBanner } from '../pwa/UpdateBanner';

interface DashboardLayoutProps {
  children: (currentPath: string, navigate: (path: string) => void) => ReactNode;
  initialPath?: string;
  /** Paths rendered without sidebar/footer chrome (e.g. the mobile gate). */
  fullscreenPaths?: string[];
}

const LANGUAGE_LABELS: Record<AppLanguage, { short: string; key: string }> = {
  en: { short: 'EN', key: 'language.english' },
  ar: { short: 'عربي', key: 'language.arabic' },
};

/** Floating EN/ع switcher — used by DashboardLayout and the parent desktop layout. */
export function LanguageSwitcher() {
  const { language, setLanguage, t } = useI18n();

  return (
    <div className="fixed right-4 top-4 z-40 rounded-2xl border border-slate-200 bg-white/95 p-1.5 shadow-lg backdrop-blur lg:right-6 lg:top-6">
      <div className="flex items-center gap-1.5" role="group" aria-label={t('language.switch')}>
        <Languages className="ml-1 h-4 w-4 text-slate-400" />
        {(['en', 'ar'] as const).map((key) => {
          const selected = language === key;
          return (
            <button
              key={key}
              type="button"
              onClick={() => setLanguage(key)}
              aria-pressed={selected}
              title={`${t('language.switchTo')} ${t(LANGUAGE_LABELS[key].key)}`}
              className={
                selected
                  ? 'min-h-9 rounded-xl bg-indigo-600 px-3 text-xs font-bold text-white shadow-sm transition'
                  : 'min-h-9 rounded-xl px-3 text-xs font-bold text-slate-500 transition hover:bg-slate-100 hover:text-slate-800'
              }
            >
              {LANGUAGE_LABELS[key].short}
            </button>
          );
        })}
      </div>
    </div>
  );
}

export function DashboardLayout({ children, initialPath = '/dashboard', fullscreenPaths = [] }: DashboardLayoutProps) {
  // Deep links: when a notification click (or a cold PWA launch) opens the
  // app on a known route such as /teacher/lesson-plans, honour the URL
  // instead of always landing on the dashboard.
  const [currentPath, setCurrentPath] = useState(() => initialPathFromLocation() ?? initialPath);
  const { t } = useI18n();

  const applyPath = useCallback((path: string, updateUrl: boolean) => {
    setCurrentPath(path);
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
    const onPopState = () => setCurrentPath(initialPathFromLocation() ?? '/dashboard');
    window.addEventListener('popstate', onPopState);
    return () => window.removeEventListener('popstate', onPopState);
  }, []);

  // Mobile-first full-screen routes (no sidebar, no footer, edge-to-edge).
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
      <Sidebar currentPath={currentPath} onNavigate={navigate} />
      <main className="relative flex-1 min-w-0 flex flex-col">
        <LanguageSwitcher />
        <div className="p-4 lg:p-8 pt-20 lg:pt-20 max-w-7xl mx-auto flex-1 w-full">
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
