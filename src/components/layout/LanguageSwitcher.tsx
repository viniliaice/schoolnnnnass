// Language switcher (EN / ع).
//
// Lives in its own module so the sidebar can reuse it without importing the
// layout that renders the sidebar (the layout imports the sidebar, so a
// back-import would be a cycle). Two presentations, one implementation:
//
//   floating (default) → viewport-pinned pill for tablet/desktop (lg+);
//   inline             → compact row inside the sidebar account panel, which is
//                        how phones switch language now that the pill is
//                        desktop-only.

import { Languages } from 'lucide-react';
import { cn } from '../../utils/cn';
import { useI18n, type AppLanguage } from '../../lib/i18n/AppLanguageContext';

export const LANGUAGE_LABELS: Record<AppLanguage, { short: string; key: string }> = {
  en: { short: 'EN', key: 'language.english' },
  ar: { short: 'عربي', key: 'language.arabic' },
};

export function LanguageSwitcher({
  className,
  variant = 'floating',
}: {
  className?: string;
  variant?: 'floating' | 'inline';
} = {}) {
  const { language, setLanguage, t } = useI18n();

  return (
    <div
      className={cn(
        variant === 'floating'
          ? 'fixed right-4 top-4 z-40 rounded-2xl border border-slate-200 bg-white/95 p-1.5 shadow-lg backdrop-blur lg:right-6 lg:top-6'
          : 'app-language-inline',
        className,
      )}
    >
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
