import { useEffect, useId, useRef, useState } from 'react';
import { useRole } from '../../context/RoleContext';
import { Role } from '../../types';
import { LogOut, Menu, X, ChevronRight } from 'lucide-react';
import { cn } from '../../utils/cn';
import { ThemeSwitcher } from '../ui/ThemeSwitcher';
import { navGroups } from './navConfig';
import logo from '../../../assets/logo.png';

const roleColors: Record<Role, string> = {
  admin: 'from-indigo-600 to-indigo-800',
  teacher: 'from-teal-600 to-teal-800',
  parent: 'from-violet-600 to-violet-800',
  supervisor: 'from-amber-600 to-amber-800',
};

const roleBadgeColors: Record<Role, string> = {
  admin: 'bg-indigo-500/20 text-indigo-100',
  teacher: 'bg-teal-500/20 text-teal-100',
  parent: 'bg-violet-500/20 text-violet-100',
  supervisor: 'bg-amber-500/20 text-amber-100',
};

interface SidebarProps {
  currentPath: string;
  onNavigate: (path: string) => void;
}

export function Sidebar({ currentPath, onNavigate }: SidebarProps) {
  const { session, logout } = useRole();
  const [mobileOpen, setMobileOpen] = useState(false);
  const drawerRef = useRef<HTMLDivElement>(null);
  const openButtonRef = useRef<HTMLButtonElement>(null);
  const baseId = useId();

  // Drawer: close on Escape, keep Tab focus inside, restore focus on close.
  useEffect(() => {
    if (!mobileOpen) return;

    const focusables = () => Array.from(
      drawerRef.current?.querySelectorAll<HTMLElement>(
        'a[href], button:not([disabled]), select, input, [tabindex]:not([tabindex="-1"])'
      ) ?? []
    ).filter(el => el.offsetParent !== null);

    focusables()[0]?.focus();

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        setMobileOpen(false);
        return;
      }
      if (event.key !== 'Tab') return;

      const items = focusables();
      if (items.length === 0) return;
      const first = items[0];
      const last = items[items.length - 1];
      const active = document.activeElement as HTMLElement | null;

      if (event.shiftKey && (active === first || !drawerRef.current?.contains(active))) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && active === last) {
        event.preventDefault();
        first.focus();
      }
    };

    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      openButtonRef.current?.focus();
    };
  }, [mobileOpen]);

  if (!session) return null;

  const groups = navGroups[session.role];
  const gradientClass = roleColors[session.role];

  // Rendered twice (mobile drawer + desktop rail), so IDs are namespaced per
  // variant to avoid duplicate DOM ids breaking aria-labelledby.
  const renderSidebar = (variant: 'mobile' | 'desktop') => {
    const navId = `${baseId}-${variant}`;
    return (
      <div className={cn("theme-sidebar flex flex-col h-full bg-linear-to-b", gradientClass)}>
        {/* Logo */}
        <div className="p-5 pb-2">
          <div className="flex flex-col items-center gap-1">
            <img src={logo} alt="MBK International School" className="w-20 h-20 object-contain" />
            <h1 className="text-sm font-bold text-white tracking-tight text-center">MBK International School</h1>
            <span className={cn("text-xs px-2 py-0.5 rounded-full font-medium", roleBadgeColors[session.role])}>
              {session.role.charAt(0).toUpperCase() + session.role.slice(1)}
            </span>
          </div>
        </div>

        {/* User */}
        <div className="px-5 pb-2">
          <div className="bg-white/10 rounded-xl p-3 backdrop-blur-sm">
            <div className="flex items-center gap-3">
              <div className="w-9 h-9 rounded-full bg-white/20 flex items-center justify-center text-white font-bold text-sm shrink-0">
                {session.userName.split(' ').map(n => n[0]).join('').substring(0, 2)}
              </div>
              <div className="min-w-0 flex-1">
                <p className="text-sm font-semibold text-white truncate">{session.userName}</p>
                <p className="text-xs text-white/60">Active Session</p>
              </div>
              <button
                onClick={logout}
                className="shrink-0 w-8 h-8 rounded-lg flex items-center justify-center text-white/50 hover:text-white hover:bg-white/10 transition-all"
                title="Sign Out"
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

        {/* Nav */}
        <nav aria-label="Main navigation" className="flex-1 px-3 pb-4 space-y-3 overflow-y-auto">
          {groups.map((group, groupIndex) => {
            const headingId = group.title ? `${navId}-group-${groupIndex}` : undefined;
            return (
              <div
                key={group.title ?? `group-${groupIndex}`}
                className="space-y-1"
                role="group"
                aria-labelledby={headingId}
              >
                {group.title && (
                  <p
                    id={headingId}
                    className="px-3 pt-2 pb-0.5 text-[10px] font-bold uppercase tracking-[0.18em] text-white/40"
                  >
                    {group.title}
                  </p>
                )}
                {group.items.map(item => {
                  const isActive = currentPath === item.path;
                  return (
                    <button
                      key={item.path}
                      onClick={() => { onNavigate(item.path); setMobileOpen(false); }}
                      aria-current={isActive ? 'page' : undefined}
                      className={cn(
                        "w-full flex items-center gap-3 px-3 py-2.5 rounded-xl text-sm font-medium transition-all duration-200",
                        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/70 focus-visible:ring-offset-2 focus-visible:ring-offset-transparent",
                        isActive
                          ? "bg-white/20 text-white shadow-lg shadow-black/10 backdrop-blur-sm"
                          : "text-white/70 hover:text-white hover:bg-white/10"
                      )}
                    >
                      <item.icon className="w-5 h-5 shrink-0" aria-hidden="true" />
                      <span className="flex-1 text-left">{item.label}</span>
                      {isActive && <ChevronRight className="w-4 h-4 opacity-60" aria-hidden="true" />}
                    </button>
                  );
                })}
              </div>
            );
          })}
        </nav>


      </div>
    );
  };

  return (
    <>
      {/* Mobile toggle */}
      <button
        ref={openButtonRef}
        onClick={() => setMobileOpen(true)}
        aria-label="Open navigation menu"
        aria-expanded={mobileOpen}
        aria-haspopup="dialog"
        className="theme-card lg:hidden fixed top-4 left-4 z-50 p-2.5 rounded-xl shadow-lg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-current"
      >
        <Menu className="w-5 h-5" aria-hidden="true" />
      </button>

      {/* Mobile overlay */}
      {mobileOpen && (
        <div className="lg:hidden fixed inset-0 z-50">
          <div className="absolute inset-0 bg-black/50" onClick={() => setMobileOpen(false)} />
          <div
            ref={drawerRef}
            role="dialog"
            aria-modal="true"
            aria-label="Navigation menu"
            className="absolute left-0 top-0 bottom-0 w-64 animate-[slideRight_0.2s_ease-out]"
          >
            <button
              onClick={() => setMobileOpen(false)}
              aria-label="Close navigation menu"
              className="absolute top-4 right-4 z-10 p-1.5 rounded-lg bg-white/20 text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/70"
            >
              <X className="w-4 h-4" aria-hidden="true" />
            </button>
            {renderSidebar('mobile')}
          </div>
        </div>
      )}

      {/* Desktop sidebar */}
      <div className="hidden lg:block w-64 shrink-0 h-screen sticky top-0">
        {renderSidebar('desktop')}
      </div>
    </>
  );
}
