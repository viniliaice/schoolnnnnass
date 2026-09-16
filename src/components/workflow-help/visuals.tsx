// Shared mock-UI primitives for the WorkflowHelp guides.
//
// Every guide visual is built from these small, non-interactive mock elements
// that mirror the REAL screens' styling (same borders, rounded corners, accent
// colors and labels). They are `aria-hidden` decoration — the meaningful
// explanation lives in the step summary + numbered legend callouts.

import type { ReactNode } from 'react';
import { ChevronDown } from 'lucide-react';
import { cn } from '../../utils/cn';

export const MARK_TONES = {
  amber: { ring: 'ring-2 ring-amber-400 dark:ring-amber-500', badge: 'bg-amber-400 text-amber-950 dark:bg-amber-500 dark:text-amber-950' },
  teal: { ring: 'ring-2 ring-teal-400 dark:ring-teal-500', badge: 'bg-teal-500 text-white dark:bg-teal-600' },
  indigo: { ring: 'ring-2 ring-indigo-400 dark:ring-indigo-500', badge: 'bg-indigo-500 text-white dark:bg-indigo-600' },
  red: { ring: 'ring-2 ring-red-400 dark:ring-red-500', badge: 'bg-red-500 text-white dark:bg-red-600' },
  slate: { ring: 'ring-2 ring-slate-400 dark:ring-slate-500', badge: 'bg-slate-500 text-white dark:bg-slate-600' },
} as const;

export type MarkTone = keyof typeof MARK_TONES;

/** Highlights a mock element with a colored ring + optional numbered badge. */
export function Mark({
  n,
  tone = 'amber',
  block = false,
  className,
  children,
}: {
  n?: number;
  tone?: MarkTone;
  /** Use when the highlighted element should span the full width of its container. */
  block?: boolean;
  className?: string;
  children: ReactNode;
}) {
  const t = MARK_TONES[tone];
  return (
    <span className={cn('relative align-middle', block ? 'block' : 'inline-block', className)}>
      <span className={cn(block ? 'flex rounded-md ring-offset-2 dark:ring-offset-slate-900' : 'inline-flex rounded-md ring-offset-2 dark:ring-offset-slate-900', t.ring)}>
        {children}
      </span>
      {n != null && (
        <span
          aria-hidden
          className={cn(
            'absolute -right-2 -top-2 z-10 flex h-4 w-4 items-center justify-center rounded-full text-[10px] font-bold',
            t.badge,
          )}
        >
          {n}
        </span>
      )}
    </span>
  );
}

/** Numbered callout list that explains the highlighted parts of a visual. */
export function Legend({ items }: { items: { n: number; tone?: MarkTone; text: ReactNode }[] }) {
  return (
    <ul className="mt-2.5 space-y-1.5">
      {items.map(item => (
        <li key={item.n} className="flex items-start gap-2 text-xs leading-relaxed text-slate-600 dark:text-slate-400">
          <span
            aria-hidden
            className={cn(
              'mt-px flex h-4 w-4 shrink-0 items-center justify-center rounded-full text-[10px] font-bold',
              MARK_TONES[item.tone ?? 'amber'].badge,
            )}
          >
            {item.n}
          </span>
          <span>{item.text}</span>
        </li>
      ))}
    </ul>
  );
}

/** A white app-style card container for a mock screen. */
export function MockCard({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div
      aria-hidden
      className={cn('pointer-events-none select-none rounded-2xl border border-slate-200 bg-white p-3 shadow-sm dark:border-slate-700 dark:bg-slate-800', className)}
    >
      {children}
    </div>
  );
}

export function MockLabel({ children }: { children: ReactNode }) {
  return <p className="mb-1 text-[11px] font-semibold text-slate-500 dark:text-slate-400">{children}</p>;
}

export function MockSelect({
  label,
  value,
  disabled,
  className,
}: {
  label: ReactNode;
  value: ReactNode;
  disabled?: boolean;
  className?: string;
}) {
  return (
    <label className={cn('block text-xs font-medium text-slate-600 dark:text-slate-400', className)}>
      {label}
      <span
        className={cn(
          'mt-1 flex items-center justify-between gap-2 rounded-lg border border-slate-300 bg-white px-2.5 py-1.5 text-slate-700 dark:border-slate-600 dark:bg-slate-700 dark:text-slate-200',
          disabled && 'bg-slate-50 text-slate-400 dark:bg-slate-800 dark:text-slate-500',
        )}
      >
        <span className="truncate">{value}</span>
        <ChevronDown aria-hidden className="h-3.5 w-3.5 shrink-0 text-slate-400 dark:text-slate-500" />
      </span>
    </label>
  );
}

