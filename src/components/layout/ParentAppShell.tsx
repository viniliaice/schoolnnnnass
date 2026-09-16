// App shell for the PARENT role — adapted per device:
//
//   PHONE (<md)                       TABLET / DESKTOP (md+)
//   ┌──────────────────────────┐      ┌────────┬───────────────────────────┐
//   │ header: logo · school · 🌐 │      │ the    │ content + floating 🌐     │
//   ├──────────────────────────┤      │ staff  │ (the previous desktop    │
//   │ content (max-w-2xl)      │      │ sidebar│ experience, restored per │
//   ├──────────────────────────┤      │ (old   │ request)                  │
//   │ Home Children Results ✉ ⋯│      │ design)│                           │
//   └──────────────────────────┘      └────────┴───────────────────────────┘
//
// Phones keep the simple bottom-navigation app; tablets and desktops get the
// exact sidebar parents used before the redesign (its Monthly/Midterm/Final
// links open the unified Exam Results tabs — the paths still work).
// The shell owns the current path (lightweight state-based navigation, see
// DashboardLayout) and provides ParentContext — children + active child —
// to everything it renders.

import { useCallback, useEffect, useState, type ReactNode } from 'react';
import {
  Home,
  Users,
  ClipboardList,
  Mail,
  MoreHorizontal,
  Languages,
  type LucideIcon,
} from 'lucide-react';
import { useRole } from '../../context/RoleContext';
import { useI18n, type AppLanguage } from '../../lib/i18n/AppLanguageContext';
import { ParentProvider } from '../../pages/parent/ParentContext';
import { LanguageSwitcher } from './DashboardLayout';
import { Sidebar } from './Sidebar';
import { cn } from '../../utils/cn';
import logo from '../../../assets/logo.png';

interface ParentAppShellProps {
  children: (currentPath: string, navigate: (path: string) => void) => ReactNode;
  initialPath?: string;
}

interface BottomNavItem {
  key: 'home' | 'children' | 'results' | 'messages' | 'more';
  labelKey: string;
  fallback: string;
  icon: LucideIcon;
  path: string;
  isActive: (path: string) => boolean;
}

// Bottom navigation — the ONLY primary navigation for parents. ~4–5 simple
// destinations with icons + text labels; everything else lives under More.
export const PARENT_BOTTOM_NAV: BottomNavItem[] = [
  {
    key: 'home',
    labelKey: 'nav.Home',
    fallback: 'Home',
    icon: Home,
    path: '/dashboard',
    isActive: path => path === '/dashboard',
  },
  {
    key: 'children',
    labelKey: 'nav.Children',
    fallback: 'Children',
    icon: Users,
    path: '/parent/children',
    isActive: path => path === '/parent/children',
  },
  {
    key: 'results',
    labelKey: 'nav.Results',
    fallback: 'Results',
    icon: ClipboardList,
    path: '/parent/results',
    // Monthly/Midterm/Final used to be separate menu entries; their paths now
    // open the unified Exam Results screen, so they all light up "Results".
    isActive: path =>
      path === '/parent/results' ||
      path === '/parent/monthly' ||
      path === '/parent/midterm' ||
      path === '/parent/final',
  },
  {
    key: 'messages',
    labelKey: 'nav.Messages',
    fallback: 'Messages',
    icon: Mail,
    path: '/messages',
    isActive: path => path === '/messages',
  },
  {
    key: 'more',
    labelKey: 'nav.More',
    fallback: 'More',
    icon: MoreHorizontal,
    path: '/parent/more',
    // Secondary areas (quizzes, streams, weekly learning, pickup card…)
    isActive: path =>
      path === '/parent/more' ||
      path === '/parent/quizzes' ||
      path === '/parent/weekly-learning' ||
      path === '/parent/pickup-card' ||
      path === '/streams',
  },
];

const LANGUAGE_SHORT: Record<AppLanguage, string> = { en: 'EN', ar: 'عربي' };

