import { useState } from 'react';
import { useRole } from '../../context/RoleContext';
import { Role } from '../../types';
import {
  LayoutDashboard, Users, ClipboardCheck, GraduationCap, FileText,
  Upload, LogOut, Menu, X, BookOpen, ChevronRight, School,
  Calendar, FileBarChart, Award, DatabaseBackup
} from 'lucide-react';
import { cn } from '../../utils/cn';

interface NavItem {
  label: string;
  icon: typeof LayoutDashboard;
  path: string;
}

const navItems: Record<Role, NavItem[]> = {
  admin: [
    { label: 'Dashboard', icon: LayoutDashboard, path: '/dashboard' },
    { label: 'Manage Users', icon: Users, path: '/admin/users' },
    { label: 'Manage Students', icon: GraduationCap, path: '/admin/students' },
    { label: 'Bulk Import', icon: DatabaseBackup, path: '/admin/bulk' },
    { label: 'Exam Verification', icon: ClipboardCheck, path: '/admin/exams' },
  ],
  teacher: [
    { label: 'Dashboard', icon: LayoutDashboard, path: '/dashboard' },
    { label: 'My Classes', icon: GraduationCap, path: '/teacher/students' },
    { label: 'Upload Results', icon: Upload, path: '/teacher/results' },
    { label: 'My Submissions', icon: FileText, path: '/teacher/all-results' },
  ],
  parent: [
    { label: 'Dashboard', icon: LayoutDashboard, path: '/dashboard' },
    { label: 'My Children', icon: Users, path: '/parent/children' },
    { label: 'Exam Results', icon: BookOpen, path: '/parent/results' },
    { label: 'Monthly Reports', icon: Calendar, path: '/parent/monthly' },
    { label: 'Midterm Reports', icon: FileBarChart, path: '/parent/midterm' },
    { label: 'Final Reports', icon: Award, path: '/parent/final' },
  ],
};

const roleColors: Record<Role, string> = {
  admin: 'from-indigo-600 to-indigo-800',
  teacher: 'from-teal-600 to-teal-800',
  parent: 'from-violet-600 to-violet-800',
};

const roleBadgeColors: Record<Role, string> = {
  admin: 'bg-indigo-500/20 text-indigo-100',
  teacher: 'bg-teal-500/20 text-teal-100',
  parent: 'bg-violet-500/20 text-violet-100',
};

interface SidebarProps {
  currentPath: string;
  onNavigate: (path: string) => void;
}

export function Sidebar({ currentPath, onNavigate }: SidebarProps) {
  const { session, logout } = useRole();
  const [mobileOpen, setMobileOpen] = useState(false);

  if (!session) return null;

  const items = navItems[session.role];
  const gradientClass = roleColors[session.role];

  const sidebarContent = (
    <div className={cn("flex flex-col h-full bg-gradient-to-b", gradientClass)}>
      {/* Logo */}
      <div className="p-5 pb-4">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-xl bg-white/20 flex items-center justify-center backdrop-blur-sm">
            <School className="w-6 h-6 text-white" />
          </div>
          <div>
            <h1 className="text-lg font-bold text-white tracking-tight">CampusConnect</h1>
            <span className={cn("text-xs px-2 py-0.5 rounded-full font-medium", roleBadgeColors[session.role])}>
              {session.role.charAt(0).toUpperCase() + session.role.slice(1)}
            </span>
          </div>
        </div>
      </div>

      {/* User */}
      <div className="px-5 pb-4">
        <div className="bg-white/10 rounded-xl p-3 backdrop-blur-sm">
          <div className="flex items-center gap-3">
            <div className="w-9 h-9 rounded-full bg-white/20 flex items-center justify-center text-white font-bold text-sm">
              {session.userName.split(' ').map(n => n[0]).join('').substring(0, 2)}
            </div>
            <div className="min-w-0">
              <p className="text-sm font-semibold text-white truncate">{session.userName}</p>
              <p className="text-xs text-white/60">Active Session</p>
            </div>
          </div>
        </div>
      </div>

      {/* Nav */}
      <nav className="flex-1 px-3 space-y-1 overflow-y-auto">
        {items.map(item => {
          const isActive = currentPath === item.path;
          return (
            <button
              key={item.path}
              onClick={() => { onNavigate(item.path); setMobileOpen(false); }}
              className={cn(
                "w-full flex items-center gap-3 px-3 py-2.5 rounded-xl text-sm font-medium transition-all duration-200",
                isActive
                  ? "bg-white/20 text-white shadow-lg shadow-black/10 backdrop-blur-sm"
                  : "text-white/70 hover:text-white hover:bg-white/10"
              )}
            >
              <item.icon className="w-5 h-5 flex-shrink-0" />
              <span className="flex-1 text-left">{item.label}</span>
              {isActive && <ChevronRight className="w-4 h-4 opacity-60" />}
            </button>
          );
        })}
      </nav>

      {/* Logout */}
      <div className="p-3 mt-auto">
        <button
          onClick={logout}
          className="w-full flex items-center gap-3 px-3 py-2.5 rounded-xl text-sm font-medium text-white/70 hover:text-white hover:bg-white/10 transition-all"
        >
          <LogOut className="w-5 h-5" />
          <span>Sign Out</span>
        </button>
      </div>
    </div>
  );

  return (
    <>
      {/* Mobile toggle */}
      <button
        onClick={() => setMobileOpen(true)}
        className="lg:hidden fixed top-4 left-4 z-50 p-2.5 bg-white rounded-xl shadow-lg border border-slate-200 text-slate-600 hover:text-slate-900"
      >
        <Menu className="w-5 h-5" />
      </button>

      {/* Mobile overlay */}
      {mobileOpen && (
        <div className="lg:hidden fixed inset-0 z-50">
          <div className="absolute inset-0 bg-black/50" onClick={() => setMobileOpen(false)} />
          <div className="absolute left-0 top-0 bottom-0 w-72 animate-[slideRight_0.2s_ease-out]">
            <button
              onClick={() => setMobileOpen(false)}
              className="absolute top-4 right-4 z-10 p-1.5 rounded-lg bg-white/20 text-white"
            >
              <X className="w-4 h-4" />
            </button>
            {sidebarContent}
          </div>
        </div>
      )}

      {/* Desktop sidebar */}
      <div className="hidden lg:block w-64 flex-shrink-0 h-screen sticky top-0">
        {sidebarContent}
      </div>
    </>
  );
}
