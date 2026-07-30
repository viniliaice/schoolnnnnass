import { Loader2, BookOpen, ChevronLeft, ChevronRight } from 'lucide-react';

interface CreatePlanFormProps {
  className: string;
  setClassName: (value: string) => void;
  periodCount: number;
  setPeriodCount: (value: number) => void;
  title: string;
  setTitle: (value: string) => void;
  teacherClasses: string[];
  onCreate: () => void;
  loading: boolean;
  weekStartDate: string;
  weekEndDate: string;
  /** Full "1 Aug – 5 Aug 2026" label. */
  weekRangeLabel?: string;
  onPrevWeek: () => void;
  onNextWeek: () => void;
}

export function CreatePlanForm({
  className,
  setClassName,
  periodCount,
  setPeriodCount,
  title,
  setTitle,
  teacherClasses,
  onCreate,
  loading,
  weekStartDate,
  weekEndDate,
  weekRangeLabel,
  onPrevWeek,
  onNextWeek,
}: CreatePlanFormProps) {
  return (
    <div className="bg-white rounded-2xl border border-slate-200 p-6 space-y-4">
      <div className="flex items-center gap-3 mb-6">
        <div className="p-2.5 rounded-xl bg-indigo-100 text-indigo-700">
          <BookOpen className="w-6 h-6" />
        </div>
        <div>
          <h1 className="text-2xl font-bold text-slate-900">Lesson Plan</h1>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-4">
        <div>
          <label className="block text-sm font-medium text-slate-700 mb-1">Class</label>
          <select
            value={className}
            onChange={(e) => setClassName(e.target.value)}
            className="w-full rounded-xl border border-slate-300 px-3 py-2 text-sm"
          >
            <option value="">Select class</option>
            {teacherClasses.map((c) => (
              <option key={c} value={c}>{c}</option>
            ))}
          </select>
        </div>
        <div>
          <label className="block text-sm font-medium text-slate-700 mb-1">Periods per day</label>
          <select
            value={periodCount}
            onChange={(e) => setPeriodCount(Number(e.target.value))}
            className="w-full rounded-xl border border-slate-300 px-3 py-2 text-sm"
          >
            <option value={5}>5 periods</option>
            <option value={6}>6 periods</option>
          </select>
        </div>
      </div>

      <div className="flex items-center justify-center gap-3">
        <button
          onClick={onPrevWeek}
          className="p-1.5 rounded-lg hover:bg-slate-100 text-slate-500 hover:text-slate-700 transition-colors"
        >
          <ChevronLeft className="w-5 h-5" />
        </button>
        <span className="text-sm font-semibold text-slate-700 min-w-[200px] text-center">
          {weekRangeLabel || `${weekStartDate} — ${weekEndDate}`}
        </span>
        <button
          onClick={onNextWeek}
          className="p-1.5 rounded-lg hover:bg-slate-100 text-slate-500 hover:text-slate-700 transition-colors"
        >
          <ChevronRight className="w-5 h-5" />
        </button>
      </div>

      <div>
        <label className="block text-sm font-medium text-slate-700 mb-1">Title (optional)</label>
        <input
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="e.g. Week 31 - Math - Fractions"
          className="w-full rounded-xl border border-slate-300 px-3 py-2 text-sm"
        />
      </div>
      <button
        onClick={onCreate}
        disabled={!className || loading}
        className="w-full py-2.5 rounded-xl bg-indigo-600 text-white font-medium text-sm hover:bg-indigo-700 disabled:opacity-50 transition-colors"
      >
        {loading ? <Loader2 className="w-4 h-4 animate-spin mx-auto" /> : 'Start Planning'}
      </button>
    </div>
  );
}
