import { BookOpen, CalendarRange, FileCheck2, FolderOpen, ChevronRight } from 'lucide-react';
import { cn } from '../../utils/cn';

export type PlanTab = 'setup' | 'plan' | 'review' | 'mine';

const STEPS: { key: PlanTab; label: string; short: string; icon: typeof BookOpen }[] = [
  { key: 'setup', label: 'Lesson Plan', short: 'Setup', icon: BookOpen },
  { key: 'plan', label: 'Lesson Plans', short: 'Plan', icon: CalendarRange },
  { key: 'review', label: 'Review & Submit', short: 'Review', icon: FileCheck2 },
  { key: 'mine', label: 'My Lesson Plans', short: 'Mine', icon: FolderOpen },
];

interface PlanStepperProps {
  activeTab: PlanTab;
  onSelect: (tab: PlanTab) => void;
  /** Which steps are reachable right now */
  canGoToPlan: boolean;
  canGoToReview: boolean;
  weekLabel: string;
  className: string;
  isDirty: boolean;
  saving: boolean;
}

export function PlanStepper({
  activeTab,
  onSelect,
  canGoToPlan,
  canGoToReview,
  weekLabel,
  className,
  isDirty,
  saving,
}: PlanStepperProps) {
  const activeIndex = STEPS.findIndex((s) => s.key === activeTab);

  const isEnabled = (key: PlanTab) => {
    if (key === 'setup' || key === 'mine') return true;
    if (key === 'plan') return canGoToPlan;
    return canGoToReview;
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <div className="p-2.5 rounded-xl bg-indigo-100 text-indigo-700">
            <BookOpen className="w-6 h-6" />
          </div>
          <div>
            <h1 className="text-2xl font-bold text-slate-900">Lesson Plans</h1>
            <p className="text-sm text-slate-500">
              {className ? `${className} · ` : ''}{weekLabel}
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2 text-xs">
          {saving ? (
            <span className="px-2.5 py-1 rounded-full bg-blue-50 text-blue-600 font-medium">Saving…</span>
          ) : isDirty ? (
            <span className="px-2.5 py-1 rounded-full bg-amber-50 text-amber-700 font-medium">Unsaved changes</span>
          ) : (
            <span className="px-2.5 py-1 rounded-full bg-emerald-50 text-emerald-700 font-medium">All changes saved</span>
          )}
        </div>
      </div>

      {/* Progress steps — same interaction pattern as Upload Exam Results */}
      <div className="flex flex-wrap items-center gap-2">
        {STEPS.map((s, i) => {
          const enabled = isEnabled(s.key);
          const done = i < activeIndex && enabled;
          return (
            <div key={s.key} className="flex items-center gap-2">
              {i > 0 && <ChevronRight className="w-4 h-4 text-slate-300" />}
              <button
                type="button"
                onClick={() => enabled && onSelect(s.key)}
                disabled={!enabled}
                className={cn(
                  'flex items-center gap-2 px-4 py-2 rounded-xl text-sm font-medium transition-all',
                  activeTab === s.key
                    ? 'bg-indigo-100 text-indigo-700 ring-2 ring-offset-1 ring-indigo-200'
                    : done
                      ? 'bg-emerald-50 text-emerald-600'
                      : enabled
                        ? 'bg-white text-slate-500 border border-slate-200 hover:bg-slate-50'
                        : 'bg-white text-slate-300 border border-slate-100 cursor-not-allowed'
                )}
              >
                <span className={cn(
                  'w-5 h-5 rounded-full text-[11px] font-bold flex items-center justify-center',
                  activeTab === s.key ? 'bg-indigo-600 text-white' : done ? 'bg-emerald-500 text-white' : 'bg-slate-100 text-slate-400'
                )}>
                  {i + 1}
                </span>
                <s.icon className="w-4 h-4" />
                <span className="hidden sm:inline">{s.label}</span>
                <span className="sm:hidden">{s.short}</span>
              </button>
            </div>
          );
        })}
      </div>
    </div>
  );
}

interface StepNavProps {
  onBack?: () => void;
  onNext?: () => void;
  backLabel?: string;
  nextLabel?: string;
  nextDisabled?: boolean;
  nextHint?: string;
}

/** Shared Back / Next footer used on every step of the lesson-plan wizard. */
export function StepNav({ onBack, onNext, backLabel = 'Back', nextLabel = 'Next', nextDisabled, nextHint }: StepNavProps) {
  return (
    <div className="flex items-center justify-between gap-3 pt-4 border-t border-slate-200">
      {onBack ? (
        <button
          type="button"
          onClick={onBack}
          className="flex items-center gap-2 px-5 py-2.5 bg-white text-slate-600 border border-slate-200 rounded-xl font-medium text-sm hover:bg-slate-50 transition-all"
        >
          <span aria-hidden>←</span> {backLabel}
        </button>
      ) : <span />}

      <div className="flex items-center gap-3">
        {nextHint && <span className="text-xs text-slate-400 hidden sm:inline">{nextHint}</span>}
        {onNext && (
          <button
            type="button"
            onClick={onNext}
            disabled={nextDisabled}
            className={cn(
              'flex items-center gap-2 px-5 py-2.5 rounded-xl font-medium text-sm transition-all',
              nextDisabled
                ? 'bg-slate-100 text-slate-400 cursor-not-allowed'
                : 'bg-indigo-600 text-white hover:bg-indigo-700 shadow-lg shadow-indigo-100'
            )}
          >
            {nextLabel} <span aria-hidden>→</span>
          </button>
        )}
      </div>
    </div>
  );
}