export function MockInput({ label, value, optional }: { label: ReactNode; value: ReactNode; optional?: boolean }) {
  return (
    <label className="block text-xs font-medium text-slate-600 dark:text-slate-400">
      {label}
      <span className="mt-1 block truncate rounded-lg border border-slate-300 bg-white px-2.5 py-1.5 text-slate-700 dark:border-slate-600 dark:bg-slate-700 dark:text-slate-200">
        {value}
      </span>
      {optional && <span className="text-[10px] font-normal text-slate-400 dark:text-slate-500"> (optional)</span>}
    </label>
  );
}

/** Class-chip style selector pill (Bulk Upload step 1). */
export function MockChip({ children, active, tone = 'teal' }: { children: ReactNode; active?: boolean; tone?: 'teal' | 'indigo' }) {
  return (
    <span
      className={cn(
        'inline-flex items-center rounded-xl border px-3 py-2 text-sm font-medium',
        active
          ? tone === 'teal'
            ? 'border-teal-300 bg-teal-100 text-teal-800 dark:border-teal-700 dark:bg-teal-900/40 dark:text-teal-100'
            : 'border-indigo-300 bg-indigo-100 text-indigo-800 dark:border-indigo-700 dark:bg-indigo-900/40 dark:text-indigo-100'
          : 'border-slate-200 text-slate-600 dark:border-slate-600 dark:text-slate-400',
      )}
    >
      {children}
    </span>
  );
}

/** Checkbox-row mock (subject pickers). */
export function MockCheck({ children, checked, tone = 'teal' }: { children: ReactNode; checked?: boolean; tone?: 'teal' | 'indigo' }) {
  return (
    <span className="flex items-center gap-2 text-sm text-slate-700 dark:text-slate-300">
      <span
        aria-hidden
        className={cn(
          'flex h-4 w-4 items-center justify-center rounded border text-[10px] font-bold text-white',
          checked ? (tone === 'teal' ? 'border-teal-600 bg-teal-600 dark:border-teal-500 dark:bg-teal-500' : 'border-indigo-600 bg-indigo-600 dark:border-indigo-500 dark:bg-indigo-500') : 'border-slate-300 bg-white dark:border-slate-600 dark:bg-slate-700',
        )}
      >
        {checked ? '✓' : ''}
      </span>
      {children}
    </span>
  );
}

/** App-style button mock. */
export function MockButton({
  children,
  tone = 'teal',
  className,
}: {
  children: ReactNode;
  tone?: 'teal' | 'indigo' | 'outline' | 'disabled' | 'danger' | 'red';
  className?: string;
}) {
  const tones = {
    teal: 'bg-teal-600 text-white dark:bg-teal-600',
    indigo: 'bg-indigo-600 text-white dark:bg-indigo-600',
    outline: 'border border-slate-200 text-slate-700 dark:border-slate-600 dark:text-slate-300 dark:bg-slate-800',
    disabled: 'bg-slate-100 text-slate-400 dark:bg-slate-800 dark:text-slate-500',
    danger: 'bg-slate-800 text-white dark:bg-slate-700',
    red: 'border border-red-300 bg-white text-red-700 dark:border-red-700 dark:bg-red-900/20 dark:text-red-300',
  } as const;
  return (
    <span className={cn('inline-flex items-center justify-center gap-1.5 rounded-xl px-4 py-2 text-sm font-semibold', tones[tone], className)}>
      {children}
    </span>
  );
}

