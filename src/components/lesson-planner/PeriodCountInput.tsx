import { PERIOD_COUNT_OPTIONS, clampPeriodCount } from '../../lib/lessonPlanPeriods';
import { cn } from '../../utils/cn';

interface PeriodCountInputProps {
  value: number;
  onChange: (value: number) => void;
  /** Compact styling for the plan-page config bar (vs. the setup form). */
  compact?: boolean;
  'aria-label'?: string;
}

/**
 * Periods-per-day control. Classes only ever run 4, 5, or 6 periods a day,
 * so the count is a fixed dropdown — no free-form entry.
 */
export function PeriodCountInput({
  value,
  onChange,
  compact = false,
  'aria-label': ariaLabel = 'Periods per day',
}: PeriodCountInputProps) {
  // Defensive: a legacy/invalid value can never leave the dropdown blank.
  const selected = clampPeriodCount(value);

  return (
    <select
      value={selected}
      onChange={(e) => onChange(Number(e.target.value))}
      aria-label={ariaLabel}
      className={cn(
        'rounded-xl border border-slate-300 bg-white text-sm text-slate-700',
        'focus:outline-none focus:ring-2 focus:ring-indigo-200',
        compact ? 'px-2.5 py-1.5' : 'w-full px-3 py-2'
      )}
    >
      {PERIOD_COUNT_OPTIONS.map((count) => (
        <option key={count} value={count}>
          {count} periods
        </option>
      ))}
    </select>
  );
}
