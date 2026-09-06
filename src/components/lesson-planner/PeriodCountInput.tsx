import { Minus, Plus } from 'lucide-react';
import { clampPeriodCount, MIN_PERIOD_COUNT } from '../../lib/lessonPlanPeriods';
import { cn } from '../../utils/cn';

interface PeriodCountInputProps {
  value: number;
  onChange: (value: number) => void;
  /** Compact styling for the plan-page config bar (vs. the setup form). */
  compact?: boolean;
  'aria-label'?: string;
}

/**
 * Dynamic periods-per-day control. Any positive count is accepted — there is
 * no fixed 4/5/6 option list.
 */
export function PeriodCountInput({
  value,
  onChange,
  compact = false,
  'aria-label': ariaLabel = 'Periods per day',
}: PeriodCountInputProps) {
  const atMin = value <= MIN_PERIOD_COUNT;

  const setCount = (next: number) => onChange(clampPeriodCount(next));

  return (
    <div
      className={cn(
        'inline-flex items-center gap-1 rounded-xl border border-slate-300 bg-white',
        compact ? 'px-1 py-0.5' : 'px-1.5 py-1'
      )}
    >
      <button
        type="button"
        onClick={() => setCount(value - 1)}
        disabled={atMin}
        aria-label="Remove one period"
        title="Remove one period"
        className="flex h-7 w-7 items-center justify-center rounded-lg text-slate-500 transition-colors hover:bg-slate-100 disabled:cursor-not-allowed disabled:opacity-40"
      >
        <Minus className="h-4 w-4" />
      </button>
      <input
        type="number"
        min={MIN_PERIOD_COUNT}
        value={value}
        onChange={(e) => setCount(e.target.valueAsNumber || MIN_PERIOD_COUNT)}
        aria-label={ariaLabel}
        className={cn(
          'w-12 bg-transparent text-center text-sm font-medium text-slate-800 focus:outline-none',
          'appearance-none [-moz-appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none'
        )}
      />
      <button
        type="button"
        onClick={() => setCount(value + 1)}
        aria-label="Add one period"
        title="Add one period"
        className="flex h-7 w-7 items-center justify-center rounded-lg text-slate-500 transition-colors hover:bg-slate-100"
      >
        <Plus className="h-4 w-4" />
      </button>
    </div>
  );
}
