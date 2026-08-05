import { createContext, useContext, useState, useCallback, type ReactNode } from 'react';
import { ToastMessage } from '../types';

interface ToastContextType {
  toasts: ToastMessage[];
  addToast: (toast: Omit<ToastMessage, 'id'>) => void;
  removeToast: (id: string) => void;
}

const ToastContext = createContext<ToastContextType | undefined>(undefined);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<ToastMessage[]>([]);

  const addToast = useCallback((toast: Omit<ToastMessage, 'id'>) => {
    const id = Date.now().toString(36) + Math.random().toString(36).substring(2);
    const newToast: ToastMessage = { ...toast, id };
    console.log('[Toast]', toast.type, toast.title, toast.description);
    setToasts(prev => [...prev, newToast]);
    // Keep errors visible until manually dismissed. Teachers/supervisors need
    // enough time to read operational failures such as AI/quiz generation errors.
    if (toast.type === 'loading' || toast.type === 'error') return;

    const timeoutMs = toast.type === 'warning' ? 10000 : 5000;
    setTimeout(() => {
      setToasts(prev => prev.filter(t => t.id !== id));
    }, timeoutMs);
  }, []);

  const removeToast = useCallback((id: string) => {
    setToasts(prev => prev.filter(t => t.id !== id));
  }, []);

  return (
    <ToastContext.Provider value={{ toasts, addToast, removeToast }}>
      {children}
    </ToastContext.Provider>
  );
}

export function useToast() {
  const context = useContext(ToastContext);
  if (!context) throw new Error('useToast must be used within a ToastProvider');
  return context;
}
