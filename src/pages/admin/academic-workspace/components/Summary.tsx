import type { ComponentType } from 'react';
import { cn } from '../../../../utils/cn';

type IconComponent = ComponentType<{ className?: string }>;

export function InfoPill({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-2xl bg-slate-50 px-3 py-2">
      <p className="text-[10px] font-bold uppercase tracking-[0.2em] text-slate-400">{label}</p>
      <p className="text-sm font-semibold text-slate-800">{value}</p>
    </div>
  );
}

export function SummaryCard({
  icon: Icon,
  label,
  value,
  tone = 'neutral',
}: {
  icon: IconComponent;
  label: string;
  value: string | number;
  tone?: 'neutral' | 'ok' | 'warn';
}) {
  const toneClass = tone === 'ok'
    ? 'bg-emerald-50 text-emerald-700'
    : tone === 'warn'
      ? 'bg-amber-50 text-amber-700'
      : 'bg-slate-50 text-slate-700';

  return (
    <div className="rounded-3xl border border-slate-200 bg-white p-4 shadow-sm">
      <div className={cn('mb-3 inline-flex rounded-2xl p-2', toneClass)}>
        <Icon className="h-5 w-5" />
      </div>
      <p className="text-2xl font-bold text-slate-900">{value}</p>
      <p className="text-sm text-slate-500">{label}</p>
    </div>
  );
}
