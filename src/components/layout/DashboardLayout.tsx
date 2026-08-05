import { type ReactNode, useCallback, useEffect, useState } from 'react';
import { Languages } from 'lucide-react';
import { Sidebar } from './Sidebar';

interface DashboardLayoutProps {
  children: (currentPath: string, navigate: (path: string) => void) => ReactNode;
  initialPath?: string;
  /** Paths rendered without sidebar/footer chrome (e.g. the mobile gate). */
  fullscreenPaths?: string[];
}

type AppLanguage = 'en' | 'ar';

const LANGUAGE_LABELS: Record<AppLanguage, { short: string; label: string; dir: 'ltr' | 'rtl' }> = {
  en: { short: 'EN', label: 'English', dir: 'ltr' },
  ar: { short: 'عربي', label: 'Arabic', dir: 'rtl' },
};

function initialLanguage(): AppLanguage {
  if (typeof window === 'undefined') return 'en';
  return window.localStorage.getItem('mbk-language') === 'ar' ? 'ar' : 'en';
}

function LanguageSwitcher({ language, onChange }: { language: AppLanguage; onChange: (language: AppLanguage) => void }) {
  return (
    <div className="fixed right-4 top-4 z-40 rounded-2xl border border-slate-200 bg-white/95 p-1.5 shadow-lg backdrop-blur lg:right-6 lg:top-6">
      <div className="flex items-center gap-1.5" role="group" aria-label="Change language">
        <Languages className="ml-1 h-4 w-4 text-slate-400" />
        {(['en', 'ar'] as const).map((key) => {
          const selected = language === key;
          return (
            <button
              key={key}
              type="button"
              onClick={() => onChange(key)}
              aria-pressed={selected}
              title={`Switch language to ${LANGUAGE_LABELS[key].label}`}
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
  const [currentPath, setCurrentPath] = useState(initialPath);
  const [language, setLanguage] = useState<AppLanguage>(initialLanguage);

  const navigate = useCallback((path: string) => {
    setCurrentPath(path);
  }, []);

  useEffect(() => {
    const { dir } = LANGUAGE_LABELS[language];
    document.documentElement.lang = language;
    document.documentElement.dir = dir;
    window.localStorage.setItem('mbk-language', language);
  }, [language]);

  // Mobile-first full-screen routes (no sidebar, no footer, edge-to-edge).
  if (fullscreenPaths.includes(currentPath)) {
    return <main className="min-h-screen bg-slate-100">{children(currentPath, navigate)}</main>;
  }

  return (
    <div className="flex min-h-screen bg-slate-50">
      <Sidebar currentPath={currentPath} onNavigate={navigate} />
      <main className="relative flex-1 min-w-0 flex flex-col">
        <LanguageSwitcher language={language} onChange={setLanguage} />
        <div className="p-4 lg:p-8 pt-20 lg:pt-20 max-w-7xl mx-auto flex-1 w-full">
          {children(currentPath, navigate)}
        </div>
        <footer className="border-t border-slate-200 py-3 px-4 text-center">
          <p className="text-sm text-slate-400" style={{ fontFamily: "'Dancing Script', cursive", fontSize: '1rem' }}>
            Made by <span className="font-bold text-indigo-500">Eng. Akso</span>
          </p>
        </footer>
      </main>
    </div>
  );
}
