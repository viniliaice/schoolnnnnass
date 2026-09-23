// PARENT — More screen.
//
// Everything that is NOT one of the four daily jobs (Home / Children /
// Results / Messages) lives here, as a short list of big, clearly-labelled
// rows. Secondary features first, then Settings, Account and a tiny Help
// block. Nothing technical on the surface — the appearance switcher and
// account info that used to sit in the staff sidebar live here for parents.

import { useEffect, useState } from 'react';
import { useRole } from '../../context/RoleContext';
import { useI18n, type AppLanguage } from '../../lib/i18n/AppLanguageContext';
import {
  Activity,
  BadgeCheck,
  BookOpen,
  ChevronRight,
  HelpCircle,
  Languages,
  LogOut,
  Mail,
  type LucideIcon,
} from 'lucide-react';
import { cn } from '../../utils/cn';
import { ThemeSwitcher } from '../../components/ui/ThemeSwitcher';
import { useParentContext } from './ParentContext';
import { getParentFamilyCard } from '../../lib/db/familyPortal';
import { FamilyIdCard, classifyFamilyCard, type FamilyCardState } from './components/FamilyIdCard';
import { RecentReleases } from './components/RecentReleases';

interface MoreRow {
  key: string;
  icon: LucideIcon;
  title: string;
  subtitle: string;
  path: string;
  iconClass: string;
}

const MORE_ROWS: MoreRow[] = [
  {
    key: 'quiz',
    icon: HelpCircle,
    title: 'Take Quiz',
    subtitle: 'Practice quizzes for your children',
    path: '/parent/quizzes',
    iconClass: 'bg-indigo-100 text-indigo-600',
  },
  {
    key: 'learning',
    icon: BookOpen,
    title: 'Today’s Learning',
    subtitle: 'What your child is learning this week',
    path: '/parent/weekly-learning',
    iconClass: 'bg-indigo-50 text-indigo-600',
  },
  {
    key: 'updates',
    icon: Activity,
    title: 'Activity Updates',
    subtitle: 'Attendance and homework updates',
    path: '/streams',
    iconClass: 'bg-cyan-100 text-cyan-600',
  },
  {
    key: 'pickup',
    icon: BadgeCheck,
    title: 'School Pickup Card',
    subtitle: 'Your family card for gate pickup',
    path: '/parent/pickup-card',
    iconClass: 'bg-emerald-100 text-emerald-600',
  },
  {
    key: 'messages',
    icon: Mail,
    title: 'Messages',
    subtitle: 'Send a message to the school',
    path: '/messages',
    iconClass: 'bg-amber-100 text-amber-600',
  },
];

const LANGUAGE_OPTIONS: Array<{ id: AppLanguage; label: string }> = [
  { id: 'en', label: 'English' },
  { id: 'ar', label: 'العربية' },
];

