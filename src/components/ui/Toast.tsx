import { useToast } from '../../context/ToastContext';
import { X, CheckCircle, AlertCircle, AlertTriangle, Info, Loader2 } from 'lucide-react';

const icons = {
  success: CheckCircle,
  error: AlertCircle,
  warning: AlertTriangle,
  info: Info,
  loading: Loader2,
};

const colors = {
  success: 'bg-emerald-50 border-emerald-200 text-emerald-800',
  error: 'bg-red-50 border-red-200 text-red-800',
  warning: 'bg-amber-50 border-amber-200 text-amber-800',
  info: 'bg-blue-50 border-blue-200 text-blue-800',
  loading: 'bg-indigo-50 border-indigo-200 text-indigo-800',
};

const iconColors = {
  success: 'text-emerald-500',
  error: 'text-red-500',
  warning: 'text-amber-500',
  info: 'text-blue-500',
  loading: 'text-indigo-500',
};

export function ToastContainer() {
  const { toasts, removeToast } = useToast();

  if (toasts.length === 0) return null;

  return (
    <div
      className="fixed inset-x-3 top-[calc(env(safe-area-inset-top)+0.75rem)] z-[9999] flex max-h-[calc(100dvh-1.5rem-env(safe-area-inset-top)-env(safe-area-inset-bottom))] flex-col gap-2 overflow-y-auto sm:left-auto sm:right-4 sm:top-[calc(env(safe-area-inset-top)+1rem)] sm:w-full sm:max-w-sm"
      aria-live="assertive"
      aria-relevant="additions"
    >
      {toasts.map(toast => {
        const Icon = icons[toast.type];
        return (
          <div
            key={toast.id}
            className={`flex w-full items-start gap-3 rounded-xl border p-4 shadow-xl animate-[slideIn_0.3s_ease-out] ${colors[toast.type]}`}
          >
            <Icon className={`mt-0.5 h-5 w-5 flex-shrink-0 ${iconColors[toast.type]} ${toast.type === 'loading' ? 'animate-spin' : ''}`} />
            <div className="min-w-0 flex-1">
              <p className="text-sm font-semibold leading-5">{toast.title}</p>
              {toast.description && <p className="mt-1 max-h-40 overflow-y-auto whitespace-pre-wrap break-words text-xs leading-5 opacity-90">{toast.description}</p>}
            </div>
            <button
              onClick={() => removeToast(toast.id)}
              className="flex-shrink-0 rounded-lg p-1 opacity-60 transition-opacity hover:bg-black/5 hover:opacity-100"
              aria-label="Dismiss notification"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
        );
      })}
    </div>
  );
}
