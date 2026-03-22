import { type ReactNode, useState, useCallback } from 'react';
import { Sidebar } from './Sidebar';

interface DashboardLayoutProps {
  children: (currentPath: string, navigate: (path: string) => void) => ReactNode;
  initialPath?: string;
}

export function DashboardLayout({ children, initialPath = '/dashboard' }: DashboardLayoutProps) {
  const [currentPath, setCurrentPath] = useState(initialPath);

  const navigate = useCallback((path: string) => {
    setCurrentPath(path);
  }, []);

  return (
    <div className="flex min-h-screen bg-slate-50">
      <Sidebar currentPath={currentPath} onNavigate={navigate} />
      <main className="flex-1 min-w-0">
        <div className="p-4 lg:p-8 pt-16 lg:pt-8 max-w-7xl mx-auto">
          {children(currentPath, navigate)}
        </div>
      </main>
    </div>
  );
}
