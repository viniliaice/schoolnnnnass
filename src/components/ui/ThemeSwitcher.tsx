import { useEffect, useMemo, useState } from 'react';
import { Moon, Palette, Sun } from 'lucide-react';
import { cn } from '../../utils/cn';

type ThemeId = 'acanthus' | 'baroque' | 'aurora';
type AppearanceMode = 'light' | 'dark';

const THEMES: Array<{ id: ThemeId; label: string; description: string }> = [
  { id: 'acanthus', label: 'Acanthus', description: 'Classical private-school elegance' },
  { id: 'baroque', label: 'Baroque', description: 'Grand dramatic opulence' },
  { id: 'aurora', label: 'Aurora', description: 'Futuristic ambient wonder' },
];

const THEME_STORAGE_KEY = 'school-theme';
const MODE_STORAGE_KEY = 'school-appearance-mode';

function isTheme(value: string | null): value is ThemeId {
  return THEMES.some(theme => theme.id === value);
}

function isMode(value: string | null): value is AppearanceMode {
  return value === 'light' || value === 'dark';
}

export function applyStoredAppearance() {
  if (typeof window === 'undefined') return;
  const theme = isTheme(window.localStorage.getItem(THEME_STORAGE_KEY))
    ? (window.localStorage.getItem(THEME_STORAGE_KEY) as ThemeId)
    : 'acanthus';
  const mode = isMode(window.localStorage.getItem(MODE_STORAGE_KEY))
    ? (window.localStorage.getItem(MODE_STORAGE_KEY) as AppearanceMode)
    : 'dark';
  document.documentElement.dataset.theme = theme;
  document.documentElement.dataset.mode = mode;
}

function getInitialTheme(): ThemeId {
  if (typeof window === 'undefined') return 'acanthus';
  const stored = window.localStorage.getItem(THEME_STORAGE_KEY);
  return isTheme(stored) ? stored : 'acanthus';
}

function getInitialMode(): AppearanceMode {
  if (typeof window === 'undefined') return 'dark';
  const stored = window.localStorage.getItem(MODE_STORAGE_KEY);
  return isMode(stored) ? stored : 'dark';
}

export function ThemeSwitcher() {
  const [theme, setTheme] = useState<ThemeId>(getInitialTheme);
  const [mode, setMode] = useState<AppearanceMode>(getInitialMode);
  const selectedTheme = useMemo(() => THEMES.find(item => item.id === theme) ?? THEMES[0], [theme]);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    window.localStorage.setItem(THEME_STORAGE_KEY, theme);
  }, [theme]);

  useEffect(() => {
    document.documentElement.dataset.mode = mode;
    window.localStorage.setItem(MODE_STORAGE_KEY, mode);
  }, [mode]);

  return (
    <section className="theme-switcher w-full rounded-2xl border p-3 shadow-lg backdrop-blur-xl">
      <div className="mb-3 flex items-center gap-2">
        <Palette className="h-4 w-4" aria-hidden="true" />
        <div className="leading-tight">
          <p className="text-[10px] font-bold uppercase tracking-[0.22em]">Appearance</p>
          <p className="text-xs opacity-75">{selectedTheme.description}</p>
        </div>
      </div>

      <label className="mb-1 block text-[11px] font-semibold uppercase tracking-[0.16em] opacity-75" htmlFor="theme-select">
        Choose Theme
      </label>
      <select
        id="theme-select"
        value={theme}
        onChange={event => setTheme(event.target.value as ThemeId)}
        className="mb-3 w-full rounded-xl border px-3 py-2 text-sm font-semibold"
      >
        {THEMES.map(item => (
          <option key={item.id} value={item.id}>{item.label}</option>
        ))}
      </select>

      <div className="flex items-center justify-between gap-3 rounded-xl border px-3 py-2">
        <span className={cn('flex items-center gap-1.5 text-xs font-semibold', mode === 'light' ? 'opacity-100' : 'opacity-55')}>
          <Sun className="h-3.5 w-3.5" /> Light Mode
        </span>
        <button
          type="button"
          aria-label="Toggle light or dark appearance mode"
          aria-pressed={mode === 'dark'}
          onClick={() => setMode(current => current === 'dark' ? 'light' : 'dark')}
          className={cn(
            'relative h-6 w-11 shrink-0 rounded-full border transition-all',
            mode === 'dark' ? 'theme-option-active' : 'bg-white/20',
          )}
        >
          <span
            className={cn(
              'absolute top-0.5 h-4.5 w-4.5 rounded-full bg-current transition-transform',
              mode === 'dark' ? 'translate-x-5' : 'translate-x-0.5',
            )}
          />
        </button>
        <span className={cn('flex items-center gap-1.5 text-xs font-semibold', mode === 'dark' ? 'opacity-100' : 'opacity-55')}>
          <Moon className="h-3.5 w-3.5" /> Dark Mode
        </span>
      </div>
    </section>
  );
}
