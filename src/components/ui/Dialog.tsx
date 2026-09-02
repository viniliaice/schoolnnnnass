import { type ReactNode, useCallback, useEffect, useRef } from 'react';
import { X } from 'lucide-react';
import { cn } from '../../utils/cn';

interface DialogProps {
  open: boolean;
  onClose: () => void;
  title: string;
  description?: string;
  children: ReactNode;
  className?: string;
  /** Hide the corner close button (for confirmations with explicit buttons). */
  hideCloseButton?: boolean;
}

const FOCUSABLE = [
  'a[href]', 'button:not([disabled])', 'textarea:not([disabled])',
  'input:not([disabled])', 'select:not([disabled])', '[tabindex]:not([tabindex="-1"])',
].join(',');

export function Dialog({
  open, onClose, title, description, children, className, hideCloseButton,
}: DialogProps) {
  const panelRef = useRef<HTMLDivElement>(null);
  // Where focus was before we opened, so we can hand it back on close.
  const restoreRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (!open) return undefined;
    document.body.style.overflow = 'hidden';
    return () => { document.body.style.overflow = ''; };
  }, [open]);

  // Move focus into the dialog on open, and restore it on close. Without this a
  // keyboard or screen-reader user stays parked on the button behind the
  // backdrop and can tab through content they cannot see.
  useEffect(() => {
    if (!open) return undefined;
    restoreRef.current = document.activeElement as HTMLElement | null;
    const panel = panelRef.current;
    const first = panel?.querySelector<HTMLElement>(FOCUSABLE);
    (first ?? panel)?.focus();
    return () => {
      const target = restoreRef.current;
      if (target && document.contains(target)) target.focus();
    };
  }, [open]);

  const onKeyDown = useCallback((event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Escape') {
      event.stopPropagation();
      onClose();
      return;
    }
    if (event.key !== 'Tab') return;
    // Cycle focus within the dialog.
    const nodes = Array.from(panelRef.current?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? [])
      .filter((node) => node.offsetParent !== null || node === document.activeElement);
    if (nodes.length === 0) return;
    const first = nodes[0];
    const last = nodes[nodes.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }, [onClose]);

  if (!open) return null;

  const titleId = 'dialog-title';
  const descId = description ? 'dialog-desc' : undefined;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center" onKeyDown={onKeyDown}>
      <div className="fixed inset-0 bg-black/50 backdrop-blur-sm" onClick={onClose} aria-hidden="true" />
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={descId}
        tabIndex={-1}
        className={cn(
          'relative bg-white rounded-2xl shadow-2xl w-full max-w-lg mx-4 max-h-[85vh] overflow-y-auto',
          'motion-safe:animate-[scaleIn_0.18s_ease-out] focus:outline-none',
          className,
        )}
      >
        <div className="flex items-start justify-between p-6 pb-2 gap-4">
          <div>
            <h2 id={titleId} className="text-lg font-bold text-slate-900">{title}</h2>
            {description && <p id={descId} className="text-sm text-slate-500 mt-1">{description}</p>}
          </div>
          {!hideCloseButton && (
            <button
              onClick={onClose}
              aria-label="Close dialog"
              className="p-2 rounded-lg hover:bg-slate-100 text-slate-400 hover:text-slate-600 transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-600"
            >
              <X className="w-5 h-5" />
            </button>
          )}
        </div>
        <div className="p-6 pt-4">{children}</div>
      </div>
    </div>
  );
}
