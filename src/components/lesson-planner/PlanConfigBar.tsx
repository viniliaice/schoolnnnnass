import { ChevronLeft, ChevronRight } from 'lucide-react';

interface PlanConfigBarProps {
  className: string;
  setClassName: (value: string) => void;
  periodCount: number;
  setPeriodCount: (value: number) => void;
  teacherClasses: string[];
  weekLabel: string;
  weekStartDate: string;
  weekEndDate: string;
  onPrevWeek: () => void;
  onNextWeek: () => void;
}

export function PlanConfigBar({
  className,
  setClassName,
  periodCount,
  setPeriodCount,
  teacherClasses,
  weekLabel,
  weekStartDate,
  weekEndDate,
  onPrevWeek,
  onNextWeek,
}: PlanConfigBarProps) {
  return (
    <div className="flex items-center gap-4 bg-slate-50 rounded-xl px-4 py-2 border border-slate-200">
      <div className="flex items-center gap-2">
        <span className="text-xs font-semibold text-slate-700">Class</span>
        <select
          value={className}
          onChange={(e) => setClassName(e.target.value)}
          className="rounded-lg border border-slate-300 px-2.5 py-1.5 text-sm text-slate-700 focus:outline-none focus:ring-2 focus:ring-indigo-200 bg-white"
        >
          {teacherClasses.map((c) => <option key={c} value={c}>{c}</option>)}
        </select>
      </div>
      <div className="flex items-center gap-2">
        <span className="text-xs font-semibold text-slate-700">Periods/day</span>
        <select
          value={periodCount}
          onChange={(e) => setPeriodCount(Number(e.target.value))}
          className="rounded-lg border border-slate-300 px-2.5 py-1.5 text-sm text-slate-700 focus:outline-none focus:ring-2 focus:ring-indigo-200 bg-white w-24"
        >
          <option value={5}>5</option>
          <option value={6}>6</option>
        </select>
      </div>
      <div className="flex items-center gap-1 ml-auto">
        <button
          onClick={onPrevWeek}
          className="p-1 rounded-lg hover:bg-white text-slate-500 hover:text-slate-700 transition-colors"
        >
          <ChevronLeft className="w-4 h-4" />
        </button>
        <span className="text-xs text-slate-500">
          {weekStartDate} — {weekEndDate}
        </span>
        <button
          onClick={onNextWeek}
          className="p-1 rounded-lg hover:bg-white text-slate-500 hover:text-slate-700 transition-colors"
        >
          <ChevronRight className="w-4 h-4" />
        </button>
      </div>
    </div>
  );
}