export function ParentAppShell({ children, initialPath = '/dashboard' }: ParentAppShellProps) {
  const { session } = useRole();
  const { language, setLanguage, t } = useI18n();
  const [currentPath, setCurrentPath] = useState(initialPath);

  const navigate = useCallback((path: string) => {
    setCurrentPath(path);
  }, []);

  // Start each screen at the top (app-like behaviour; silent in jsdom).
  useEffect(() => {
    if (typeof document === 'undefined') return;
    document.documentElement.scrollTop = 0;
    document.body.scrollTop = 0;
  }, [currentPath]);

  if (!session) return null;
  const firstName = session.userName.split(' ')[0] || session.userName;

  return (
    <ParentProvider parentId={session.userId}>
      {/* `app-shell` (see index.css) keeps this root from becoming the
          containing block of the fixed bottom navigation below: the theme
          engine adds a backdrop-filter to `.bg-slate-50`, which would anchor
          the bar to this (page-height) div instead of the phone viewport. */}
      <div className="app-shell min-h-screen min-h-dvh bg-slate-50 text-slate-900 md:flex">
        {/* TABLET / DESKTOP (md+): the previous staff sidebar, restored. Its mobile
            toggle/overlay stays off — phones use the chrome below. Its
            Monthly/Midterm/Final links open the unified Exam Results tabs. */}
        <div className="hidden md:block">
          <Sidebar currentPath={currentPath} onNavigate={navigate} mobileToggle={false} breakpoint="md" />
        </div>

        <div className="min-w-0 flex-1 flex flex-col">
          {/* PHONE (<md): compact header — identity + language only */}
          <header className="sticky top-0 z-40 bg-indigo-600 shadow-md md:hidden">
            <div className="mx-auto flex h-14 w-full max-w-2xl items-center gap-3 px-4">
              <img
                src={logo}
                alt="MBK International School"
                className="h-9 w-9 shrink-0 rounded-full bg-white/95 object-contain p-0.5"
              />
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-bold leading-tight text-white">MBK International School</p>
                <p className="truncate text-[11px] leading-tight text-white/80">
                  {t('parent.hello', 'Hello')}, {firstName}
                </p>
              </div>
              <button
                type="button"
                onClick={() => setLanguage(language === 'en' ? 'ar' : 'en')}
                className="flex min-h-9 items-center gap-1.5 rounded-full bg-white/15 px-3 text-xs font-bold text-white transition hover:bg-white/25"
                aria-label={t('language.switch')}
              >
                <Languages className="h-4 w-4" aria-hidden="true" />
                {LANGUAGE_SHORT[language === 'en' ? 'ar' : 'en']}
              </button>
            </div>
          </header>

          {/* TABLET / DESKTOP (md+): the floating language switcher parents had before */}
          <div className="hidden md:block">
            <LanguageSwitcher />
          </div>

          {/* Page content — phone-first width; wider with room for the
              floating language switcher on tablet/desktop */}
          <main className="parent-main mx-auto w-full max-w-2xl flex-1 px-4 pt-5 md:max-w-4xl md:px-8 md:pt-20" id="parent-main">
            {children(currentPath, navigate)}
          </main>

          <footer className="hidden border-t border-slate-200 px-4 py-3 text-center md:block">
            <p className="text-sm text-slate-400" style={{ fontFamily: "'Dancing Script', cursive", fontSize: '1rem' }}>
              {t('app.madeBy', 'Made by')} <span className="font-bold text-indigo-500">Eng. Akso</span>
            </p>
          </footer>
        </div>

        {/* PHONE (<md): fixed bottom navigation — the primary navigation */}
        <nav
          aria-label={t('parent.navigation', 'Parent navigation')}
          className="parent-bottom-nav fixed inset-x-0 bottom-0 z-40 border-t border-slate-200 bg-white/95 backdrop-blur md:hidden"
        >
          <div className="mx-auto flex w-full max-w-2xl items-stretch">
            {PARENT_BOTTOM_NAV.map(item => {
              const active = item.isActive(currentPath);
              return (
                <button
                  key={item.key}
                  type="button"
                  data-testid={`parent-nav-${item.key}`}
                  aria-current={active ? 'page' : undefined}
                  onClick={() => navigate(item.path)}
                  className={cn(
                    'flex min-h-[60px] min-w-0 flex-1 flex-col items-center justify-center gap-0.5 py-2 transition-colors',
                    active ? 'text-indigo-600' : 'text-slate-500 hover:text-slate-700',
                  )}
                >
                  <item.icon className="h-6 w-6 shrink-0" aria-hidden="true" />
                  <span className="max-w-full truncate px-1 text-[11px] font-semibold leading-tight">
                    {t(item.labelKey, item.fallback)}
                  </span>
                  {active && <span className="h-1 w-8 rounded-full bg-indigo-600" aria-hidden="true" />}
                </button>
              );
            })}
          </div>
        </nav>
      </div>
    </ParentProvider>
  );
}
