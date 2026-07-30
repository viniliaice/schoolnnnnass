import { useRef } from 'react';
import { DayOfWeek, PeriodActivity, Subject } from '../../types';
import { Loader2, Send, FileCheck2, Download, AlertTriangle, CheckCircle2 } from 'lucide-react';
import { cn } from '../../utils/cn';
import { PlanReadView } from './PlanReadView';
import { StepNav } from './PlanStepper';
import { printElementAsPdf } from '../../utils/printToPdf';

interface ReviewStepProps {
  periods: {
    day: DayOfWeek;
    period_number: number;
    subject: string;
    className: string;
    isFree: boolean;
    topic: string;
    objective: string;
    slide_number: string;
    details: PeriodActivity[];
  }[];
  teacherClasses: string[];
  subjects: Subject[];
  periodCount: number;
  weekLabel: string;
  weekDates?: string[];
  weekRange?: string;
  title: string;
  planClassName: string;
  onBack: () => void;
  onSubmit: () => void;
  isSubmitting: boolean;
  submitted?: boolean;
  onViewSubmitted?: () => void;
}

export function ReviewStep({
  periods,
  subjects,
  periodCount,
  weekLabel,
  weekDates,
  weekRange,
  title,
  planClassName,
  onBack,
  onSubmit,
  isSubmitting,
  submitted,
  onViewSubmitted,
}: ReviewStepProps) {
  const printRef = useRef<HTMLDivElement>(null);

  const freeCount = periods.filter((p) => p.isFree || p.subject === '__FREE__').length;
  const active = periods.filter((p) => !p.isFree && p.subject !== '__FREE__');
  const filledCount = active.filter((p) => p.topic.trim()).length;
  const emptyCount = active.filter((p) => !p.topic.trim()).length;
  const withObjective = active.filter((p) => p.objective.trim()).length;
  const activityCount = active.reduce((n, p) => n + p.details.filter((d) => d.activity.trim()).length, 0);
  const totalSlots = periods.length || 1;
  const completion = Math.round(((filledCount + freeCount) / totalSlots) * 100);

  const handleExportPdf = () => {
    printElementAsPdf(printRef.current, `${title || 'Lesson Plan'} — ${planClassName} — ${weekLabel}`);
  };

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="flex items-center gap-3">
          <div className="p-2.5 rounded-xl bg-amber-100 text-amber-700">
            <FileCheck2 className="w-6 h-6" />
          </div>
          <div>
            <h2 className="text-2xl font-bold text-slate-900">Review &amp; Submit</h2>
            <p className="text-sm text-slate-500">
              {title || 'Lesson Plan'} · {planClassName || '—'} · {weekRange ? `${weekRange} · ` : ''}Week {weekLabel}
            </p>
          </div>
        </div>
        <button
          type="button"
          onClick={handleExportPdf}
          className="no-print flex items-center gap-2 px-4 py-2.5 rounded-xl bg-white border border-slate-200 text-sm font-medium text-slate-700 hover:bg-slate-50 transition-colors"
        >
          <Download className="w-4 h-4" />
          Export PDF
        </button>
      </div>

      {/* Readiness banner */}
      <div className={cn(
        'rounded-2xl border p-4 flex items-start gap-3',
        emptyCount > 0 ? 'bg-amber-50 border-amber-200' : 'bg-emerald-50 border-emerald-200'
      )}>
        {emptyCount > 0 ? (
          <AlertTriangle className="w-5 h-5 text-amber-600 shrink-0 mt-0.5" />
        ) : (
          <CheckCircle2 className="w-5 h-5 text-emerald-600 shrink-0 mt-0.5" />
        )}
        <div className="min-w-0">
          <p className={cn('text-sm font-semibold', emptyCount > 0 ? 'text-amber-800' : 'text-emerald-800')}>
            {emptyCount > 0
              ? `${emptyCount} period${emptyCount === 1 ? '' : 's'} still need a topic`
              : 'This plan is ready to submit'}
          </p>
          <p className={cn('text-xs mt-0.5', emptyCount > 0 ? 'text-amber-700' : 'text-emerald-700')}>
            {emptyCount > 0
              ? 'Go back to the Plan step and fill in the missing topics, or mark those periods as free.'
              : 'Once submitted, the plan goes to your supervisor and an AI review is generated automatically.'}
          </p>
          <div className="mt-3 h-2 w-full max-w-md rounded-full bg-white/70 overflow-hidden">
            <div
              className={cn('h-full rounded-full transition-all', emptyCount > 0 ? 'bg-amber-400' : 'bg-emerald-500')}
              style={{ width: `${completion}%` }}
            />
          </div>
          <p className="text-xs text-slate-500 mt-1">{completion}% complete</p>
        </div>
      </div>

      {/* Printable region */}
      <div ref={printRef} className="space-y-6">
        {/* Print-only document header */}
        <div className="hidden print:block">
          <h1 className="text-xl font-bold text-slate-900">{title || 'Lesson Plan'}</h1>
          <p className="text-sm text-slate-500">{planClassName} · {weekRange} · Week {weekLabel}</p>
        </div>

        {/* Summary cards */}
        <div className="grid grid-cols-2 lg:grid-cols-5 gap-3">
          <SummaryCard value={filledCount} label="Periods planned" tone="emerald" />
          <SummaryCard value={emptyCount} label="Empty periods" tone={emptyCount > 0 ? 'amber' : 'slate'} />
          <SummaryCard value={freeCount} label="Free periods" tone="slate" />
          <SummaryCard value={withObjective} label="With objectives" tone="indigo" />
          <SummaryCard value={activityCount} label="Activities" tone="violet" />
        </div>

        {/* Plan details, day by day */}
        <PlanReadView
          periods={periods}
          periodCount={periodCount}
          subjects={subjects}
          planClassName={planClassName}
          weekDates={weekDates}
        />
      </div>

      {/* Back / Submit */}
      <div className="no-print flex flex-wrap items-center justify-between gap-3 pt-4 border-t border-slate-200">
        <button
          type="button"
          onClick={onBack}
          className="flex items-center gap-2 px-5 py-2.5 bg-white text-slate-600 border border-slate-200 rounded-xl font-medium text-sm hover:bg-slate-50 transition-all"
        >
          <span aria-hidden>←</span> Back to Plan
        </button>
        <div className="flex items-center gap-3">
          {submitted && onViewSubmitted && (
            <button
              type="button"
              onClick={onViewSubmitted}
              className="px-5 py-2.5 rounded-xl bg-white border border-slate-200 text-sm font-medium text-slate-700 hover:bg-slate-50 transition-colors"
            >
              View submitted plans →
            </button>
          )}
          <button
            type="button"
            onClick={onSubmit}
            disabled={isSubmitting || emptyCount > 0}
            className={cn(
              'flex items-center gap-2 px-6 py-2.5 rounded-xl font-semibold text-sm transition-all',
              isSubmitting || emptyCount > 0
                ? 'bg-slate-100 text-slate-400 cursor-not-allowed'
                : 'bg-indigo-600 text-white hover:bg-indigo-700 shadow-lg shadow-indigo-100'
            )}
          >
            {isSubmitting ? <Loader2 className="w-4 h-4 animate-spin" /> : <Send className="w-4 h-4" />}
            Submit to Supervisor
          </button>
        </div>
      </div>
    </div>
  );
}

const TONES: Record<string, string> = {
  emerald: 'bg-emerald-50 border-emerald-100 text-emerald-700',
  amber: 'bg-amber-50 border-amber-100 text-amber-700',
  slate: 'bg-slate-50 border-slate-200 text-slate-700',
  indigo: 'bg-indigo-50 border-indigo-100 text-indigo-700',
  violet: 'bg-violet-50 border-violet-100 text-violet-700',
};

function SummaryCard({ value, label, tone }: { value: number; label: string; tone: keyof typeof TONES }) {
  return (
    <div className={cn('avoid-break rounded-2xl border p-4 text-center', TONES[tone])}>
      <p className="text-3xl font-bold leading-none">{value}</p>
      <p className="text-xs mt-1.5 opacity-80">{label}</p>
    </div>
  );
}

export { StepNav };
