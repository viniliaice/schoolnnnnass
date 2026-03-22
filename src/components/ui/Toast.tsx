import { useToast } from '../../context/ToastContext';
import { X, CheckCircle, AlertCircle, Info, Loader2 } from 'lucide-react';

const icons = {
  success: CheckCircle,
  error: AlertCircle,
  info: Info,
  loading: Loader2,
};

const colors = {
  success: 'bg-emerald-50 border-emerald-200 text-emerald-800',
  error: 'bg-red-50 border-red-200 text-red-800',
  info: 'bg-blue-50 border-blue-200 text-blue-800',
  loading: 'bg-indigo-50 border-indigo-200 text-indigo-800',
};

const iconColors = {
  success: 'text-emerald-500',
  error: 'text-red-500',
  info: 'text-blue-500',
  loading: 'text-indigo-500',
};

export function ToastContainer() {
  const { toasts, removeToast } = useToast();

  if (toasts.length === 0) return null;

  return (
    <div className="fixed bottom-4 right-4 z-[100] flex flex-col gap-2 max-w-sm w-full">
      {toasts.map(toast => {
        const Icon = icons[toast.type];
        return (
          <div
            key={toast.id}
            className={`flex items-start gap-3 p-4 rounded-xl border shadow-lg animate-[slideIn_0.3s_ease-out] ${colors[toast.type]}`}
          >
            <Icon className={`w-5 h-5 mt-0.5 flex-shrink-0 ${iconColors[toast.type]} ${toast.type === 'loading' ? 'animate-spin' : ''}`} />
            <div className="flex-1 min-w-0">
              <p className="font-semibold text-sm">{toast.title}</p>
              {toast.description && <p className="text-xs mt-0.5 opacity-80">{toast.description}</p>}
            </div>
            <button onClick={() => removeToast(toast.id)} className="flex-shrink-0 opacity-60 hover:opacity-100 transition-opacity">
              <X className="w-4 h-4" />
            </button>
          </div>
        );
      })}
    </div>
  );
}
