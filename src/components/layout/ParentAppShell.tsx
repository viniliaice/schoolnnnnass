// Mobile-first app shell for the PARENT role.
//
// The generic DashboardLayout renders a long staff sidebar (dashboard, admin
// tools, theme controls, "Active Session"…). Parents get this instead:
//
//   ┌──────────────────────────┐
//   │ header: logo · school · 🌐 │  compact, language always one tap away
//   ├──────────────────────────┤
//   │ content (max-w-2xl)      │  page scrolls here; padded for the nav
//   ├──────────────────────────┤
//   │ Home Children Results ✉ ⋯│  fixed bottom navigation, thumb-sized
//   └──────────────────────────┘
//
// The shell owns the current path (this app uses lightweight state-based
// navigation, see DashboardLayout) and provides ParentContext — children +
// active child — to everything it renders.

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
      <div className="min-h-screen bg-slate-50 text-slate-900">
        {/* Compact header — identity + language only, nothing technical */}
        <header className="sticky top-0 z-40 bg-linear-to-r from-violet-700 via-violet-600 to-indigo-700 shadow-md">
          <div className="mx-auto flex h-14 w-full max-w-2xl items-center gap-3 px-4">
            <img
              src={logo}
              alt="MBK International School"
              className="h-9 w-9 shrink-0 rounded-full bg-white/95 object-contain p-0.5"
            />
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-bold leading-tight text-white">MBK International School</p>
              <p className="truncate text-[11px] leading-tight text-violet-200">
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

        {/* Page content — phone-first width, padded clear of the bottom nav */}
        <main className="mx-auto w-full max-w-2xl px-4 pb-28 pt-5" id="parent-main">
          {children(currentPath, navigate)}
        </main>

        {/* Fixed bottom navigation — primary navigation for parents */}
        <nav
          aria-label={t('parent.navigation', 'Parent navigation')}
          className="fixed inset-x-0 bottom-0 z-40 border-t border-slate-200 bg-white/95 backdrop-blur pb-[env(safe-area-inset-bottom)]"
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
                    active ? 'text-violet-700' : 'text-slate-500 hover:text-slate-700',
                  )}
                >
                  <item.icon className="h-6 w-6 shrink-0" aria-hidden="true" />
                  <span className="max-w-full truncate px-1 text-[11px] font-semibold leading-tight">
                    {t(item.labelKey, item.fallback)}
                  </span>
                  {active && <span className="h-1 w-8 rounded-full bg-violet-600" aria-hidden="true" />}
                </button>
              );
            })}
          </div>
        </nav>
      </div>
    </ParentProvider>
  );
}