/** Toast mock (success/error feedback as shown in the app). */
export function MockToast({
  tone,
  title,
  description,
}: {
  tone: 'success' | 'error' | 'info';
  title: ReactNode;
  description?: ReactNode;
}) {
  const tones = {
    success: 'border-emerald-200 bg-emerald-50 text-emerald-900 dark:border-emerald-800 dark:bg-emerald-900/20 dark:text-emerald-100',
    error: 'border-red-200 bg-red-50 text-red-900 dark:border-red-800 dark:bg-red-900/20 dark:text-red-100',
    info: 'border-blue-200 bg-blue-50 text-blue-900 dark:border-blue-800 dark:bg-blue-900/20 dark:text-blue-100',
  } as const;
  const icon = tone === 'success' ? '✓' : tone === 'error' ? '✕' : 'i';
  return (
    <div className={cn('flex items-start gap-2 rounded-xl border p-3 text-left', tones[tone])}>
      <span
        aria-hidden
        className={cn(
          'mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-full text-[10px] font-bold text-white',
          tone === 'success' ? 'bg-emerald-500 dark:bg-emerald-600' : tone === 'error' ? 'bg-red-500 dark:bg-red-600' : 'bg-blue-500 dark:bg-blue-600',
        )}
      >
        {icon}
      </span>
      <span className="min-w-0">
        <span className="block text-sm font-semibold leading-snug">{title}</span>
        {description && <span className="block text-xs leading-snug opacity-80">{description}</span>}
      </span>
    </div>
  );
}

/** Simplified spreadsheet mock with row numbers and highlighted cells. */
export function SpreadsheetMock({
  headers,
  rows,
  className,
}: {
  headers: ReactNode[];
  rows: ReactNode[][];
  className?: string;
}) {
  return (
    <div aria-hidden className={cn('overflow-x-auto rounded-xl border border-slate-200 bg-white pt-2.5 dark:border-slate-700 dark:bg-slate-800', className)}>
      <table className="w-full min-w-[540px] border-collapse text-left">
        <thead>
          <tr className="border-b border-slate-200 bg-slate-100 dark:border-slate-700 dark:bg-slate-700">
            <th className="w-8 px-2 py-1.5 text-center text-[10px] font-bold text-slate-400 dark:text-slate-500">#</th>
            {headers.map((header, index) => (
              <th key={index} className="whitespace-nowrap px-2 py-1.5 text-[10px] font-bold uppercase tracking-wide text-slate-600 dark:text-slate-400">
                {header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, rowIndex) => (
            <tr key={rowIndex} className="border-b border-slate-100 last:border-0 dark:border-slate-700">
              <td className="px-2 py-1 text-center text-[10px] text-slate-400 dark:text-slate-500">{rowIndex + 1}</td>
              {row.map((cell, cellIndex) => (
                <td
                  key={cellIndex}
                  className={cn(
                    'whitespace-nowrap px-2 py-1.5 text-xs',
                    cellIndex === 0 ? 'sticky left-0 bg-slate-50 font-semibold text-slate-700 dark:bg-slate-700 dark:text-slate-200' : 'text-slate-600 dark:text-slate-400',
                  )}
                >
                  {cell}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** A colored score cell used inside SpreadsheetMock. */
export function ScoreCell({ children, tone = 'ok' }: { children: ReactNode; tone?: 'ok' | 'bad' | 'blank' | 'note' }) {
  const tones = {
    ok: 'bg-emerald-50 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-200',
    bad: 'bg-red-50 text-red-700 dark:bg-red-900/30 dark:text-red-200',
    blank: 'bg-slate-50 text-slate-400 dark:bg-slate-800 dark:text-slate-500',
    note: 'bg-amber-50 text-amber-700 dark:bg-amber-900/30 dark:text-amber-200',
  } as const;
  return (
    <span className={cn('inline-block rounded-md px-1.5 py-0.5 text-center font-mono font-semibold', tones[tone])}>
      {children}
    </span>
  );
}

/** The little stat/counter cards used on the Bulk Upload resolve + review steps. */
export function MockCountCard({
  label,
  count,
  tone = 'slate',
}: {
  label: ReactNode;
  count: ReactNode;
  tone?: 'teal' | 'amber' | 'red' | 'slate';
}) {
  const tones = {
    teal: 'bg-teal-50 text-teal-800 dark:bg-teal-900/30 dark:text-teal-100',
    amber: 'bg-amber-50 text-amber-800 dark:bg-amber-900/30 dark:text-amber-100',
    red: 'bg-red-50 text-red-800 dark:bg-red-900/30 dark:text-red-100',
    slate: 'bg-slate-100 text-slate-800 dark:bg-slate-700 dark:text-slate-200',
  } as const;
  return (
    <div className={cn('rounded-xl p-2.5 text-center', tones[tone])}>
      <p className="text-xl font-bold leading-none">{count}</p>
      <p className="mt-1 text-[10px] font-medium leading-tight">{label}</p>
    </div>
  );
}
