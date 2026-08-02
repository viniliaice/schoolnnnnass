import { type ReactNode, useState, useCallback } from 'react';
import { Sidebar } from './Sidebar';

interface DashboardLayoutProps {
  children: (currentPath: string, navigate: (path: string) => void) => ReactNode;
  initialPath?: string;
  /** Paths rendered without sidebar/footer chrome (e.g. the mobile gate). */
  fullscreenPaths?: string[];
}

export function DashboardLayout({ children, initialPath = '/dashboard', fullscreenPaths = [] }: DashboardLayoutProps) {
  const [currentPath, setCurrentPath] = useState(initialPath);

  const navigate = useCallback((path: string) => {
    setCurrentPath(path);
  }, []);

  // Mobile-first full-screen routes (no sidebar, no footer, edge-to-edge).
  if (fullscreenPaths.includes(currentPath)) {
    return <main className="min-h-screen bg-slate-100">{children(currentPath, navigate)}</main>;
  }

  return (
    <div className="flex min-h-screen bg-slate-50">
      <Sidebar currentPath={currentPath} onNavigate={navigate} />
      <main className="flex-1 min-w-0 flex flex-col">
        <div className="p-4 lg:p-8 pt-16 lg:pt-8 max-w-7xl mx-auto flex-1 w-full">
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