export function MorePage({ navigate }: { navigate: (path: string) => void }) {
  const { session, logout } = useRole();
  const { language, setLanguage, t } = useI18n();
  const parentCtx = useParentContext();
  const [signingOut, setSigningOut] = useState(false);

  const childCount = parentCtx?.kids.length ?? 0;

  const handleSignOut = async () => {
    setSigningOut(true);
    try {
      await logout();
    } finally {
      setSigningOut(false);
    }
  };

  return (
    <div className="space-y-6" data-testid="parent-more">
      <div>
        <h1 className="text-2xl font-bold text-slate-900">{t('nav.More', 'More')}</h1>
        <p className="mt-1 text-slate-500">More features and settings</p>
      </div>

      {/* Secondary features — Take Quiz is here, NOT on the main navigation */}
      <div className="overflow-hidden rounded-2xl border border-slate-200 bg-white">
        {MORE_ROWS.map((row, index) => (
          <button
            key={row.key}
            type="button"
            data-testid={`more-${row.key}`}
            onClick={() => navigate(row.path)}
            className={cn(
              'flex min-h-[64px] w-full items-center gap-3 p-4 text-left transition-colors hover:bg-slate-50',
              index > 0 && 'border-t border-slate-100',
            )}
          >
            <span className={cn('flex h-11 w-11 shrink-0 items-center justify-center rounded-xl', row.iconClass)}>
              <row.icon className="h-5 w-5" aria-hidden="true" />
            </span>
            <span className="min-w-0 flex-1">
              <span className="block truncate text-sm font-bold text-slate-900">{row.title}</span>
              <span className="block truncate text-xs text-slate-500">{row.subtitle}</span>
            </span>
            <ChevronRight className="h-5 w-5 shrink-0 text-slate-300" aria-hidden="true" />
          </button>
        ))}
      </div>

      {/* Settings — language + appearance (moved OFF the main dashboard) */}
      <section aria-label="Settings" className="space-y-3">
        <h2 className="text-sm font-bold uppercase tracking-wide text-slate-500">Settings</h2>
        <div className="rounded-2xl border border-slate-200 bg-white p-4">
          <p className="mb-3 flex items-center gap-2 text-sm font-bold text-slate-900">
            <Languages className="h-4 w-4 text-slate-400" aria-hidden="true" />
            {t('language.switch', 'Change language')}
          </p>
          <div className="grid grid-cols-2 gap-2">
            {LANGUAGE_OPTIONS.map(option => (
              <button
                key={option.id}
                type="button"
                aria-pressed={language === option.id}
                onClick={() => setLanguage(option.id)}
                className={cn(
                  'min-h-[48px] rounded-xl text-sm font-bold transition-colors',
                  language === option.id
                    ? 'bg-indigo-600 text-white'
                    : 'border border-slate-200 bg-white text-slate-600 hover:bg-slate-50',
                )}
              >
                {option.label}
              </button>
            ))}
          </div>
        </div>
        <ThemeSwitcher />
      </section>

      {/* Account — the only account info parents see, plus sign out */}
      <section aria-label="Account" className="space-y-3">
        <h2 className="text-sm font-bold uppercase tracking-wide text-slate-500">Account</h2>
        <div className="rounded-2xl border border-slate-200 bg-white p-4">
          <div className="flex items-center gap-3">
            <span className="flex h-12 w-12 shrink-0 items-center justify-center rounded-full bg-indigo-50 text-base font-bold text-indigo-600">
              {(session?.userName ?? '?').split(' ').map(n => n[0]).join('').substring(0, 2)}
            </span>
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-bold text-slate-900">{session?.userName}</p>
              <p className="text-xs text-slate-500">
                {t('role.parent', 'Parent')}
                {childCount > 0 ? ` · ${childCount} ${childCount === 1 ? 'child' : 'children'}` : ''}
              </p>
            </div>
          </div>
          <button
            type="button"
            data-testid="more-sign-out"
            onClick={handleSignOut}
            disabled={signingOut}
            className="mt-4 flex min-h-[48px] w-full items-center justify-center gap-2 rounded-xl border border-red-200 bg-red-50 text-sm font-bold text-red-600 transition-colors hover:bg-red-100 disabled:opacity-60"
          >
            <LogOut className="h-4 w-4" aria-hidden="true" />
            {signingOut ? 'Signing out…' : t('session.signOut', 'Sign Out')}
          </button>
        </div>
      </section>

      {/* Help — three plain sentences, no manual required */}
      <section aria-label="Help" className="rounded-2xl border border-slate-200 bg-white p-4">
        <h2 className="text-sm font-bold uppercase tracking-wide text-slate-500">Help</h2>
        <ul className="mt-3 list-disc space-y-2 pl-5 text-sm leading-relaxed text-slate-600">
          <li>Tap <span className="font-semibold text-slate-900">Results</span> to see Monthly, Midterm and Final reports.</li>
          <li>Tap a child anywhere to switch between your children.</li>
          <li>For anything else, message the school from <span className="font-semibold text-slate-900">Messages</span>.</li>
        </ul>
        <p className="mt-4 border-t border-slate-100 pt-3 text-sm">
          <a
            href="/privacy-policy"
            className="font-semibold text-indigo-600 underline underline-offset-2 transition-colors hover:text-indigo-700"
          >
            Privacy Policy
          </a>
          <span className="text-slate-500"> — how the school handles your family's information.</span>
        </p>
        <p className="mt-3 border-t border-slate-100 pt-3 text-center text-xs text-slate-400">
          MBK International School · {t('app.madeBy', 'Made by')}{' '}
          <span className="font-bold text-indigo-400">Eng. Akso</span>
        </p>
      </section>
    </div>
  );
}

/**
 * School Pickup Card — the administrative home of the Family ID.
 *
 * The Family ID is only needed at the school gate when picking children up,
 * so it no longer sits on the Home screen. The card and recent-pickup feed
 * components are reused UNCHANGED — same queries, same printable PDF.
 */
export function PickupCardPage() {
  const { session } = useRole();
  const [familyCard, setFamilyCard] = useState<FamilyCardState>({ status: 'loading' });

  useEffect(() => {
    if (!session) return;
    getParentFamilyCard(session.userId)
      .then(card => setFamilyCard(classifyFamilyCard(false, card.familyId, card.students)))
      .catch(() => setFamilyCard({ status: 'pending', students: [] }));
  }, [session]);

  if (!session) return null;

  return (
    <div className="space-y-4" data-testid="pickup-card-page">
      <div>
        <h1 className="text-2xl font-bold text-slate-900">School Pickup Card</h1>
        <p className="mt-1 text-sm text-slate-500">
          Show this card at the gate when you pick up your children.
        </p>
      </div>
      <FamilyIdCard state={familyCard} />
      <RecentReleases parentId={session.userId} />
    </div>
  );
}
