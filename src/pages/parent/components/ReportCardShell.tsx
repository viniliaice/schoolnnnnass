// Shared report card frame for the parent Exam Results screen.
//
// Monthly, Midterm and Final reports all render inside this shell so a parent
// always sees the same structure whichever tab they opened:
//
//   ┌ gradient header ─────────────────┐
//   │ Report title          92%        │
//   │ Child · Class · Term  Average    │   ← big readable stats, no jargon
//   └──────────────────────────────────┘
//   {body: subject rows / tables / comments}
//
// Keep the three tabs visually consistent by passing only `tone` + `title`.

import type { ReactNode } from 'react';
import { cn } from '../../../utils/cn';

export type ReportTone = 'violet' | 'blue' | 'amber';

const TONE_GRADIENTS: Record<ReportTone, string> = {
  violet: 'from-indigo-600 to-indigo-700',
  blue: 'from-blue-600 to-cyan-600',
  amber: 'from-amber-500 to-orange-600',
};

const TONE_NOTE: Record<ReportTone, string> = {
  violet: 'bg-indigo-50 border-indigo-100 text-indigo-800',
  blue: 'bg-blue-50 border-blue-100 text-blue-800',
  amber: 'bg-amber-50 border-amber-100 text-amber-800',
};

export interface ReportStat {
  label: string;
  value: string;
}

export function ReportCardShell({
  title,
  subtitle,
  tone,
  stats = [],
  note,
  testId,
  children,
}: {
  /** e.g. "Monthly Report — September" */
  title: string;
  /** e.g. "Amina Yusuf · Grade 2-B · Term 1" */
  subtitle?: string;
  tone: ReportTone;
  /** Big header stats (overall average, grade, position…). Keep to 1–3. */
  stats?: ReportStat[];
  /** Optional plain-language explanation shown under the header. */
  note?: string;
  testId?: string;
  children: ReactNode;
}) {
  return (
    <div className="overflow-hidden rounded-2xl border border-slate-200 bg-white" data-testid={testId}>
      <div className={cn('bg-linear-to-r p-5 text-white', TONE_GRADIENTS[tone])}>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <h2 className="text-lg font-bold leading-snug">{title}</h2>
            {subtitle && <p className="mt-0.5 text-sm text-white/85 break-words">{subtitle}</p>}
          </div>
          {stats.length > 0 && (
            <div className="flex shrink-0 gap-5">
              {stats.map(stat => (
                <div key={stat.label} className="text-right">
                  <p className="text-2xl font-extrabold leading-none tracking-tight sm:text-3xl">{stat.value}</p>
                  <p className="mt-1 text-[11px] font-medium uppercase tracking-wide text-white/75">{stat.label}</p>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      {note && (
        <div className={cn('border-b px-4 py-2.5 text-xs leading-relaxed', TONE_NOTE[tone])}>{note}</div>
      )}

      {children}
    </div>
  );
}
