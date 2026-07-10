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

export function ThemeSwitcher({ compact }: { compact?: boolean }) {
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
    <section className={cn("theme-switcher w-full rounded-xl border shadow-lg backdrop-blur-xl", compact ? "p-1.5" : "p-3")}>
      <div className={cn("flex items-center gap-1.5", compact ? "mb-1" : "mb-3")}>
        <Palette className={compact ? "h-3 w-3" : "h-4 w-4"} aria-hidden="true" />
        <p className={cn("font-bold uppercase tracking-[0.22em]", compact ? "text-[8px]" : "text-[10px]")}>Appearance</p>
      </div>

      <div className={cn("flex items-center gap-1", compact ? "mb-1" : "mb-3")}>
        <select
          id="theme-select"
          value={theme}
          onChange={event => setTheme(event.target.value as ThemeId)}
          className={cn("flex-1 rounded-lg border font-semibold", compact ? "px-1.5 py-1 text-[10px]" : "px-3 py-2 text-sm")}
        >
          {THEMES.map(item => (
            <option key={item.id} value={item.id}>{item.label}</option>
          ))}
        </select>
        <button
          type="button"
          aria-label="Toggle light or dark mode"
          aria-pressed={mode === 'dark'}
          onClick={() => setMode(current => current === 'dark' ? 'light' : 'dark')}
          className={cn(
            'flex items-center gap-1 rounded-lg border px-1.5 py-1 text-[10px] font-semibold shrink-0',
            mode === 'light' ? 'opacity-100' : 'opacity-55'
          )}
        >
          {mode === 'light' ? <Sun className="h-3 w-3" /> : <Moon className="h-3 w-3" />}
          {mode === 'light' ? 'Light' : 'Dark'}
        </button>
      </div>
    </section>
  );
}
